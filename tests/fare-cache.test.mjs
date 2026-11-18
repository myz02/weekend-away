import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {cacheSchedule, openFareCache} from '../fare-cache.mjs';
import {nextShanghaiNoon} from '../temporary-fares.mjs';

test('北京时间中午启动每日采集，覆盖当月与下月且支持跨年', () => {
  assert.equal(cacheSchedule(new Date('2026-11-18T03:59:59Z')).due, false);
  assert.equal(cacheSchedule(new Date('2026-11-18T04:00:00Z')).due, true);
  const november = cacheSchedule(new Date('2026-11-21T04:00:00Z')).outbound;
  assert.deepEqual(november.slice(0, 3), ['2026-11-21', '2026-11-27', '2026-11-28']);
  assert.equal(november.at(-1), '2026-12-26');
  const december = cacheSchedule(new Date('2026-11-30T16:00:00Z')).outbound;
  assert.equal(december[0], '2026-12-04');
  assert.equal(december.at(-1), '2027-01-30');
});

test('启动时清理已移除城市的去返缓存和临时缓存，保留其他城市', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'weekend-catalog-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = join(dir, 'fares.json');
  const current = '2026-11-20/深圳/张家界';
  const validTemp = JSON.stringify(['张家界', '深圳', '2026-11-22', 18, null]);
  const removedTemp = JSON.stringify(['旧目的地', '深圳', '2026-11-22', 18, null]);
  const expiresAt = '2026-11-19T04:00:00.000Z';
  await writeFile(file, JSON.stringify({legs: {
    [current]: {},
    '2026-11-20/深圳/旧目的地': {},
    '2026-11-22/旧目的地/深圳': {},
  }}));
  await writeFile(file + '.temporary', JSON.stringify({[validTemp]: {expiresAt}, [removedTemp]: {expiresAt}}));
  await openFareCache(file, {now: () => new Date('2026-11-18T04:00:00Z')});
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8')).legs), [current]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file + '.temporary', 'utf8'))), [validTemp]);
});

test('每批次覆盖站点航线，重复查询及重启只读缓存，失败时保留已有报价', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'weekend-fares-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = join(dir, 'fares.json');
  let time = new Date('2026-11-18T04:00:00Z');
  await writeFile(file, JSON.stringify({day: '2026-11-18', legs: {}}));
  const calls = [];
  const fetchLeg = async (from, to, date, filter) => {
    calls.push([from, to, date, filter.depHour]);
    return {collectedAt: time.toISOString(), flights: []};
  };
  const cache = await openFareCache(file, {now: () => time, fetchLeg});
  await cache.refresh();
  assert.equal(calls.length, cache.status().progress.total);
  assert(calls.some(([from, to, date, hour]) => from === '青岛' && to === '杭州' && date === '2026-11-22' && hour === 18));
  assert(calls.some(([from, to, date, hour]) => from === '深圳' && to === '张家界' && date === '2026-11-20' && hour === 21));
  assert(calls.some(([from, to, date, hour]) => from === '深圳' && to === '厦门' && date === '2026-11-21' && hour === 7));
  assert(calls.some(([from, to, date, hour]) => from === '深圳' && to === '厦门' && date === '2026-12-26' && hour === 7));
  const initialCalls = calls.length;
  const query = {origin: '深圳', destinations: ['厦门'], outDate: '2026-11-28',
    backDate: '2026-11-29', earliest: '21:00', returnEarliest: '18:00'};
  await cache.refresh();
  assert.equal((await cache.search(query)).results['厦门'].status, 'no_match');
  assert.equal(calls.length, initialCalls);

  time = new Date('2026-11-19T04:00:00Z');
  const restarted = await openFareCache(file, {now: () => time, fetchLeg: async () => { throw Error('超时'); }});
  await restarted.refresh();
  const old = await restarted.search(query);
  assert.equal(old.results['厦门'].status, 'no_match');
  assert.equal(old.results['厦门'].collectedAt, '2026-11-18T04:00:00.000Z');
});

test('超出两个月的周末按需采集，并发查询和重启复用报价，到北京时间中午重新采集', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'weekend-temporary-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = join(dir, 'fares.json');
  let time = new Date('2026-11-18T03:55:00Z');
  let calls = 0;
  const options = {now: () => time, fetchLeg: async () => {
    calls++;
    return {collectedAt: time.toISOString(), flights: []};
  }};
  const query = {origin: '深圳', destinations: ['厦门'], outDate: '2027-01-02',
    backDate: '2027-01-03', earliest: '21:00', returnEarliest: '18:00'};
  const cache = await openFareCache(file, options);
  const [first, second] = await Promise.all([cache.search(query), cache.search(query)]);
  assert.equal(calls, 2);
  assert.equal(first.temporaryExpiresAt, '2026-11-18T04:00:00.000Z');
  assert.equal(second.temporaryExpiresAt, first.temporaryExpiresAt);
  const restarted = await openFareCache(file, options);
  await restarted.search(query);
  assert.equal(calls, 2);

  time = new Date('2026-11-18T04:00:00Z');
  await restarted.search({...query, outDate: '2026-11-21', backDate: '2026-11-22', cacheOnly: true});
  await assert.rejects(readFile(file + '.temporary'), {code: 'ENOENT'});
  assert.equal(calls, 2);
  const fresh = await restarted.search(query);
  assert.equal(calls, 4);
  assert.equal(fresh.temporaryExpiresAt, '2026-11-19T04:00:00.000Z');
  assert.equal(nextShanghaiNoon(new Date('2026-12-31T13:00:00Z')), '2027-01-01T04:00:00.000Z');
});

test('手动补查已纳入定期采集但尚未写入的航段，首屏查询仍只读批量缓存', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'weekend-gap-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = join(dir, 'fares.json');
  const now = () => new Date('2026-11-18T04:00:00Z');
  const cached = {collectedAt: now().toISOString(), flights: []};
  await writeFile(file, JSON.stringify({legs: {'2026-12-19/深圳/海口': {21: {result: cached}}}}));
  const calls = [];
  const cache = await openFareCache(file, {now, fetchLeg: async (...args) => {
    calls.push(args);
    return cached;
  }});
  const query = {origin: '深圳', destinations: ['海口'], outDate: '2026-12-19',
    backDate: '2026-12-20', earliest: '21:00', returnEarliest: '18:00'};
  assert.equal((await cache.search({...query, cacheOnly: true})).results['海口'].status, 'error');
  assert.equal(calls.length, 0);
  assert.equal((await cache.search(query)).results['海口'].status, 'no_match');
  assert.deepEqual(calls, [['海口', '深圳', '2026-12-20', {depHour: 18}]]);
  await cache.search(query);
  assert.equal(calls.length, 1);
});
