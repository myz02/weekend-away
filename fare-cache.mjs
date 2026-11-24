import {openDatabase} from './database.mjs';
import {collect, destinationAirports} from './live.mjs';
import {runSearchBatch} from './search-batch.mjs';
import {returnDate} from './dist/engine.js';
import {originAirports} from './dist/destinations.js';
import {nextShanghaiNoon, openTemporaryFares} from './temporary-fares.mjs';

const origins = Object.keys(originAirports);
const destinations = Object.keys(destinationAirports);
const validLeg = (from, to) => from !== to && (
  (Object.hasOwn(originAirports, from) && Object.hasOwn(destinationAirports, to)) ||
  (Object.hasOwn(originAirports, to) && Object.hasOwn(destinationAirports, from))
);
const clock = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'});
const legKey = (from, to, date) => [date, from, to].join('/');
const coverageKey = JSON.stringify([origins, Object.entries(destinationAirports).sort()]);

export function cacheSchedule(now) {
  const [day, hour] = clock.format(now).split(' ');
  const today = new Date(day + 'T12:00:00Z');
  const end = new Date(today);
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 2);
  const outbound = [];
  for (const date = new Date(today); date < end; date.setUTCDate(date.getUTCDate() + 1)) {
    const weekday = date.getUTCDay();
    if (weekday === 5 || weekday === 6) outbound.push(date.toISOString().slice(0, 10));
  }
  return {day, due: Number(hour) >= 12, outbound};
}

function coverage(outbound) {
  const calls = new Map();
  for (const date of outbound) {
    const back = returnDate(date);
    const earliest = new Date(date + 'T12:00:00Z').getUTCDay() === 6 ? 7 : 21;
    for (const from of origins) {
      for (const to of destinations) {
        if (from === to) continue;
        for (const [origin, destination, departure, hour] of [[from, to, date, earliest], [to, from, back, 18]]) {
          const key = legKey(origin, destination, departure);
          calls.set(key, [key, origin, destination, departure, hour]);
        }
      }
    }
  }
  return [...calls.values()];
}

