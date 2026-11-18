import {spaceRequestStarts} from './request-spacing.mjs';
import { estimateDomesticFees, roundMoney } from './fees.mjs';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),cli=fileURLToPath(new URL('./node_modules/@fly-ai/flyai-cli/dist/flyai-bundle.cjs',import.meta.url));
const launchSearch = spaceRequestStarts(1800);
export function friendlyError(error){const text=String(error?.stderr||error?.message||error);if(/429|rate limit|risk control|限流/i.test(text))return '飞猪体验通道请求较频繁，请稍后重新查询；其他成功报价已保留';if(/401|403|api.?key|unauthorized/i.test(text))return '飞猪体验通道要求授权，本次未取得价格';if(/timeout|timed out|ETIMEDOUT/i.test(text))return '飞猪查询超时，请稍后重试';return '飞猪暂未返回可用报价，请稍后重试或在飞猪核价'}
export const places={深圳:'SZX',上海:'SHA',北京:'BJS',广州:'CAN',杭州:'HGH',成都:'CTU',厦门:'XMN',桂林:'KWL',重庆:'CKG',海口:'HAK',昆明:'KMG',大理:'DLU',青岛:'TAO'};
const flightSearchPage = 'https://sjipiao.fliggy.com/flight_search_result.htm?';
export function searchUrl(origin, destination, date) {
  return flightSearchPage + new URLSearchParams({
    tripType: '0', depCity: places[origin], arrCity: places[destination],
    depDate: date, depCityName: origin, arrCityName: destination,
  });
}

export function roundTripSearchUrl(origin, destination, outDate, backDate) {
  return flightSearchPage + new URLSearchParams({
    tripType: '1', depCity: places[origin], arrCity: places[destination],
    depCityName: origin, arrCityName: destination, depDate: outDate, arrDate: backDate,
  });
}
export function normalizeItems(items, { origin, destination, date, url, collectedAt = new Date() }) {
  const flights = [];
  for (const item of items) {
    if (item.journeys?.length !== 1 || item.journeys[0].segments?.length !== 1) continue;
    const s = item.journeys[0].segments[0];
    if (s.depCityName !== origin || s.arrCityName !== destination || s.depDateTime?.slice(0, 10) !== date ||
        s.seatClassName !== '经济舱' || s.stopInfos?.length) continue;
    // The current FlyAI response supplies the base fare without a tax breakdown.
    const raw = item.ticketPrice ?? item.adultPrice;
    const fare = Number(String(raw ?? '').replace(/[¥￥,]/g, ''));
    if (!Number.isFinite(fare) || fare <= 0 || !s.marketingTransportNo || !s.depStationCode || !s.arrStationCode) continue;
    const d = s.depDateTime?.slice(11, 16), a = s.arrDateTime?.slice(11, 16);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(a)) continue;

    let booking = url;
    try {
      const link = new URL(item.jumpUrl);
      if (['https:', 'http:'].includes(link.protocol)) booking = link.href;
    } catch {}
    const fees = estimateDomesticFees(s.depStationCode, s.arrStationCode, collectedAt);
    const tax = fees ? fees.airport + fees.fuel : null;
    const flight = {
      number: s.marketingTransportNo,
      airline: s.marketingTransportName,
      origin, destination, date,
      departureTime: d, arrivalTime: a,
      departureAirport: s.depStationName, arrivalAirport: s.arrStationName,
      depAirportCode: s.depStationCode, arrAirportCode: s.arrStationCode,
      departureDateTime: s.depDateTime, arrivalDateTime: s.arrDateTime,
      nextDay: s.arrDateTime.slice(0, 10) !== date,
      platform: '飞猪 FlyAI', currency: 'CNY', adults: 1, cabin: 'economy', direct: true,
      fare, tax, fees, estimated: fees !== null, total: tax === null ? null : roundMoney(fare + tax),
      rawPrice: String(raw), rawFee: fees ? '按国内成人标准估算' : '税费待核实',
      url: booking, sourceUrl: url, collectedAt: collectedAt.toISOString(),
    };
    if (!flights.some(f => f.number === flight.number && f.depAirportCode === flight.depAirportCode &&
        f.arrAirportCode === flight.arrAirportCode && f.departureTime === d && f.fare === fare)) flights.push(flight);
  }
  return flights;
}
async function fetchFlights(origin, destination, date, options, timeout = 60000) {
  const args = [cli, 'search-flight', '--origin', origin, '--destination', destination,
    '--dep-date', date, '--journey-type', '1', '--seat-class-name', '经济舱', '--sort-type', '3', ...options];
  let stdout;
  try {
    ({stdout} = await launchSearch(() => exec(process.execPath, args, {
      timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    })));
  } catch (error) {
    throw Error(friendlyError(error));
  }
  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    throw Error('FlyAI 返回格式异常，未显示任何价格');
  }
  if (result.status !== 0) throw Error(friendlyError(result.message || 'FlyAI 查询失败'));
  const items = result.data?.itemList;
  if (!Array.isArray(items)) throw Error('FlyAI 未返回航班列表');
  return {items, notice: result.systemMessage || ''};
}

