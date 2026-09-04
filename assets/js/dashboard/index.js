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

// FIRST, and it has to stay first: this module throws when the page is framed,
// which aborts this one before a single line below it runs. See frame-guard.js.
import './frame-guard.js';
import { initTheme } from '../theme.js';
import { applyAppLink } from '../app-link.js';
import { icon } from '../icons.js';
import * as api from './api.js';
import { materialise, buildModel } from './store.js';
import { fmt, priceRow, savedCountry } from '../prices.js';
import {
  fromMilli,
  toMilli,
  convertMilli,
  countsAsWorking,
  fullDate,
  normalizeName,
  defaultIncrementMilli,
} from './domain.js';
import * as views from './views.js';
import { routineBlocks } from './views.js';
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
  // The routine exercises whose plan is open. Kept here rather than in the DOM
  // so a save, which rebuilds the page from the feed, leaves them open.
  openRoutineItems: new Set(),
  // The handle to put the keyboard back on after a reorder re-renders the list.
  focusGrip: null,
  // Grouping a superset is a mode: the exercise it started from, and what has
  // been picked so far. Null when the routine is being edited normally.
  supersetSource: null,
  supersetPicked: new Set(),
  exportFormat: 'csv',
  exportFrom: null,
  exportTo: null,
  weightStepMilli: null,
  busy: false,
  rows: [],
  creatingExercise: false,
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

    const rows = await api.readFeed();
    state.rows = rows;
    const model = buildModel(materialise(rows), { cutoff: state.cutoff ?? Infinity });
    state.model = model;
    state.weightStepMilli = model.weightStepMilli;
    state.user = api.currentUser();

    state.phase = model.sessions.length === 0 && model.exercises.length === 0 ? 'empty' : 'ready';
    if (state.phase === 'ready' && state.tab === 'routines') {
      render();
      // The same conversion the app runs when it opens a routine, so the two
      // surfaces are looking at one plan rather than at two descriptions of it.
      await ensurePlannedSets(shownRoutineId());
    }
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

  /* A reorder rebuilds the list, and a fresh button never has the focus the one
   * it replaced was holding. Without this, moving a row with the keyboard moves
   * it once and then drops you at the top of the page. */
  if (state.focusGrip) {
    const grip = root.querySelector(`[data-routine-block="${CSS.escape(state.focusGrip)}"] [data-routine-grip]`);
    state.focusGrip = null;
    if (grip) grip.focus();
  }

  /* The chart opens pinned to the NEWEST session and drags back exactly as far
   * as the first, never forward past the newest. It re-pins only when the SERIES
   * changes: another exercise, another metric, a new cutoff.
   *
   * On any other re-render the reader's own scroll position is put back. A
   * re-render replaces the scroller, and a fresh element starts at 0, so without
   * this a reader who had dragged back through a year of history was returned to
   * the start by something as incidental as saving a name. */
  const scroller = root.querySelector('[data-chart-scroll]');
  if (scroller) {
    const key = [state.tab, state.progressExercise, state.metric, state.cutoff].join('|');
    if (key !== render.pinned) {
      render.pinned = key;
      scroller.scrollLeft = scroller.scrollWidth;
    } else if (render.scrollLeft) {
      scroller.scrollLeft = render.scrollLeft;
    }
    scroller.addEventListener('scroll', () => {
      render.scrollLeft = scroller.scrollLeft;
    });
  }
}

/**
 * Move the guide, the dot and the readout to a point, WITHOUT re-rendering.
 * Each hit target carries its own geometry, so this is three style writes; a
 * re-render would replace the scroller and lose the reader's place.
 */
