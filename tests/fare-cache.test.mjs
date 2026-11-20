import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {cacheSchedule, openFareCache} from '../fare-cache.mjs';
import {nextShanghaiNoon} from '../temporary-fares.mjs';
import {openDatabase} from '../database.mjs';

async function cacheFixture(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const file = join(dir, 'fares.json');
  const caches = [];
  t.after(async () => {
    for (const cache of caches) cache.close();
    await rm(dir, {recursive:true, force:true});
  });
  return {file, async open(options) {
    const cache = await openFareCache(file, options);
    caches.push(cache);
    return cache;
  }};
}

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

test('从旧 JSON 导入单段报价并创建 SQLite 文件', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'weekend-sqlite-'));
  let cache;
  t.after(async () => {
    cache?.close?.();
    await rm(dir, {recursive: true, force: true});
  });
  const file = join(dir, 'fares.json');
  const result = {collectedAt: '2026-11-18T04:00:00Z', flights: []};
  const contents = JSON.stringify({legs: {
    '2026-11-21/深圳/厦门': {7: {result}},
    '2026-11-22/厦门/深圳': {18: {result}},
  }});
  await writeFile(file, contents);
  const now = () => new Date('2026-11-18T04:00:00Z');
  cache = await openFareCache(file, {now});
  const resultSet = await cache.search({origin:'深圳', destinations:['厦门'], outDate:'2026-11-21',
    backDate:'2026-11-22', earliest:'07:00', returnEarliest:'18:00', cacheOnly:true});
  assert.equal(resultSet.results['厦门'].status, 'no_match');
  const database = await readFile(file + '.sqlite').catch(() => Buffer.alloc(0));
  assert.equal(database.subarray(0,16).toString(), 'SQLite format 3\0');
  assert.equal(await readFile(file,'utf8'), contents);
});

test('启动时清理已移除城市的去返缓存和临时缓存，保留其他城市', async t => {
  const {file, open} = await cacheFixture(t, 'weekend-catalog-');
  const current = '2026-11-20/深圳/张家界';
  const validTemp = JSON.stringify(['张家界', '深圳', '2026-11-22', 18, null]);
  const removedTemp = JSON.stringify(['旧目的地', '深圳', '2026-11-22', 18, null]);
  const expiresAt = '2026-11-19T04:00:00.000Z';
  const result = {collectedAt:'2026-11-18T04:00:00.000Z', flights:[]};
  await writeFile(file, JSON.stringify({legs: {
    [current]: {21:{result}},
    '2026-11-20/深圳/旧目的地': {21:{result}},
    '2026-11-22/旧目的地/深圳': {18:{result}},
  }}));
  await writeFile(file + '.temporary', JSON.stringify({[validTemp]: {expiresAt,result}, [removedTemp]: {expiresAt,result}}));
  const now = '2026-11-18T04:00:00.000Z';
  await open({now: () => new Date(now)});
  const database = await openDatabase(file + '.sqlite');
  try {
    assert.deepEqual(database.scheduledLegs('深圳','张家界','2026-11-20'), [result]);
    assert.deepEqual(database.scheduledLegs('深圳','旧目的地','2026-11-20'), []);
    assert.deepEqual(database.scheduledLegs('旧目的地','深圳','2026-11-22'), []);
    const key = {mode:'flight',scope:'temporary',from:'张家界',to:'深圳',date:'2026-11-22',depHour:18};
    assert.equal(database.getLeg(key, now).temporaryExpiresAt, expiresAt);
    assert.equal(database.getLeg({...key,from:'旧目的地'},now), null);
  } finally { database.close(); }
});

