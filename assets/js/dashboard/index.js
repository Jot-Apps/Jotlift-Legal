/* The dashboard.
 *
 * THREE GATES, IN THIS ORDER, each with its own screen:
 *   1. no session            -> sign in
 *   2. entitlement 'none'    -> the upgrade screen. Free accounts get no data.
 *   3. 'active'              -> the working dashboard
 *      'lapsed'              -> the same dashboard, READ ONLY, under a banner
 *
 * Plus: active with nothing backed up yet, a loading state (row placeholders,
 * never a spinner) and a fetch failure with a retry.
 *
 * LAPSED FREEZES THE DATA, and that is a product rule rather than a UI nicety.
 * When a subscription lapses, sync stops, so the server holds nothing newer.
 * The page shows the log as it stood on the day the subscription ended and must
 * not imply it carries on.
 */

import { initTheme } from '../theme.js';
import { applyAppLink } from '../app-link.js';
import { icon } from '../icons.js';
import * as api from './api.js';
import { materialise, buildModel } from './store.js';
import { fmt, priceRow, savedCountry } from '../prices.js';
import { fromMilli, toMilli, fullDate } from './domain.js';
import * as views from './views.js';
import { buildRows, toCsv, toXlsx, download } from './export.js';

initTheme();

const root = document.querySelector('[data-dash-root]');
const esc = views.esc;

const TABS = [
  ['history', 'History'],
  ['progress', 'Progress'],
  ['exercises', 'Exercises'],
  ['routines', 'Routines'],
  ['export', 'Export'],
  ['account', 'Account'],
];

const state = {
  phase: 'boot', // boot | signedout | loading | error | none | empty | ready
  user: null,
  entitlement: null,
  expiresAt: null,
  product: null,
  cutoff: null,
  model: null,
  message: null,

  tab: 'history',
  openSession: null,
  progressExercise: null,
  metric: null,
  pickerOpen: false,
  point: null,
  exerciseQuery: '',
  selectedExercise: null,
  selectedRoutine: null,
  exportFormat: 'csv',
  exportFrom: null,
  exportTo: null,
  weightStepMilli: null,
  busy: false,
};

/* Remember the tab across a reload, the way a signed-in surface should. */
try {
  const saved = localStorage.getItem('jotlift.tab');
  if (saved && TABS.some(([id]) => id === saved)) state.tab = saved;
} catch {
  /* the default tab is fine */
}

/* ==================================================================== boot */

start();

async function start() {
  const message = await api.completeRedirect();
  if (message) state.message = message;

  if (!api.hasSession()) {
    state.phase = 'signedout';
    render();
    return;
  }
  state.user = api.currentUser();
  await load();
}

async function load() {
  state.phase = 'loading';
  render();

  try {
    const mirror = await api.entitlement();
    state.entitlement = mirror.state;
    state.expiresAt = mirror.expiresAt;
    state.product = mirror.product;

    if (mirror.state === 'none') {
      state.phase = 'none';
      render();
      return;
    }

    // A lapsed subscription stopped sync on its expiry, so nothing after that
    // day exists on the server. Freezing the read at the same moment makes the
    // page say so instead of showing a log that simply stops.
    state.cutoff = mirror.state === 'lapsed' && mirror.expiresAt
      ? new Date(mirror.expiresAt).getTime()
      : null;

    const rows = await api.pullAll();
    const model = buildModel(materialise(rows), { cutoff: state.cutoff ?? Infinity });
    state.model = model;
    state.weightStepMilli = model.weightStepMilli;
    state.user = api.currentUser();

    state.phase = model.sessions.length === 0 && model.exercises.length === 0 ? 'empty' : 'ready';
  } catch (error) {
    // A declined token is a sign-out, not a fetch failure: say the true thing.
    if (error instanceof api.ApiError && error.reason === 'auth') {
      await api.signOut();
      state.phase = 'signedout';
      state.message = 'Your session ran out. Sign in again.';
    } else {
      state.phase = 'error';
    }
  }
  render();
}

/* ================================================================== render */

