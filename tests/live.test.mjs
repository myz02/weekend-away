import {test} from 'node:test';import assert from 'node:assert/strict';import {normalizeItems,combine,friendlyError} from '../live.mjs';
import {plansWithinBudget} from '../dist/budget.js';
import {estimateDomesticFees} from '../fees.mjs';
import {matchRoundTripLink, roundTripBookingUrl, roundTripSearchUrl} from '../live.mjs';
test('限流错误不向产品界面泄露命令及本机路径',()=>{const text=friendlyError({stderr:'MCP HTTP 429: rate limit exceeded',message:'Command failed C:/Users/private/run'});assert.match(text,/较频繁/);assert.doesNotMatch(text,/C:|Command|MCP/)});
const item=(overrides={})=>({ticketPrice:'500',jumpUrl:'https://example.com/',journeys:[{segments:[{depCityName:'深圳',arrCityName:'重庆',depStationName:'宝安国际机场',arrStationName:'江北国际机场',depStationCode:'SZX',arrStationCode:'CKG',depDateTime:'2026-11-20 20:00:00',arrDateTime:'2026-11-20 22:00:00',seatClassName:'经济舱',marketingTransportNo:'CA1234',...overrides}]}]});
test('官方结构化结果必须匹配航线日期，缺少机场坐标时总价未知', () => {
  const context = {
    origin: '深圳', destination: '重庆', date: '2026-11-20', url: 'https://example.com',
    collectedAt: new Date('2026-11-18T04:00:00Z'),
  };
  const flights = normalizeItems([
    item(), item(), item({depCityName:'北京'}),
    item({depDateTime:'2026-11-21 20:00:00'}),
    item({arrStationCode:'XXX'}),
  ], context);
  assert.equal(flights.length, 2);
  assert.equal(flights[0].fare, 500);
  assert.equal(flights[0].total, 690);
  assert.equal(flights[0].estimated, true);
  assert.equal(flights[1].total, null);
  assert.equal(flights[1].tax, null);
});
test('往返组合核对精确时间与机场，排除周一到达的返程',()=>{const a={departureTime:'19:30',arrivalTime:'21:30',depAirportCode:'SZX',arrAirportCode:'CKG',fare:500,total:null,nextDay:false};const b={...a,departureTime:'18:00',arrivalTime:'20:00',depAirportCode:'CKG',arrAirportCode:'SZX',fare:600};assert.equal(combine({flights:[a]},{flights:[b]},'19:00','22:00').best.fare,1100);assert.equal(combine({flights:[a]},{flights:[{...b,nextDay:true}]},'19:00','22:00').best,null);assert.equal(combine({flights:[a]},{flights:[{...b,arrAirportCode:'CAN'}]},'19:00','22:00').best,null);assert.equal(combine({flights:[a]},{flights:[b]},'20:00','22:00').best,null)});

test('燃油附加费以北京时间出票日期及航段机场距离选档', () => {
  assert.equal(estimateDomesticFees('SZX', 'HAK', new Date('2026-11-04T15:59:59Z')), null);
  const cutoff = new Date('2026-11-04T16:00:00Z');
  const short = estimateDomesticFees('SZX', 'HAK', cutoff);
  const long = estimateDomesticFees('CKG', 'SZX', cutoff);
  assert.equal(short.assessedDate, '2026-11-05');
  assert.equal(short.airport, 50);
  assert.equal(short.fuel, 80);
  assert.equal(long.fuel, 140);
});

test('往返预算包含两段费用，接受刚好等于预算的方案', () => {
  const flight = {departureTime:'19:30', arrivalTime:'21:00', depAirportCode:'SZX',
    arrAirportCode:'HAK', fare:260, total:390, estimated:true};
  const back = {...flight, depAirportCode:'HAK', arrAirportCode:'SZX', fare:410, total:540};
  const result = combine({flights:[flight]}, {flights:[back, {...back, fare:420, total:550},
    {...back, total:null}]}, '19:00', '22:00');
  assert.equal(result.best.estimated, true);
  assert.equal(result.best.fare, 670);
  assert.equal(result.best.total, 930);
  assert.deepEqual(plansWithinBudget(result, 929), []);
  assert.deepEqual(plansWithinBudget(result, 930).map(plan => plan.total), [930]);
  assert.deepEqual(plansWithinBudget(result, 2000).map(plan => plan.total), [930, 940]);
});

