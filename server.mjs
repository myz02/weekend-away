import {openFareCache} from './fare-cache.mjs';
import {destinationAirports, resolveRoundTripBooking, roundTripSearchUrl} from './live.mjs';
import {searchRail} from './railway.mjs';
import {destinations, originAirports} from './dist/destinations.js';
import http from 'node:http';import {readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import path from 'node:path';
const root=path.resolve(fileURLToPath(new URL('./dist/',import.meta.url)));
const validTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
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
const cacheFile = fileURLToPath(new URL('./.fare-cache/flights.json', import.meta.url));
const fares = await openFareCache(cacheFile);
const refreshFares = () => fares.refresh().catch(error => console.error('票价缓存采集失败', error));
http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://127.0.0.1:4173');if(u.pathname==='/api/round-trip'&&req.method==='GET')return await openRoundTrip(u.searchParams,res);if(u.pathname==='/api/health')return json(res,200,{ready:true,source:'飞猪 FlyAI',mode:'cache',cache:fares.status(),adults:1,cabin:'economy',directOnly:true});if(u.pathname==='/api/search'&&req.method==='POST'){if(req.headers.origin&&!['http://127.0.0.1:4173','http://localhost:4173'].includes(req.headers.origin))return json(res,403,{error:'不允许来自其他网站的查询'});let body='';for await(const chunk of req){body+=chunk;if(body.length>10000)return json(res,413,{error:'请求过大'})}const q=JSON.parse(body);const railway=q.mode==='rail';const allowed=railway?railCities:destinationAirports;if(!Object.hasOwn(originAirports,q.origin)||!Array.isArray(q.destinations)||q.destinations.length>Object.keys(allowed).length||!q.destinations.length||q.destinations.some(c=>!Object.hasOwn(allowed,c)||c===q.origin)||!/^\d{4}-\d{2}-\d{2}$/.test(q.outDate)||!/^\d{4}-\d{2}-\d{2}$/.test(q.backDate)||q.backDate<q.outDate||!/^([01]\d|2[0-3]):[0-5]\d$/.test(q.earliest)||!(validTime(q.returnEarliest)||(!railway&&validTime(q.latest)))||(q.returnEarliest!==undefined&&!validTime(q.returnEarliest))||(q.latest!==undefined&&!validTime(q.latest)))return json(res,400,{error:'查询条件无效'});return json(res,200,railway?await searchRail(q):await fares.search(q))}const file=path.resolve(root,'.'+(u.pathname==='/'?'/index.html':decodeURIComponent(u.pathname)));if(!file.startsWith(root+path.sep))return res.writeHead(403).end();const data=await readFile(file);res.setHeader('Cache-Control','no-cache');res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(data)}catch(e){if(req.url.startsWith('/api/'))json(res,500,{error:e.message});else res.writeHead(404).end('Not found')}}).listen(4173,'127.0.0.1',() => {
  console.log('Local: http://127.0.0.1:4173 · 飞猪票价缓存');
  void refreshFares();
  setInterval(refreshFares, 15000).unref();
});