function render() {
  if (state.phase === 'signedout') root.innerHTML = signedOut();
  else if (state.phase === 'loading') root.innerHTML = loading();
  else if (state.phase === 'error') root.innerHTML = failed();
  else if (state.phase === 'none') root.innerHTML = upgrade();
  else if (state.phase === 'empty') root.innerHTML = empty();
  else if (state.phase === 'ready') root.innerHTML = dashboard();
  else return;

  applyAppLink();

  // The chart opens pinned to the NEWEST session and drags back exactly as far
  // as the first, never forward past the newest.
  const scroller = root.querySelector('[data-chart-scroll]');
  if (scroller) {
    const key = [state.tab, state.progressExercise, state.metric, state.cutoff].join('|');
    if (key !== render.pinned) {
      render.pinned = key;
      scroller.scrollLeft = scroller.scrollWidth;
    }
  }
}

function notice() {
  if (!state.message) return '';
  return `<p class="notice notice--danger" style="margin-bottom:20px">${esc(state.message)}</p>`;
}

/* ------------------------------------------------------------- 1. no session */

function signedOut() {
  return `
    <section class="signin" data-state="no-session" data-condition="!session">
      <h1 class="display" style="margin:0 0 8px;font-size:clamp(26px,3.4vw,34px);line-height:1.15;letter-spacing:-0.022em">Sign in</h1>
      <p style="margin:0 0 28px" class="quiet">Your log opens in the browser. It reads what your phone has backed up.</p>
      ${notice()}
      <form class="signin__card" data-signin>
        <label class="field">
          <span class="field__label">Email</span>
          <span class="field__box"><input type="email" name="email" placeholder="you@example.com" autocomplete="email" required></span>
        </label>
        <label class="field">
          <span class="field__label">Password</span>
          <span class="field__box"><input type="password" name="password" placeholder="Your password" autocomplete="current-password" required></span>
        </label>
        <button class="btn btn--lg btn--full" type="submit" data-signin-submit>Sign in</button>
        <div class="signin__or"><span></span><span>or</span><span></span></div>
        <div style="display:flex;flex-direction:column;gap:10px">
          <button class="oauth" type="button" data-oauth="apple">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.3 12.7c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.1-2.7.8-3.4.8-.7 0-1.8-.8-3-.8-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.3 3 2.3 1.2 0 1.6-.8 3.1-.8 1.4 0 1.8.8 3 .7 1.3 0 2.1-1.2 2.9-2.3.6-.9.9-1.7 1-2.1-.1 0-2.6-1-2.6-3.8zM14.4 5.3c.6-.8 1.1-1.9 1-3-1 0-2.1.6-2.8 1.5-.6.7-1.1 1.8-1 2.9 1.1.1 2.2-.6 2.8-1.4z"/></svg>
            Continue with Apple
          </button>
          <button class="oauth" type="button" data-oauth="google">
            <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.2z"/><path fill="#34A853" d="M12 22c2.7 0 4.9-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1a6 6 0 0 1-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"/><path fill="#FBBC05" d="M6.4 14a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9L6.4 14z"/><path fill="#EA4335" d="M12 6a5.4 5.4 0 0 1 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.5l3.3 2.6A6 6 0 0 1 12 6z"/></svg>
            Continue with Google
          </button>
        </div>
        <p class="signin__foot">The app works offline with no account. If you have not signed in on your phone yet, there is nothing here to show.</p>
      </form>
    </section>`;
}

/* ----------------------------------------------------------- 2. loading */

function loading() {
  return `
    <section class="shell-dash" style="padding:48px 24px 96px" data-state="loading" data-condition="session &amp;&amp; query.isPending">
      <div class="skeleton__line"></div>
      <div class="skeleton__title"></div>
      <div class="skeleton__rows">
        <div class="skeleton__row"></div>
        <div class="skeleton__row"></div>
        <div class="skeleton__row"></div>
        <div class="skeleton__row"></div>
      </div>
      <p style="margin:24px 0 0;font-size:15px" class="quiet">Loading your log.</p>
    </section>`;
}

