import {chromium} from 'playwright';
import {places} from './dist/flight-links.js';
import {estimateDomesticFees, roundMoney} from './fees.mjs';
import {spaceRequestStarts} from './request-spacing.mjs';

const startSearch = spaceRequestStarts(1100);
const validDateTime = /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/;
let browserPromise;
let retryAt = 0;

function browser() {
  return browserPromise ??= chromium.launch({executablePath:process.env.WEEKEND_CHROMIUM_EXECUTABLE}).then(instance => {
    instance.once('disconnected', () => { browserPromise = undefined; });
    return instance;
  }).catch(error => { browserPromise = undefined; throw error; });
}

function limited() {
  return Object.assign(Error('同程查询受限，请稍后重试'), {code:'TONGCHENG_RATE_LIMIT'});
}

export function tongchengUrl(origin, destination, date) {
  return `https://www.ly.com/flights/itinerary/oneway/${places[origin]}-${places[destination]}?date=${date}`;
}

export function tongchengFlights(state, {origin, destination, date, url, collectedAt}) {
  const {Departure, Arrival, DepartureDate, flightLists} = state ?? {};
  if (Departure !== places[origin] || Arrival !== places[destination] || DepartureDate !== date || !Array.isArray(flightLists)) {
    throw Error('同程未返回可核对的航线和日期');
  }
  return flightLists.flatMap(row => {
    const {flyOffTime, arrivalTime, originAirportCode, arriveAirportCode, flightNo, lecp} = row;
    if (row.stopNum !== 0 || row.hasmt || row.departureCityCode !== Departure || row.arrivalCityCode !== Arrival ||
        !validDateTime.test(flyOffTime) || flyOffTime.slice(0, 10) !== date || !validDateTime.test(arrivalTime) ||
        !/^[A-Z0-9]{2,3}\d{2,4}[A-Z]?$/.test(flightNo) || !/^[A-Z]{3}$/.test(originAirportCode) ||
        !/^[A-Z]{3}$/.test(arriveAirportCode) || !Number.isFinite(lecp) || lecp <= 0 || lecp !== row.flightPrice) return [];
    const fees = estimateDomesticFees(originAirportCode, arriveAirportCode, collectedAt);
    const tax = fees ? fees.airport + fees.fuel : null;
    return [{number:flightNo, airline:row.airCompanyName, origin, destination, date,
      departureTime:flyOffTime.slice(11, 16), arrivalTime:arrivalTime.slice(11, 16),
      departureDateTime:flyOffTime, arrivalDateTime:arrivalTime, nextDay:arrivalTime.slice(0, 10) !== date,
      depAirportCode:originAirportCode, arrAirportCode:arriveAirportCode,
      departureAirport:row.originAirportShortName, arrivalAirport:row.arriveAirportShortName,
      platform:'同程旅行', direct:true, currency:'CNY', adults:1, cabin:'economy', fare:lecp, tax, fees,
      total:tax === null ? null : roundMoney(lecp + tax), estimated:fees !== null, url, sourceUrl:url,
      collectedAt:collectedAt.toISOString(), rawFee:fees ? '按国内成人标准估算' : '税费待核实'}];
  });
}

export async function collectTongcheng(origin, destination, date) {
  if (retryAt > Date.now()) throw limited();
  return startSearch(async () => {
    if (retryAt > Date.now()) throw limited();
    const url = tongchengUrl(origin, destination, date);
    let page;
    try {
      page = await (await browser()).newPage({locale:'zh-CN', timezoneId:'Asia/Shanghai'});
      const response = await page.goto(url, {waitUntil:'domcontentloaded', timeout:10000});
      const blocked = async () => [403, 429].includes(response?.status()) ||
        /请完成安全验证|访问过于频繁|请完成验证码/.test(await page.locator('body').innerText({timeout:1000}).catch(() => ''));
      if (await blocked()) {
        retryAt = Date.now() + 60000;
        throw limited();
      }
      await page.waitForFunction(() => Array.isArray(window.__NUXT__?.state?.book1?.flightLists), null, {timeout:4000});
      const more = page.getByText('加载剩余航班数据', {exact:true});
      if (await more.isVisible()) {
        const initialCount = await page.evaluate(() => window.__NUXT__.state.book1.flightLists.length);
        // Hydration can replace the control after loading the rest of the results itself.
        await more.click({timeout:2500}).catch(() => {});
        await Promise.race([
          page.waitForFunction(count => window.__NUXT__.state.book1.flightLists.length > count, initialCount, {timeout:10000}),
          more.waitFor({state:'hidden', timeout:10000}),
        ]);
      }
      const state = await page.evaluate(() => window.__NUXT__.state.book1);
      const collectedAt = new Date();
      return {origin, destination, date, url, platform:'同程旅行', collectedAt:collectedAt.toISOString(),
        flights:tongchengFlights(state, {origin, destination, date, url, collectedAt})};
    } catch (error) {
      if (error.code === 'TONGCHENG_RATE_LIMIT') throw error;
      throw Error('同程暂未返回可核对的报价', {cause:error});
    } finally {
      await page?.close();
    }
  });
}