function pickPoint(index, hit) {
  state.point = index;
  const guide = root.querySelector('[data-chart-guide]');
  const dot = root.querySelector('[data-chart-pick]');
  const readout = root.querySelector('[data-chart-readout]');
  if (!guide || !dot || !readout) return;
  guide.style.left = hit.dataset.left;
  dot.style.left = hit.dataset.left;
  dot.style.top = hit.dataset.top;
  guide.hidden = false;
  dot.hidden = false;
  readout.textContent = hit.dataset.readout;
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
    <nav class="dash-tabbar" aria-label="Dashboard">${nav}</nav>
    ${views.confirmDialog()}`;
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

  /* The confirm's own arms, ahead of everything: while it is open nothing behind
     it is reachable anyway, and this is the one place a deletion runs. */
  if (target('[data-confirm-cancel]')) {
    closeConfirm();
    return;
  }
  if (target('[data-confirm-go]')) {
    const run = pendingConfirm;
    closeConfirm();
    run?.();
    return;
  }
  // A click on the dialog itself landed on its backdrop, which is a no.
  if (e.target.matches('[data-confirm]')) {
    closeConfirm();
    return;
  }

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
    if (state.tab === 'routines') ensurePlannedSets(shownRoutineId());
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
    pickPoint(Number(point.dataset.point), point);
    return;
  }

  const exercise = target('[data-exercise]');
  if (exercise) {
    // Clicking the open one closes it, so the panel is never stuck open.
    const id = exercise.dataset.exercise;
    state.selectedExercise = state.selectedExercise === id ? null : id;
    state.creatingExercise = false;
    render();
    return;
  }

  if (target('[data-add-exercise]')) {
    state.creatingExercise = true;
    state.selectedExercise = null;
    render();
    root.querySelector('[data-exercise-create] [data-field="name"]')?.focus();
    return;
  }
  if (target('[data-exercise-create-cancel]')) {
    state.creatingExercise = false;
    render();
    return;
  }
  if (target('[data-exercise-create-save]')) {
    createExercise();
    return;
  }
  if (target('[data-exercise-cancel]')) {
    state.selectedExercise = null;
    render();
    return;
  }
  const exSave = target('[data-exercise-save]');
  if (exSave) {
    saveExercise(exSave.dataset.exerciseSave);
    return;
  }
  const exDelete = target('[data-exercise-delete]');
  if (exDelete) {
    deleteExercise(exDelete.dataset.exerciseDelete);
    return;
  }

  const routine = target('[data-routine]');
  if (routine) {
    harvestRoutine();
    state.selectedRoutine = routine.dataset.routine;
    state.supersetSource = null;
    state.supersetPicked = new Set();
    render();
    // The same conversion the app runs when it opens a routine.
    ensurePlannedSets(state.selectedRoutine);
    return;
  }
  if (target('[data-routine-new]')) {
    createRoutine();
    return;
  }
  const rtSave = target('[data-routine-save]');
  if (rtSave) {
    saveRoutine(rtSave.dataset.routineSave);
    return;
  }
  const rtDelete = target('[data-routine-delete]');
  if (rtDelete) {
    deleteRoutine(rtDelete.dataset.routineDelete);
    return;
  }
  if (target('[data-routine-add]')) {
    addRoutineExercise();
    return;
  }
  const rtOpen = target('[data-routine-open]');
  if (rtOpen) {
    toggleRoutineItem(rtOpen);
    return;
  }
  if (target('[data-superset-add]')) {
    startSuperset(target('[data-superset-add]').closest('[data-routine-item]').dataset.routineItem);
    return;
  }
  if (target('[data-superset-remove]')) {
    ungroupRoutineItem(target('[data-superset-remove]').closest('[data-routine-item]').dataset.routineItem);
    return;
  }
  if (target('[data-superset-confirm]')) {
    groupRoutineItems();
    return;
  }
  if (target('[data-superset-cancel]')) {
    state.supersetSource = null;
    state.supersetPicked = new Set();
    render();
    return;
  }
  if (target('[data-routine-set-add]')) {
    addRoutineSet(target('[data-routine-set-add]').closest('[data-routine-item]').dataset.routineItem);
    return;
  }
  const rtSetRemove = target('[data-routine-set-remove]');
  if (rtSetRemove) {
    removeRoutineSet(rtSetRemove.closest('[data-routine-set]').dataset.routineSet);
    return;
  }
  const rtRemove = target('[data-routine-remove]');
  if (rtRemove) {
    removeRoutineItem(rtRemove.closest('[data-routine-item]').dataset.routineItem);
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

}

/* ==================================================== the destructive confirm */

/* EVERY DELETION ON THIS PAGE GOES THROUGH ONE GATE, so the idiom is identical
 * wherever it appears, the way F04's ConfirmSheet is in the app. Nothing here
 * decides what a deletion means; a caller hands over its own copy and the thing
 * to do once the reader has said yes.
 *
 * Opening it does NOT re-render. The dialog is already in the page, and every
 * field in the routine editor is uncontrolled, so a re-render to show a confirm
 * would cost the reader whatever they had typed on the way to asking for it.
 */

/** What a confirmed dialog will run. Held here rather than in `state`, which
 *  carries the data a render reads, never a callback. */
let pendingConfirm = null;

/**
 * Ask, then act. `title` is a plain question, `body` an optional one-line
 * consequence, `confirmLabel` the same verb the control that opened it used.
 */
function confirmThen({ title, body = '', confirmLabel }, run) {
  const dialog = root.querySelector('[data-confirm]');
  // A destructive control on a screen with no dialog to ask through would fall
  // back to deleting WITHOUT asking, which is the one thing this gate exists to
  // prevent. So it refuses, loudly enough to be found, and deletes nothing.
  if (!dialog) throw new Error('a destructive action with no confirm to ask through');
  pendingConfirm = run;
  dialog.querySelector('[data-confirm-title]').textContent = title;
  const bodyEl = dialog.querySelector('[data-confirm-body]');
  bodyEl.textContent = body;
  bodyEl.hidden = body === '';
  dialog.querySelector('[data-confirm-go]').textContent = confirmLabel;
  dialog.showModal();
}

function closeConfirm() {
  pendingConfirm = null;
  root.querySelector('[data-confirm]')?.close();
}

/* Escape needs no handler of its own. The dialog closes itself, and the only
 * thing that ever reads `pendingConfirm` is the confirm arm inside a dialog that
 * is open: a closed one cannot be clicked, and opening the next one re-arms it.
 * A `cancel` listener clearing it would be a guard against a state that cannot
 * be reached, which is why there is not one. */

/* ==================================================== reordering a routine */

/* A routine reorders by dragging the handle at the start of a BLOCK. The dragged
 * block follows the pointer, and the blocks it passes move out from under it AS
 * IT GOES, so what is on screen at any moment is the order that gets saved:
 * nothing is inferred afterwards from where a pointer happened to be let go. On
 * release the order is read back off the DOM and committed once.
 *
 * A BLOCK, not a row, and that is what keeps a superset whole: its members are
 * contiguous by definition, so the thing that moves is the group, and flattening
 * the blocks at the end is what keeps them together (the app's `reorderedIds`).
 *
 * Pointer events, so mouse, trackpad, touch and pen are one path rather than
 * three. The handle carries `touch-action: none`, which is what stops a touch
 * drag from scrolling the page instead of moving the block, and it is a real
 * button: the arrow keys move it for anyone not using a pointer.
 */
let drag = null;

root.addEventListener('pointerdown', (e) => {
  const grip = e.target.closest && e.target.closest('[data-routine-grip]');
  if (!grip || state.busy) return;
  const item = grip.closest('[data-routine-block]');
  const list = item && item.parentElement;
  if (!item || !list) return;
  // Stops the press turning into a text selection or a page scroll mid-drag.
  e.preventDefault();
  grip.focus();
  grip.setPointerCapture(e.pointerId);
  drag = { grip, item, list, pointerId: e.pointerId, originY: e.clientY, moved: false };
  item.classList.add('is-dragging');
  list.classList.add('is-reordering');
});

root.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dy = e.clientY - drag.originY;
  // A few pixels of travel is a press, not a drag. Only past that does releasing
  // count as a reorder worth writing.
  if (Math.abs(dy) > 3) drag.moved = true;
  drag.item.style.transform = `translateY(${dy}px)`;

  const box = drag.item.getBoundingClientRect();
  for (const sibling of drag.list.querySelectorAll(':scope > [data-routine-block]')) {
    if (sibling === drag.item) continue;
    const rect = sibling.getBoundingClientRect();
    const middle = rect.top + rect.height / 2;
    // Blocks have different heights (a superset is taller, and any plan may be
    // open), so the test is the neighbour's own middle, never a row height.
    const below = drag.item.compareDocumentPosition(sibling) & Node.DOCUMENT_POSITION_FOLLOWING;
    if (below && box.bottom > middle) {
      drag.list.insertBefore(drag.item, sibling.nextSibling);
      rebaseDrag(e);
      break;
    }
    if (!below && box.top < middle) {
      drag.list.insertBefore(drag.item, sibling);
      rebaseDrag(e);
      break;
    }
  }
});

/** The row has just taken its new slot, so it is where it belongs: drop the
 *  offset it was carrying and take this pointer position as the new origin. */
function rebaseDrag(e) {
  drag.item.style.transform = '';
  drag.originY = e.clientY;
}

function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const { item, list, moved } = drag;
  item.style.transform = '';
  item.classList.remove('is-dragging');
  list.classList.remove('is-reordering');
  drag = null;
  if (!moved) return;
  reorderRoutineItems(orderInDom(list));
}

/** The routine's exercise ids in the order the list currently shows them, read
 *  block by block so a superset's members stay together and in their own order. */
function orderInDom(list) {
  return [...list.querySelectorAll(':scope > [data-routine-block]')].flatMap((block) =>
    [...block.querySelectorAll('[data-routine-item]')].map((node) => node.dataset.routineItem),
  );
}

root.addEventListener('pointerup', endDrag);
root.addEventListener('pointercancel', endDrag);

/* The same move without a pointer. The handle says so in its own label. */
root.addEventListener('keydown', (e) => {
  const grip = e.target.closest && e.target.closest('[data-routine-grip]');
  if (!grip) return;
  const direction = e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : null;
  if (!direction) return;
  e.preventDefault();
  moveRoutineBlock(grip.closest('[data-routine-block]').dataset.routineBlock, direction);
});

/* Hovering a chart point reads it out, the same as clicking it. */
root.addEventListener(
  'pointerover',
  (e) => {
    const point = e.target.closest && e.target.closest('[data-point]');
    if (!point) return;
    const index = Number(point.dataset.point);
    if (state.point === index) return;
    pickPoint(index, point);
  },
  true,
);

/* The subtype field only means anything for a bodyweight exercise, so it
   appears and disappears with the equipment select, without a re-render. */
root.addEventListener('change', (e) => {
  if (e.target.matches('[data-equipment-select]')) {
    const panel = e.target.closest('[data-exercise-form], [data-exercise-create]');
    const subtype = panel?.querySelector('[data-subtype-field]');
    if (subtype) subtype.hidden = e.target.value !== 'bodyweight';
    return;
  }
  /* Per side is the exercise's mode, not a target, so it commits on the tick
     rather than waiting for Save: it is the same one-tap toggle the app's row
     menu carries, and there is nothing else to type alongside it. */
  if (e.target.matches('[data-per-side]')) {
    setPerSide(e.target.closest('[data-routine-item]').dataset.routineItem, e.target.checked);
    return;
  }
  const pick = e.target.closest('[data-superset-pick]');
  if (pick) {
    if (pick.checked) state.supersetPicked.add(pick.dataset.supersetPick);
    else state.supersetPicked.delete(pick.dataset.supersetPick);
    render();
  }
});

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
 * clock and settles the envelope applied or stale.
 *
 * AN EDIT ECHOES THE ROW THE APP LAST WROTE and changes only the edited field,
 * so nothing the app stores is dropped by a client that did not know about it.
 * A NEW row is built with the same field set the app's own repositories build
 * (src/db/repositories/*.ts), so the phone reads it as one of its own.
 *
 * After a successful push the envelope is appended to the feed this page already
 * holds and the model is rebuilt from it. Patching the derived structures by
 * hand would be faster and would drift; rebuilding cannot.
 */

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

function ownerId() {
  // Every row the feed carries names its owner; fall back to the token's user.
  return state.rows.find((r) => r.payload?.ownerId)?.payload.ownerId ?? state.user?.id;
}

/** The sync-kit values every new row carries (repositories/internal.ts). */
function newStamps() {
  const ts = Date.now();
  return {
    id: crypto.randomUUID(),
    ownerId: ownerId(),
    hlc: api.mintHlc(deviceId()),
    deviceId: deviceId(),
    deletedAt: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

/** The values re-stamped on every update. */
function updateStamps() {
  return { hlc: api.mintHlc(deviceId()), deviceId: deviceId(), updatedAt: Date.now() };
}

/** An envelope for one row. `deleted` follows deletedAt, as the app's does. */
function envelope(table, payload) {
  return {
    owner_id: payload.ownerId ?? ownerId(),
    table,
    id: payload.id,
    hlc: payload.hlc,
    deleted: payload.deletedAt != null,
    schema_version: state.model.schemaVersion,
    payload,
  };
}

/** An edited copy of a materialised entity, without the internal handle. */
function edited(entity, changes) {
  const payload = { ...entity, ...changes, ...updateStamps() };
  delete payload.__change;
  return payload;
}

/** A tombstone for a materialised entity (D33). */
function tombstoned(entity) {
  const payload = { ...entity, ...updateStamps(), deletedAt: Date.now() };
  delete payload.__change;
  return payload;
}

/**
 * Push a batch, then fold it into the feed and rebuild. Returns false and says
 * so on screen when the relay did not take it, leaving the page as it was.
 */
async function commit(envelopes, { failure } = {}) {
  if (envelopes.length === 0) return true;
  if (state.entitlement !== 'active' || state.busy) return false;

  state.busy = true;
  try {
    const results = await api.push(envelopes);
    // 'stale' is settled, not failed: something newer already won.
    const bad = results.find((r) => r.result !== 'applied' && r.result !== 'stale');
    if (bad) throw new api.ApiError('server');

    for (const e of envelopes) {
      state.rows.push({
        entity_table: e.table,
        entity_id: e.id,
        hlc: e.hlc,
        deleted: e.deleted,
        schema_version: e.schema_version,
        payload: e.payload,
      });
    }
    state.model = buildModel(materialise(state.rows), { cutoff: state.cutoff ?? Infinity });
    state.weightStepMilli = state.model.weightStepMilli;
    state.busy = false;
    return true;
  } catch {
    state.busy = false;
    state.message = failure || 'We could not save that. Nothing changed.';
    render();
    return false;
  }
}

function flash(selector, text) {
  const node = root.querySelector(selector);
  if (!node) return;
  node.textContent = text;
  node.hidden = false;
}

/* ---------------------------------------------------------- the weight step */

/** One value for every + and - on every weight field, the same number in kg and
 *  in lb. 0.5 increments, 0.5 to 999. Changing it never rewrites a logged set. */
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

  const ok = await commit(
    [envelope('settings', edited(settings, { weightStepMilli: toMilli(next) }))],
    { failure: 'We could not save the weight step. Nothing changed.' },
  );
  if (!ok) return;
  render();
  flash('[data-step-saved]', `Weight step saved. Every device steps by ${next} now.`);
}

/* ------------------------------------------------------------- exercises */

/** Read the open exercise form. Uncontrolled fields, so nothing re-renders
 *  while the reader types and the caret never moves. */
function readExerciseForm(scope) {
  const get = (name) => scope.querySelector(`[data-field="${name}"]`);
  return {
    name: get('name')?.value.trim() || '',
    categoryId: get('category')?.value || '',
    equipmentType: get('equipment')?.value || 'barbell',
    bodyweightSubtype: get('subtype')?.value || 'pure',
  };
}

/** The link rows that file an exercise under a muscle. Re-filing tombstones the
 *  old row and writes a new one; the relay resolves the pair on its own unique
 *  tuple (owner, exercise, category), so a repeat never collides. */
function categoryEnvelopes(exerciseId, categoryId) {
  const out = [];
  const existing = state.model.categoryLinkOf.get(exerciseId);
  if (existing && existing.categoryId === categoryId) return out;
  if (existing) out.push(envelope('exercise_categories', tombstoned(existing)));
  if (categoryId) {
    out.push(envelope('exercise_categories', { ...newStamps(), exerciseId, categoryId }));
  }
  return out;
}

async function saveExercise(id) {
  const scope = root.querySelector(`[data-exercise-form="${CSS.escape(id)}"]`);
  const exercise = state.model.exercises.find((e) => e.id === id);
  if (!scope || !exercise) return;

  const form = readExerciseForm(scope);
  if (!form.name) {
    state.message = 'An exercise needs a name.';
    render();
    return;
  }

  const changes = {
    name: form.name,
    nameNormalized: normalizeName(form.name),
    equipmentType: form.equipmentType,
    // Only bodyweight carries a subtype; anything else clears it.
    bodyweightSubtype: form.equipmentType === 'bodyweight' ? form.bodyweightSubtype : null,
    // D60 amendment: the first edit graduates a built-in to the reader's own
    // version. Same id, so its history, rules and filing all come with it.
    isBuiltin: 0,
  };

  const ok = await commit([
    envelope('exercises', edited(exercise, changes)),
    ...categoryEnvelopes(id, form.categoryId),
  ]);
  if (!ok) return;
  state.selectedExercise = null;
  render();
  flash('[data-exercise-saved]', `Saved ${form.name}. Your phone picks it up on the next sync.`);
}

async function createExercise() {
  const scope = root.querySelector('[data-exercise-create]');
  if (!scope) return;
  const form = readExerciseForm(scope);
  if (!form.name) {
    state.message = 'An exercise needs a name.';
    render();
    return;
  }

  const row = {
    ...newStamps(),
    name: form.name,
    nameNormalized: normalizeName(form.name),
    equipmentType: form.equipmentType,
    bodyweightSubtype: form.equipmentType === 'bodyweight' ? form.bodyweightSubtype : null,
    unit: state.model.displayUnit,
    // The step follows the equipment, and bodyweight is rep-only (null).
    incrementMilli: defaultIncrementMilli(form.equipmentType),
    isBuiltin: 0,
  };

  const ok = await commit([
    envelope('exercises', row),
    ...(form.categoryId
      ? [envelope('exercise_categories', { ...newStamps(), exerciseId: row.id, categoryId: form.categoryId })]
      : []),
  ]);
  if (!ok) return;
  state.creatingExercise = false;
  state.exerciseQuery = '';
  state.selectedExercise = null;
  render();
  flash('[data-exercise-saved]', `Added ${form.name}.`);
}

function deleteExercise(id) {
  const exercise = state.model.exercises.find((e) => e.id === id);
  if (!exercise) return;
  confirmThen(
    {
      title: `Delete "${exercise.name}"?`,
      body: 'Its logged sets stay in your history.',
      confirmLabel: 'Delete',
    },
    () => reallyDeleteExercise(exercise),
  );
}

async function reallyDeleteExercise(exercise) {
  const ok = await commit([envelope('exercises', tombstoned(exercise))]);
  if (!ok) return;
  state.selectedExercise = null;
  render();
  flash('[data-exercise-saved]', `Deleted ${exercise.name}. Every workout you logged with it is still there.`);
}

/* -------------------------------------------------------------- routines */

/**
 * Read the routine's uncontrolled cells into a pending patch per row.
 *
 * A structural change (add, remove, reorder) COMMITS what has been typed in the
 * same batch, rather than dropping it. It has to: a successful push rebuilds the
 * model from the feed, so anything held only in the DOM or only on the in-memory
 * object is gone the moment anything else is saved. Carrying the edit into the
 * same push is the one version of this that cannot lose a keystroke.
 *
 * The patch is kept SEPARATE from the row rather than merged into it here, so a
 * reorder and a target edit on the same row become ONE envelope. Two envelopes
 * for one entity in a batch would settle by HLC, and the loser's fields would
 * silently vanish.
 */
function harvestRoutine() {
  const detail = root.querySelector('[data-routine-detail]');
  if (!detail) return null;
  const routine = state.model.routines.find((r) => r.id === detail.dataset.routineDetail);
  if (!routine) return null;

  const nameField = detail.querySelector('[data-routine-name]');
  routine.pendingName = nameField ? nameField.value.trim() || routine.name : routine.name;

  for (const rowEl of detail.querySelectorAll('[data-routine-item]')) {
    const item = routine.items.find((i) => i.id === rowEl.dataset.routineItem);
    if (!item) continue;

    for (const setEl of rowEl.querySelectorAll('[data-routine-set]')) {
      const set = item.sets.find((s) => s.id === setEl.dataset.routineSet);
      if (set) set.pending = readPlannedSet(setEl, item.exercise, set);
    }
  }
  return routine;
}

/**
 * One planned set's fields, read off its row.
 *
 * `0` AND `null` ARE DIFFERENT ANSWERS AND BOTH SURVIVE THE TRIP. An empty
 * weight is null, which tells the logger to carry whatever was last lifted; a
 * typed 0 is a target of zero and stays 0. Reps go the other way, matching the
 * app's own builder: 0 is how a planned set says it has no rep target, so the
 * empty box and a typed 0 both store null.
 *
 * A value nobody touched is written back EXACTLY as it is stored, never as its
 * rendering. The reps box shows one number for a stored range, so re-reading it
 * as min and max would narrow a 6 to 8 the app wrote into a flat 6, on a save
 * the reader made for some other row entirely.
 */
function readPlannedSet(el, exercise, set) {
  const field = (name) => el.querySelector(`[data-set-field="${name}"]`);
  const patch = { setType: field('type')?.value || set.setType };

  const shownReps = set.repsMin ?? set.repsMax;
  const repsText = field('reps')?.value.trim() ?? '';
  if (repsText === String(shownReps ?? '')) {
    patch.targetRepsMin = set.repsMin;
    patch.targetRepsMax = set.repsMax;
  } else {
    const reps = Math.round(Number(repsText));
    // A typo keeps the target the set already had, rather than clearing it.
    const target = repsText === '' ? null : Number.isFinite(reps) ? Math.min(999, Math.max(0, reps)) : shownReps;
    patch.targetRepsMin = target ? target : null;
    patch.targetRepsMax = target ? target : null;
  }

  const weightEl = field('weight');
  if (!weightEl) {
    // A rep-only exercise draws no weight field at all (D135); it keeps whatever
    // the row stores rather than having it read off a control that is not there.
    patch.targetWeightMilli = set.weightMilli;
  } else {
    const text = weightEl.value.trim();
    const milli = text === '' ? null : toMilli(text);
    if (text === '') patch.targetWeightMilli = null;
    else if (!Number.isFinite(milli) || milli < 0) patch.targetWeightMilli = set.weightMilli;
    // Typed in the unit on screen, stored in the exercise's own unit (D31).
    else patch.targetWeightMilli = convertMilli(milli, state.model.displayUnit, exercise.unit || 'kg');
  }
  return patch;
}

/** A planned set's live values: what has been typed into it, or what it stores. */
function plannedValues(set) {
  if (set.pending) return set.pending;
  return {
    setType: set.setType,
    targetRepsMin: set.repsMin,
    targetRepsMax: set.repsMax,
    targetWeightMilli: set.weightMilli,
  };
}

/** One envelope for a routine row: its stored form, plus anything typed into it,
 *  plus whatever this action changes. Merged, so a row is written once. */
function itemEnvelope(item, extra = {}) {
  return envelope('routine_exercises', edited(item.raw, { ...(item.pending || {}), ...extra }));
}

/** The same for one planned set. */
function setEnvelope(set, extra = {}) {
  return envelope('routine_sets', edited(set.raw, { ...(set.pending || {}), ...extra }));
}

/** True when the row already holds these values, so it need not be written. */
function itemUnchanged(item, extra = {}) {
  const next = { ...(item.pending || {}), ...extra };
  return Object.entries(next).every(([k, v]) => item.raw[k] === v);
}

function setUnchanged(set, extra = {}) {
  const next = { ...(set.pending || {}), ...extra };
  return Object.entries(next).every(([k, v]) => set.raw[k] === v);
}

/** The routine's own row, when its name has been typed over. */
function routineNameEnvelopes(routine) {
  const name = routine.pendingName ?? routine.name;
  if (!name || name === routine.raw.name) return [];
  return [envelope('routines', edited(routine.raw, { name }))];
}

/**
 * Everything typed into the open routine that is not already stored: the name,
 * the exercise rows, and every planned set under them.
 *
 * A caller that writes a row itself names it in `skipItems` / `skipSets`, because
 * two envelopes for one entity in a batch settle by HLC and the loser's fields
 * go missing. The caller's own envelope already carries the pending patch.
 */
function routineEnvelopes(routine, { skipItems, skipSets } = {}) {
  const out = [...routineNameEnvelopes(routine)];
  for (const item of routine.items) {
    if (!skipItems?.has(item.id) && item.pending && !itemUnchanged(item)) out.push(itemEnvelope(item));
    for (const set of item.sets) {
      if (skipSets?.has(set.id) || !set.pending || setUnchanged(set)) continue;
      out.push(setEnvelope(set));
    }
  }
  return out;
}

/* The ceilings src/db/limits.ts puts on the same rows. Unreachable by a person,
 * and here so the web cannot write past what the phone will accept. */
const LIMITS = { exercisesPerRoutine: 200, setsPerRoutineExercise: 100 };

/** A fresh routine_sets row, with the field set the app's own repository builds. */
function newPlannedSet(routineExerciseId, orderIndex, seed = {}) {
  return {
    ...newStamps(),
    routineExerciseId,
    orderIndex,
    setType: seed.setType ?? 'working',
    targetRepsMin: seed.targetRepsMin ?? null,
    targetRepsMax: seed.targetRepsMax ?? null,
    // `??` never catches a 0, so a planned 0 reaches the row as 0.
    targetWeightMilli: seed.targetWeightMilli ?? null,
  };
}

async function createRoutine() {
  const row = { ...newStamps(), name: 'New routine' };
  const ok = await commit([envelope('routines', row)]);
  if (!ok) return;
  state.selectedRoutine = row.id;
  render();
  flash('[data-routine-saved]', 'Routine created. Name it and add exercises.');
}

async function saveRoutine(id) {
  const routine = harvestRoutine();
  if (!routine || routine.id !== id) return;

  const envelopes = routineEnvelopes(routine);
  if (envelopes.length === 0) {
    flash('[data-routine-saved]', 'Nothing to save.');
    return;
  }
  const ok = await commit(envelopes);
  if (!ok) return;
  render();
  flash('[data-routine-saved]', `Saved ${routine.pendingName ?? routine.name}. Start it on your phone.`);
}

async function addRoutineExercise() {
  const routine = harvestRoutine();
  const pick = root.querySelector('[data-routine-add-pick]');
  if (!routine || !pick?.value) return;
  if (routine.items.length >= LIMITS.exercisesPerRoutine) {
    flash('[data-routine-saved]', `A routine holds ${LIMITS.exercisesPerRoutine} exercises.`);
    return;
  }

  const row = {
    ...newStamps(),
    routineId: routine.id,
    exerciseId: pick.value,
    // At the end of the order, which is where an added thing goes.
    orderIndex: routine.items.length,
    targetSets: null,
    targetRepsMin: null,
    targetRepsMax: null,
    supersetGroupId: null,
    perSide: 0,
  };

  const ok = await commit([
    ...routineEnvelopes(routine),
    envelope('routine_exercises', row),
    // One working set, seeded from history, exactly as addExerciseToRoutine
    // does: a routine is usually written around what is already happening.
    envelope('routine_sets', newPlannedSet(row.id, 0, ghostSeed(pick.value))),
  ]);
  if (!ok) return;
  // Adding is the one moment the plan is certainly about to be edited, so the
  // new row arrives open rather than as one more closed line at the far end.
  state.openRoutineItems.add(row.id);
  render();
}

/**
 * What the last session says set 1 of this exercise was, which is what a fresh
 * planned set opens on (`ghostPrefillResolver` at ordinal 0). No history lands
 * blank, which is the honest answer: nothing here invents a number (D25/D72).
 *
 * The pool is the WORKING sets, through the shared predicate, so a plan never
 * opens on a warmup. Sides collapse the way the resolver collapses them: a plan
 * carries one number whatever the exercise's per-side mode is, so both-sides
 * rows are preferred and anything logged one-sided is the fallback.
 *
 * The app reads its last session straight off the sets table, with no endedAt
 * filter, so a workout in progress can seed it. This page only ever holds
 * FINISHED workouts, so it seeds from the last one of those.
 */
function ghostSeed(exerciseId) {
  const history = state.model.historyByExercise.get(exerciseId) || [];
  const last = history[history.length - 1];
  if (!last) return {};
  const working = last.sets.filter((set) => countsAsWorking(set.setType));
  const bothSides = working.filter((set) => set.side === 'both');
  const pool = bothSides.length > 0 ? bothSides : working;
  const hit = pool[0] ?? pool[pool.length - 1];
  if (!hit) return {};
  // 0 reps is the logger's not-yet-filled sentinel, so it seeds no target. The
  // weight deliberately does not get the same treatment: a logged 0 is a real 0.
  const reps = hit.reps > 0 ? hit.reps : null;
  return { targetRepsMin: reps, targetRepsMax: reps, targetWeightMilli: hit.weightMilli };
}

function removeRoutineItem(itemId) {
  const routine = state.model.routines.find((r) => r.id === shownRoutineId());
  const item = routine?.items.find((i) => i.id === itemId);
  if (!item) return;
  const name = item.exercise ? item.exercise.name : 'this exercise';
  confirmThen({ title: `Remove ${name}?`, confirmLabel: 'Remove' }, () => reallyRemoveRoutineItem(itemId));
}

async function reallyRemoveRoutineItem(itemId) {
  // The fields have sat untouched behind a modal since the question was asked,
  // so what is in them is what was typed before it, and it rides along in the
  // same push. Nothing was re-rendered to ask, which is what makes that true.
  const routine = harvestRoutine();
  const item = routine?.items.find((i) => i.id === itemId);
  if (!item) return;

  // Removing one leaves a hole in the order, so the rest close up behind it.
  const rest = routine.items.filter((i) => i.id !== itemId);
  const ok = await commit([
    // Every exercise row is written below, and this row's own planned sets are
    // about to lose the row that names them.
    ...routineEnvelopes(routine, {
      skipItems: new Set(routine.items.map((i) => i.id)),
      skipSets: new Set(item.sets.map((s) => s.id)),
    }),
    envelope('routine_exercises', tombstoned(item.raw)),
    ...rest
      .map((i, index) => (itemUnchanged(i, { orderIndex: index }) ? null : itemEnvelope(i, { orderIndex: index })))
      .filter(Boolean),
  ]);
  if (!ok) return;
  state.openRoutineItems.delete(itemId);
  render();
}

/**
 * Move one block a single place. The handle's keyboard route, and the same
 * definition of a move the drag uses: a block is lifted out and inserted, so a
 * superset travels whole and its members stay contiguous.
 */
async function moveRoutineBlock(blockKey, direction) {
  const routine = state.model.routines.find((r) => r.id === shownRoutineId());
  if (!routine) return;
  const blocks = routineBlocks(routine.items);
  const from = blocks.findIndex((b) => blockKeyOf(b) === blockKey);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= blocks.length) return;

  const next = blocks.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  state.focusGrip = blockKey;
  await reorderRoutineItems(next.flatMap((b) => b.items.map((i) => i.id)));
}

/** What names a block in the DOM: a superset by its group, a lone row by its id. */
function blockKeyOf(block) {
  return block.kind === 'group' ? block.groupId : block.items[0].id;
}

/** Write a whole new order for a routine's exercises. `order` is item ids. */
async function reorderRoutineItems(order) {
  const routine = harvestRoutine();
  if (!routine) return;
  const moved = order
    .map((id) => routine.items.find((i) => i.id === id))
    .filter(Boolean);
  if (moved.length !== routine.items.length) return;
  // A drag that ended where it started is not a change. Returning before the
  // re-render is what keeps a half-typed target in the row above it.
  if (moved.every((item, index) => item === routine.items[index])) return;

  await commit([
    // Every exercise row is written below, merged with whatever was typed into it.
    ...routineEnvelopes(routine, { skipItems: new Set(routine.items.map((i) => i.id)) }),
    ...moved
      .map((i, index) => (itemUnchanged(i, { orderIndex: index }) ? null : itemEnvelope(i, { orderIndex: index })))
      .filter(Boolean),
  ]);
  // Re-rendered either way. A refused push leaves the model as it was, so this
  // is what puts the rows back where they were before the drag.
  render();
}

function deleteRoutine(id) {
  const routine = state.model.routines.find((r) => r.id === id);
  if (!routine) return;
  confirmThen(
    { title: 'Delete this routine?', body: 'Your workout history is untouched.', confirmLabel: 'Delete' },
    () => reallyDeleteRoutine(routine),
  );
}

async function reallyDeleteRoutine(routine) {
  const ok = await commit([
    envelope('routines', tombstoned(routine.raw)),
    ...routine.items.map((i) => envelope('routine_exercises', tombstoned(i.raw))),
  ]);
  if (!ok) return;
  state.selectedRoutine = null;
  render();
  flash('[data-routine-saved]', `Deleted ${routine.name}.`);
}

/* ----------------------------------------------------------- planned sets */

/**
 * Open or close one exercise's plan.
 *
 * A `hidden` flip and nothing else. Every field in a routine is uncontrolled, so
 * a re-render here would cost the reader whatever they had typed into the rows
 * above the one they just opened.
 */
function toggleRoutineItem(button) {
  const itemEl = button.closest('[data-routine-item]');
  const plan = itemEl?.querySelector('[data-routine-plan]');
  if (!plan) return;
  const open = plan.hidden;
  plan.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  if (open) state.openRoutineItems.add(itemEl.dataset.routineItem);
  else state.openRoutineItems.delete(itemEl.dataset.routineItem);
}

/**
 * Give every exercise in a routine its own planned sets, once, when the routine
 * is opened.
 *
 * THE APP'S OWN CONVERSION (`ensurePlannedSets`), run at the same moment: an
 * exercise with no planned rows gets `targetSets ?? 3` working sets carrying its
 * summary rep range. Whichever surface opens the routine first does it, and the
 * other finds nothing left to do, so both sides end up looking at the same plan
 * rather than at two different descriptions of one.
 *
 * NEVER from a post-mutation path, which is why it hangs off opening a routine
 * and nothing else: removing every set from an exercise while working on it must
 * not put three back.
 */
async function ensurePlannedSets(routineId) {
  // No entitlement check of its own: `commit` is the one gate on writing, and a
  // second copy of that rule here is a second place for it to go stale.
  const routine = state.model?.routines.find((r) => r.id === routineId);
  if (!routine) return;

  const rows = [];
  for (const item of routine.items) {
    if (item.sets.length > 0) continue;
    const count = Math.min(LIMITS.setsPerRoutineExercise, Math.max(1, item.targetSets ?? 3));
    for (let i = 0; i < count; i++) {
      rows.push(newPlannedSet(item.id, i, { targetRepsMin: item.repsMin, targetRepsMax: item.repsMax }));
    }
  }
  if (rows.length === 0) return;

  const ok = await commit(rows.map((row) => envelope('routine_sets', row)));
  if (ok) render();
}

/** The routine the panel is showing: the chosen one, or the first. */
function shownRoutineId() {
  const routines = state.model?.routines || [];
  const chosen = routines.find((r) => r.id === state.selectedRoutine);
  return (chosen || routines[0])?.id ?? null;
}

/**
 * Turn one exercise's per-side mode on or off (D13).
 *
 * The EXERCISE's mode, never a set's: a per-side card logs a left and a right
 * row at one order index, so it could not be per-set even in principle. It
 * carries into the workout started from this routine.
 */
async function setPerSide(itemId, perSide) {
  const routine = harvestRoutine();
  const item = routine?.items.find((i) => i.id === itemId);
  if (!item) return;
  const ok = await commit([
    ...routineEnvelopes(routine, { skipItems: new Set([itemId]) }),
    itemEnvelope(item, { perSide: perSide ? 1 : 0 }),
  ]);
  if (!ok) return;
  render();
}

/* ---------------------------------------------------------------- supersets */

/* Rows sharing a non-null group id are a superset (R2-8): they render as one
 * well, move as one block, and the grouping carries into the workout started
 * from the routine. Grouping is a mode, as it is in the app: pick the exercises,
 * then one control confirms.
 */

/** Enter the picker, having first saved whatever was typed: the picker replaces
 *  the rows on screen, and an uncommitted target would go with them. */
async function startSuperset(itemId) {
  const routine = harvestRoutine();
  if (!routine) return;
  const pending = routineEnvelopes(routine);
  if (pending.length > 0 && !(await commit(pending))) return;
  state.supersetSource = itemId;
  state.supersetPicked = new Set([itemId]);
  render();
}

/**
 * Group the picked exercises. A fresh group id on each, then the order is
 * rewritten so the members sit together at the earliest one's place, mirroring
 * the app's `contiguousOrder`: a superset is contiguous by definition, and the
 * logger keeps it that way.
 */
async function groupRoutineItems() {
  const routine = state.model.routines.find((r) => r.id === shownRoutineId());
  if (!routine) return;
  const members = routine.items.filter((i) => state.supersetPicked.has(i.id) && i.supersetGroupId == null);
  if (members.length < 2) return;

  const groupId = crypto.randomUUID();
  const memberIds = new Set(members.map((i) => i.id));
  const earliest = routine.items.findIndex((i) => memberIds.has(i.id));
  const before = routine.items.slice(0, earliest).filter((i) => !memberIds.has(i.id));
  const after = routine.items.filter((i) => !memberIds.has(i.id)).slice(before.length);
  const order = [...before, ...members, ...after];

  const ok = await commit(
    order
      .map((item, index) => {
        const extra = { orderIndex: index };
        if (memberIds.has(item.id)) extra.supersetGroupId = groupId;
        return itemUnchanged(item, extra) ? null : itemEnvelope(item, extra);
      })
      .filter(Boolean),
  );
  state.supersetSource = null;
  state.supersetPicked = new Set();
  if (!ok) return;
  render();
}

/**
 * Take one exercise out of its superset. A group left with a single member is
 * not a superset, so it dissolves and that member is cleared too.
 */
async function ungroupRoutineItem(itemId) {
  const routine = harvestRoutine();
  const item = routine?.items.find((i) => i.id === itemId);
  if (!item || !item.supersetGroupId) return;

  const groupId = item.supersetGroupId;
  const cleared = [item];
  const remaining = routine.items.filter((i) => i.supersetGroupId === groupId && i.id !== itemId);
  if (remaining.length === 1) cleared.push(remaining[0]);

  const clearedIds = new Set(cleared.map((i) => i.id));
  const ok = await commit([
    ...routineEnvelopes(routine, { skipItems: clearedIds }),
    ...cleared.map((i) => itemEnvelope(i, { supersetGroupId: null })),
  ]);
  if (!ok) return;
  render();
}

/** Append one planned set, opening on the last one of the same work: a fourth
 *  set of the same thing is one tap rather than three fields. */
async function addRoutineSet(itemId) {
  const routine = harvestRoutine();
  const item = routine?.items.find((i) => i.id === itemId);
  if (!item) return;

  if (item.sets.length >= LIMITS.setsPerRoutineExercise) {
    flash('[data-routine-saved]', `An exercise holds ${LIMITS.setsPerRoutineExercise} planned sets.`);
    return;
  }

  const working = item.sets.filter((s) => plannedValues(s).setType === 'working');
  const prior = working[working.length - 1];
  const orderIndex = item.sets.reduce((max, s) => Math.max(max, s.raw.orderIndex), -1) + 1;
  const row = newPlannedSet(item.id, orderIndex, prior ? plannedValues(prior) : {});

  const ok = await commit([...routineEnvelopes(routine), envelope('routine_sets', row)]);
  if (!ok) return;
  render();
}

function removeRoutineSet(setId) {
  const routine = state.model.routines.find((r) => r.id === shownRoutineId());
  const item = routine?.items.find((i) => i.sets.some((s) => s.id === setId));
  if (!item) return;
  const position = item.sets.findIndex((s) => s.id === setId) + 1;
  confirmThen({ title: `Remove set ${position}?`, confirmLabel: 'Remove' }, () => reallyRemoveRoutineSet(setId));
}

async function reallyRemoveRoutineSet(setId) {
  const routine = harvestRoutine();
  const item = routine?.items.find((i) => i.sets.some((s) => s.id === setId));
  const set = item?.sets.find((s) => s.id === setId);
  if (!set) return;

  // The sets behind it close up, the same way the exercises do.
  const rest = item.sets.filter((s) => s.id !== setId);
  const ok = await commit([
    ...routineEnvelopes(routine, { skipSets: new Set(item.sets.map((s) => s.id)) }),
    envelope('routine_sets', tombstoned(set.raw)),
    ...rest
      .map((s, index) => (setUnchanged(s, { orderIndex: index }) ? null : setEnvelope(s, { orderIndex: index })))
      .filter(Boolean),
  ]);
  if (!ok) return;
  render();
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
