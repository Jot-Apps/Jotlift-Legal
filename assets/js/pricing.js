/* Pricing. The plan switch, the storefront picker, and the derived lines. */

import { applyAppLink } from './app-link.js';
import { initTheme } from './theme.js';
import {
  ROWS,
  priceRow,
  savedCountry,
  saveCountry,
  fmt,
  usdMonthly,
  usdYearly,
  yearlyPerMonth,
  savePercent,
} from './prices.js';

initTheme();
applyAppLink();

const state = { plan: 'yearly', country: savedCountry(), query: '', open: false };

const el = {
  planButtons: [...document.querySelectorAll('[data-plan]')],
  country: document.querySelector('[data-country]'),
  toggle: document.querySelector('[data-country-toggle]'),
  menu: document.querySelector('[data-country-menu]'),
  list: document.querySelector('[data-country-list]'),
  query: document.querySelector('[data-country-query]'),
  name: document.querySelector('[data-country-name]'),
  code: document.querySelector('[data-country-code]'),
  echo: document.querySelector('[data-country-echo]'),
  free: document.querySelector('[data-price-free]'),
  amount: document.querySelector('[data-price-amount]'),
  per: document.querySelector('[data-price-per]'),
  note: document.querySelector('[data-price-note]'),
};

document.querySelector('[data-usd-monthly]').textContent = usdMonthly;
document.querySelector('[data-usd-yearly]').textContent = usdYearly;

function renderPrices() {
  const row = priceRow(state.country);
  const yearly = state.plan === 'yearly';
  const save = savePercent(row);

  el.name.textContent = row[0];
  el.code.textContent = row[1];
  el.echo.textContent = row[0];
  el.free.textContent = fmt(row, 0);
  el.amount.textContent = fmt(row, yearly ? row[3] : row[2]);
  el.per.textContent = yearly ? 'a year' : 'a month';
  el.note.textContent = yearly
    ? `Works out to ${fmt(row, yearlyPerMonth(row))} a month, ${save}% less than paying monthly.`
    : `${fmt(row, row[3])} a year works out ${save}% cheaper.`;

  el.planButtons.forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.plan === state.plan)),
  );
}

function renderList() {
  const q = state.query.trim().toLowerCase();
  const matches = q ? ROWS.filter((r) => r[0].toLowerCase().includes(q)) : ROWS;
  if (matches.length === 0) {
    el.list.innerHTML = '<p class="country__empty">No match. Try another country.</p>';
    return;
  }
  el.list.innerHTML = matches
    .map(
      (r) =>
        `<button type="button" role="option" data-pick="${r[0].replace(/"/g, '&quot;')}"` +
        ` aria-selected="${r[0] === state.country}"><span>${r[0]}</span><span>${r[1]}</span></button>`,
    )
    .join('');
}

function setOpen(open) {
  state.open = open;
  el.menu.hidden = !open;
  el.toggle.setAttribute('aria-expanded', String(open));
  if (open) {
    state.query = '';
    el.query.value = '';
    renderList();
    el.query.focus();
  }
}

el.planButtons.forEach((b) =>
  b.addEventListener('click', () => {
    state.plan = b.dataset.plan;
    renderPrices();
  }),
);

el.toggle.addEventListener('click', () => setOpen(!state.open));

el.query.addEventListener('input', () => {
  state.query = el.query.value;
  renderList();
});

el.list.addEventListener('click', (e) => {
  const button = e.target.closest('[data-pick]');
  if (!button) return;
  state.country = button.dataset.pick;
  saveCountry(state.country);
  setOpen(false);
  renderPrices();
});

document.addEventListener('click', (e) => {
  if (state.open && !el.country.contains(e.target)) setOpen(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.open) {
    setOpen(false);
    el.toggle.focus();
  }
});

renderPrices();