/* ------------------------------------------------------------- 3. failed */

function failed() {
  return `
    <section style="width:min(520px,100%);margin:0 auto;padding:80px 24px 96px" data-state="error" data-condition="session &amp;&amp; query.isError">
      <div class="card" style="border-radius:var(--radius-xl);padding:28px">
        <span class="pill pill--danger">${icon('alert', 14, 2)}Not loaded</span>
        <h1 style="margin:16px 0 8px;font-size:22px;font-weight:700;letter-spacing:-0.015em;color:var(--color-text)">We could not reach your log</h1>
        <p style="margin:0 0 20px" class="quiet">Your data is safe on your phone and in backup. This is a connection problem on this page.</p>
        <button class="btn" type="button" data-retry>Try again</button>
        <p style="margin:20px 0 0;font-size:15px" class="quiet">If it keeps happening, <a href="/support/" style="font-weight:600">email support</a>.</p>
      </div>
    </section>`;
}

/* --------------------------------------------------- 4. free, paywalled */

function upgrade() {
  const row = priceRow(savedCountry());
  return `
    <section class="shell-prose dash-gate" data-state="entitlement-none" data-condition="useEntitlement() === 'none'">
      <p style="margin:0 0 6px;font-size:15px" class="quiet">Signed in as ${esc(state.user?.email || '')}</p>
      <h1 class="display" style="margin:0 0 10px;font-size:clamp(26px,3.4vw,36px);line-height:1.14;letter-spacing:-0.022em">The dashboard is part of Pro</h1>
      <p style="margin:0 0 28px;font-size:18px;line-height:1.5;max-width:48ch" class="quiet">Your backup is safe and restoring stays free. Subscribing opens your log here.</p>

      <div class="card card--xl" style="padding:clamp(22px,3vw,32px)">
        <h2 style="margin:0 0 18px;font-size:18px;font-weight:600;color:var(--color-text)">What Pro unlocks</h2>
        <div class="gate-list">
          <div class="gate-item">
            <span class="gate-item__n">1</span>
            <p><strong>Auto progression.</strong> Three workouts at the same weight, mostly the same reps, and it tells you it is time to go up, with the count it used.</p>
          </div>
          <div class="gate-item">
            <span class="gate-item__n">2</span>
            <p><strong>Routines.</strong> Build one on a keyboard here, start it on your phone.</p>
          </div>
          <div class="gate-item">
            <span class="gate-item__n">3</span>
            <p><strong>This dashboard.</strong> Read your history, add and edit exercises, and export everything to a spreadsheet.</p>
          </div>
          <div class="gate-item">
            <span class="gate-item__n">4</span>
            <p><strong>Sync.</strong> Every device you sign in on stays current.</p>
          </div>
        </div>
        <div style="margin-top:24px;display:flex;flex-wrap:wrap;gap:14px;align-items:center">
          <a class="btn btn--lg" href="/how-it-works/#get-the-app" data-app-link>Subscribe in the app</a>
          <span style="font-size:15px" class="quiet">${esc(fmt(row, row[2]))} a month or ${esc(fmt(row, row[3]))} a year</span>
        </div>
        <p style="margin:16px 0 0;font-size:14px" class="decorative">Subscriptions are billed by your app store. No free trial.</p>
      </div>

      <p style="margin:24px 0 0;font-size:15px" class="quiet">Your free account keeps backing up, and restoring is free forever. <a href="/pricing/" style="font-weight:600">See pricing</a></p>
      <p style="margin:20px 0 0"><button class="signout" type="button" data-sign-out>Sign out</button></p>
    </section>`;
}

/* --------------------------------------------------- 5. active, no data */

function empty() {
  return `
    <section style="width:min(560px,100%);margin:0 auto;padding:96px 24px" data-state="active-empty" data-condition="entitlement === 'active' &amp;&amp; workouts.length === 0">
      <div class="empty-card">
        <span>${icon('list', 40, 1.5)}</span>
        <h1>No workouts here yet</h1>
        <p>This page reads what your phone has backed up. Sign in on the phone, log a workout, and it shows up here.</p>
        <button class="btn btn--secondary" type="button" data-retry>Reload</button>
      </div>
      <p style="margin:20px 0 0;text-align:center"><button class="signout" type="button" data-sign-out>Sign out</button></p>
    </section>`;
}

