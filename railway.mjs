import {spaceRequestStarts} from './request-spacing.mjs';
import {returnDate} from './dist/engine.js';
import {keepWeekendOptions, returnBefore} from './dist/weekend-window.js';
import {openDatabase} from './database.mjs';

const base = 'https://kyfw.12306.cn';
const init = base + '/otn/leftTicket/init';
const spacing = spaceRequestStarts(350);
const time = /^([01]\d|2[0-3]):[0-5]\d$/;
const shanghaiDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit'});
let retryAt = 0;
let session;
let sessionPending;
let memoryDatabase;
const pendingByDatabase = new WeakMap();
const railTtl = 120000;

export function parseStations(text) {
  const cities = {}, stations = {};
  for (const match of text.matchAll(/@([^@']+)/g)) {
    const [, name, code, , , , group, city] = match[1].split('|');
    if (!/^[A-Z]{3}$/.test(code ?? '')) continue;
    stations[code] = name;
    if (city && name === city && /^\d+$/.test(group)) cities[city] = code;
    // A matching station name is still useful in cities without a separate city code.
    cities[name] ??= code;
  }
  if (cities.西双版纳 === undefined && cities.景洪) cities.西双版纳 = cities.景洪;
  return {cities, stations};
}

export function parseRailLegs(rows, stations, date) {
  const trains = [];
  for (const row of rows) {
    if (typeof row !== 'string') continue;
    const p = row.split('|');
    const [number, departureTime, arrivalTime, duration] = [p[3],p[8],p[9],p[10]];
    if (!/^[GDC]\d{1,5}$/.test(number ?? '') || !time.test(departureTime) || !time.test(arrivalTime) ||
        !/^\d{2}:[0-5]\d$/.test(duration) || p[11] !== 'Y' || !/^(有|[1-9]\d*)$/.test(p[30] ?? '')) continue;
    // 12306 uses 10 characters per price: seat code, price in tenths, inventory flags.
    // The 3 flag is for standing tickets, which are not a second-class seat.
    const entries = (p[39] ?? '').match(/.{10}/g) ?? [];
    const price = entries.find(entry => /^O\d{9}$/.test(entry) && entry[6] !== '3');
    const fare = price ? Number(price.slice(1, 6)) / 10 : 0;
    if (fare <= 0 || !stations[p[6]] || !stations[p[7]]) continue;
    const minutes = v => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
    trains.push({number, date, departureTime, arrivalTime, nextDay: minutes(departureTime) + minutes(duration) >= 1440,
      departureAirport: stations[p[6]], arrivalAirport: stations[p[7]],
      depStationCode:p[6], arrStationCode:p[7], fare, total: fare, seats: p[30]});
  }
  return trains;
}

export function railPlans(outbound, inbound, {earliest, returnEarliest, latest}) {
  const going = outbound.filter(trip => trip.departureTime >= earliest);
  const returning = inbound.filter(trip => trip.departureTime >= returnEarliest &&
    !trip.nextDay && returnBefore(trip, latest));
  const options = going.flatMap(out => returning.map(back => ({outbound:out, inbound:back,
    total:Math.round((out.fare + back.fare)*100)/100})))
    .sort((a,b) => a.total-b.total || a.outbound.departureTime.localeCompare(b.outbound.departureTime));
  return keepWeekendOptions(options, 6, 'rail');
}

function waitError() { return Error('12306 暂时无法返回报价，请稍后重试或到官网查询。'); }
async function getSession() {
  if (session?.expires > Date.now()) return session;
  if (!sessionPending) sessionPending = (async () => {
    const options = {signal: AbortSignal.timeout(9000)};
    const [page, stationFile] = await Promise.all([fetch(init, options),
      fetch(base + '/otn/resources/js/framework/station_name.js', options)]);
    if (!page.ok || !stationFile.ok) throw waitError();
    const cookie = page.headers.getSetCookie().map(header => header.split(';', 1)[0]).join('; ');
    const endpoint = (await page.text()).match(/CLeftTicketUrl\s*=\s*['"](leftTicket\/query[A-Z]?)['"]/)?.[1];
    const {cities, stations} = parseStations(await stationFile.text());
    if (!endpoint || !Object.keys(cities).length) throw waitError();
    return session = {cookie, endpoint, cities, stations, expires: Date.now()+15*60000};
  })().finally(() => { sessionPending = null; });
  return sessionPending;
}

async function fetchRailTrains(context, from, to, date) {
  if (retryAt > Date.now()) throw waitError();
  const params = new URLSearchParams({'leftTicketDTO.train_date':date, 'leftTicketDTO.from_station':from,
    'leftTicketDTO.to_station':to, purpose_codes:'ADULT'});
  try {
    const res = await fetch(`${base}/otn/${context.endpoint}?${params}`, {signal:AbortSignal.timeout(7500),
      headers:{accept:'application/json, text/javascript, */*; q=0.01', referer:init,
        'x-requested-with':'XMLHttpRequest', cookie:context.cookie}});
    if (!res.ok || !res.headers.get('content-type')?.match(/json|plain/i)) throw waitError();
    const payload = await res.json();
    if (payload.status !== true || !Array.isArray(payload.data?.result)) throw waitError();
    return parseRailLegs(payload.data.result, {...context.stations, ...payload.data.map}, date);
  } catch {
    retryAt = Date.now() + 60000;
    throw waitError();
  }
}

async function getLeg(store, fetchContext, fetchRailLeg, clock, from, to, date) {
  const leg = {mode:'rail', scope:'temporary', from, to, date};
  const cached = store.getLeg(leg, clock().toISOString());
  if (cached) return cached;
  if (retryAt > Date.now()) throw waitError();
  if (!pendingByDatabase.has(store)) pendingByDatabase.set(store, new Map());
  const pending = pendingByDatabase.get(store);
  const key = JSON.stringify(leg);
  if (!pending.has(key)) {
    const request = spacing(async () => {
      const trains = await fetchRailLeg(await fetchContext(), from, to, date);
      const at = clock();
      const expiresAt = new Date(at.getTime() + railTtl).toISOString();
      const result = {trains, collectedAt:at.toISOString(), expiresAt};
      store.saveLeg(leg, result, expiresAt);
      return result;
    }).finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return pending.get(key);
}

export async function searchRail(query, now = new Date(), {
  database, clock = () => new Date(), getRailSession = getSession, fetchRailLeg = fetchRailTrains,
} = {}) {
  const today = shanghaiDate.format(now);
  const last = new Date(Date.parse(today + 'T00:00:00Z') + 14 * 86400000).toISOString().slice(0,10);
  const departure = new Date(query.outDate + 'T00:00:00Z');
  if (![5,6].includes(departure.getUTCDay()) || departure.toISOString().slice(0,10) !== query.outDate ||
      returnDate(query.outDate) !== query.backDate || query.outDate < today) {
    throw Error('请选择周五或周六出发、同一周日返程的日期。');
  }
  if (query.backDate > last) {
    throw Object.assign(Error('返程还未到铁路 12306 的预售期，暂时无法查询往返报价。'),
      {code:'RAIL_NOT_ON_SALE'});
  }
  const results = Object.fromEntries([...new Set(query.destinations)].map(city => [city,{city}]));
  const store = database ?? await (memoryDatabase ??= openDatabase(':memory:'));
  store.sweepExpired(clock().toISOString());
  let sessionRequest;
  const fetchContext = () => (sessionRequest ??= (async () => {
    const context = await getRailSession();
    store.saveRailDirectory(context);
    return context;
  })());
  let directory;
  try { directory = store.railDirectory() ?? await fetchContext(); } catch { throw waitError(); }
  const from = directory.cities[query.origin];
  if (!from) throw Error('12306 站点列表没有匹配到出发城市。');
  const cities = Object.keys(results);
  let index = 0;
  async function worker() {
    while (index < cities.length) {
      const city = cities[index++], result = results[city], to = directory.cities[city];
      if (to) {
        // The official page decodes the URL with decodeURI, then splits on literal commas.
        result.searchUrl = `${init}?linktypeid=wf&fs=${encodeURIComponent(query.origin)},${from}` +
          `&ts=${encodeURIComponent(directory.stations[to])},${to}&date=${query.outDate},${query.backDate}&flag=N,Y,N`;
      }
      if (!to || to === from) {
        Object.assign(result, {status:'no_match', message:'未匹配到目的地的 12306 站点'});
        continue;
      }
      try {
        const out = await getLeg(store, fetchContext, fetchRailLeg, clock, from, to, query.outDate);
        if (!out.trains.some(train => train.departureTime >= query.earliest)) {
          Object.assign(result, {status:'no_match', message:'去程没有符合时间且有二等座报价的直达车次'});
          continue;
        }
        const back = await getLeg(store, fetchContext, fetchRailLeg, clock, to, from, query.backDate);
        const options = railPlans(out.trains, back.trains, query);
        Object.assign(result, {status:options.length ? 'success' : 'no_match', options,
          collectedAt:[out.collectedAt, back.collectedAt].sort()[0],
          expiresAt:[out.expiresAt, back.expiresAt].sort()[0],
          message:options.length ? '' : '返程没有符合时间、周日到达且有二等座报价的直达车次'});
      } catch (error) {
        Object.assign(result, {status:'error', message:error.message});
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(4, cities.length)}, worker));
  return {status:'complete', query, results};
}
