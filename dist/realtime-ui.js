import {returnDate, weekend} from './engine.js';
import {plansWithinBudget} from './budget.js';
import {syncDepartureCalendar} from './departure-calendar.js';
import {destinations as cities} from './destinations.js';

document.documentElement.dataset.live = '1';

const $ = selector => document.querySelector(selector);
const money = amount => '¥' + amount.toLocaleString('zh-CN', {maximumFractionDigits: 2});
function chooseHeroDestination() {
  let previous;
  try { previous = sessionStorage.getItem('weekend-hero'); } catch {}
  const choices = cities.filter(city => city.hasPhoto && city.id !== previous);
  const destination = choices[Math.floor(Math.random() * choices.length)];
  const image = $('.hero-image');
  const label = destination.city + ' · ' + destination.photoSubject;
  if (destination.id !== 'guilin') {
    image.removeAttribute('srcset');
    image.removeAttribute('sizes');
    image.src = 'images/' + destination.id + '.webp';
  }
  image.alt = label;
  $('.hero-location').textContent = label;
  try { sessionStorage.setItem('weekend-hero', destination.id); } catch {}
}

chooseHeroDestination();

let job = null, tag = '全部', saved = false, busy = false, available = false;
let hasSearched = false;
let appliedBudget = null;
let coveredDates = [];
const destinationIds = new Set(cities.map(city => city.id));
let favorites = readFavorites();
function readFavorites() {
  try {
    const value = JSON.parse(localStorage.getItem('weekend-favorites'));
    return Array.isArray(value) ? value.filter(id => destinationIds.has(id)) : [];
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
function matchesCityKeyword(city) {
  const keyword = $('#city-search').value.trim().toLowerCase();
  return [city.city, city.landmark, city.id, city.airport].some(value => value?.toLowerCase().includes(keyword));
}
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
  if (city.hasPhoto) {
    const image = make('img', 'city-image');
    image.src = 'images/' + city.id + '.webp';
    image.alt = city.city + ' · ' + city.photoSubject;
    image.loading = 'lazy';
    art.append(image);
  } else {
    art.classList.add('city-text-art');
    art.dataset.theme = city.tag;
  }
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
  art.append(make('span', 'art-tag', city.hasPhoto ? city.photoSubject : city.landmark), favorite);
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
  syncDepartureCalendar();
  if (job?.temporaryExpiresAt && Date.parse(job.temporaryExpiresAt) <= Date.now()) {
    job = null;
    appliedBudget = null;
    noteText.textContent = '临时报价已到期，请重新查询。';
    if ($('#trip-dialog').open) $('#trip-dialog').close();
  }
  const origin = $('#origin').value;
  const limit = appliedBudget ?? Infinity;
  const candidateCities = cities.filter(city => (!job || city.city !== origin)
    && matchesCityKeyword(city)
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
  $('#sort').hidden = !job;
  if (!busy) {
    $('.search-submit').textContent = $('#city-search').value.trim() ? '查询匹配目的地 ↗' : '查询全部目的地 ↗';
  }
  $('#section-title').textContent = saved ? '收藏目的地' : appliedBudget !== null ? '预算内目的地' : '这周末，去这里';
  const date = $('#departure').value;
  const dateRange = date ? date + ' — ' + returnDate(date) : '请选择出发日期';
  const progress = appliedBudget !== null
    ? `${entries.length} 个目的地符合已查询预算 ${money(limit)}`
    : job ? '已按起飞时间筛选 · 点击查询应用往返预算'
      : `浏览 ${entries.length} 个目的地 · 点击查询查看往返航班和票价`;
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
    resolve: '1',
  });
  const actions = make('div', '');
  const button = make('button', 'detail round-trip-search', '去飞猪选票价套餐 ↗');
  button.type = 'button';
  const status = make('p', 'muted');
  status.setAttribute('role', 'status');
  const search = make('a', 'detail round-trip-search', '去飞猪搜索往返 ↗');
  search.target = '_blank';
  search.rel = 'noopener noreferrer';
  search.hidden = true;
  actions.append(button, status, search);
  button.onclick = async () => {
    button.disabled = true;
    search.hidden = true;
    status.textContent = '正在核对飞猪往返套餐…';
    try {
      const response = await fetch('/api/round-trip?' + params, {cache: 'no-store'});
      if (!response.ok) throw Error('暂时无法核对套餐，请重试。');
      const result = await response.json();
      if (!actions.isConnected || !$('#trip-dialog').open) return;
      if (result.status === 'matched' && result.bookingUrl) {
        status.textContent = '已找到对应套餐，正在打开飞猪…';
        window.location.assign(result.bookingUrl);
        return;
      }
      if (result.status === 'rate_limited') {
        status.textContent = `飞猪暂时限制套餐查询。建议北京时间 ${fareTime(result.retryAt)} 后重试，也可以现在打开飞猪往返搜索。`;
      } else {
        status.textContent = result.status === 'no_match'
          ? '飞猪未返回这两班对应的套餐。可打开往返搜索页按航班号查找。'
          : (result.message || '飞猪套餐暂时无法核对，可稍后重试。');
      }
      search.href = result.searchUrl;
      search.hidden = false;
    } catch {
      status.textContent = '暂时无法核对套餐，请重试。';
    } finally {
      button.disabled = false;
    }
  };
  return actions;
}