/* ------------------------------------- 6 + 7. working (active and lapsed) */

function dashboard() {
  const readOnly = state.entitlement === 'lapsed';
  const model = state.model;

  const banner = readOnly
    ? `
      <div class="dash-banner">
        ${icon('alert', 20, 1.8)}
        <div>
          <p>Your subscription has lapsed. This page is read only.</p>
          <p>It shows your log as it stood on ${esc(state.cutoff ? fullDate(state.cutoff) : 'the day the subscription ended')}, the day the subscription ended. Anything you have logged on your phone since then is on your phone, and appears here again if you resubscribe.</p>
        </div>
      </div>`
    : '';

  const body =
    state.tab === 'history'
      ? views.renderHistory(model, state)
      : state.tab === 'progress'
        ? views.renderProgress(model, state)
        : state.tab === 'exercises'
          ? views.renderExercises(model, state)
          : state.tab === 'routines'
            ? views.renderRoutines(model, state)
            : state.tab === 'export'
              ? views.renderExport(model, state)
              : views.renderAccount(model, state);

  const nav = TABS.map(
    ([id, label]) =>
      `<button type="button" data-tab="${id}" aria-current="${id === state.tab}">${label}</button>`,
  ).join('');

  return `
    <section class="shell-dash dash-wrap" style="padding-bottom:96px"
             data-state="${readOnly ? 'entitlement-lapsed' : 'entitlement-active'}"
             data-condition="${readOnly ? "useEntitlement() === 'lapsed'" : "useEntitlement() === 'active' && workouts.length > 0"}">
      ${banner}
      ${notice()}
      <div class="dash-head">
        <div>
          <p class="dash-head__email">${esc(state.user?.email || '')}</p>
          <h1>Your log</h1>
        </div>
      </div>

      <div class="dash-body">
        <nav class="dash-rail" aria-label="Dashboard">${nav}</nav>
        <div class="dash-main">${body}</div>
      </div>
    </section>
    <nav class="dash-tabbar" aria-label="Dashboard">${nav}</nav>`;
}

/* ================================================================== events */

root.addEventListener('click', onClick);
root.addEventListener('submit', onSubmit);
root.addEventListener('input', onInput);
document.addEventListener('click', (e) => {
  // A picker left open when the reader looks elsewhere.
  if (state.pickerOpen && !e.target.closest('[data-picker]')) {
    state.pickerOpen = false;
    render();
  }
});

function onClick(e) {
  const target = (selector) => e.target.closest(selector);

  const tab = target('[data-tab]');
  if (tab) {
    state.tab = tab.dataset.tab;
    state.pickerOpen = false;
    try {
      localStorage.setItem('jotlift.tab', state.tab);
    } catch {
      /* the tab just is not remembered */
    }
    render();
    return;
  }

  if (target('[data-retry]')) {
    state.message = null;
    load();
    return;
  }

  if (target('[data-sign-out]')) {
    api.signOut().then(() => {
      Object.assign(state, { phase: 'signedout', user: null, model: null, entitlement: null, message: null });
      render();
    });
    return;
  }

  const oauth = target('[data-oauth]');
  if (oauth) {
    api.signInWithOAuth(oauth.dataset.oauth).catch(() => {
      state.message = 'We could not open that sign-in. Try email and password.';
      render();
    });
    return;
  }

  const session = target('[data-session]');
  if (session) {
    state.openSession = state.openSession === session.dataset.session ? null : session.dataset.session;
    render();
    return;
  }

  if (target('[data-picker-toggle]')) {
    state.pickerOpen = !state.pickerOpen;
    render();
    return;
  }

  const pick = target('[data-pick-exercise]');
  if (pick) {
    state.progressExercise = pick.dataset.pickExercise;
    state.pickerOpen = false;
    // Re-pin and clear the pinned point: this is a different series.
    state.point = null;
    state.metric = null;
    render();
    return;
  }

  const metric = target('[data-metric]');
  if (metric) {
    state.metric = metric.dataset.metric;
    state.point = null;
    render();
    return;
  }

  const point = target('[data-point]');
  if (point) {
    // Hover or click pins a session and it STAYS pinned: a readout that vanishes
    // the moment the pointer moves is one nobody gets to finish reading.
    state.point = Number(point.dataset.point);
    render();
    return;
  }

  const exercise = target('[data-exercise]');
  if (exercise) {
    state.selectedExercise = exercise.dataset.exercise;
    render();
    return;
  }

  const routine = target('[data-routine]');
  if (routine) {
    state.selectedRoutine = routine.dataset.routine;
    render();
    return;
  }

  const format = target('[data-format]');
  if (format) {
    state.exportFormat = format.dataset.format;
    render();
    return;
  }

  if (target('[data-export-run]')) {
    runExport();
    return;
  }

  const step = target('[data-step]');
  if (step) {
    changeWeightStep(step.dataset.step === 'up' ? 0.5 : -0.5);
    return;
  }

  if (target('[data-exercise-save]')) {
    saveExerciseName();
    return;
  }

  if (target('[data-add-exercise]')) {
    state.message = 'Adding an exercise happens on your phone for now. It appears here on the next backup.';
    render();
  }
}

