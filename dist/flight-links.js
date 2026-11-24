import {destinations, originAirports} from './destinations.js';

export const destinationAirports = Object.fromEntries(destinations.filter(city => city.airport).map(city => [city.city, city.airport]));
export const places = {...originAirports, ...destinationAirports};
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

export function fliggyBookingLinks(origin, destination, outDate, backDate, {userAgent = '', platform = '', maxTouchPoints = 0} = {}) {
  const android = /Android/i.test(userAgent);
  const ios = /iPhone|iPad|iPod/i.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
  if (!android && !ios) return {web:roundTripSearchUrl(origin, destination, outDate, backDate)};

  const page = 'https://market.m.taobao.com/app/trip/rx-flight-eco/pages/roundtrip';
  const web = `${page}?${new URLSearchParams({searchType:'4', tripType:'2',
    depCityCode:places[origin], depCityName:origin, arrCityCode:places[destination], arrCityName:destination,
    leaveDate:outDate, backDate, containChild:'0', containInfant:'0'})}`;
  if (/MicroMessenger/i.test(userAgent)) return {web};

  const params = encodeURIComponent(JSON.stringify({naviType:0, animeType:-1, url:web}));
  const app = android
    ? `intent://smartbanner?params=${params}#Intent;scheme=taobaotravel;package=com.taobao.trip;S.browser_fallback_url=${encodeURIComponent(web)};end`
    : `taobaotravel://smartbanner?params=${params}`;
  return {web, app};
}
