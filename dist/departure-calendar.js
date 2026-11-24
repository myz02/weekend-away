import {localDate} from './engine.js';

const field = document.querySelector('#departure');
const trigger = document.querySelector('#departure-trigger');
const panel = document.querySelector('#departure-calendar');
const days = document.querySelector('#calendar-days');
const previous = document.querySelector('#calendar-prev');
const next = document.querySelector('#calendar-next');
const monthLabel = document.querySelector('#calendar-month');
const dateAtNoon = value => new Date(value + 'T12:00:00');
const monthStart = (year, month) => new Date(year, month, 1, 12);
const dateLabel = new Intl.DateTimeFormat('zh-CN', {month: 'long', day: 'numeric', weekday: 'long'});
let month;

export function syncDepartureCalendar() {
  document.querySelector('#departure-display').textContent = field.value
    ? dateLabel.format(dateAtNoon(field.value))
    : '选择日期';
}

function showMonth() {
  const year = month.getFullYear();
  const number = month.getMonth();
  const firstColumn = (month.getDay() + 6) % 7;
  const today = localDate(new Date());
  monthLabel.textContent = `${year} 年 ${number + 1} 月`;
  previous.disabled = localDate(month) <= today.slice(0, 7) + '-01';
  days.replaceChildren();

  for (let i = 0; i < firstColumn; i++) days.append(document.createElement('span'));
  const count = new Date(year, number + 1, 0).getDate();
  for (let day = 1; day <= count; day++) {
    const date = new Date(year, number, day, 12);
    const value = localDate(date);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(day);
    button.setAttribute('aria-label', dateLabel.format(date));
    button.setAttribute('aria-pressed', String(value === field.value));
    const weekday = date.getDay();
    button.disabled = value < today || (weekday !== 5 && weekday !== 6);
    button.onclick = () => {
      const daySelect = document.querySelector('#departure-day');
      const dayChanged = daySelect.value !== String(weekday);
      daySelect.value = String(weekday);
      field.value = value;
      closeCalendar(true);
      syncDepartureCalendar();
      (dayChanged ? daySelect : field).dispatchEvent(new Event('change', {bubbles: true}));
    };
    days.append(button);
  }
}

function closeCalendar(restoreFocus = false) {
  panel.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger.focus();
}

trigger.onclick = () => {
  if (!panel.hidden) return closeCalendar();
  const date = dateAtNoon(field.value || field.min);
  month = monthStart(date.getFullYear(), date.getMonth());
  showMonth();
  panel.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  (days.querySelector('[aria-pressed="true"]:enabled') || days.querySelector('button:enabled') || next).focus();
};

for (const [button, offset] of [[previous, -1], [next, 1]]) {
  button.onclick = () => {
    month = monthStart(month.getFullYear(), month.getMonth() + offset);
    showMonth();
    if (button.disabled) next.focus();
  };
}

document.addEventListener('pointerdown', event => {
  if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) closeCalendar();
});
document.addEventListener('focusin', event => {
  if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) closeCalendar();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !panel.hidden) {
    event.preventDefault();
    closeCalendar(true);
  }
});