/* Hovering a chart point reads it out, the same as clicking it. */
root.addEventListener(
  'pointerover',
  (e) => {
    const point = e.target.closest && e.target.closest('[data-point]');
    if (!point) return;
    const index = Number(point.dataset.point);
    if (state.point === index) return;
    state.point = index;
    render();
  },
  true,
);

function onInput(e) {
  if (e.target.matches('[data-exercise-query]')) {
    state.exerciseQuery = e.target.value;
    const caret = e.target.selectionStart;
    render();
    const next = root.querySelector('[data-exercise-query]');
    if (next) {
      next.focus();
      try {
        next.setSelectionRange(caret, caret);
      } catch {
        /* a search input can refuse a selection range; the text is still right */
      }
    }
    return;
  }
  if (e.target.matches('[data-export-from]')) state.exportFrom = e.target.value;
  if (e.target.matches('[data-export-to]')) state.exportTo = e.target.value;
}

async function onSubmit(e) {
  if (!e.target.matches('[data-signin]')) return;
  e.preventDefault();
  const form = e.target;
  const button = form.querySelector('[data-signin-submit]');
  const email = form.elements.email.value.trim();
  const password = form.elements.password.value;

  button.disabled = true;
  button.textContent = 'Signing in';
  state.message = null;

  try {
    await api.signInWithPassword(email, password);
    state.user = api.currentUser();
    await load();
  } catch (error) {
    state.message =
      error.reason === 'auth'
        ? error.detail || 'That email and password did not match. Try again.'
        : 'We could not reach the server. Check your connection and try again.';
    render();
  }
}

/* ================================================================== writes */

/* The dashboard writes through the same relay the phone pushes to, so a web
 * edit lands under the same rules: the relay validates the stamp against its own
 * clock and settles the envelope applied or stale. The payload is the row the
 * app last wrote, with ONLY the edited field changed, so nothing the app stores
 * is dropped by a client that did not know about it. */

const DEVICE_KEY = 'jotlift.device';

/** This browser's device id, stable across visits, like a phone's. */
function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/* `<millis, 14 digits>-<counter, base36, 4 wide>-<device_id>`, monotonic so two
 * writes in one millisecond still order. */
let lastStamp = 0;
let lastCounter = 0;
function mintHlc() {
  const now = Date.now();
  if (now > lastStamp) {
    lastStamp = now;
    lastCounter = 0;
  } else {
    lastCounter += 1;
  }
  return `${String(lastStamp).padStart(14, '0')}-${lastCounter.toString(36).padStart(4, '0')}-${deviceId()}`;
}

/**
 * Push one edited entity. `entity` is a materialised row, which carries the
 * change it came from on `__change`, so the schema version is the one the app
 * stamped rather than a number this page invented.
 */
