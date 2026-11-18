import {weekend,departureOn,returnDate,filterTrips} from './engine.js';
const $=s=>document.querySelector(s), money=n=>'¥'+Number(n).toLocaleString('zh-CN',{maximumFractionDigits:2});
const destinations=[
{id:'xiamen',city:'厦门',code:'XMN',region:'福建 · 海风与老街',desc:'沿着环岛路，把一整周的疲惫吹散。',tags:['海边','城市'],price:680,duration:85,out:'20:10',back:'21:20',direct:true,score:99,sky:'#cbdedb',sun:'#f3d7a2',land:'#8bb5ac',symbol:'◡',plan:['周六｜沙坡尾散步，在老街喝一杯咖啡','周日｜沿环岛路看海，留出充足时间返程']},
{id:'chengdu',city:'成都',code:'CTU',region:'四川 · 烟火慢生活',desc:'一顿火锅，一杯盖碗茶，慢下来就好。',tags:['美食','城市'],price:860,duration:140,out:'19:40',back:'21:40',direct:true,score:96,sky:'#e3ddca',sun:'#e8bc86',land:'#a3ad7f',symbol:'⌂',plan:['周六｜人民公园喝茶，傍晚找一家街边火锅','周日｜玉林街区慢逛，尝尝街头小吃']},
{id:'guilin',city:'桂林',code:'KWL',region:'广西 · 山水之间',desc:'把屏幕关掉，把山水装进眼睛。',tags:['山野'],price:590,duration:75,out:'20:00',back:'20:50',direct:true,score:93,sky:'#d9e0cd',sun:'#efe1b1',land:'#749989',symbol:'△',plan:['周六｜沿漓江散步，看山与水慢慢交错','周日｜在市区轻松走走，避免远途赶路']},
{id:'chongqing',city:'重庆',code:'CKG',region:'重庆 · 山城夜色',desc:'走进立体街巷，等一场江边的夜。',tags:['美食','城市'],price:720,duration:130,out:'21:00',back:'21:30',direct:true,score:91,sky:'#dbd9d4',sun:'#d6a88f',land:'#8b9c91',symbol:'▥',plan:['周六｜山城步道闲逛，晚上去江边看灯火','周日｜找一家小面馆，再去老街走一走']},
{id:'haikou',city:'海口',code:'HAK',region:'海南 · 椰风骑楼',desc:'去有椰子的地方，让日子长一点。',tags:['海边','美食'],price:780,duration:80,out:'19:20',back:'20:30',direct:true,score:89,sky:'#d1e6df',sun:'#eacd8b',land:'#96bda0',symbol:'♧',plan:['周六｜骑楼老街喝老爸茶，傍晚去海边','周日｜吃一碗海南粉，带着椰香返程']},
{id:'kunming',city:'昆明',code:'KMG',region:'云南 · 阳光与花',desc:'在春城，把周末过成一个晴天。',tags:['山野','城市'],price:1080,duration:165,out:'19:10',back:'21:00',direct:true,score:87,sky:'#d5dfdc',sun:'#edcd8e',land:'#a0b58d',symbol:'✳',plan:['周六｜翠湖晒太阳，街边吃一碗米线','周日｜在花市选一束花，把好心情带回家']},
{id:'dali',city:'大理',code:'DLU',region:'云南 · 苍山洱海',desc:'找个靠窗的位置，看云慢慢走。',tags:['山野'],price:1680,duration:230,out:'18:30',back:'22:40',direct:false,score:85,sky:'#cfdee2',sun:'#e5d7a4',land:'#8faab0',symbol:'△',plan:['周六｜古城与洱海，给行程留白','周日｜轻松吃早饭，提前安排机场交通']},
{id:'qingdao',city:'青岛',code:'TAO',region:'山东 · 红瓦与海',desc:'走过红瓦绿树，听一下午的海。',tags:['海边','城市'],price:1190,duration:180,out:'19:15',back:'21:50',direct:true,score:84,sky:'#c9dee3',sun:'#f3d5a8',land:'#94b3b0',symbol:'⌂',plan:['周六｜老城区散步，在海边看日落','周日｜找家咖啡店坐坐，慢慢收拾返程']}];
const codes={深圳:'SZX',上海:'SHA',北京:'BJS',广州:'CAN',杭州:'HGH',成都:'CTU'};
function read(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback}catch{return fallback}}
let favorites=read('weekend-favorites',[]);if(!Array.isArray(favorites))favorites=[];
let tag='全部',onlySaved=false;
function persist(){try{localStorage.setItem('weekend-favorites',JSON.stringify(favorites));return true}catch{toast('浏览器存储不可用');return false}}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.remove('show'),3200)}
function el(name,cls,text){const e=document.createElement(name);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function options(){return {origin:$('#origin').value,budget:+$('#budget').value,earliest:$('#earliest').value||'00:00',returnEarliest:$('#return-earliest').value||'00:00',direct:$('#direct').checked,tag,favorites,onlySaved,sort:$('#sort').value}}
function dates(){const out=$('#departure').value;return {out,back:returnDate(out)}}
function render(){if(document.documentElement.dataset.live==='1'){window.dispatchEvent(new Event('live-render'));return}const o=options();const trips=filterTrips(destinations,o);$('#fav-count').textContent=favorites.length;$('#section-title').textContent=onlySaved?'收藏你的下一次出发':'这周末，去这里';$('#result-summary').textContent=`${o.origin}出发 · ${dates().out} — ${dates().back} · ${trips.length} 个符合筛选的演示方案`;$('#budget-value').textContent=money(o.budget);$('#cards').replaceChildren();$('#empty').hidden=trips.length>0;for(const t of trips){const card=el('article','card');const art=el('div','art');art.style.setProperty('--sky',t.sky);art.style.setProperty('--sun',t.sun);art.style.setProperty('--land',t.land);art.append(el('span','art-tag',t.tags[0]+' · 演示方案'),el('span','landmark',t.symbol),el('span','big-city',t.city));const save=el('button','save'+(favorites.includes(t.id)?' saved':''),favorites.includes(t.id)?'♥':'♡');save.setAttribute('aria-label',(favorites.includes(t.id)?'取消收藏':'收藏')+t.city);save.onclick=()=>{favorites=favorites.includes(t.id)?favorites.filter(id=>id!==t.id):[...favorites,t.id];persist();render()};art.append(save);const body=el('div','card-body');const title=el('div','card-title');title.append(el('h3','',t.city),el('span','region',t.region));body.append(title,el('p','description',t.desc));const schedule=el('div','schedule');for(const [small,big] of [['周'+($('#departure-day').value==='6'?'六':'五')+'出发',t.out+' 起飞'],['↔',t.direct?'直飞':'含中转'],['周日返回',t.back+' 起飞']]){const s=el('span');s.append(el('small','',small),el('b','',big));schedule.append(s)}body.append(schedule);const bottom=el('div','card-bottom');const p=el('div','price');p.append(el('small','','演示往返机票预算 / 人'));const strong=el('strong','',money(t.price));p.append(strong,el('em','','非实时报价'));const detail=el('button','detail','看看怎么玩 ↗');detail.onclick=()=>openTrip(t);bottom.append(p,detail);body.append(bottom);card.append(art,body);$('#cards').append(card)}}
function platformLinks(t){const o=options(),d=dates();const links=[['飞猪','https://www.fliggy.com/'],['同程','https://www.ly.com/'],['携程',`https://flights.ctrip.com/online/list/oneway-${codes[o.origin].toLowerCase()}-${t.code.toLowerCase()}?depdate=${d.out}&cabin=y&adult=1&child=0&infant=0`]];const box=el('div','platforms');for(const [name,url] of links){const a=el('a','',name+' ↗');a.href=url;a.target='_blank';a.rel='noopener noreferrer';box.append(a)}return box}
function openTrip(t){const o=options(),d=dates(),box=$('#trip-content');box.replaceChildren(el('p','eyebrow','TWO DAYS, A DIFFERENT PACE'),el('h2','',o.origin+' → '+t.city),el('p','muted','演示行程 · '+d.out+' — '+d.back+' · 成人 1 人 / 经济舱'));const info=el('div','trip-summary');info.append(el('div','',`去程 ${t.out} 起飞，周日 ${t.back} 起飞`),el('div','',`演示往返预算 ${money(t.price)} / 人 · ${t.direct?'直飞':'含中转'}`),el('small','muted','时间、直飞状态及预算均为演示设定，未核验实际航班。'));box.append(info);for(const p of t.plan)box.append(el('p','',p));box.append(el('h3','','去原平台核对价格'),el('p','muted','携程链接预填去程搜索条件，返程需另查；飞猪、同程打开首页。跳转后请核对日期、机场、人数、行李和含税总价。'));box.append(platformLinks(t));const actions=el('div','dialog-actions');const copy=el('button','primary','复制行程');copy.onclick=async()=>{const text=`${o.origin} → ${t.city}，去程 ${d.out}（${o.earliest} 后出发），返程 ${d.back}（${o.returnEarliest} 后起飞），1 名成人经济舱，往返机票预算 ${money(o.budget)}。请查询实际航班与含税总价。`;try{await navigator.clipboard.writeText(text);toast('行程已复制')}catch{const area=el('textarea');area.value=text;box.append(area);area.select();toast('请手动复制下方行程文字')}};actions.append(copy);box.append(actions);$('#trip-dialog').showModal()}
function syncDepartureDate() {
  const field = $('#departure');
  const day = Number($('#departure-day').value);
  field.min = weekend(new Date(), day);
  const selected = field.value ? departureOn(field.value, day) : field.min;
  field.value = selected < field.min ? field.min : selected;
}
syncDepartureDate();
for (const field of document.querySelectorAll('#search-form input[type="date"], #search-form input[type="time"]')) {
  field.addEventListener('click', event => {
    if (typeof field.showPicker !== 'function') return;
    try {
      field.showPicker();
      event.preventDefault();
    } catch {
      // Keep the browser's default interaction when showPicker is blocked.
    }
  });
}
$('#search-form').onsubmit=e=>{e.preventDefault();syncDepartureDate();render();$('#section-title').scrollIntoView({behavior:'smooth',block:'center'})};
$('#budget').oninput=render;$('#sort').onchange=render;$('#direct').onchange=render;$('#origin').onchange=render;$('#earliest').onchange=render;$('#return-earliest').onchange=render;$('#chips').onclick=e=>{const btn=e.target.closest('[data-tag]');if(!btn)return;tag=btn.dataset.tag;document.querySelectorAll('[data-tag]').forEach(b=>b.classList.toggle('selected',b===btn));render()};
function view(saved){onlySaved=saved;$('#favorites').classList.toggle('active',saved);$('#discover').classList.toggle('active',!saved);render();$('#section-title').scrollIntoView({behavior:'smooth'})}$('#favorites').onclick=()=>view(true);$('#discover').onclick=()=>view(false);
$('#reset').onclick=()=>{tag='全部';$('#budget').value=1200;$('#earliest').value='21:00';$('#return-earliest').value='18:00';$('#direct').checked=true;document.querySelectorAll('[data-tag]').forEach(b=>b.classList.toggle('selected',b.dataset.tag==='全部'));view(false)};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$('#'+b.dataset.close).close());
for (const id of ['departure', 'departure-day']) {
  $('#' + id).onchange = () => {
    syncDepartureDate();
    if (document.documentElement.dataset.live !== '1') render();
  };
}
window.addEventListener('live-favorites-changed', event => { favorites = event.detail; });
await import('./realtime-ui.js');

