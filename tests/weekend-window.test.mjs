import test from 'node:test';
import assert from 'node:assert/strict';
import {fitGuideDay, keepWeekendOptions, returnBefore, weekendWindow} from '../dist/weekend-window.js';
import {railPlans} from '../railway.mjs';

const plan = {
  total: 1000,
  outbound: {date: '2026-11-28', arrivalTime: '10:00', arrAirportCode: 'XMN'},
  inbound: {date: '2026-11-29', departureTime: '18:00', arrivalTime: '19:30', depAirportCode: 'XMN'},
};

test('可玩时间扣除到市区、返程接驳、提前到场和取行李时间', () => {
  const timing = weekendWindow(plan, 'flight');
  assert.equal(timing.arrivalInTown, 11 * 60 + 10);
  assert.equal(timing.leaveForReturn, 1440 + 15 * 60 + 25);
  assert.equal(timing.lastStopEnd, 1440 + 15 * 60 + 5);
  assert.deepEqual(timing.days.map(day => day.usableMinutes), [590, 365]);
  assert.equal(timing.usableMinutes, 955);
});

test('周五跨午夜抵达仍从周六白天计时，火车接驳取实际车站', () => {
  const friday = {...plan,
    outbound: {...plan.outbound, date: '2026-11-27', arrivalTime: '00:25', nextDay: true, arrivalAirport: '厦门站'},
    inbound: {...plan.inbound, departureAirport: '厦门北站'},
  };
  const timing = weekendWindow(friday, 'rail');
  assert.equal(timing.arrivalInTown, 60);
  assert.equal(timing.days[0].start, 9 * 60);
  assert.equal(timing.days[1].end, 16 * 60);
});

test('最晚抵达包含边界，铁路筛选先于价格候选裁剪', () => {
  const railOut = {...plan.outbound, departureTime: '07:00', fare: 100};
  const train = {...plan.inbound, fare: 100};
  assert.equal(returnBefore(train, '19:30'), true);
  assert.equal(returnBefore(train, '19:29'), false);
  assert.equal(returnBefore({...train, nextDay: true}, '23:59'), false);
  const options = railPlans([railOut], [train, {...train, fare: 90, arrivalTime: '20:00'}],
    {earliest: '07:00', returnEarliest: '18:00', latest: '19:30'});
  assert.deepEqual(options.map(option => option.total), [200]);
});

test('比按价格保留的选项更能玩的候选仍可用于排序', () => {
  const later = {...plan, total: 900, outbound: {...plan.outbound, arrivalTime: '15:00'}};
  const worse = {...later, total: 1100};
  assert.deepEqual(keepWeekendOptions([later, plan, worse], 1, 'flight'), [later, plan]);
});

test('晚到和早返使用短线，无交通方案时显示原攻略', () => {
  const day = {title:'鼓浪屿与老城', stops:['鼓浪屿','八市'], tip:'上午上岛。'};
  assert.equal(fitGuideDay(day, 0), day);
  assert.equal(fitGuideDay(day, 0, {start: 17 * 60, usableMinutes: 240}, '中山路').title, '傍晚短线');
  assert.deepEqual(fitGuideDay(day, 1, {end: 14 * 60, usableMinutes: 300}, '沙坡尾').stops, ['沙坡尾']);
  assert.deepEqual(fitGuideDay(day, 1, {end: 9 * 60, usableMinutes: 0}, '沙坡尾').stops, []);
});
