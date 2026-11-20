import {mkdir, readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {destinations} from './dist/destinations.js';
import {cityGuides} from './dist/city-guides.js';
import {guideRouteDetails} from './dist/guide-route-details.js';
import {shortGuideStops} from './dist/short-guide-stops.js';

const schema = `
  CREATE TABLE IF NOT EXISTS destinations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, airport TEXT, category TEXT NOT NULL,
    position INTEGER NOT NULL, data TEXT NOT NULL CHECK (json_valid(data))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS guides (
    destination_id TEXT PRIMARY KEY REFERENCES destinations(id) ON DELETE CASCADE,
    data TEXT NOT NULL CHECK (json_valid(data))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS fare_cache (
    mode TEXT NOT NULL, scope TEXT NOT NULL, origin TEXT NOT NULL, destination TEXT NOT NULL,
    travel_date TEXT NOT NULL, departure_hour INTEGER NOT NULL, arrival_hour INTEGER NOT NULL,
    collected_at TEXT NOT NULL, expires_at TEXT, batch TEXT,
    data TEXT NOT NULL CHECK (json_valid(data)),
    PRIMARY KEY (mode, scope, origin, destination, travel_date, departure_hour, arrival_hour)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS fare_cache_expiry ON fare_cache(expires_at) WHERE expires_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS fare_cache_date ON fare_cache(travel_date);
  CREATE INDEX IF NOT EXISTS fare_cache_latest ON fare_cache(mode, scope, collected_at);
  CREATE TABLE IF NOT EXISTS collection_runs (
    id INTEGER PRIMARY KEY, batch TEXT NOT NULL, coverage TEXT NOT NULL,
    status TEXT NOT NULL, planned INTEGER NOT NULL, started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, retry_at TEXT, UNIQUE (batch, coverage)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS collection_attempts (
    run_id INTEGER NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
    origin TEXT NOT NULL, destination TEXT NOT NULL, travel_date TEXT NOT NULL, departure_hour INTEGER NOT NULL,
    status TEXT NOT NULL, attempted_at TEXT NOT NULL,
    PRIMARY KEY (run_id, origin, destination, travel_date, departure_hour)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

const legKey = ({mode, scope, from, to, date, depHour, arrHour}) =>
  [mode, scope, from, to, date, depHour ?? -1, arrHour ?? -1];
const timestamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

async function readLegacy(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (!(error instanceof SyntaxError)) throw error;
    console.warn('旧票价 JSON 格式无效，原文件已保留。');
    return null;
  }
}

export async function openDatabase(file, {legacyFlightFile, now = () => new Date()} = {}) {
  if (file !== ':memory:') await mkdir(dirname(file), {recursive: true});
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    db.exec(schema);
    const readMeta = db.prepare('SELECT value FROM metadata WHERE key=?');
    const saveMeta = db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    const insertFare = 'INSERT INTO fare_cache VALUES (?,?,?,?,?,?,?,?,?,?,?)';
    const saveFare = db.prepare(insertFare + ` ON CONFLICT DO UPDATE SET
      collected_at=excluded.collected_at, expires_at=excluded.expires_at, batch=excluded.batch, data=excluded.data
      WHERE excluded.collected_at >= fare_cache.collected_at`);
    const importFare = db.prepare(insertFare + ' ON CONFLICT DO NOTHING');
    const selectFare = db.prepare(`SELECT data FROM fare_cache WHERE mode=? AND scope=? AND origin=? AND destination=?
      AND travel_date=? AND departure_hour=? AND arrival_hour=? AND (expires_at IS NULL OR expires_at>?)`);
    const selectLegs = db.prepare(`SELECT data FROM fare_cache
      WHERE mode='flight' AND scope='scheduled' AND origin=? AND destination=? AND travel_date=?
      ORDER BY collected_at DESC, departure_hour`);
    const hasCoverage = db.prepare(`SELECT 1 AS covered FROM fare_cache WHERE mode='flight' AND scope='scheduled'
      AND origin=? AND destination=? AND travel_date=? AND departure_hour<=? AND (? IS NULL OR batch=?) LIMIT 1`);
    const flightRoutes = db.prepare("SELECT DISTINCT origin, destination FROM fare_cache WHERE mode='flight'");
    const deleteRoute = db.prepare("DELETE FROM fare_cache WHERE mode='flight' AND origin=? AND destination=?");
    const deleteExpired = db.prepare('DELETE FROM fare_cache WHERE expires_at<=?');
    const deletePast = db.prepare("DELETE FROM fare_cache WHERE mode='flight' AND scope='scheduled' AND travel_date<?");
    const deleteRuns = db.prepare('DELETE FROM collection_runs WHERE updated_at<?');
    const beginRun = db.prepare(`INSERT INTO collection_runs(batch,coverage,status,planned,started_at,updated_at)
      VALUES(?,?,'running',?,?,?) ON CONFLICT(batch,coverage) DO UPDATE SET
      status='running', planned=excluded.planned, updated_at=excluded.updated_at, retry_at=NULL RETURNING id`);
    const updateRun = db.prepare('UPDATE collection_runs SET status=?, updated_at=?, retry_at=? WHERE id=?');
    const latestRun = db.prepare('SELECT * FROM collection_runs ORDER BY updated_at DESC, id DESC LIMIT 1');
    const completedRun = db.prepare("SELECT * FROM collection_runs WHERE status='complete' ORDER BY updated_at DESC, id DESC LIMIT 1");
    const countAttempts = db.prepare('SELECT status, COUNT(*) AS count FROM collection_attempts WHERE run_id=? GROUP BY status');
    const saveAttempt = db.prepare(`INSERT INTO collection_attempts VALUES (?,?,?,?,?,?,?)
      ON CONFLICT DO UPDATE SET status=excluded.status, attempted_at=excluded.attempted_at`);
    const lastFlightWrite = db.prepare("SELECT max(collected_at) AS time FROM fare_cache WHERE mode='flight' AND scope='scheduled'");
    const listDestinations = db.prepare('SELECT data FROM destinations ORDER BY position');
    const loadGuide = db.prepare(`SELECT destinations.data AS destination, guides.data AS guide
      FROM guides JOIN destinations ON destinations.id=guides.destination_id WHERE destinations.id=?`);

    function transaction(write) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = write();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }

    function saveLeg(statement, key, result, batch = null, expiresAt = null) {
      statement.run(...legKey(key), result.collectedAt, expiresAt, batch, JSON.stringify(result));
    }

    if (legacyFlightFile && !readMeta.get('legacy_flight_v1')) {
      const [saved, temporary] = await Promise.all([readLegacy(legacyFlightFile), readLegacy(legacyFlightFile + '.temporary')]);
      transaction(() => {
        if (readMeta.get('legacy_flight_v1')) return;
        for (const [route, entries] of Object.entries(saved?.legs ?? {})) {
          const [date, from, to] = route.split('/');
          if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
          for (const [hour, entry] of Object.entries(entries ?? {})) {
            const result = entry?.result;
            if (!Array.isArray(result?.flights) || !timestamp(result.collectedAt) || !/^\d{1,2}$/.test(hour)) continue;
            saveLeg(importFare, {mode:'flight', scope:'scheduled', from, to, date, depHour:Number(hour)},
              {...result, collectedAt:timestamp(result.collectedAt)}, entry.day ?? null);
          }
        }
        for (const [key, entry] of Object.entries(temporary ?? {})) {
          let fields;
          try { fields = JSON.parse(key); } catch { continue; }
          if (!Array.isArray(fields)) continue;
          const [from, to, date, depHour, arrHour] = fields;
          const result = entry?.result;
          const expiresAt = timestamp(entry?.expiresAt);
          if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !expiresAt ||
              !Array.isArray(result?.flights) || !timestamp(result.collectedAt)) continue;
          saveLeg(importFare, {mode:'flight', scope:'temporary', from, to, date, depHour, arrHour},
            {...result, collectedAt:timestamp(result.collectedAt), temporaryExpiresAt:expiresAt}, null, expiresAt);
        }
        if (typeof saved?.day === 'string' && typeof saved?.coverageKey === 'string') {
          const at = timestamp(saved.updatedAt) ?? now().toISOString();
          const id = beginRun.get(saved.day, saved.coverageKey, 0, at, at).id;
          updateRun.run('complete', at, null, id);
        }
        saveMeta.run('legacy_flight_v1', now().toISOString());
      });
    }

    function seedCatalog() {
      const cities = db.prepare(`INSERT INTO destinations VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, airport=excluded.airport, category=excluded.category,
        position=excluded.position, data=excluded.data`);
      const guides = db.prepare('INSERT INTO guides VALUES(?,?) ON CONFLICT(destination_id) DO UPDATE SET data=excluded.data');
      const removeCity = db.prepare('DELETE FROM destinations WHERE id=?');
      const ids = new Set(destinations.map(city => city.id));
      transaction(() => {
        for (const row of db.prepare('SELECT id FROM destinations').all()) {
          if (!ids.has(row.id)) removeCity.run(row.id);
        }
        for (const [position, city] of destinations.entries()) {
          const cover = city.hasPhoto ? '/images/' + city.id + '.webp' : null;
          cities.run(city.id, city.city, city.airport, city.tag, position, JSON.stringify({...city, cover}));
          const guide = cityGuides[city.id];
          if (guide) guides.run(city.id, JSON.stringify({...guide,
            routeDetails:guideRouteDetails[city.id], shortStops:shortGuideStops[city.id]}));
        }
      });
    }

    return {
      close: () => db.close(),
      seedCatalog,
      destinations: () => listDestinations.all().map(row => JSON.parse(row.data)),
      guide(id) {
        const row = loadGuide.get(id);
        return row ? {destination:JSON.parse(row.destination), guide:JSON.parse(row.guide)} : null;
      },
      railDirectory() {
        const row = readMeta.get('rail_directory');
        return row ? JSON.parse(row.value) : null;
      },
      saveRailDirectory({cities, stations}) {
        saveMeta.run('rail_directory', JSON.stringify({cities, stations}));
      },
      getLeg(key, at) {
        const row = selectFare.get(...legKey(key), at);
        return row ? JSON.parse(row.data) : null;
      },
      saveLeg(key, result, expiresAt) { saveLeg(saveFare, key, result, null, expiresAt); },
      scheduledLegs: (from, to, date) => selectLegs.all(from, to, date).map(row => JSON.parse(row.data)),
      covers: (from, to, date, hour = 23, batch = null) => !!hasCoverage.get(from, to, date, hour, batch, batch),
      pruneFlightRoutes(valid) {
        transaction(() => {
          for (const {origin, destination} of flightRoutes.all()) {
            if (!valid(origin, destination)) deleteRoute.run(origin, destination);
          }
        });
      },
      sweepExpired: at => deleteExpired.run(at),
      pruneSchedule(today, cutoff) {
        deletePast.run(today);
        deleteRuns.run(cutoff);
      },
      latestRun() {
        const run = latestRun.get();
        return run ? {...run, outcomes:Object.fromEntries(countAttempts.all(run.id).map(row => [row.status, row.count]))} : null;
      },
      completedRun: () => completedRun.get(),
      lastFlightWrite: () => lastFlightWrite.get().time,
      startRun: (batch, coverage, planned, at) => beginRun.get(batch, coverage, planned, at, at).id,
      finishRun: (id, status, at, retryAt = null) => updateRun.run(status, at, retryAt, id),
      recordAttempt(id, batch, key, status, at, result) {
        transaction(() => {
          if (result) saveLeg(saveFare, key, result, batch);
          saveAttempt.run(id, key.from, key.to, key.date, key.depHour, status, at);
        });
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
