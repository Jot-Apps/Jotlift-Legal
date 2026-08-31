/* Home. The hero phone walk, and the two live price lines. */

import { applyAppLink } from './app-link.js';
import { initTheme, currentTheme } from './theme.js';
import { priceRow, savedCountry, heroPriceLine, proPriceLine } from './prices.js';

initTheme();
applyAppLink();

/* ---------------------------------------------------------------- the price */

const row = priceRow(savedCountry());
const heroPrice = document.querySelector('[data-hero-price]');
if (heroPrice) heroPrice.textContent = heroPriceLine(row);
const proPrice = document.querySelector('[data-pro-price]');
if (proPrice) proPrice.textContent = proPriceLine(row);

/* ---------------------------------------------------------------- the phone */

/*
 * The four subjects, in the founder's order, as REAL captures rather than a
 * redrawn mock: the logger, the chart, the routines and the log.
 *
 * The dark capture shows in dark mode and the light one in light mode, and THE
 * CYCLE IS THE SAME FOUR SUBJECTS EITHER WAY: the position is an index into
 * this list, not into a per-mode subset, so flipping the theme swaps the image
 * under the frame and leaves the subject, the order and the timer where they
 * were.
 */
const SHOTS = [
  ['Logging a set', '/assets/img/screens/logger-dark.png', '/assets/img/screens/logger-light.png'],
  ['Progress by exercise', '/assets/img/screens/chart-dark.png', '/assets/img/screens/chart-light.png'],
  ['Routines', '/assets/img/screens/routines-dark.png', '/assets/img/screens/routines-light.png'],
  ['Workout history', '/assets/img/screens/history-dark.png', '/assets/img/screens/history-light.png'],
];

const track = document.querySelector('[data-hero-track]');
const dots = document.querySelector('[data-hero-dots]');

if (track && dots) {
  const n = SHOTS.length;
  let at = 0;

  track.style.width = n * 100 + '%';
  track.innerHTML = SHOTS.map(
    ([label], i) =>
      `<div class="phone__panel" style="flex:0 0 ${100 / n}%"><img alt="${label}, in the Jotlift app" data-shot="${i}"${i === 0 ? '' : ' loading="lazy"'}></div>`,
  ).join('');

  dots.innerHTML = SHOTS.map(
    ([label], i) =>
      `<button type="button" role="tab" data-dot="${i}" aria-label="${label}" title="${label}"></button>`,
  ).join('');

  const imgs = [...track.querySelectorAll('img')];
  const buttons = [...dots.querySelectorAll('button')];

  /** Serve the dark capture in dark mode and the light one in light mode. The
   *  subject and the position are untouched: only the image swaps. */
  function paintShots() {
    const dark = currentTheme() === 'dark';
    imgs.forEach((img, i) => {
      const src = dark ? SHOTS[i][1] : SHOTS[i][2];
      if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    });
  }

  function show(index) {
    at = ((index % n) + n) % n;
    track.style.transform = `translateX(-${(at * 100) / n}%)`;
    buttons.forEach((b, i) => b.setAttribute('aria-current', String(i === at)));
  }

  buttons.forEach((b, i) =>
    b.addEventListener('click', () => {
      show(i);
      restart();
    }),
  );

  /* Slow enough to read one screen, and stopped while the tab is hidden. */
  let timer = null;
  function restart() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (document.hidden) return;
      show(at + 1);
    }, 4600);
  }

  document.addEventListener('jotlift:theme', paintShots);

  paintShots();
  show(0);
  restart();
}
