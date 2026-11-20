import {minutes} from './engine.js';

const dayMinutes = 24 * 60;
const dayMs = dayMinutes * 60_000;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const airportTransfers = {
  CAN: 60, CTU: 50, TFU: 90, PKX: 85, PEK: 60, PVG: 75, SHA: 40,
  TAO: 80, HAK: 45, XMN: 35, KWL: 65, JZH: 120, LXA: 75,
  LJG: 55, ZUH: 75, NKG: 65, FOC: 75, YTY: 65,
  ENH: 30, KHG: 35, DNH: 30,
  DIG: 30, HSN: 45, WUH: 65, CZX: 55, WUX: 45,
};
const stationTransfers = {
  厦门北: 55, 厦门: 20, 杭州西: 55, 青岛北: 45, 苏州北: 45,
  黄龙九寨: 135, 黄山北: 40, 张家界西: 35, 桂林西: 45, 敦煌: 30,
};

function transfer(leg, stationSide, mode) {
  if (mode === 'rail') {
    return stationTransfers[leg[stationSide + 'Airport']?.replace(/站$/, '')] ?? 35;
  }
  const code = stationSide === 'arrival' ? leg.arrAirportCode : leg.depAirportCode;
  return airportTransfers[code] ?? 60;
}

// Times are local to mainland China. UTC arithmetic here keeps dates independent of the device timezone.
export function weekendWindow(plan, mode) {
  const {outbound, inbound} = plan;
  if (![outbound.arrivalTime, inbound.departureTime].every(time => timePattern.test(time))) return null;
  const sunday = Date.parse(inbound.date + 'T00:00:00Z');
  const departureDay = Date.parse(outbound.date + 'T00:00:00Z');
  const daysBeforeSunday = (sunday - departureDay) / dayMs;
  if (new Date(sunday).getUTCDay() !== 0 || ![1, 2].includes(daysBeforeSunday)) return null;

  const arrivalTransfer = transfer(outbound, 'arrival', mode);
  const returnTransfer = transfer(inbound, 'departure', mode);
  const exitBuffer = mode === 'rail' ? 15 : 35;
  const departureBuffer = mode === 'rail' ? 45 : 120;
  const arrivalInTown = (1 - daysBeforeSunday + Number(Boolean(outbound.nextDay))) * dayMinutes
    + minutes(outbound.arrivalTime) + exitBuffer + arrivalTransfer;
  const leaveForReturn = dayMinutes + minutes(inbound.departureTime) - returnTransfer - departureBuffer;
  const luggageBuffer = 20;
  const lastStopEnd = leaveForReturn - luggageBuffer;
  const days = [0, dayMinutes].map(offset => {
    const start = Math.max(offset + 9 * 60, arrivalInTown);
    const end = Math.min(offset + 21 * 60, lastStopEnd);
    return {start: start - offset, end: end - offset, usableMinutes: Math.max(0, end - start)};
  });

  return {
    days, arrivalInTown, leaveForReturn, lastStopEnd, arrivalTransfer, returnTransfer,
    exitBuffer, departureBuffer, luggageBuffer,
    usableMinutes: days[0].usableMinutes + days[1].usableMinutes,
  };
}

export function returnBefore(inbound, latest) {
  return !latest || (!inbound.nextDay && timePattern.test(inbound.arrivalTime) &&
    inbound.arrivalTime <= latest);
}

export function fitGuideDay(day, index, window, shortStop) {
  if (!window) return day;
  const lateArrival = index === 0 && window.start >= 11 * 60 + 30;
  const earlyReturn = index === 1 && window.end < 16 * 60;
  if (!lateArrival && !earlyReturn && window.usableMinutes > 0) return day;
  if (window.usableMinutes < 90) {
    return index === 0
      ? {title: '抵达与入住', stops: [], tip: '先办理入住，晚餐就近安排。'}
      : {title: '整理行李与返程', stops: [], tip: '早餐可在住宿附近解决，取好行李后直接去机场或车站。'};
  }
  if (index === 0) {
    const evening = window.start >= 16 * 60;
    return {
      title: evening ? '傍晚短线' : '午后短线',
      stops: [shortStop],
      tip: '安顿好行李后只逛这一带，晚餐就近安排。若换乘或入住比预计慢，可直接在住处附近吃饭。',
    };
  }
  return {
    title: '返程前半日短线',
    stops: [window.usableMinutes >= 150 ? shortStop : '住宿附近街区'],
    tip: '早餐后就近走一段。出门前安排好退房和取行李，按上方时间出发去机场或车站。',
  };
}

// Alongside the cheapest options, retain each improvement in usable time at a higher price.
export function keepWeekendOptions(sortedPlans, priceOptions, mode) {
  let longest = -1;
  return sortedPlans.filter((plan, index) => {
    const usable = Number.isFinite(plan.total) ? weekendWindow(plan, mode)?.usableMinutes ?? -1 : -1;
    const improves = usable > longest;
    if (improves) longest = usable;
    return index < priceOptions || improves;
  });
}
