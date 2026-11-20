import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createWeekendServer} from '../server.mjs';

test('SQLite 后端同时提供目的地、攻略和已有往返报价', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'weekend-api-'));
  const legacyFlightFile = join(dir, 'legacy.json');
  const now = () => new Date('2026-11-18T04:00:00Z');
  function leg(date, departureTime, arrivalTime, depAirportCode, arrAirportCode) {
    return {collectedAt:now().toISOString(), flights:[{date, number:'MF8001', departureTime,
      arrivalTime, depAirportCode, arrAirportCode, fare:400, total:480}]};
  }
  await writeFile(legacyFlightFile, JSON.stringify({legs:{
    '2026-11-21/深圳/厦门': {7:{result:leg('2026-11-21','08:00','09:30','SZX','XMN')}},
    '2026-11-22/厦门/深圳': {18:{result:leg('2026-11-22','19:00','20:30','XMN','SZX')}},
  }}));
  let remoteCalls = 0;
  const {server} = await createWeekendServer({
    dbPath:join(dir,'weekend.sqlite'), legacyFlightFile, now,
    fetchLeg: async () => { remoteCalls++; throw Error('不应请求上游'); },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, {recursive:true, force:true});
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = async pathname => {
    const res = await fetch(base + pathname);
    assert.equal(res.status, 200);
    return res.json();
  };
  const health = await get('/api/health');
  assert.equal(health.storage, 'sqlite');
  const catalog = await get('/api/destinations');
  assert.equal(catalog.destinations.length, 52);
  assert.equal(catalog.destinations.find(city => city.id === 'xiamen').cover, '/images/xiamen.webp');
  const {guide} = await get('/api/guides/xiamen');
  assert.equal(guide.days.length, 2);
  assert.equal(guide.compactDays.length, 2);
  assert.ok(guide.routeDetails[guide.days[0].title].legs.length);
  assert.equal((await fetch(base + '/api/guides/unknown')).status, 404);
  const query = await fetch(base + '/api/search', {method:'POST', body:JSON.stringify({
    origin:'深圳', destinations:['厦门'], outDate:'2026-11-21', backDate:'2026-11-22',
    earliest:'07:00', returnEarliest:'18:00', cacheOnly:true,
  })});
  assert.equal(query.status, 200);
  assert.equal((await query.json()).results.厦门.options[0].total, 960);
  assert.equal(remoteCalls, 0);
});