export async function openFareCache(file, {fetchLeg = collect, fetchAlternateLeg, now = () => new Date(), database} = {}) {
  const store = database ?? await openDatabase(file + '.sqlite', {legacyFlightFile: file, now});
  const temporary = openTemporaryFares(store, fetchLeg, now);
  const alternate = fetchAlternateLeg && openTemporaryFares(store, fetchAlternateLeg, now, 'tongcheng');
  let refreshing = false;
  let progress = null;
  const started = store.latestRun();
  let retryAt = started?.status === 'paused' ? started.retry_at : null;
  store.pruneFlightRoutes(validLeg);
  const pruneSchedule = day => store.pruneSchedule(day,
    new Date(now().getTime() - 14 * 86400000).toISOString());
  pruneSchedule(cacheSchedule(now()).day);
  temporary.sweep();

  async function refresh() {
    temporary.sweep();
    const schedule = cacheSchedule(now());
    const batch = schedule.due ? schedule.day : schedule.day + '-bootstrap';
    const completed = store.completedRun();
    const currentCoverage = completed?.coverage === coverageKey;
    if (refreshing || (retryAt && now().getTime() < Date.parse(retryAt)) ||
        (currentCoverage && (completed.batch === batch || !schedule.due))) return;
    refreshing = true;
    retryAt = null;
    let runId;
    try {
      const calls = coverage(schedule.outbound).map(([, from, to, date, hour]) =>
        ({mode:'flight', scope:'scheduled', from, to, date, depHour:hour,
          cached:store.covers(from, to, date)}));
      calls.sort((a, b) => Number(a.cached) - Number(b.cached));
      progress = {done: 0, total: calls.length};
      runId = store.startRun(batch, coverageKey, calls.length, now().toISOString());
      for (const leg of calls) {
        const {from, to, date, depHour} = leg;
        if (store.covers(from, to, date, depHour, batch)) {
          progress.done++;
          continue;
        }
        let result;
        try {
          result = await fetchLeg(from, to, date, {depHour});
        } catch (error) {
          if (error.code === 'FLYAI_RATE_LIMIT') {
            const nowDate = now();
            retryAt = new Date(nowDate.getTime() + 5 * 60000).toISOString();
            store.recordAttempt(runId, batch, leg, 'rate_limited', nowDate.toISOString());
            store.finishRun(runId, 'paused', nowDate.toISOString(), retryAt);
            return;
          }
        }
        store.recordAttempt(runId, batch, leg, result ? 'success' : 'failed', now().toISOString(), result);
        progress.done++;
      }
      pruneSchedule(schedule.day);
      store.finishRun(runId, 'complete', now().toISOString());
    } catch (error) {
      if (runId) store.finishRun(runId, 'interrupted', now().toISOString());
      throw error;
    } finally {
      refreshing = false;
    }
  }

  async function cachedLeg(from, to, date) {
    const entries = store.scheduledLegs(from, to, date);
    if (!entries.length) throw Error(refreshing ? '该航线正在采集，请稍后再查缓存' : '该航线或日期暂无缓存报价');
    const flights = new Map();
    for (const result of entries) {
      for (const flight of result.flights) {
        const key = [flight.number, flight.depAirportCode, flight.arrAirportCode, flight.departureTime].join('/');
        if (!flights.has(key)) flights.set(key, flight);
      }
    }
    return {...entries.at(-1), flights: [...flights.values()]};
  }

  const status = () => {
    const run = store.latestRun();
    return {refreshing, progress, retryAt, updatedAt:store.lastFlightWrite(), dates:cacheSchedule(now()).outbound,
      lastBatch:run && {batch:run.batch, status:run.status, total:run.planned, outcomes:run.outcomes}};
  };
  return {
    refresh,
    status,
    close() { if (!database) store.close(); },
    async search(query) {
      await temporary.sweep();
      const schedule = cacheSchedule(now());
      const departure = new Date(query.outDate + 'T12:00:00Z');
      const canFetch = query.cacheOnly !== true && query.outDate >= schedule.day &&
        [5, 6].includes(departure.getUTCDay()) && departure.toISOString().slice(0, 10) === query.outDate &&
        returnDate(query.outDate) === query.backDate;
      let usedOnDemand = false;
      const lookup = (from, to, date, filter) => {
        if (store.covers(from, to, date, filter.depHour)) return cachedLeg(from, to, date);
        if (query.cacheOnly) {
          const cached = temporary.read(from, to, date, filter);
          if (cached) return cached;
          throw Error('该航线或日期暂无完整缓存报价');
        }
        if (!canFetch) return cachedLeg(from, to, date);
        usedOnDemand = true;
        return temporary.get(from, to, date, filter).catch(error => {
          if (store.covers(from, to, date)) return cachedLeg(from, to, date);
          throw error;
        });
      };
      const results = Object.fromEntries([...new Set(query.destinations)].filter(city =>
        Object.hasOwn(originAirports, query.origin) && city !== query.origin && Object.hasOwn(destinationAirports, city))
        .map(city => [city, {city, status: 'queued'}]));
      const job = {status: 'queued', query: {...query, destinations: Object.keys(results)}, completed: 0, results};
      const lookupAlternate = alternate && ((from, to, date) => {
        if (canFetch) return alternate.get(from, to, date, {});
        const cached = alternate.read(from, to, date, {});
        if (!cached) throw Error('暂无同程缓存报价');
        return cached;
      });
      await runSearchBatch(job, {fetchLeg:lookup, fetchAlternateLeg:lookupAlternate});
      const expirations = [];
      for (const item of Object.values(results)) {
        if (item.inbound && item.outbound) {
          item.collectedAt = [item.inbound.collectedAt, item.outbound.collectedAt].sort()[0];
        }
        const expiresAt = [item.inbound?.temporaryExpiresAt, item.outbound?.temporaryExpiresAt]
          .filter(Boolean).sort()[0];
        if (expiresAt) {
          item.temporaryExpiresAt = expiresAt;
          expirations.push(expiresAt);
        }
        delete item.outbound;
        delete item.inbound;
      }
      const temporaryExpiresAt = expirations.sort()[0] ?? (usedOnDemand ? nextShanghaiNoon(now()) : null);
      return {...job, cache: status(), temporaryExpiresAt};
    },
  };
}
