/* Where "Get the app" and "Subscribe in the app" point.
 *
 * THE ONE PLACE TO CHANGE WHEN THE APP STORE LISTING GOES LIVE. Jotlift is on
 * TestFlight today and has no public store URL, so every one of those buttons
 * falls back to the How it works page, which explains what the app is and what
 * Pro adds. That is a real destination rather than a dead link or a button that
 * does nothing.
 *
 * Set APP_STORE_URL to the listing and every button on every page follows it.
 * Nothing else needs touching.
 */

export const APP_STORE_URL = null;

/** Point every app-store button at the listing, once there is one. */
export function applyAppLink() {
  if (!APP_STORE_URL) return;
  for (const link of document.querySelectorAll('[data-app-link]')) {
    link.setAttribute('href', APP_STORE_URL);
    link.setAttribute('rel', 'noopener');
  }
}
