import assert from 'node:assert/strict';
import test from 'node:test';
import {spaceRequestStarts} from '../request-spacing.mjs';
import {runSearchBatch} from '../search-batch.mjs';

test('查询启动间隔适用于并发请求，后续请求可以在首个请求结束前启动', async () => {
  let clock = 0;
  const starts = [];
  const launch = spaceRequestStarts(1800, {
    now: () => clock,
    wait: async ms => { clock += ms; },
  });
  const first = Promise.withResolvers();
  const pending = launch(() => {
    starts.push(clock);
    return first.promise;
  });
  await Promise.all([launch(() => starts.push(clock)), launch(() => starts.push(clock))]);
  assert.deepEqual(starts, [0, 1800, 3600]);
  first.resolve();
  await pending;
});

test('一个目的地仍在查询时可返回其他结果，单城失败后继续查询剩余目的地', async () => {
  const destinations = ['厦门', '成都', '桂林', '重庆'];
  const query = {
    origin: '深圳', destinations: [...destinations, '厦门'],
    outDate: '2026-11-21', backDate: '2026-11-22', earliest: '21:00', returnEarliest: '18:00',
  };
  const job = {
    query, completed: 0,
    results: Object.fromEntries(destinations.map(city => [city, {status: 'queued'}])),
  };
  const xiamen = Promise.withResolvers();
  const calls = [];
  const batch = runSearchBatch(job, {fetchLeg: async (from, to, date, filter) => {
    calls.push({from, to, date, filter});
    if (to === '厦门') return xiamen.promise;
    if (to === '成都') throw Error('查询超时');
    return {flights: []};
  }});
  assert.deepEqual(calls.map(call => call.to), ['厦门', '成都', '桂林']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(job.status, 'running');
  assert.equal(job.completed, 3);
  assert.equal(job.results['成都'].status, 'error');
  assert.equal(job.results['重庆'].status, 'no_match');
  xiamen.resolve({flights: []});
  await batch;
  assert.equal(job.status, 'complete');
  assert.equal(job.completed, 4);
  assert.equal(calls.length, 7);
  assert.deepEqual(calls[0], {from: '深圳', to: '厦门', date: query.outDate, filter: {depHour: 21}});
  assert.deepEqual(calls.at(-1), {from: '厦门', to: '深圳', date: query.backDate, filter: {depHour: 18}});
});
