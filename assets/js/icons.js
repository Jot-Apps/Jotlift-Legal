/* The curated line set.
 *
 * The app renders SF Symbols, which are not web-distributable. This is the
 * documented substitution named in the design system readme: a consistent-stroke
 * line set drawn in the SF Symbols family style (24x24 viewBox, 1.8 stroke,
 * round caps and joins), with geometry matching Lucide.
 *
 * The five tab glyphs map to the symbols the app registers in
 * src/app/(tabs)/_layout.tsx: dumbbell, figure.strengthtraining.traditional,
 * clock.arrow.circlepath, list.bullet.rectangle, gearshape.
 */

export const GLYPH = {
  dumbbell:
    '<path d="M14.4 14.4 9.6 9.6"/><path d="M18.657 21.485a2 2 0 1 1-2.829-2.828l-1.767 1.768a2 2 0 1 1-2.829-2.829l6.364-6.364a2 2 0 1 1 2.829 2.829l-1.768 1.767a2 2 0 1 1 2.828 2.829z"/><path d="m21.5 21.5-1.4-1.4"/><path d="M3.9 3.9 2.5 2.5"/><path d="M6.404 12.768a2 2 0 1 1-2.829-2.829l1.768-1.767a2 2 0 1 1-2.828-2.829l2.828-2.828a2 2 0 1 1 2.829 2.828l1.767-1.768a2 2 0 1 1 2.829 2.829z"/>',
  chevronR: '<path d="m9 18 6-6-6-6"/>',
  chevronD: '<path d="m6 9 6 6 6-6"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 0-9h-1.8A7 7 0 1 0 4 14.9"/><path d="m9 14 2 2 4-4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  flame: '<path d="M12 2c1.5 3 4 4.5 4 8a4 4 0 0 1-8 0c0-1 .3-1.8.8-2.5C8 9 8.5 11 10 11c0-2 0-4 2-9z"/>',
  // Not in the curated set; the Lucide trophy, which the readme names as the
  // proxy for glyphs the kit does not draw. Stands in for SF `trophy.fill`.
  trophy:
    '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  timer: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="12" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
  // WhyLine's urge state: arrow.up.circle, in success.
  upCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 16.5V8"/><path d="m8.5 11.5 3.5-3.5 3.5 3.5"/>',
  // The finish summary's new-floor badge: lock.fill, in success.
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/>',
  grip: '<path d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  figure: '<circle cx="12" cy="4.5" r="1.6"/><path d="M12 8v5"/><path d="m6 9 6 1.6L18 9"/><path d="m9 21 3-8 3 8"/>',
  clockBack:
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7.5V12l3.5 2"/>',
  clipboardList:
    '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  gear:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};

/** An icon as an SVG string. Decorative by default: a glyph is never the sole
 *  carrier of meaning, so every call site pairs it with a label. */
export function icon(name, size = 24, stroke = 1.8) {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
    ` stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"` +
    ` style="display:block;flex:0 0 auto">${GLYPH[name]}</svg>`
  );
}

/** A recessed tile holding a glyph in decorative ink (PRList.tsx). */
export function tile(name, size = 32) {
  const cls = size === 44 ? 'tile tile--44' : 'tile tile--32';
  return `<span class="${cls}">${icon(name, size === 44 ? 22 : 18)}</span>`;
}
