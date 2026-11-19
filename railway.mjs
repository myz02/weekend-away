import {spaceRequestStarts} from './request-spacing.mjs';
import {returnDate} from './dist/engine.js';

const base = 'https://kyfw.12306.cn';
const init = base + '/otn/leftTicket/init';
const spacing = spaceRequestStarts(350);
const time = /^([01]\d|2[0-3]):[0-5]\d$/;
const shanghaiDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit'});
let retryAt = 0;
let session;
let sessionPending;
const cache = new Map();
const pending = new Map();

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
      departureAirport: stations[p[6]], arrivalAirport: stations[p[7]], fare, total: fare, seats: p[30]});
  }
  return trains;
}

export function railPlans(outbound, inbound, {earliest, returnEarliest}) {
  const cheapest = (trains, predicate) => trains.filter(predicate).sort((a,b) => a.fare - b.fare || a.departureTime.localeCompare(b.departureTime)).slice(0, 6);
  const going = cheapest(outbound, trip => trip.departureTime >= earliest);
  const returning = cheapest(inbound, trip => trip.departureTime >= returnEarliest && !trip.nextDay);
  return going.flatMap(out => returning.map(back => ({outbound:out, inbound:back,
    total:Math.round((out.fare + back.fare)*100)/100})))
    .sort((a,b) => a.total-b.total || a.outbound.departureTime.localeCompare(b.outbound.departureTime)).slice(0, 6);
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

async function getLeg(context, from, to, date) {
  const key = `${from}:${to}:${date}`;
  const entry = cache.get(key);
  if (entry?.expires > Date.now()) return entry;
  if (retryAt > Date.now()) throw waitError();
  if (!pending.has(key)) pending.set(key, spacing(async () => {
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
      const value = {trains:parseRailLegs(payload.data.result, {...context.stations, ...payload.data.map}, date),
        collectedAt:new Date().toISOString(), expires:Date.now()+120000};
      if (cache.size >= 512) cache.delete(cache.keys().next().value);
      cache.set(key, value);
      return value;
    } catch {
      retryAt = Date.now() + 60000;
      throw waitError();
    }
  }).finally(() => pending.delete(key)));
  return pending.get(key);
}

export async function searchRail(query, now = new Date()) {
  const today = shanghaiDate.format(now);
  const last = new Date(Date.parse(today + 'T00:00:00Z') + 14 * 86400000).toISOString().slice(0,10);
  const departure = new Date(query.outDate + 'T00:00:00Z');
  if (![5,6].includes(departure.getUTCDay()) || departure.toISOString().slice(0,10) !== query.outDate ||
      returnDate(query.outDate) !== query.backDate || query.outDate < today) {
    throw Error('请选择周五或周六出发、同一周日返程的日期。');
  }
  if (query.backDate > last) throw Error('返程还未到铁路 12306 的预售期，暂时无法查询往返报价。');
  const results = Object.fromEntries([...new Set(query.destinations)].map(city => [city,{city}]));
  let context;
  try { context = await getSession(); } catch { throw waitError(); }
  const from = context.cities[query.origin];
  if (!from) throw Error('12306 站点列表没有匹配到出发城市。');
  const cities = Object.keys(results);
  let index = 0;
  async function worker() {
    while (index < cities.length) {
      const city = cities[index++], result = results[city], to = context.cities[city];
      if (to) {
        // The official page decodes the URL with decodeURI, then splits on literal commas.
        result.searchUrl = `${init}?linktypeid=wf&fs=${encodeURIComponent(query.origin)},${from}` +
          `&ts=${encodeURIComponent(context.stations[to])},${to}&date=${query.outDate},${query.backDate}&flag=N,Y,N`;
      }
      if (!to || to === from) {
        Object.assign(result, {status:'no_match', message:'未匹配到目的地的 12306 站点'});
        continue;
      }
      try {
        const out = await getLeg(context, from, to, query.outDate);
        if (!out.trains.some(train => train.departureTime >= query.earliest)) {
          Object.assign(result, {status:'no_match', message:'去程没有符合时间且有二等座报价的直达车次'});
          continue;
        }
        const back = await getLeg(context, to, from, query.backDate);
        const options = railPlans(out.trains, back.trains, query);
        Object.assign(result, {status:options.length ? 'success' : 'no_match', options,
          collectedAt:[out.collectedAt, back.collectedAt].sort()[0],
          message:options.length ? '' : '返程没有符合时间、周日到达且有二等座报价的直达车次'});
      } catch (error) {
        Object.assign(result, {status:'error', message:error.message});
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(4, cities.length)}, worker));
  return {status:'complete', query, results};
}
