import {returnDate, weekend} from './engine.js';
import {plansWithinBudget} from './budget.js';
import {syncDepartureCalendar} from './departure-calendar.js';
import {destinations as cities} from './destinations.js';
import {cityGuides} from './city-guides.js';
import {guideRouteDetails} from './guide-route-details.js';
import {guideMapLink, localCostItems, weekendCost} from './trip-planning.js';
import {shortGuideStops} from './short-guide-stops.js';
import {fitGuideDay, returnBefore, weekendWindow} from './weekend-window.js';

document.documentElement.dataset.live = '1';

const $ = selector => document.querySelector(selector);
const money = amount => '¥' + amount.toLocaleString('zh-CN', {maximumFractionDigits: 2});
function chooseHeroDestination() {
  let previous;
  try { previous = sessionStorage.getItem('weekend-hero'); } catch {}
  const panoramas = ['guilin', 'chongqing', 'qingdao', 'nanning', 'xiamen'];
  const choices = cities.filter(city => city.hasPhoto && panoramas.includes(city.id) && city.id !== previous);
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
const empty = $('#empty');
const otherCities = $('#unpriced-guides');
const budget = () => Number($('#budget').value);
const modeLabels = {flight: '飞机', rail: '高铁'};
const searchModes = () => {
  const mode = $('#travel-mode input:checked').value;
  return mode === 'compare' ? ['flight', 'rail'] : [mode];
};
let refreshTrip;

function clock(minutes) {
  const inDay = ((minutes % 1440) + 1440) % 1440;
  return [Math.floor(inDay / 60), inDay % 60].map(n => String(n).padStart(2, '0')).join(':');
}

function weekendClock(minutes) {
  const day = ['周五', '周六', '周日', '周一'][Math.floor(minutes / 1440) + 1];
  return `${day ?? ''} ${clock(minutes)}`;
}

function playTime(minutes) {
  const rounded = Math.floor(minutes / 15) * 15;
  if (rounded === 0) return minutes ? '不到 15 分钟' : '0 分钟';
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return [hours && `${hours} 小时`, remainder && `${remainder} 分钟`].filter(Boolean).join(' ');
}
function matchesCityKeyword(city) {
  const keyword = $('#city-search').value.trim().toLowerCase();
  return [city.city, city.landmark, city.id, city.airport].some(value => value?.toLowerCase().includes(keyword));
}
function quoteFor(city, mode, sort = $('#sort').value) {
  const source = job?.sources[mode];
  const result = source?.results[city.city];
  const pending = source?.pending.has(city.city);
  const latest = job?.query.latest;
  const limit = appliedBudget ?? Infinity;
  if (mode === 'flight' && !city.airport) {
    return {mode, plans: [], text: '暂无直飞查询入口'};
  }
  if (pending) return {mode, plans: [], text: '查询中…'};
  if (!result) return {mode, plans: [], text: '尚未查询', retry: !!appliedBudget};
  if (result.status === 'error') return {mode, result, plans: [], text: '暂未拿到报价', retry: true};
  if (result.status === 'unavailable') return {mode, result, plans: [], text: result.message};
  if (result.status === 'no_match') return {mode, result, plans: [], text: '没有合适班次'};
  if (result.status !== 'success') return {mode, result, plans: [], text: '暂未拿到报价', retry: true};

  const timely = (result.options ?? []).filter(plan => returnBefore(plan.inbound, latest));
  if (!timely.length) return {mode, result, plans: [], text: '没有合适班次'};
  const priced = plansWithinBudget({options: timely}, Infinity).sort((a, b) => a.total - b.total);
  if (!priced.length) return {mode, result, plans: [], text: '总价待核实'};
  const lowest = priced[0].total;
  if (lowest > limit) {
    return {mode, result, plans: [], text: `最低 ${money(lowest)}，差 ${money(Math.round((lowest - limit) * 100) / 100)}`};
  }
  const plans = plansWithinBudget({options: priced}, limit);
  if (sort === 'play') {
    plans.sort((a, b) => (weekendWindow(b, mode)?.usableMinutes ?? -1) - (weekendWindow(a, mode)?.usableMinutes ?? -1)
      || a.total - b.total);
  }
  return {mode, result, plans};
}

function retryButton(city, quote) {
  const button = make('button', 'quote-retry', '补查');
  button.type = 'button';
  button.setAttribute('aria-label', `补查${city.city}${modeLabels[quote.mode]}`);
  button.onclick = () => void requestQuotes(job, quote.mode, [city.city]);
  return button;
}

function createQuote(city, quote) {
  const {mode, plans, result, text} = quote;
  const quoteBox = make('div', 'transport-quote');
  quoteBox.append(make('strong', 'quote-mode', modeLabels[mode]));
  const plan = plans[0];
  if (!plan) {
    quoteBox.append(make('p', 'quote-caption', text));
    if (quote.retry) quoteBox.append(retryButton(city, quote));
    return quoteBox;
  }
  const timing = weekendWindow(plan, mode);
  const stale = Date.now() - Date.parse(result.collectedAt) > 86400000;
  quoteBox.append(
    make('b', 'quote-price', money(plan.total)),
    make('small', 'quote-caption', (mode === 'rail' ? '二等座往返' : plan.estimated ? '往返含费估算' : '往返含费')
      + (stale ? ' · 旧报价' : '')),
  );
  if (timing) {
    quoteBox.append(make('small', 'quote-play', `可玩约 ${playTime(timing.usableMinutes)}`));
  }
  return quoteBox;
}

function createCard(city, quotes) {
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
  body.append(make('h3', '', city.city));
  const guide = cityGuides[city.id];
  if (quotes.length) {
    const comparison = make('div', 'transport-quotes');
    comparison.append(...quotes.map(quote => createQuote(city, quote)));
    body.append(comparison);
  }
  if (guide || quotes.some(quote => quote.plans.length)) {
    const label = '看行程 ↗';
    const button = make('button', 'detail', label);
    button.type = 'button';
    button.setAttribute('aria-label', `${label.replace(' ↗', '')}：${city.city}`);
    button.onclick = () => showPlans(city);
    const actions = make('div', 'live-card-actions');
    actions.append(button);
    body.append(actions);
  }
  card.append(art, body);
  return card;
}

function render() {
  syncDepartureCalendar();
  const earliest = $('#earliest').value;
  const returnEarliest = $('#return-earliest').value;
  const latest = $('#return-latest').value;
  $('#time-preferences-value').textContent = [earliest && `去 ${earliest} 后`,
    returnEarliest && `回 ${returnEarliest} 后`, latest && `${latest} 前抵达`].filter(Boolean).join(' · ');
  for (const [mode, source] of Object.entries(job?.sources ?? {})) {
    const expired = new Set();
    for (const [city, result] of Object.entries(source.results)) {
      const {temporaryExpiresAt, expiresAt, ...saved} = result;
      if (Date.parse(temporaryExpiresAt ?? expiresAt) <= Date.now()) {
        source.results[city] = {...saved, status:'error', options:[], message:'临时报价已到期，可重新补查。'};
        expired.add(city);
      }
    }
    if (expired.size) refreshTrip?.(mode, expired);
  }
  const origin = $('#origin').value;
  const sort = $('#sort').value;
  const modes = job?.modes ?? [];
  const matchingCities = cities.filter(city => (!job || city.city !== origin)
    && matchesCityKeyword(city)
    && (tag === '全部' || city.tag === tag || (tag === '城市' && ['成都', '重庆', '昆明', '青岛', '厦门'].includes(city.city)))
    && (!saved || favorites.includes(city.id)))
    .map(city => {
      const quotes = modes.map(mode => quoteFor(city, mode, sort));
      const priced = quotes.filter(quote => quote.plans.length);
      return {
        city, quotes, priced: priced.length > 0,
        total: Math.min(...priced.map(quote => quote.plans[0].total)),
        playable: Math.max(...priced.map(quote => weekendWindow(quote.plans[0], quote.mode)?.usableMinutes ?? -1)),
      };
    });
  const filtered = appliedBudget !== null;
  const entries = matchingCities.filter(entry => !filtered || entry.priced);
  const others = filtered ? matchingCities.filter(entry => !entry.priced) : [];
  if (sort === 'price') entries.sort((a, b) => a.total - b.total);
  if (sort === 'play') entries.sort((a, b) => b.playable - a.playable || a.total - b.total);
  $('#budget-value').textContent = money(budget());
  $('#fav-count').textContent = favorites.length;
  $('#sort').hidden = !job;
  if (!busy) {
    $('.search-submit').textContent = '查往返报价';
  }
  $('#section-title').textContent = saved ? '收藏目的地' : filtered ? '预算内目的地' : '目的地';
  const date = $('#departure').value;
  const shortDate = value => value.slice(5).replace('-', '/');
  const dateRange = date ? shortDate(date) + '–' + shortDate(returnDate(date)) : '请选择出发日期';
  const progress = filtered ? `${entries.length} 个目的地有 ${money(appliedBudget)} 内的往返报价`
    : `${entries.length} 个目的地`;
  $('#result-summary').textContent = `${origin}出发 · ${dateRange} · ${progress}`;
  $('#cards').replaceChildren(...entries.map(({city, quotes}) => createCard(city, quotes)));
  otherCities.hidden = !others.length;
  otherCities.querySelector('summary').textContent = `查看其他 ${others.length} 个目的地的报价状态`;
  $('#unpriced-guide-cards').replaceChildren(...others.map(({city, quotes}) => createCard(city, quotes)));
  empty.hidden = entries.length > 0 || (busy && filtered);
  empty.querySelector('h3').textContent = filtered ? '目前没有预算内的往返报价' : '没有符合当前筛选的目的地';
  empty.querySelector('p').textContent = filtered
    ? '展开下方目的地，可查看差多少预算、没有合适班次或暂未拿到报价。'
    : '试试更换搜索词或目的地分类。';
}

function flightBreakdown(direction, flight, mode) {
  const section = make('section', 'flight-breakdown');
  section.append(
    make('p', '', `${direction} ${flight.date} · ${flight.number} · ${flight.departureTime} → ${flight.arrivalTime}${flight.nextDay ? '（次日）' : ''}`),
    make('p', 'muted', mode === 'rail' ? `${flight.departureAirport} → ${flight.arrivalAirport}`
      : `${flight.departureAirport}（${flight.depAirportCode}） → ${flight.arrivalAirport}（${flight.arrAirportCode}）`),
  );
  if (mode === 'rail') {
    section.append(make('p', 'fee-line', `二等座 ${money(flight.fare)} · ${flight.seats === '有' ? '有余票' : '余票 ' + flight.seats + ' 张'}`));
    return section;
  }
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

function railBooking(url) {
  const link = make('a', 'detail round-trip-search', '去 12306 查往返 ↗');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function sourceLink({title, url}) {
  const link = make('a', '', title + ' ↗');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function renderWeekendCost(selection, values) {
  const panel = make('details', 'guide-notes trip-cost');
  panel.append(make('summary', '', '周末花费参考'));
  const breakdown = make('div', 'trip-cost-breakdown');
  const total = make('output', 'trip-cost-total');
  total.setAttribute('aria-live', 'polite');
  const quote = selection?.plan.total;
  const knownFare = Number.isFinite(quote);
  const fare = make('p', 'trip-cost-fare');
  if (knownFare) {
    fare.append(make('span', '', `${modeLabels[selection.mode]}往返报价`), make('strong', '', money(quote)));
  } else fare.textContent = '往返交通待查询';
  panel.append(fare, make('p', 'muted trip-cost-note', '成人 1 人。以下是可修改的预留金额，住宿按一晚填写。'), breakdown, total);

  function renderTotal() {
    const sums = weekendCost(values, quote);
    if (!sums) {
      total.textContent = '请填写各项金额，填 0 可跳过该项。';
      return;
    }
    total.replaceChildren(
      make('span', '', knownFare ? '周末合计参考' : '本地花费小计'),
      make('strong', '', money(sums.total ?? sums.local)),
    );
  }

  for (const {id, label} of localCostItems) {
    const row = make('label', 'trip-cost-row');
    const input = make('input', '');
    input.type = 'number';
    input.inputMode = 'decimal';
    input.min = '0';
    input.max = '50000';
    input.step = '0.01';
    input.value = values[id];
    input.setAttribute('aria-label', label);
    input.oninput = () => {
      values[id] = input.value;
      renderTotal();
    };
    row.append(make('span', '', label), input);
    breakdown.append(row);
  }
  renderTotal();
  return panel;
}

function renderGuideDays(route, city, days, timing) {
  const sections = days.map((day, index) => {
    const window = timing?.days[index];
    const itinerary = fitGuideDay(day, index, window, shortGuideStops[city.id]?.[index] ?? '住宿附近街区');
    const details = itinerary === day
      ? guideRouteDetails[city.id]?.[day.title]
      : {stay: ['30–60 分钟'], legs: []};
    const section = make('section', 'guide-day');
    section.append(make('h3', '', `Day ${index + 1} · ${itinerary.title}`));
    if (window?.usableMinutes > 0) {
      section.append(make('p', 'guide-hours', `预计游玩时段 ${clock(window.start)}–${clock(window.end)}`));
    }
    const stops = make('ol', 'guide-route');
    for (const [position, stop] of itinerary.stops.entries()) {
      const item = make('li', '');
      const visit = make('div', 'guide-stop');
      visit.append(make('strong', '', stop));
      const stay = details?.stay[position];
      if (stay) {
        const duration = make('small', 'guide-stay');
        duration.append(make('span', 'sr-only', '建议停留 '), stay);
        visit.append(duration);
      }
      item.append(visit);
      if (position < itinerary.stops.length - 1) {
        const leg = make('div', 'guide-leg');
        const arrow = make('span', '', '↓');
        arrow.setAttribute('aria-hidden', 'true');
        const distance = details?.legs[position] ?? '查看地图';
        const map = guideMapLink(city, stop, itinerary.stops[position + 1], distance);
        const link = sourceLink({title: distance, url: map.url});
        link.setAttribute('aria-label', map.label);
        leg.append(arrow, link);
        item.append(leg);
      }
      stops.append(item);
    }
    if (stops.childElementCount) section.append(stops);
    section.append(make('p', 'muted guide-day-intro', itinerary.tip));
    return section;
  });
  route.replaceChildren(...sections);
}

function renderGuide(box, city, guide, selection, costValues) {
  const plan = selection?.plan;
  const timing = plan && weekendWindow(plan, selection.mode);
  const notes = make('details', 'guide-notes');
  notes.append(make('summary', '', '住宿与返程'));
  notes.append(make('p', 'muted', guide.notes ?? `住宿可选${guide.stay}。`),
    make('p', 'muted', guide.returnTip));
  if (guide.travelLink) notes.append(sourceLink(guide.travelLink));
  const estimate = make('p', 'guide-estimate');
  if (timing) {
    estimate.append(
      make('strong', '', `预计可玩 ${playTime(timing.usableMinutes)}`),
      make('span', '', `${weekendClock(timing.leaveForReturn)} 前出发返程`),
    );
    notes.append(
      make('p', 'muted', `去 ${plan.outbound.number} · 回 ${plan.inbound.number}。预计 ${weekendClock(timing.arrivalInTown)} 到市区。若最后一站在市区，建议 ${weekendClock(timing.lastStopEnd)} 前结束游玩，取行李后于 ${clock(timing.leaveForReturn)} 前出发去${plan.inbound.departureAirport}。`),
      make('p', 'muted', `到达后预留出站和接驳约 ${timing.exitBuffer + timing.arrivalTransfer} 分钟。返程预留取行李 ${timing.luggageBuffer} 分钟、接驳约 ${timing.returnTransfer} 分钟，并建议提前 ${timing.departureBuffer} 分钟到场。游玩窗口按周六、周日 09:00–21:00 估算。若最后一站在远郊景区或岛上，请另留回城或离岛时间。`),
    );
  }
  const versions = make('div', 'city-detail-options guide-options');
  versions.setAttribute('role', 'group');
  versions.setAttribute('aria-label', '攻略版本');
  const relaxed = make('button', '', '休闲版');
  const compact = make('button', '', '特种兵版');
  const route = make('div', '');
  route.id = 'guide-days';
  route.setAttribute('aria-live', 'polite');
  const selectVersion = isCompact => {
    relaxed.setAttribute('aria-pressed', String(!isCompact));
    compact.setAttribute('aria-pressed', String(isCompact));
    renderGuideDays(route, city, isCompact ? guide.compactDays : guide.days, timing);
  };
  for (const button of [relaxed, compact]) {
    button.type = 'button';
    button.setAttribute('aria-controls', route.id);
  }
  relaxed.onclick = () => selectVersion(false);
  compact.onclick = () => selectVersion(true);
  versions.append(relaxed, compact);
  selectVersion(false);
  box.append(versions);
  if (timing) box.append(estimate);
  box.append(route, renderWeekendCost(selection, costValues), notes);
}

function showPlans(city) {
  const guide = cityGuides[city.id];
  const modes = job?.modes ?? searchModes();
  const quotes = modes.map(mode => quoteFor(city, mode));
  const priced = quotes.filter(quote => quote.plans.length);
  const first = priced.reduce((best, candidate) => {
    const price = candidate.plans[0].total - best.plans[0].total;
    if ($('#sort').value !== 'play') return price < 0 ? candidate : best;
    const duration = quote => weekendWindow(quote.plans[0], quote.mode)?.usableMinutes ?? -1;
    return duration(candidate) > duration(best) || (duration(candidate) === duration(best) && price < 0) ? candidate : best;
  }, priced[0]);
  const dialog = $('#trip-dialog');
  const box = $('#trip-content');
  const title = make('h2', '', city.city);
  title.id = 'trip-title';
  const heading = $('#trip-heading');
  heading.replaceChildren(title);
  dialog.setAttribute('aria-labelledby', title.id);

  let activeMode = first?.mode ?? modes[0];
  let selection = first && {mode: first.mode, plan: first.plans[0]};
  const costValues = Object.fromEntries(localCostItems.map(({id, amount}) => [id, String(amount)]));
  let showingGuide;
  const tabs = make('div', 'city-detail-options transport-tabs');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', '选择交通方案');
  const details = make('div', '');
  details.id = 'transport-options';

  function renderMode() {
    for (const button of tabs.children) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === activeMode));
    }
    details.replaceChildren();
    const quote = quoteFor(city, activeMode);
    const {plans, result} = quote;
    const rail = activeMode === 'rail';
    if (!plans.length) {
      details.append(make('p', 'muted', quote.text));
      if (result?.message && result.message !== quote.text) details.append(make('p', 'muted', result.message));
      if (quote.retry && job) details.append(retryButton(city, quote));
      if (result?.searchUrl) details.append(railBooking(result.searchUrl));
      else if (result && !rail) {
        const {origin, outDate, backDate} = job.query;
        const params = new URLSearchParams({origin, destination: city.city, outDate, backDate});
        details.append(sourceLink({title: '去飞猪查往返', url: '/api/round-trip?' + params}));
      }
      return;
    }
    details.append(make('p', 'muted', rail
      ? '铁路 12306 · 二等座，余票及成交价以购票页为准。'
      : '飞猪 FlyAI · 含机建燃油，成交价以购票页为准。'));
    for (const [index, plan] of plans.entries()) {
      const row = make('div', 'trip-summary');
      row.append(
        make('b', '', `方案 ${index + 1} · ${plan.estimated ? '往返估算' : '往返总价'} ${money(plan.total)}`),
        flightBreakdown('去程', plan.outbound, activeMode), flightBreakdown('返程', plan.inbound, activeMode),
      );
      if (guide && weekendWindow(plan, activeMode)) {
        const view = make('button', 'detail guide-plan-button', '用这组班次看攻略');
        view.type = 'button';
        view.onclick = () => {
          selection = {mode: activeMode, plan};
          selectGuide(true);
          play.focus();
        };
        row.append(view);
      }
      if (rail) {
        row.append(railBooking(result.searchUrl || 'https://www.12306.cn/'));
      } else row.append(roundTripBooking(city.city, job.query, plan));
      details.append(row);
    }
    if (result.collectedAt) details.append(make('p', 'muted', '采集时间 ' + fareTime(result.collectedAt)));
  }

  for (const mode of modes) {
    const button = make('button', '', modeLabels[mode]);
    button.type = 'button';
    button.dataset.mode = mode;
    button.setAttribute('aria-controls', details.id);
    button.onclick = () => {
      activeMode = mode;
      const plan = quoteFor(city, mode).plans[0];
      selection = plan && {mode, plan};
      renderMode();
    };
    tabs.append(button);
  }
  const nav = make('div', 'city-detail-options');
  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', '城市详情');
  const transport = make('button', '', '交通');
  const play = make('button', '', '游玩');
  for (const button of [transport, play]) {
    button.type = 'button';
    button.setAttribute('aria-controls', box.id);
  }
  function selectGuide(showGuide) {
    showingGuide = showGuide;
    transport.setAttribute('aria-pressed', String(!showGuide));
    play.setAttribute('aria-pressed', String(showGuide));
    box.replaceChildren();
    if (showGuide) renderGuide(box, city, guide, selection, costValues);
    else {
      if (modes.length > 1) box.append(tabs);
      box.append(details);
      renderMode();
    }
    box.scrollTop = 0;
  }
  refreshTrip = (mode, expired) => {
    if (!dialog.open) return;
    if (showingGuide && selection?.mode === mode && expired?.has(city.city)) {
      selection = null;
      selectGuide(true);
    } else if (!showingGuide && mode === activeMode && (!expired || expired.has(city.city))) {
      renderMode();
    }
  };
  transport.onclick = () => selectGuide(false);
  play.onclick = () => selectGuide(true);
  if (guide) {
    nav.append(transport, play);
    heading.append(nav);
  }
  selectGuide(!!guide && !first);
  dialog.showModal();
}

function lock(value) {
  busy = value;
  $('#departure-trigger').disabled = value;
  $('#travel-mode').disabled = value;
  for (const id of ['origin', 'departure', 'departure-day', 'earliest', 'return-earliest', 'return-latest']) $('#' + id).disabled = value;
  $('.search-submit').disabled = value;
  $('.search-submit').textContent = value ? '正在读取缓存…'
    : $('#city-search').value.trim() ? '查询匹配目的地 ↗' : '查询全部目的地 ↗';
}

function fareTime(value) {
  return new Date(value).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false,
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
}

async function requestQuotes(search, mode, destinations, cacheOnly = false) {
  if (!search || job !== search || !destinations.length) return;
  const source = search.sources[mode];
  const requested = destinations.filter(city => !source.pending.has(city));
  if (!requested.length) return;
  for (const city of requested) source.pending.add(city);
  render();
  refreshTrip?.(mode);
  try {
    const query = {...search.query, mode, cacheOnly, destinations: requested};
    const response = await fetch('/api/search', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(query),
    });
    const data = await response.json();
    if (!response.ok) {
      for (const city of requested) {
        source.results[city] = data.code === 'RAIL_NOT_ON_SALE'
          ? {status: 'unavailable', message: '铁路返程尚未开售'}
          : {status: 'error', message: data.error || '查询未能完成，请重试。'};
      }
      return;
    }
    for (const city of requested) {
      source.results[city] = data.results?.[city] ?? {status: 'error'};
    }
    if (job === search && mode === 'flight' && !cacheOnly && !data.temporaryExpiresAt &&
      Object.values(data.results ?? {}).some(result => result.status === 'success')) {
      try { localStorage.setItem('weekend-last-cache', JSON.stringify(data)); } catch {}
    }
  } catch {
    for (const city of requested) {
      source.results[city] = {status: 'error', message: '暂时无法连接查询服务，请稍后补查。'};
    }
  } finally {
    for (const city of requested) source.pending.delete(city);
    if (job === search) {
      render();
      refreshTrip?.(mode);
    }
  }
}

