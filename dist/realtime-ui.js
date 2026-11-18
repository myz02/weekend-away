import {returnDate, weekend} from './engine.js';
import {plansWithinBudget} from './budget.js';

document.documentElement.dataset.live = '1';

const $ = selector => document.querySelector(selector);
const money = amount => '¥' + amount.toLocaleString('zh-CN', {maximumFractionDigits: 2});
const cities = [
  ['xiamen', '厦门', '海边', '厦门双子塔', '两座帆形大楼立在海边，傍晚能一起看到海湾和城市灯火。'],
  ['chengdu', '成都', '美食', '大熊猫繁育基地', '在熊猫基地看大熊猫抱着竹子吃。'],
  ['guilin', '桂林', '山野', '兴坪漓江', '从高处俯瞰，漓江绕过兴坪村落，峰林一层层延伸到远处。'],
  ['chongqing', '重庆', '美食', '洪崖洞夜景', '从千厮门大桥望过去，嘉陵江边的吊脚楼层层亮起。'],
  ['haikou', '海口', '海边', '假日海滩', '从秀英港远眺，碧蓝的海水沿着海口西海岸铺开。'],
  ['kunming', '昆明', '山野', '滇池红嘴鸥', '冬天到滇池大堤，看红嘴鸥贴着水面飞。'],
  ['dali', '大理', '山野', '崇圣寺三塔', '认准一高两低的三座白塔，背后就是苍山。'],
  ['qingdao', '青岛', '海边', '浮山湾夜景', '夜里沿浮山湾散步，五四广场一带的楼群在海面映出灯影。'],
].map(([id, city, tag, landmark, caption]) => ({id, city, tag, landmark, caption}));

