/* The appearance toggle.
 *
 * One semantic token set, two modes. The choice is remembered per reader and
 * applied before first paint by the inline script in each page's <head>, so a
 * light-mode reader never sees a dark flash.
 *
 * This module only wires the header button and tells the rest of the page when
 * the mode changed (the hero swaps its capture on that event).
 */

const KEY = 'jotlift.theme';

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // A reader with storage blocked still gets the toggle, just not the memory.
  }
  document.dispatchEvent(new CustomEvent('jotlift:theme', { detail: { theme } }));
}

export function initTheme() {
  const button = document.querySelector('[data-theme-toggle]');
  if (!button) return;
  button.addEventListener('click', () => {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });
}