async function loadFares(limit) {
  if (busy) return;
  if (!available) {
    noteText.textContent = '票价查询服务未连接。请使用本机网页查询。';
    return;
  }
  const origin = $('#origin').value;
  const outDate = $('#departure').value;
  const earliest = $('#earliest').value;
  const returnEarliest = $('#return-earliest').value;
  const latest = $('#return-latest').value;
  if (!outDate || !earliest || !returnEarliest) {
    noteText.textContent = '请填写出发日期、去程和返程最早出发时间。';
    return;
  }
  if (latest && latest <= returnEarliest) {
    noteText.textContent = '周日最晚抵达时间需要晚于返程出发时间。';
    return;
  }
  const modes = searchModes();
  const queriedModes = limit === null ? modes.filter(mode => mode === 'flight') : modes;
  if (!queriedModes.length) return;
  const destinations = cities.filter(city => city.city !== origin && matchesCityKeyword(city));
  const byMode = Object.fromEntries(queriedModes.map(mode =>
    [mode, destinations.filter(city => mode === 'rail' || city.airport).map(city => city.city)]));
  if (!Object.values(byMode).some(list => list.length)) {
    noteText.textContent = '当前搜索没有可查询的线路，请更换交通方式或搜索词。';
    return;
  }
  const query = {origin, outDate, backDate: returnDate(outDate), earliest, returnEarliest, ...(latest ? {latest} : {})};
  const sources = Object.fromEntries(modes.map(mode => [mode, {results: {}, pending: new Set()}]));
  const search = {query, modes, sources};
  job = search;
  appliedBudget = limit;
  otherCities.open = destinations.length === 1;
  if ($('#trip-dialog').open) $('#trip-dialog').close();
  lock(true);
  noteText.textContent = limit === null ? '正在读取机票缓存…' : '正在查询往返报价，先返回的结果会先显示。';
  try {
    await Promise.all(queriedModes.map(mode => requestQuotes(search, mode, byMode[mode], limit === null)));
    hasSearched = true;
    noteText.textContent = '';
  } finally {
    lock(false);
    render();
  }
}