test('去程与返程按起飞分钟筛选，接受恰好达到时间的航班', () => {
  const out = {departureTime:'21:00', arrivalTime:'22:00', depAirportCode:'SZX',
    arrAirportCode:'HAK', fare:260, total:390};
  const back = {...out, departureTime:'18:00', arrivalTime:'22:30', depAirportCode:'HAK', arrAirportCode:'SZX'};
  const result = combine(
    {flights:[{...out, departureTime:'20:59'}, out]},
    {flights:[{...back, departureTime:'17:59'}, back, {...back, nextDay:true}]},
    '21:00', undefined, '18:00',
  );
  assert.equal(result.matchingCount, 1);
  assert.equal(result.best.outbound, out);
  assert.equal(result.best.inbound, back);
});

test('飞猪往返入口带入当前航线和去返日期', () => {
  const url = new URL(roundTripSearchUrl('深圳', '厦门', '2026-11-27', '2026-11-29'));
  assert.equal(url.origin, 'https://sjipiao.fliggy.com');
  assert.equal(url.pathname, '/flight_search_result.htm');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    tripType: '1', depCity: 'SZX', arrCity: 'XMN', depCityName: '深圳', arrCityName: '厦门',
    depDate: '2026-11-27', arrDate: '2026-11-29',
  });
});

test('套餐入口仅使用两段航班均匹配的飞猪官方链接', async () => {
  const query = {
    origin: '深圳', destination: '重庆', outDate: '2026-11-20', backDate: '2026-11-22',
    outFlight: 'CA1234', backFlight: 'CA4321', outTime: '20:00', backTime: '18:00',
    depAirport: 'SZX', arrAirport: 'CKG',
  };
  const [outbound] = item().journeys;
  const [inbound] = item({
    depCityName: '重庆', arrCityName: '深圳', depStationCode: 'CKG', arrStationCode: 'SZX',
    depDateTime: '2026-11-22 18:00:00', marketingTransportNo: 'CA4321',
  }).journeys;
  const officialUrl = 'https://router.feizhu.com/ws/example';
  const matching = {journeys: [outbound, inbound], jumpUrl: officialUrl};
  assert.equal(matchRoundTripLink([{...matching, journeys: [outbound]}], query), null);
  assert.equal(matchRoundTripLink([matching], {...query, backFlight: 'CA4000'}), null);
  assert.equal(matchRoundTripLink([matching], {...query, arrAirport: 'CAN'}), null);
  assert.equal(matchRoundTripLink([matching], {...query, backTime: '18:01'}), null);
  assert.equal(matchRoundTripLink([{...matching, jumpUrl: 'https://fliggy.com.example.org/'}], query), null);
  assert.equal(matchRoundTripLink([matching], query), officialUrl);
  assert.equal(await roundTripBookingUrl(query, async (_origin, _destination, _date, options) => {
    assert.deepEqual(options, ['--back-date', query.backDate, '--transport-no', query.outFlight + ',' + query.backFlight]);
    return {items: [matching]};
  }), officialUrl);
  assert.equal(await roundTripBookingUrl(query, async (_origin, _destination, _date, options) => ({
    items: options.includes('--transport-no') ? [] : [matching],
  })), officialUrl);
});

test('飞猪报价异常或缺少所选组合时仍打开同线路同日期的往返搜索', async () => {
  const query = {
    origin: '深圳', destination: '海口', outDate: '2026-11-27', backDate: '2026-11-29',
    outFlight: 'DZ6261', backFlight: 'CZ6793', outTime: '23:40', backTime: '21:00',
    depAirport: 'SZX', arrAirport: 'HAK',
  };
  const search = roundTripSearchUrl(query.origin, query.destination, query.outDate, query.backDate);
  assert.equal(await roundTripBookingUrl(query, async () => ({items: []})), search);
  assert.equal(await roundTripBookingUrl(query, async () => { throw Error('搜索机票行业失败'); }), search);
});
