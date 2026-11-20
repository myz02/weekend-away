import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRailLegs, railPlans, searchRail} from '../railway.mjs';
import {plansWithinBudget} from '../dist/budget.js';
import {openDatabase} from '../database.mjs';

const date = '2026-11-21';
const stations = {SZQ:'深圳', GZQ:'广州'};
function row({number='G27', time='22:00', arrival='23:10', duration='01:10', seats='有', price='M009950005O007450021O007453000', book='Y'}={}) {
  const p = Array(40).fill('');
  for (const [i,v] of Object.entries({3:number,6:'SZQ',7:'GZQ',8:time,9:arrival,10:duration,11:book,30:seats,39:price})) p[i]=v;
  return p.join('|');
}

test('只采用有余票的直达动车二等座报价，排除无座、候补和普通列车', () => {
  const trains = parseRailLegs([row(),row({seats:'无'}),row({seats:'候补'}),row({number:'K12'}),
    row({price:'O007453000'}),row({book:'N'}),row({arrival:'00:10',duration:'02:10',number:'D22'})], stations, date);
  assert.deepEqual(trains.map(x => [x.number,x.fare,x.nextDay]), [['G27',74.5,false],['D22',74.5,true]]);
});

test('高铁沿用往返预算和最早出发时间，返程不跨到周一', () => {
  const train = (number, departureTime, fare, nextDay=false) => ({number,departureTime,fare,nextDay});
  const options = railPlans([train('G1','06:59',20),train('G2','07:00',74.5)],
    [train('G3','17:59',25),train('G4','18:00',105.5),train('G5','23:10',30,true)],
    {earliest:'07:00',returnEarliest:'18:00'});
  assert.deepEqual(options.map(x => [x.outbound.number,x.inbound.number,x.total]), [['G2','G4',180]]);
  assert.equal(plansWithinBudget({options},179).length,0);
  assert.equal(plansWithinBudget({options},180).length,1);
});

test('铁路返程超过预售期时不请求报价', async () => {
  await assert.rejects(searchRail({outDate:'2026-12-04',backDate:'2026-12-06'},new Date('2026-11-19T09:00:00Z')),
    {code: 'RAIL_NOT_ON_SALE', message: /预售期/});
});

test('高铁单段报价重启后复用，过两分钟重新查询', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'weekend-rail-sqlite-'));
  let database = await openDatabase(join(dir, 'test.sqlite'));
  t.after(async () => {
    database.close();
    await rm(dir, {recursive:true, force:true});
  });
  let now = new Date('2026-11-19T09:00:00Z');
  const query = {origin:'深圳', destinations:['广州'], outDate:date, backDate:'2026-11-22',
    earliest:'07:00', returnEarliest:'18:00'};
  let visits = 0;
  const getRailSession = async () => ({cities:{深圳:'SZQ',广州:'GZQ'}, stations});
  const fetchRailLeg = async (_session, _from, _to, travelDate) => {
    visits++;
    return [{number:'G27', date:travelDate, departureTime:'19:00', arrivalTime:'20:00', fare:75}];
  };
  const search = session => searchRail(query, now, {database, clock:() => now, getRailSession:session, fetchRailLeg});

  assert.equal((await search(getRailSession)).results.广州.options[0].total, 150);
  assert.equal(visits, 2);
  database.close();
  database = await openDatabase(join(dir, 'test.sqlite'));
  assert.equal((await search(async () => { throw Error('上游不可用'); })).results.广州.options[0].total, 150);
  assert.equal(visits, 2);
  now = new Date(now.getTime() + 120000);
  assert.equal((await search(getRailSession)).results.广州.options[0].total, 150);
  assert.equal(visits, 4);
});