$('#search-form').onsubmit = event => {
  event.preventDefault();
  void loadFares(budget());
};

for (const id of ['origin', 'departure', 'departure-day', 'earliest', 'return-earliest', 'return-latest']) {
  $('#' + id).addEventListener('change', () => {
    job = null;
    appliedBudget = null;
    if ($('#trip-dialog').open) $('#trip-dialog').close();
    render();
    if (hasSearched && $('#departure').value && searchModes().includes('flight')) void loadFares(null);
  });
}
$('#travel-mode').onchange = () => {
  job = null;
  appliedBudget = null;
  if ($('#trip-dialog').open) $('#trip-dialog').close();
  noteText.textContent = '';
  render();
};

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
  if ($('#return-latest').value) {
    $('#return-latest').value = '';
    job = null;
  }
  appliedBudget = null;
  document.querySelectorAll('[data-tag]').forEach(item => item.classList.toggle('selected', item.dataset.tag === tag));
  setSaved(false);
};
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
    noteText.textContent = '';
  }
  else noteText.textContent = '票价缓存服务尚未就绪';
} catch {
  noteText.textContent = '当前网址未连接本机采集服务。请使用本机 http://127.0.0.1:4173/。';
}

try {
  const previous = JSON.parse(localStorage.getItem('weekend-last-cache'));
  if (previous?.status === 'complete' && previous.query?.returnEarliest &&
      previous.query.origin === $('#origin').value && coveredDates.includes(previous.query.outDate)) {
    const {query} = previous;
    const day = new Date(query.outDate + 'T12:00:00').getDay();
    $('#departure-day').value = String(day);
    $('#departure').min = weekend(new Date(), day);
    $('#departure').value = query.outDate;
    $('#earliest').value = query.earliest;
    $('#return-earliest').value = query.returnEarliest;
    $('#return-latest').value = query.latest ?? '';
    render();
  }
} catch {}
setInterval(render, 15000);