test('每批次覆盖站点航线，重复查询及重启只读缓存，失败时保留已有报价', async t => {
  const {file, open} = await cacheFixture(t, 'weekend-fares-');
  let time = new Date('2026-11-18T04:00:00Z');
  await writeFile(file, JSON.stringify({day: '2026-11-18', legs: {}}));
  const calls = [];
  const fetchLeg = async (from, to, date, filter) => {
    calls.push([from, to, date, filter.depHour]);
    return {collectedAt: time.toISOString(), flights: []};
  };
  const cache = await open({now: () => time, fetchLeg});
  await cache.refresh();
  assert.equal(calls.length, cache.status().progress.total);
  assert(calls.some(([from, to, date, hour]) => from === '青岛' && to === '杭州' && date === '2026-11-22' && hour === 18));
  assert(calls.some(([from, to, date, hour]) => from === '深圳' && to === '张家界' && date === '2026-11-20' && hour === 21));
  assert(calls.some(([from, to, date, hour]) => from === '深圳' && to === '厦门' && date === '2026-11-21' && hour === 7));
  assert(calls.some(([from, to, date, hour]) => from === '深圳' && to === '厦门' && date === '2026-12-26' && hour === 7));
  const initialCalls = calls.length;
  assert.equal(cache.status().lastBatch.outcomes.success, initialCalls);
  const query = {origin: '深圳', destinations: ['厦门'], outDate: '2026-11-28',
    backDate: '2026-11-29', earliest: '21:00', returnEarliest: '18:00'};
  await cache.refresh();
  assert.equal((await cache.search(query)).results['厦门'].status, 'no_match');
  assert.equal(calls.length, initialCalls);

  time = new Date('2026-11-19T04:00:00Z');
  const restarted = await open({now: () => time, fetchLeg: async () => { throw Error('超时'); }});
  await restarted.refresh();
  const old = await restarted.search(query);
  assert.equal(old.results['厦门'].status, 'no_match');
  assert.equal(old.results['厦门'].collectedAt, '2026-11-18T04:00:00.000Z');
  assert.equal(restarted.status().lastBatch.outcomes.failed, restarted.status().lastBatch.total);
});

test('超出两个月的周末按需采集，并发查询和重启复用报价，到北京时间中午重新采集', async t => {
  const {file, open} = await cacheFixture(t, 'weekend-temporary-');
  let time = new Date('2026-11-18T03:55:00Z');
  let calls = 0;
  const options = {now: () => time, fetchLeg: async () => {
    calls++;
    return {collectedAt: time.toISOString(), flights: []};
  }};
  const query = {origin: '深圳', destinations: ['厦门'], outDate: '2027-01-02',
    backDate: '2027-01-03', earliest: '21:00', returnEarliest: '18:00'};
  const cache = await open(options);
  const [first, second] = await Promise.all([cache.search(query), cache.search(query)]);
  assert.equal(calls, 2);
  assert.equal(first.temporaryExpiresAt, '2026-11-18T04:00:00.000Z');
  assert.equal(first.results['厦门'].temporaryExpiresAt, first.temporaryExpiresAt);
  assert.equal(second.temporaryExpiresAt, first.temporaryExpiresAt);
  const restarted = await open(options);
  await restarted.search(query);
  assert.equal(calls, 2);

  time = new Date('2026-11-18T04:00:00Z');
  await restarted.search({...query, outDate: '2026-11-21', backDate: '2026-11-22', cacheOnly: true});
  const database = await openDatabase(file + '.sqlite');
  try {
    assert.equal(database.getLeg({mode:'flight',scope:'temporary',from:'深圳',to:'厦门',
      date:query.outDate,depHour:21}, '2026-11-18T03:59:00.000Z'), null);
  } finally { database.close(); }
  assert.equal(calls, 2);
  const fresh = await restarted.search(query);
  assert.equal(calls, 4);
  assert.equal(fresh.temporaryExpiresAt, '2026-11-19T04:00:00.000Z');
  assert.equal(nextShanghaiNoon(new Date('2026-12-31T13:00:00Z')), '2027-01-01T04:00:00.000Z');
});

test('手动补查已纳入定期采集但尚未写入的航段，首屏查询仍只读批量缓存', async t => {
  const {file, open} = await cacheFixture(t, 'weekend-gap-');
  const now = () => new Date('2026-11-18T04:00:00Z');
  const cached = {collectedAt: now().toISOString(), flights: []};
  await writeFile(file, JSON.stringify({legs: {'2026-12-19/深圳/海口': {21: {result: cached}}}}));
  const calls = [];
  const cache = await open({now, fetchLeg: async (...args) => {
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

test('采集遇到限流后，重启保留暂停状态和已经写入的航段', async t => {
  const {open} = await cacheFixture(t, 'weekend-paused-');
  const now = () => new Date('2026-11-18T04:00:00Z');
  let attempts = 0;
  const fetchLeg = async () => {
    attempts++;
    if (attempts > 1) throw Object.assign(Error('限流'), {code:'FLYAI_RATE_LIMIT'});
    return {collectedAt:now().toISOString(), flights:[]};
  };
  const cache = await open({now,fetchLeg});
  await cache.refresh();
  assert.equal(cache.status().lastBatch.status, 'paused');
  assert.deepEqual(cache.status().lastBatch.outcomes, {rate_limited:1, success:1});
  const reopened = await open({now,fetchLeg});
  assert.equal(reopened.status().retryAt, '2026-11-18T04:05:00.000Z');
  await reopened.refresh();
  assert.equal(attempts, 2);
});