export async function collect(origin, destination, date, filter = {}) {
  const options = [];
  if (filter.depHour > 0) options.push('--dep-hour-start', String(filter.depHour));
  if (filter.arrHour !== undefined) options.push('--arr-hour-end', String(filter.arrHour));
  const {items, notice} = await fetchFlights(origin, destination, date, options);
  const url = searchUrl(origin, destination, date);
  return {origin, destination, date, url, platform: '飞猪 FlyAI', collectedAt: new Date().toISOString(),
    notice, flights: normalizeItems(items, {origin, destination, date, url}), parsedRows: items.length};
}

export function matchRoundTripLink(items, {origin, destination, outDate, backDate,
  outFlight, backFlight, outTime, backTime, depAirport, arrAirport}) {
  const legs = [
    [origin, destination, outFlight, outDate + ' ' + outTime, depAirport, arrAirport],
    [destination, origin, backFlight, backDate + ' ' + backTime, arrAirport, depAirport],
  ];
  for (const item of items) {
    if (item.journeys?.length !== 2) continue;
    const matches = legs.every(([from, to, number, departure, dep, arr], index) => {
      const segments = item.journeys[index]?.segments;
      if (segments?.length !== 1) return false;
      const flight = segments[0];
      return flight.depCityName === from && flight.arrCityName === to &&
        flight.marketingTransportNo === number && flight.seatClassName === '经济舱' &&
        !flight.stopInfos?.length && flight.depStationCode === dep && flight.arrStationCode === arr &&
        flight.depDateTime?.slice(0, 16) === departure;
    });
    if (!matches) continue;
    try {
      const url = new URL(item.jumpUrl);
      if (url.protocol === 'https:' && /(^|\.)(fliggy|feizhu)\.com$/.test(url.hostname)) return url.href;
    } catch {}
  }
  return null;
}

export async function roundTripBookingUrl(query, lookup = fetchFlights) {
  const {origin, destination, outDate, backDate, outFlight, backFlight} = query;
  try {
    const {items} = await lookup(origin, destination, outDate,
      ['--back-date', backDate, '--transport-no', outFlight + ',' + backFlight], 12000);
    const booking = matchRoundTripLink(items, query);
    if (booking) return booking;
  } catch {
    // The carrier pairing may be unsupported, or the quote service may be unavailable.
    // Keep the requested route and dates usable through the public round-trip search.
  }
  return roundTripSearchUrl(origin, destination, outDate, backDate);
}

const mins=t=>{const [h,m]=t.split(':').map(Number);return h*60+m};
export function combine(out, back, earliest, latest = '23:59', returnEarliest) {
  const outbound = out.flights.filter(f => mins(f.departureTime) >= mins(earliest));
  const inbound = back.flights.filter(f => !f.nextDay && mins(f.arrivalTime) <= mins(latest) &&
    (!returnEarliest || mins(f.departureTime) >= mins(returnEarliest)));
  const pairs = [];
  for (const a of outbound) {
    for (const b of inbound) {
      if (a.depAirportCode !== b.arrAirportCode || a.arrAirportCode !== b.depAirportCode) continue;
      const total = Number.isFinite(a.total) && Number.isFinite(b.total) ? roundMoney(a.total + b.total) : null;
      pairs.push({
        outbound: a, inbound: b,
        fare: roundMoney(a.fare + b.fare),
        total,
        estimated: Boolean(a.estimated || b.estimated),
      });
    }
  }
  pairs.sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity) || a.fare - b.fare);
  return { best: pairs[0] || null, options: pairs.slice(0, 8), matchingCount: pairs.length };
}
