import {AIRPORT_COORDINATES} from './airport-coordinates.mjs';

const RAD = Math.PI / 180;

const airportFee = {
  amount: 50,
  effective: '2012-04-01',
  label: '财政部 · 民航发展基金',
  url: 'https://m.mof.gov.cn/zcfb/201203/t20120329_638923.htm',
};
const fuelSchedule = {
  effective: '2026-11-05',
  verifiedOn: '2026-11-18',
  thresholdKm: 800,
  short: 80,
  long: 140,
  label: '中国东方航空 · 国内燃油附加费',
  url: 'https://global.ceair.com/global/static/Announcement/AnnouncementMessage/notices/202611/t20261104_30653.html',
};

const chinaDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
export const roundMoney = amount => Math.round(amount * 100) / 100;

export function distanceKm(from, to) {
  if (from === to || !Object.hasOwn(AIRPORT_COORDINATES, from) ||
      !Object.hasOwn(AIRPORT_COORDINATES, to)) return null;
  const [lat1, lon1] = AIRPORT_COORDINATES[from].map(value => value * RAD);
  const [lat2, lon2] = AIRPORT_COORDINATES[to].map(value => value * RAD);
  const a = Math.sin((lat2 - lat1) / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function estimateDomesticFees(from, to, asOf = new Date()) {
  const assessedDate = chinaDate.format(asOf);
  const km = distanceKm(from, to);
  if (km === null || assessedDate < fuelSchedule.effective) return null;
  return {
    airport: airportFee.amount,
    fuel: km <= fuelSchedule.thresholdKm ? fuelSchedule.short : fuelSchedule.long,
    distanceKm: Math.round(km),
    band: km <= fuelSchedule.thresholdKm ? '800 公里及以内' : '超过 800 公里',
    assessedDate,
    verifiedOn: fuelSchedule.verifiedOn,
    airportSource: { label: airportFee.label, url: airportFee.url, effective: airportFee.effective },
    fuelSource: { label: fuelSchedule.label, url: fuelSchedule.url, effective: fuelSchedule.effective },
  };
}
