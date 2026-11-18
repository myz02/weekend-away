export function weekend(date=new Date(), day=5){const d=new Date(date);d.setHours(12,0,0,0);const shift=(day-d.getDay()+7)%7;d.setDate(d.getDate()+shift);return localDate(d)}
export function localDate(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
export function departureOn(date, day) {
  const d = new Date(date + 'T12:00:00');
  const selectedDay = d.getDay();
  if (selectedDay !== 5 && selectedDay !== 6) return weekend(d, day);
  d.setDate(d.getDate() + day - selectedDay);
  return localDate(d);
}
export function returnDate(date) {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() + (d.getDay() === 6 ? 1 : 2));
  return localDate(d);
}
export function minutes(t){const [h,m]=t.split(':').map(Number);return h*60+m}
export function filterTrips(trips,{origin,budget,earliest,latest='23:59',returnEarliest='00:00',direct,tag='全部',favorites,onlySaved=false,sort='recommended'}){return trips.filter(t=>t.city!==origin&&t.price<=budget&&minutes(t.out)>=minutes(earliest)&&minutes(t.back)>=minutes(returnEarliest)&&minutes(t.back)<=minutes(latest)&&(!direct||t.direct)&&(tag==='全部'||t.tags.includes(tag))&&(!onlySaved||favorites.includes(t.id))).sort((a,b)=>sort==='price'?a.price-b.price:sort==='duration'?a.duration-b.duration:b.score-a.score)}
export function safeUrl(url){try{const u=new URL(url);return ['http:','https:'].includes(u.protocol)?u.href:null}catch{return null}}
export function validateQuote(q){if(!q.origin?.trim()||!q.destination?.trim()||q.origin.trim()===q.destination.trim())return '请填写不同的出发城市和目的城市';if(!/^\d{4}-\d{2}-\d{2}$/.test(q.outDate)||!/^\d{4}-\d{2}-\d{2}$/.test(q.backDate)||q.backDate<q.outDate)return '返程日期不能早于去程日期';if(!q.outFlight?.trim()||!q.backFlight?.trim()||!q.seller?.trim())return '请填写航班号和销售商';if(!Number.isInteger(Number(q.adults))||Number(q.adults)<1||Number(q.adults)>9)return '乘机人数应为 1–9 人';if(q.fare===''||!Number.isFinite(Number(q.fare))||Number(q.fare)<0)return '请填写有效票面价';if(q.tax!==''&&(!Number.isFinite(Number(q.tax))||Number(q.tax)<0))return '税费必须为非负数，未知请留空';if(!safeUrl(q.url))return '购买链接应以 http:// 或 https:// 开头';return null}
export function total(q){return q.included?Number(q.fare):q.tax===''?null:Math.round((Number(q.fare)+Number(q.tax))*100)/100}
