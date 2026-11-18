import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
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

export async function openFareCache(file, {fetchLeg = collect, now = () => new Date()} = {}) {
  const temporary = await openTemporaryFares(file + '.temporary', fetchLeg, now, validLeg);
  let state = {day: null, updatedAt: null, legs: {}};
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved?.legs) state = saved;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('无法读取票价缓存，将重新采集', error.message);
  }
  let refreshing = false;
  let progress = null;
  let retryAt = null;
  const persist = async () => {
    await mkdir(dirname(file), {recursive: true});
    await writeFile(file + '.tmp', JSON.stringify(state));
    await rename(file + '.tmp', file);
  };
  const today = cacheSchedule(now()).day;
  const obsolete = Object.keys(state.legs).filter(key => {
    const [date, from, to] = key.split('/');
    return date < today || !validLeg(from, to);
  });
  if (obsolete.length) {
    for (const key of obsolete) delete state.legs[key];
    await persist();
  }
  await temporary.sweep();

  async function refresh() {
    await temporary.sweep();
    const schedule = cacheSchedule(now());
    const batch = schedule.due ? schedule.day : schedule.day + '-bootstrap';
    const currentCoverage = state.coverageKey === coverageKey;
    if (refreshing || (retryAt && now().getTime() < Date.parse(retryAt)) ||
        (currentCoverage && (state.day === batch || (!schedule.due && state.day)))) return;
    refreshing = true;
    retryAt = null;
    const calls = coverage(schedule.outbound);
    const existing = state.legs;
    calls.sort(([a], [b]) => Number(Object.hasOwn(existing, a)) - Number(Object.hasOwn(existing, b)));
    progress = {done: 0, total: calls.length};
    let pendingWrites = 0;
    let firstWrite = true;
    try {
      for (const [key, from, to, date, hour] of calls) {
        if (Object.entries(state.legs[key] || {}).some(([cachedHour, entry]) =>
          Number(cachedHour) <= hour && entry.day === batch)) {
          progress.done++;
          continue;
        }
        let result;
        try {
          result = await fetchLeg(from, to, date, hour ? {depHour: hour} : {});
        } catch (error) {
          if (error.code === 'FLYAI_RATE_LIMIT') {
            retryAt = new Date(now().getTime() + 5 * 60000).toISOString();
            if (pendingWrites) await persist();
            return;
          }
        }
        if (result) {
          state.legs[key] ??= {};
          state.legs[key][hour] = {day: batch, result};
          state.updatedAt = now().toISOString();
          pendingWrites++;
          if (firstWrite || pendingWrites >= 20) {
            await persist();
            pendingWrites = 0;
            firstWrite = false;
          }
        }
        progress.done++;
      }
      state.legs = Object.fromEntries(Object.entries(state.legs).filter(([key]) => key.slice(0, 10) >= schedule.day));
      state.day = batch;
      state.coverageKey = coverageKey;
      await persist();
    } finally {
      refreshing = false;
    }
  }

  async function cachedLeg(from, to, date) {
    const entries = Object.values(state.legs[legKey(from, to, date)] ?? {});
    if (!entries.length) throw Error(refreshing ? '该航线正在采集，请稍后再查缓存' : '该航线或日期暂无缓存报价');
    entries.sort((a, b) => b.result.collectedAt.localeCompare(a.result.collectedAt));
    const flights = new Map();
    for (const {result} of entries) {
      for (const flight of result.flights) {
        const key = [flight.number, flight.depAirportCode, flight.arrAirportCode, flight.departureTime].join('/');
        if (!flights.has(key)) flights.set(key, flight);
      }
    }
    return {...entries.at(-1).result, flights: [...flights.values()]};
  }

  const status = () => ({refreshing, progress, retryAt, updatedAt: state.updatedAt, dates: cacheSchedule(now()).outbound});
  return {
    refresh,
    status,
    async search(query) {
      await temporary.sweep();
      const schedule = cacheSchedule(now());
      const departure = new Date(query.outDate + 'T12:00:00Z');
      const canFetch = query.cacheOnly !== true && query.outDate >= schedule.day &&
        [5, 6].includes(departure.getUTCDay()) && departure.toISOString().slice(0, 10) === query.outDate &&
        returnDate(query.outDate) === query.backDate;
      let usedOnDemand = false;
      const lookup = (from, to, date, filter) => {
        const entries = state.legs[legKey(from, to, date)];
        const hasCoverage = entries && Object.keys(entries).some(hour =>
          filter.depHour === undefined || Number(hour) <= filter.depHour);
        if (!canFetch || hasCoverage) return cachedLeg(from, to, date);
        usedOnDemand = true;
        return temporary.get(from, to, date, filter).catch(error => {
          if (entries) return cachedLeg(from, to, date);
          throw error;
        });
      };
      const results = Object.fromEntries([...new Set(query.destinations)].filter(city =>
        Object.hasOwn(originAirports, query.origin) && city !== query.origin && Object.hasOwn(destinationAirports, city))
        .map(city => [city, {city, status: 'queued'}]));
      const job = {status: 'queued', query: {...query, destinations: Object.keys(results)}, completed: 0, results};
      await runSearchBatch(job, {fetchLeg: lookup});
      const expirations = [];
      for (const item of Object.values(results)) {
        if (item.inbound && item.outbound) {
          item.collectedAt = [item.inbound.collectedAt, item.outbound.collectedAt].sort()[0];
        }
        for (const leg of [item.inbound, item.outbound]) {
          if (leg?.temporaryExpiresAt) expirations.push(leg.temporaryExpiresAt);
        }
        delete item.outbound;
        delete item.inbound;
      }
      const temporaryExpiresAt = usedOnDemand ? expirations.sort()[0] ?? nextShanghaiNoon(now()) : null;
      return {...job, cache: status(), temporaryExpiresAt};
    },
  };
}
