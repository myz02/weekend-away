import {test} from 'node:test';import assert from 'node:assert/strict';import {weekend,departureOn,returnDate,filterTrips,total,validateQuote,safeUrl} from '../dist/engine.js';
test('跨月和周末日期',()=>{assert.equal(weekend(new Date('2026-11-17T12:00:00')),'2026-11-20');assert.equal(weekend(new Date('2026-11-21T12:00:00')),'2026-11-27');assert.equal(returnDate('2027-01-29'),'2027-01-31')});
test('周五和周六切换到同个周末，返程日期都是周日', () => {
  assert.equal(weekend(new Date('2026-11-17T12:00:00'), 6), '2026-11-21');
  assert.equal(departureOn('2027-01-01', 6), '2027-01-02');
  assert.equal(departureOn('2027-01-02', 5), '2027-01-01');
  assert.equal(returnDate('2027-01-01'), '2027-01-03');
  assert.equal(returnDate('2027-01-02'), '2027-01-03');
});
test('全部筛选条件共同生效',()=>{const a={id:'a',city:'厦门',price:600,out:'19:00',back:'22:00',direct:true,tags:['海边'],score:1,duration:90};const b={...a,id:'b',price:900};assert.deepEqual(filterTrips([a,b],{origin:'深圳',budget:800,earliest:'19:00',latest:'22:00',direct:true,tag:'海边',favorites:['a'],onlySaved:true}),[a]);assert.equal(filterTrips([a],{origin:'深圳',budget:800,earliest:'19:01',latest:'22:00',direct:true,favorites:[]}).length,0)});
test('未知税费不会当零；总价明确才计算',()=>{assert.equal(total({fare:'500',tax:'',included:false}),null);assert.equal(total({fare:'500',tax:'190',included:false}),690);assert.equal(total({fare:'500',tax:'190',included:true}),500)});
test('报价校验阻止错误日期与危险链接',()=>{const q={origin:'深圳',destination:'北京',outDate:'2026-11-20',backDate:'2026-11-22',outFlight:'CA1',backFlight:'CA2',seller:'示例',adults:'1',fare:'500',tax:'',url:'https://example.com'};assert.equal(validateQuote(q),null);assert.ok(validateQuote({...q,backDate:'2026-11-19'}));assert.ok(validateQuote({...q,url:'javascript:alert(1)'}));assert.equal(safeUrl('file:///x'),null)});