async function pushEntity(table, entity, changes) {
  const source = entity.__change;
  const payload = { ...entity, ...changes };
  delete payload.__change;
  const hlc = mintHlc();
  payload.hlc = hlc;
  payload.updatedAt = Date.now();
  payload.deviceId = deviceId();

  const results = await api.push([
    {
      owner_id: source.payload.ownerId ?? state.user?.id,
      table,
      id: entity.id,
      hlc,
      deleted: false,
      schema_version: source.schema_version,
      payload,
    },
  ]);

  const result = results[0]?.result;
  // 'stale' means an equal-or-newer row already won, which is a settled outcome
  // rather than a failure: something else edited it more recently.
  if (result !== 'applied' && result !== 'stale') {
    throw new api.ApiError(result === 'skew' ? 'server' : 'server');
  }
  return result;
}

function flash(selector, text) {
  const node = root.querySelector(selector);
  if (!node) return;
  node.textContent = text;
  node.hidden = false;
}

/** The one weight step. Unit-free: it is how far a button moves the number on
 *  screen, so it is never converted between kg and lb. 0.5 increments, 0.5 to
 *  999. Changing it never rewrites a weight already logged. */
async function changeWeightStep(delta) {
  if (state.entitlement !== 'active' || state.busy) return;
  const settings = state.model.settings;
  if (!settings) {
    state.message = 'Your settings have not backed up yet, so there is no step to change here.';
    render();
    return;
  }

  const current = fromMilli(state.weightStepMilli);
  const next = Math.min(999, Math.max(0.5, Math.round((current + delta) * 100) / 100));
  if (next === current) return;

  const previous = state.weightStepMilli;
  state.weightStepMilli = toMilli(next);
  state.busy = true;
  render();

  try {
    await pushEntity('settings', settings, { weightStepMilli: state.weightStepMilli });
    settings.weightStepMilli = state.weightStepMilli;
    state.model.weightStepMilli = state.weightStepMilli;
    state.busy = false;
    render();
    flash('[data-step-saved]', `Weight step saved. Every device steps by ${next} now.`);
  } catch {
    // Put the number back rather than leaving a value on screen that the server
    // never took.
    state.weightStepMilli = previous;
    state.busy = false;
    state.message = 'We could not save the weight step. Nothing changed.';
    render();
  }
}

async function saveExerciseName() {
  if (state.entitlement !== 'active' || state.busy) return;
  const input = root.querySelector('[data-exercise-name]');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;

  const exercise = state.model.exercises.find((e) => e.id === state.selectedExercise);
  if (!exercise || exercise.isBuiltin) return;
  if (name === exercise.name) return;

  state.busy = true;
  try {
    await pushEntity('exercises', exercise, {
      name,
      // The normalised name is what create-time dedup matches on, so it moves
      // with the name rather than being left pointing at the old one.
      nameNormalized: name.toLowerCase().replace(/\s+/g, ' ').trim(),
    });
    exercise.name = name;
    state.busy = false;
    render();
    flash('[data-exercise-saved]', 'Saved. Your phone picks it up on the next sync.');
  } catch {
    state.busy = false;
    state.message = 'We could not save that name. Nothing changed.';
    render();
  }
}

/* ================================================================== export */

function runExport() {
  const from = state.exportFrom ? Date.parse(`${state.exportFrom}T00:00:00`) : null;
  // The To date is inclusive, so it runs to the end of that day.
  const to = state.exportTo ? Date.parse(`${state.exportTo}T23:59:59.999`) : null;

  const rows = buildRows(state.model, { from, to });
  if (rows.length === 0) {
    flash('[data-export-done]', 'No sets in that range. Widen the dates and try again.');
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  if (state.exportFormat === 'xlsx') {
    download(toXlsx(rows), `jotlift-${stamp}.xlsx`);
  } else {
    download(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), `jotlift-${stamp}.csv`);
  }
  flash('[data-export-done]', `Exported ${rows.length.toLocaleString('en-US')} sets.`);
}