function showPlans(city, result) {
  if (job?.temporaryExpiresAt && Date.parse(job.temporaryExpiresAt) <= Date.now()) {
    render();
    return;
  }
  const box = $('#trip-content');
  const {origin} = job.query;
  const plans = plansWithinBudget(result, appliedBudget ?? Infinity);
  const title = make('h2', '', origin + ' ↔ ' + city.city);
  title.id = 'trip-title';
  $('#trip-heading').replaceChildren(
    title,
    make('p', 'muted', appliedBudget === null ? '成人 1 人'
      : `往返预算 ${money(appliedBudget)} · 成人 1 人`),
    make('p', 'muted', '价格以飞猪往返订单为准。找到与所选两班匹配的套餐后会直接打开。'),
  );
  box.replaceChildren();
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
  const dialog = $('#trip-dialog');
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.showModal();
  box.scrollTop = 0;
}

function lock(value) {
  busy = value;
  $('#departure-trigger').disabled = value;
  for (const id of ['origin', 'departure', 'departure-day', 'earliest', 'return-earliest']) $('#' + id).disabled = value;
  $('.search-submit').disabled = value;
  $('.search-submit').textContent = value ? '正在读取缓存…'
    : $('#city-search').value.trim() ? '查询匹配目的地 ↗' : '查询全部目的地 ↗';
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
  if (cache.refreshing && job?.query.cacheOnly && Object.values(job.results).some(result => result.status === 'error')) {
    noteText.textContent = '部分航线仍在采集。已有报价会显示在下方，也可以手动查询补充。';
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
  const earliest = $('#earliest').value;
  const returnEarliest = $('#return-earliest').value;
  if (!outDate || !earliest || !returnEarliest) {
    noteText.textContent = '请填写出发日期、去程和返程最早起飞时间。';
    return;
  }
  const query = {
    origin, outDate, backDate: returnDate(outDate),
    cacheOnly: limit === null,
    earliest, returnEarliest,
    destinations: cities.filter(city => city.airport && city.city !== origin && matchesCityKeyword(city)).map(city => city.city),
  };
  if (!query.destinations.length) {
    noteText.textContent = '当前搜索没有可查询的直飞机票目的地，请更换搜索词。';
    return;
  }
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
    hasSearched = true;
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
  $('#' + id).addEventListener('change', () => {
    job = null;
    appliedBudget = null;
    render();
    if (hasSearched && $('#departure').value) void loadFares(null);
  });
}
$('#budget').oninput = () => { $('#budget-value').textContent = money(budget()); };
$('#sort').onchange = render;
$('#city-search').oninput = () => {
  if (!job && !busy) noteText.textContent = '';
  render();
};
$('#city-search').onkeydown = event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('#search-form').requestSubmit();
  }
};
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
  $('#city-search').value = '';
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
setInterval(render, 60000);
