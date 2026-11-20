import {openFareCache} from './fare-cache.mjs';
import {destinationAirports, resolveRoundTripBooking, roundTripSearchUrl} from './live.mjs';
import {searchRail} from './railway.mjs';
import {openDatabase} from './database.mjs';
import {destinations, originAirports} from './dist/destinations.js';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('./dist/', import.meta.url));
const cacheFile = fileURLToPath(new URL('./.fare-cache/flights.json', import.meta.url));
const databaseFile = fileURLToPath(new URL('./.fare-cache/weekend.sqlite', import.meta.url));
const validTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const contentTypes = {'.html':'text/html; charset=utf-8', '.css':'text/css',
  '.js':'text/javascript', '.webp':'image/webp'};

function json(res, status, data) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
}
async function openRoundTrip(params, res) {
  const query = Object.fromEntries(params);
  const {origin, destination, outDate, backDate, outFlight, backFlight, outTime, backTime,
    depAirport, arrAirport} = query;
  if (!Object.hasOwn(originAirports, origin) || !Object.hasOwn(destinationAirports, destination) || origin === destination ||
      ![outDate, backDate].every(date => /^\d{4}-\d{2}-\d{2}$/.test(date)) || backDate < outDate) {
    return json(res, 400, {error: '往返航线或日期无效，请重新查询'});
  }
  if (![outFlight, backFlight, outTime, backTime, depAirport, arrAirport].some(value => value !== undefined)) {
    const search = roundTripSearchUrl(origin, destination, outDate, backDate);
    return res.writeHead(302, {Location: search, 'Cache-Control': 'no-store'}).end();
  }
  if (![outFlight, backFlight].every(number => /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(number)) ||
      ![outTime, backTime].every(time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) ||
      ![depAirport, arrAirport].every(code => /^[A-Z]{3}$/.test(code))) {
    return json(res, 400, {error: '航班信息不完整，请重新查询'});
  }

  const result = await resolveRoundTripBooking(query);
  if (params.get('resolve') === '1') return json(res, 200, result);
  return res.writeHead(302, {Location: result.bookingUrl || result.searchUrl, 'Cache-Control': 'no-store'}).end();
}
const railCities = Object.fromEntries(destinations.map(({city}) => [city, true]));

function validSearch(query) {
  if (!query || !Object.hasOwn(originAirports, query.origin)) return false;
  const {mode, origin, destinations: requested, outDate, backDate, earliest, returnEarliest, latest} = query;
  const allowed = mode === 'rail' ? railCities : destinationAirports;
  return (mode === undefined || mode === 'rail' || mode === 'flight') &&
    Array.isArray(requested) && requested.length > 0 && requested.length <= Object.keys(allowed).length &&
    requested.every(city => Object.hasOwn(allowed, city) && city !== origin) &&
    validDate(outDate) && validDate(backDate) && backDate >= outDate && validTime(earliest) &&
    (validTime(returnEarliest) || (mode !== 'rail' && validTime(latest))) &&
    (returnEarliest === undefined || validTime(returnEarliest)) &&
    (latest === undefined || validTime(latest));
}

export async function createWeekendServer({
  dbPath = process.env.WEEKEND_DATABASE_PATH || databaseFile,
  legacyFlightFile = cacheFile, now = () => new Date(), fetchLeg,
} = {}) {
  const database = await openDatabase(dbPath, {legacyFlightFile, now});
  let fares;
  try {
    database.seedCatalog();
    fares = await openFareCache(legacyFlightFile, {database, now, fetchLeg});
  } catch (error) {
    database.close();
    throw error;
  }

  async function search(req, res) {
    const port = req.socket.localPort;
    if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) {
      return json(res, 403, {error:'不允许来自其他网站的查询'});
    }
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 10000) return json(res, 413, {error:'请求过大'});
    }
    let query;
    try { query = JSON.parse(body); } catch { return json(res, 400, {error:'查询条件无效'}); }
    if (!validSearch(query)) return json(res, 400, {error:'查询条件无效'});
    const result = query.mode === 'rail'
      ? await searchRail(query, now(), {database, clock:now})
      : await fares.search(query);
    return json(res, 200, result);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const {pathname} = url;
      if (req.method === 'GET') {
        if (pathname === '/api/round-trip') return await openRoundTrip(url.searchParams, res);
        if (pathname === '/api/health') return json(res, 200, {
          ready:true, source:'飞猪 FlyAI', mode:'cache', storage:'sqlite',
          cache:fares.status(), adults:1, cabin:'economy', directOnly:true,
        });
        if (pathname === '/api/destinations') {
          return json(res, 200, {originAirports, destinations:database.destinations()});
        }
        const guideId = pathname.match(/^\/api\/guides\/([a-z0-9-]+)$/)?.[1];
        if (guideId) {
          const guide = database.guide(guideId);
          return guide ? json(res, 200, guide) : json(res, 404, {error:'未找到城市攻略'});
        }
      }
      if (pathname === '/api/search' && req.method === 'POST') return await search(req, res);
      if (pathname.startsWith('/api/')) return json(res, 404, {error:'接口不存在'});

      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!file.startsWith(path.resolve(root) + path.sep)) return res.writeHead(403).end();
      const data = await readFile(file);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Type', contentTypes[path.extname(file)] || 'application/octet-stream');
      res.end(data);
    } catch (error) {
      if (error.code === 'RAIL_NOT_ON_SALE') return json(res, 422, {error:error.message, code:error.code});
      if (req.url.startsWith('/api/')) {
        if (/^(?:12306|请选择周五或周六)/.test(error.message)) return json(res, 500, {error:error.message});
        console.error('接口请求失败', error);
        return json(res, 500, {error:'查询暂不可用，请稍后重试'});
      }
      res.writeHead(404).end('Not found');
    }
  });
  server.once('close', () => database.close());
  return {server, refresh:fares.refresh};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {server, refresh} = await createWeekendServer();
  const refreshFares = () => refresh().catch(error => console.error('票价缓存采集失败', error));
  server.listen(4173, '127.0.0.1', () => {
    console.log('Local: http://127.0.0.1:4173 · SQLite 票价缓存');
    void refreshFares();
    const timer = setInterval(refreshFares, 15000).unref();
    server.once('close', () => clearInterval(timer));
  });
}