let job = null, tag = '全部', saved = false, busy = false, available = false;
let appliedBudget = null;
let coveredDates = [];
let favorites = readFavorites();
function readFavorites() {
  try {
    const value = JSON.parse(localStorage.getItem('weekend-favorites'));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function make(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const noteText = $('.data-note');
const queryDetails = $('#query-details');
const empty = $('#empty');
const budget = () => Number($('#budget').value);
const statusText = result => ({
  queued: '等待查询', running: '查询去程 / 返程中', error: '未取得报价',
  no_match: '无可组合航班', success: '已获取航班',
})[result?.status] ?? '尚未查询';

function addPlanPrice(body, plan, result) {
  const {outbound, inbound} = plan;
  body.append(
    make('p', 'live-flights', `去 ${outbound.number} ${outbound.departureTime} → ${outbound.arrivalTime}${outbound.nextDay ? '（次日）' : ''}`),
    make('p', 'live-flights', `回 ${inbound.number} ${inbound.departureTime} → ${inbound.arrivalTime}`),
  );
  const stale = Date.now() - Date.parse(result.collectedAt) > 86400000;
  const price = make('div', 'price');
  price.append(
    make('small', '', `${plan.estimated ? '往返含费估算' : '往返含费总价'} / 成人 1 人${stale ? ' · 旧报价' : ''}`),
    make('strong', '', money(plan.total)),
  );
  body.append(
    price,
    make('p', 'muted', `票面 ${money(plan.fare)} ＋ 机建燃油 ${money(plan.total - plan.fare)}`),
    make('small', 'muted', '采集于 ' + fareTime(result.collectedAt)),
  );
}

function createCard(city, plans, result) {
  const card = make('article', 'card live-card');
  const art = make('div', 'art city-art');
  const image = make('img', 'city-image');
  image.src = 'images/' + city.id + '.webp';
  image.alt = city.city + ' · ' + city.landmark;
  image.loading = 'lazy';
  const favorited = favorites.includes(city.id);
  const favorite = make('button', 'save' + (favorited ? ' saved' : ''), favorited ? '♥' : '♡');
  favorite.type = 'button';
  favorite.setAttribute('aria-label', (favorited ? '取消收藏' : '收藏') + city.city);
  favorite.setAttribute('aria-pressed', String(favorited));
  favorite.onclick = () => {
    favorites = favorited ? favorites.filter(id => id !== city.id) : [...favorites, city.id];
    try { localStorage.setItem('weekend-favorites', JSON.stringify(favorites)); } catch {}
    window.dispatchEvent(new CustomEvent('live-favorites-changed', {detail: favorites}));
    render();
  };
  art.append(image, make('span', 'art-tag', city.landmark), favorite);
  const body = make('div', 'card-body');
  body.append(make('h3', '', city.city), make('p', 'city-caption', city.caption));
  if (plans.length) {
    addPlanPrice(body, plans[0], result);
    const button = make('button', 'detail', '查看航班和费用 ↗');
    button.onclick = () => showPlans(city, result);
    const actions = make('div', 'live-card-actions');
    actions.append(button);
    body.append(actions);
  } else if (result) {
    body.append(make('p', 'muted', '暂无可用往返报价'));
  }
  card.append(art, body);
  return card;
}

function renderQueryDetails() {
  queryDetails.hidden = !job;
  if (!job) return;
  const items = queryDetails.querySelector('ul');
  items.replaceChildren(...Object.values(job.results).map(result => {
    const text = result.status === 'success'
      ? (plansWithinBudget(result, appliedBudget ?? Infinity).length ? (appliedBudget === null ? '有往返方案' : '有预算内方案')
        : result.options?.some(plan => Number.isFinite(plan.total)) ? '总价超出预算' : '总价待核实')
      : result.message || statusText(result);
    return make('li', '', result.city + ' · ' + text);
  }));
}

function render() {
  if (job?.temporaryExpiresAt && Date.parse(job.temporaryExpiresAt) <= Date.now()) {
    job = null;
    appliedBudget = null;
    noteText.textContent = '临时报价已到期，请重新查询。';
    if ($('#trip-dialog').open) $('#trip-dialog').close();
  }
  const origin = $('#origin').value;
  const limit = appliedBudget ?? Infinity;
  const candidateCities = cities.filter(city => city.city !== origin
    && (tag === '全部' || city.tag === tag || (tag === '城市' && ['成都', '重庆', '昆明', '青岛', '厦门'].includes(city.city)))
    && (!saved || favorites.includes(city.id)));
  const entries = candidateCities.map(city => {
    const result = job?.results?.[city.city];
    return {city, result, plans: plansWithinBudget(result, limit)};
  }).filter(entry => appliedBudget === null || entry.plans.length > 0);
  if ($('#sort').value === 'price' && job) {
    entries.sort((a, b) => (a.plans[0]?.total ?? Infinity) - (b.plans[0]?.total ?? Infinity));
  }
  $('#budget-value').textContent = money(budget());
  $('#fav-count').textContent = favorites.length;
  $('#section-title').textContent = saved ? '收藏目的地' : appliedBudget !== null ? '预算内目的地' : '这周末，去这里';
  const date = $('#departure').value;
  const dateRange = date ? date + ' — ' + returnDate(date) : '请选择出发日期';
  const progress = appliedBudget !== null
    ? `${entries.length} 个目的地符合已查询预算 ${money(limit)}`
    : '全部目的地 · 点击查询后按预算和起飞时间筛选';
  $('#result-summary').textContent = `${origin}出发 · ${dateRange} · ${progress}`;
  $('#cards').replaceChildren(...entries.map(({city, plans, result}) => createCard(city, plans, result)));
  empty.hidden = entries.length > 0;
  empty.querySelector('h3').textContent = appliedBudget !== null
    ? '没有符合当前筛选的报价'
    : '没有符合当前筛选的目的地';
  empty.querySelector('p').textContent = appliedBudget !== null
    ? `已查询预算 ${money(limit)}。可调整预算后重新查询，或展开查看各目的地状态。`
    : '试试选择其他分类，或在目的地卡片上添加收藏。';
  renderQueryDetails();
}

function flightBreakdown(direction, flight) {
  const section = make('section', 'flight-breakdown');
  section.append(
    make('p', '', `${direction} ${flight.date} · ${flight.number} · ${flight.departureTime} → ${flight.arrivalTime}${flight.nextDay ? '（次日）' : ''}`),
    make('p', 'muted', `${flight.departureAirport}（${flight.depAirportCode}） → ${flight.arrivalAirport}（${flight.arrAirportCode}）`),
  );
  const fees = flight.fees;
  if (fees) {
    section.append(make('p', 'fee-line', `票面 ${money(flight.fare)} ＋ 机建 ${money(fees.airport)} ＋ 燃油 ${money(fees.fuel)} ＝ 估算 ${money(flight.total)}`));
  } else {
    section.append(make('p', 'muted', `票面 ${money(flight.fare)} · ${flight.rawFee || '税费待核实'}`));
  }
  return section;
}

function roundTripBooking(destination, {origin, outDate, backDate}, {outbound, inbound}) {
  const params = new URLSearchParams({
    origin, destination, outDate, backDate,
    outFlight: outbound.number, backFlight: inbound.number,
    outTime: outbound.departureTime, backTime: inbound.departureTime,
    depAirport: outbound.depAirportCode, arrAirport: outbound.arrAirportCode,
  });
  const anchor = make('a', 'detail round-trip-search', '去飞猪选票价套餐 ↗');
  anchor.href = '/api/round-trip?' + params;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

function showPlans(city, result) {
  if (job?.temporaryExpiresAt && Date.parse(job.temporaryExpiresAt) <= Date.now()) {
    render();
    return;
  }
  const box = $('#trip-content');
  const {origin} = job.query;
  const plans = plansWithinBudget(result, appliedBudget ?? Infinity);
  box.replaceChildren(
    make('h2', '', origin + ' ↔ ' + city.city),
    make('p', 'muted', appliedBudget === null ? '成人 1 人'
      : `往返预算 ${money(appliedBudget)} · 成人 1 人`),
    make('p', 'muted', '价格按两段单程报价估算，以飞猪往返订单为准。若飞猪未返回所选组合，将打开同路线、同日期的往返搜索。'),
  );
  for (const [index, plan] of plans.entries()) {
    const row = make('div', 'trip-summary');
    row.append(
      make('b', '', `方案 ${index + 1} · ${plan.estimated ? '往返估算' : '往返总价'} ${money(plan.total)}`),
      flightBreakdown('去程', plan.outbound),
      flightBreakdown('返程', plan.inbound),
      roundTripBooking(city.city, job.query, plan),
    );
    box.append(row);
  }
  box.append(make('p', 'muted', '采集时间 ' + fareTime(result.collectedAt)));
  $('#trip-dialog').showModal();
}

function lock(value) {
  busy = value;
  for (const id of ['origin', 'departure', 'departure-day', 'earliest', 'return-earliest']) $('#' + id).disabled = value;
  $('.search-submit').disabled = value;
  $('.search-submit').textContent = value ? '正在读取缓存…' : '查询全部目的地 ↗';
}

function fareTime(value) {
  return new Date(value).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false,
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
}

function showCacheStatus(cache, date, temporaryExpiresAt) {
  if (temporaryExpiresAt) {
    const returned = Object.values(job.results).some(result => result.status !== 'error');
    noteText.textContent = returned
      ? `飞猪临时报价 · 北京时间 ${fareTime(temporaryExpiresAt)} 到期。`
      : '飞猪此次未返回报价。可展开各目的地查询状态查看原因。';
    return;
  }
  if (date && !cache.dates.includes(date)) {
    noteText.textContent = '所选日期暂无报价。';
    return;
  }
  noteText.textContent = '';
}

async function loadFares(limit) {
  if (busy) return;
  if (!available) {
    noteText.textContent = '票价缓存服务未连接。请在这台电脑运行 npm start 后使用本机网址。';
    return;
  }
  const origin = $('#origin').value;
  const outDate = $('#departure').value;
  const query = {
    origin, outDate, backDate: returnDate(outDate),
    cacheOnly: limit === null,
    earliest: limit === null ? '00:00' : $('#earliest').value,
    returnEarliest: limit === null ? '00:00' : $('#return-earliest').value,
    destinations: cities.filter(city => city.city !== origin).map(city => city.city),
  };
  lock(true);
  if (limit !== null) {
    $('.search-submit').textContent = '正在查询报价…';
    noteText.textContent = '正在读取已有报价，缺少的航线将向飞猪补查。';
  }
  try {
    const response = await fetch('/api/search', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(query),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || '查询未能启动');
    job = data;
    appliedBudget = limit;
    showCacheStatus(data.cache, outDate, data.temporaryExpiresAt);
    if (limit !== null && !data.temporaryExpiresAt && Object.values(job.results).some(result => result.status === 'success')) {
      try { localStorage.setItem('weekend-last-cache', JSON.stringify(job)); } catch {}
    }
    render();
  } catch (error) {
    noteText.textContent = error.message;
  } finally {
    lock(false);
  }
}

$('#search-form').onsubmit = event => {
  event.preventDefault();
  void loadFares(budget());
};

for (const id of ['origin', 'departure', 'departure-day', 'earliest', 'return-earliest']) {
  $('#' + id).addEventListener('change', () => { job = null; appliedBudget = null; render(); });
}
$('#budget').oninput = () => { $('#budget-value').textContent = money(budget()); };
$('#sort').onchange = render;
$('#direct').checked = true;
$('#direct').disabled = true;
$('#chips').onclick = event => {
  const button = event.target.closest('[data-tag]');
  if (!button) return;
  tag = button.dataset.tag;
  document.querySelectorAll('[data-tag]').forEach(item => item.classList.toggle('selected', item === button));
  render();
};
function setSaved(value) {
  saved = value;
  $('#discover').classList.toggle('active', !value);
  $('#favorites').classList.toggle('active', value);
  render();
}
$('#discover').onclick = () => setSaved(false);
$('#favorites').onclick = () => setSaved(true);
$('#reset').onclick = () => {
  tag = '全部';
  $('#budget').value = 1200;
  appliedBudget = null;
  document.querySelectorAll('[data-tag]').forEach(item => item.classList.toggle('selected', item.dataset.tag === tag));
  setSaved(false);
};
$('#sort').querySelector('[value=duration]').remove();
$('#sort').querySelector('[value=price]').textContent = '往返含费总价从低到高';
$('#sort').value = 'price';
window.addEventListener('live-render', () => { favorites = readFavorites(); render(); });
lock(false);
render();

noteText.textContent = '正在连接票价缓存服务…';
try {
  const response = await fetch('/api/health', {cache: 'no-store'});
  const health = await response.json();
  available = health.mode === 'cache';
  if (available) {
    coveredDates = health.cache.dates;
    showCacheStatus(health.cache);
  }
  else noteText.textContent = '票价缓存服务尚未就绪';
} catch {
  noteText.textContent = '当前网址未连接本机采集服务。请使用本机 http://127.0.0.1:4173/。';
}

try {
  const previous = JSON.parse(localStorage.getItem('weekend-last-cache'));
  if (previous?.status === 'complete' && previous.query?.returnEarliest && coveredDates.includes(previous.query.outDate)) {
    const {query} = previous;
    $('#origin').value = query.origin;
    const day = new Date(query.outDate + 'T12:00:00').getDay();
    $('#departure-day').value = String(day);
    $('#departure').min = weekend(new Date(), day);
    $('#departure').value = query.outDate;
    $('#earliest').value = query.earliest;
    $('#return-earliest').value = query.returnEarliest;
    render();
  }
} catch {}
if (available) void loadFares(null);
setInterval(render, 60000);
