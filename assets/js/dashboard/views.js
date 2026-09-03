/* The six tabs. Each render takes the model and the current UI state and
 * returns HTML; the entry point wires the events. Nothing here fetches.
 */

import { icon, tile } from '../icons.js';
import {
  makeRenderer,
  countsAsWorking,
  countsInTotals,
  setVolumeMilli,
  estimatedOneRepMaxMilli,
  estimateText,
  volumeText,
  relativeStrength,
  relativeStrengthText,
  repsText,
  durationText,
  shortDate,
  longDate,
  fullDate,
  dateTime,
  weekLabel,
  equipmentLabel,
  fromMilli,
  EQUIPMENT_TYPES,
  BODYWEIGHT_SUBTYPES,
  BODYWEIGHT_SUBTYPE_LABELS,
  isRepOnly,
  SET_TYPES,
  SET_TYPE_LABELS,
  SET_TYPE_TAGS,
} from './domain.js';

export function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ================================================================== HISTORY */

export function renderHistory(model, state) {
  const render = makeRenderer(model.displayUnit);

  if (model.sessions.length === 0) {
    return `
      <div class="tab-head"><h2>Workout history with Jotlift</h2></div>
      <p class="ex-empty">No workouts here yet. Log one on your phone and it shows up here.</p>`;
  }

  const hours = (model.totals.ms / 3_600_000).toFixed(1);
  // Session volume is summed in each exercise's own unit; reconcile it into the
  // unit on screen once, through the one renderer.
  const volume = model.sessions.reduce(
    (sum, s) => sum + render.value(s.volumeMilli, s.volumeUnit),
    0,
  );

  const weeks = model.weeks
    .map((week) => {
      const sessions = week.sessions
        .map((session) => renderSession(session, model, state, render))
        .join('');
      return `
        <section class="week">
          <h3>${esc(weekLabel(week.start, Date.now()))}</h3>
          <div class="week__list">${sessions}</div>
        </section>`;
    })
    .join('');

  return `
    <div class="tab-head">
      <h2>Workout history with Jotlift</h2>
      <span class="tab-head__meta">${model.totals.workouts.toLocaleString('en-US')} ${model.totals.workouts === 1 ? 'workout' : 'workouts'}, newest first</span>
    </div>

    <div class="summary-strip">
      <div class="summary-tile">
        <p class="summary-tile__value">${model.totals.workouts.toLocaleString('en-US')}</p>
        <p class="summary-tile__label">Workouts</p>
      </div>
      <div class="summary-tile">
        <p class="summary-tile__value">${hours}</p>
        <p class="summary-tile__label">Hrs</p>
      </div>
      <div class="summary-tile">
        <p class="summary-tile__value">${model.totals.sets.toLocaleString('en-US')}</p>
        <p class="summary-tile__label">Sets</p>
      </div>
      <div class="summary-tile">
        <p class="summary-tile__value">${Math.round(volume).toLocaleString('en-US')}</p>
        <p class="summary-tile__label">Volume, ${esc(model.displayUnit)}</p>
      </div>
    </div>

    ${weeks}`;
}

function renderSession(session, model, state, render) {
  const open = state.openSession === session.id;
  const summary = [
    longDate(session.startedAt),
    durationText(session.durationMs),
    `${session.setCount} ${session.setCount === 1 ? 'set' : 'sets'}`,
    volumeText(session.volumeMilli, session.volumeUnit, render),
  ].join(' · ');

  const detail = open
    ? `<div class="session__detail">${session.entries
        .map((entry) => renderSessionExercise(entry, model, render))
        .join('')}</div>`
    : '';

  return `
    <div class="session">
      <button class="session__toggle" type="button" data-session="${esc(session.id)}" aria-expanded="${open}">
        ${tile('dumbbell', 44)}
        <span class="session__main">
          <span class="session__title">
            <span class="session__name">${esc(session.title)}</span>
            <span class="session__synced" title="Synced" role="img" aria-label="Synced">${icon('cloud', 15, 2)}</span>
          </span>
          <span class="session__summary">${esc(summary)}</span>
        </span>
        <span class="session__caret">${icon(open ? 'chevronD' : 'chevronR', 18)}</span>
      </button>
      ${detail}
    </div>`;
}

function renderSessionExercise(entry, model, render) {
  const exercise = entry.exercise;
  const unit = exercise.unit || 'kg';
  const floorMilli = model.floorByExercise.get(exercise.id);
  const repOnly = model.isRepOnly(exercise);

  const floor = floorMilli != null
    ? `<span class="pill pill--success">${icon('check', 13, 2.4)}Floor ${esc(render.text(floorMilli, unit))}</span>`
    : '';

  // Per-side rows share one ordinal (D13). They are shown on one line rather
  // than averaged, because both sides are what was actually logged.
  const byOrdinal = new Map();
  let perSide = false;
  for (const set of entry.sets) {
    if (!countsInTotals(set.setType)) continue;
    if (set.side !== 'both') perSide = true;
    const held = byOrdinal.get(set.orderIndex) || [];
    held.push(set);
    byOrdinal.set(set.orderIndex, held);
  }

  const rows = [...byOrdinal.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, sides], index) => {
      const text = sides
        .map((set) => {
          const value =
            repOnly || set.weightMilli == null
              ? `${set.reps} reps`
              : `${render.text(set.weightMilli, unit)} × ${set.reps}`;
          if (set.side === 'left') return `${value} L`;
          if (set.side === 'right') return `${value} R`;
          return value;
        })
        .join(' · ');
      return `<span class="session__set-n">${index + 1}</span><span class="session__set-v">${esc(text)}</span>`;
    })
    .join('');

  return `
    <div class="session__exercise">
      <div class="session__exercise-head">
        <h4>${esc(exercise.name)}</h4>
        ${floor}
      </div>
      ${perSide ? '<p class="session__perside">Left and right logged separately</p>' : ''}
      <div class="session__sets">${rows}</div>
    </div>`;
}

/* ================================================================= PROGRESS */

/* Geometry. Y is fixed pixels, so nothing scales vertically; X is a percentage
 * of the plot's own width, which grows past the card once the history is long
 * and then scrolls horizontally. Both come off the same TIME scale, so a layoff
 * reads as a real gap rather than being closed up. */
const PLOT_HEIGHT = 176;
const TOP_PAD = 10;
const BOTTOM_PAD = 14;
const SESSION_SPACING = 84;

/** The metrics a chart may plot. Estimated 1RM is deliberately absent: a best is
 *  a figure in a list, a metric is an axis to plot. */
export function metricsFor(exercise, isRepOnly) {
  return isRepOnly(exercise)
    ? [{ value: 'reps', label: 'Reps' }, { value: 'volume', label: 'Volume' }]
    : [{ value: 'topSet', label: 'Top set' }, { value: 'volume', label: 'Volume' }];
}

/** One point per session that has at least one working set. */
export function buildSeries(history, exercise) {
  const ctx = {
    equipmentType: exercise.equipmentType,
    bodyweightSubtype: exercise.bodyweightSubtype ?? null,
  };
  const points = [];
  for (const session of history) {
    const working = session.sets.filter((s) => countsAsWorking(s.setType));
    if (working.length === 0) continue;

    let topSetWeightMilli = null;
    let volumeMilli = 0;
    let reps = 0;

    // Volume counts everything but a warmup, and goes through the ONE canonical
    // volume function, so this point's tonnage is the same number History prints
    // for the same session.
    for (const set of session.sets) {
      if (countsInTotals(set.setType)) volumeMilli += setVolumeMilli(set, ctx);
    }

    for (const set of working) {
      reps += set.reps;
      if (set.weightMilli != null && (topSetWeightMilli == null || set.weightMilli > topSetWeightMilli)) {
        topSetWeightMilli = set.weightMilli;
      }
    }

    points.push({ startedAt: session.startedAt, topSetWeightMilli, volumeMilli, reps });
  }
  return points;
}

export function renderProgress(model, state) {
  const exercises = [...model.historyByExercise.keys()]
    .map((id) => model.exercisesById.get(id))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (exercises.length === 0) {
    return `
      <div class="tab-head"><h2>Progress</h2></div>
      <p class="ex-empty">Nothing to chart yet. Log an exercise a few times and its line appears here.</p>`;
  }

  // Open on the exercise with the most sessions behind it, so the tab lands on a
  // line worth reading rather than on whichever name sorts first. Ties go to the
  // one logged most recently. The picker lists them alphabetically, which is how
  // you find one; this is only where the tab starts.
  const richest = exercises.reduce((best, e) => {
    const count = (model.historyByExercise.get(e.id) || []).length;
    const bestCount = (model.historyByExercise.get(best.id) || []).length;
    if (count !== bestCount) return count > bestCount ? e : best;
    return (model.lastDoneByExercise.get(e.id) ?? 0) > (model.lastDoneByExercise.get(best.id) ?? 0) ? e : best;
  }, exercises[0]);

  const exercise = exercises.find((e) => e.id === state.progressExercise) || richest;
  const unit = exercise.unit || 'kg';
  const render = makeRenderer(model.displayUnit);
  const repOnly = model.isRepOnly(exercise);
  const metrics = metricsFor(exercise, model.isRepOnly);
  const metric = metrics.some((m) => m.value === state.metric) ? state.metric : metrics[0].value;

  const history = model.historyByExercise.get(exercise.id) || [];
  const series = buildSeries(history, exercise);

  const picker = `
    <div class="prg-picker" data-picker>
      <button class="prg-picker__button" type="button" data-picker-toggle aria-expanded="${!!state.pickerOpen}" aria-haspopup="listbox">
        <span class="prg-picker__name">${esc(exercise.name)}</span>
        ${icon('chevronD', 18)}
      </button>
      ${
        state.pickerOpen
          ? `<div class="prg-picker__menu" role="listbox" aria-label="Exercise">${exercises
              .map(
                (e) =>
                  `<button type="button" role="option" data-pick-exercise="${esc(e.id)}" aria-selected="${e.id === exercise.id}">${esc(e.name)}</button>`,
              )
              .join('')}</div>`
          : ''
      }
    </div>`;

  const bests = renderBests(history, exercise, model, render);

  const readOnlyNote = state.entitlement === 'lapsed' && state.cutoff
    ? `<p class="bests-note">The line ends ${esc(fullDate(state.cutoff))}, where your subscription did. Sessions you have logged since are on your phone and are not read here.</p>`
    : '';

  const bodyweightNote = model.bodyweight
    ? ` Relative strength divides your heaviest logged weight by your latest recorded bodyweight (${esc(render.text(model.bodyweight.valueMilli, model.bodyweight.unit))}).`
    : '';

  return `
    <div class="tab-head">
      <h2>Progress</h2>
      <span class="tab-head__meta">${series.length} ${series.length === 1 ? 'session' : 'sessions'} logged</span>
    </div>

    ${picker}

    <div class="chart-card">
      <div class="segmented" role="tablist" aria-label="Metric">
        ${metrics
          .map(
            (m) =>
              `<button type="button" role="tab" data-metric="${m.value}" aria-selected="${m.value === metric}">${m.label}</button>`,
          )
          .join('')}
      </div>
      ${renderChart(series, metric, unit, render, state, exercise, repOnly)}
    </div>

    <h3 style="margin:0 0 12px;font-size:17px;font-weight:600;color:var(--color-text)">Bests</h3>
    ${bests}
    <p class="bests-note">Estimated 1RM is worked out from the sets you logged, with the Epley formula. It is an estimate, not a lift you performed.${bodyweightNote}</p>
    ${readOnlyNote}`;
}

function metricValue(point, metric, unit, render) {
  if (metric === 'reps') return point.reps;
  if (metric === 'volume') return render.value(point.volumeMilli, unit);
  return point.topSetWeightMilli == null ? 0 : render.value(point.topSetWeightMilli, unit);
}

/**
 * One metric's readout. A top set is a weight that went on the bar and reads
 * back exactly as logged; volume is a total nobody loaded, so it is rounded and
 * grouped; reps are a count with no unit to print. A shared rounder served none
 * of them: it turned a 62.5 kg top set into "62".
 */
function metricText(value, metric, render) {
  if (metric === 'reps') return `${value} reps`;
  if (metric === 'volume') return `${Math.round(value).toLocaleString('en-US')} ${render.unit}`;
  return `${Number(value.toFixed(3))} ${render.unit}`;
}

function renderChart(series, metric, unit, render, state, exercise, repOnly) {
  if (series.length < 2) {
    return `<p class="chart-readout" style="margin-top:16px">Two sessions and a line appears. Keep logging ${esc(exercise.name)} and it fills in.</p>`;
  }

  const ys = series.map((p) => metricValue(p, metric, unit, render));
  const xs = series.map((p) => p.startedAt);
  const x0 = xs[0];
  const x1 = xs[xs.length - 1];
  const yLo = Math.min(...ys);
  const yHi = Math.max(...ys);
  // Headroom so the line never runs along the frame. A flat series has no range
  // of its own, so it borrows one from its own magnitude.
  const room = (yHi - yLo) * 0.18 || Math.max(Math.abs(yHi) * 0.05, 1);
  const lo = yLo - room;
  const hi = yHi + room;

  const fx = (ms) => (x1 === x0 ? 0 : (ms - x0) / (x1 - x0));
  const py = (v) => TOP_PAD + (1 - (v - lo) / (hi - lo)) * (PLOT_HEIGHT - TOP_PAD - BOTTOM_PAD);
  const pctX = (ms) => `${2 + fx(ms) * 96}%`;
  // The polyline draws in viewBox units, which the SVG stretches to the plot
  // width; only the stroke is held at its real weight.
  const vx = (ms) => 13 + fx(ms) * 614;

  const line = series.map((p, i) => `${vx(p.startedAt).toFixed(1)},${py(ys[i]).toFixed(1)}`).join(' ');

  const pickedIndex = state.point != null && series[state.point] ? state.point : null;
  const lastIndex = series.length - 1;

  // The label sits left of the newest point, so it must clear the segment
  // arriving there: that segment is ABOVE the point when the series ends on a
  // descent and below it when it ends on a rise.
  const descending = ys[lastIndex] < ys[lastIndex - 1];
  const lastShift = descending
    ? 'translate(-100%,calc(-50% + 17px))'
    : 'translate(-100%,calc(-50% - 17px))';

  const plotPx = series.length * SESSION_SPACING;
  const xTicks = [];
  let lastPx = -Infinity;
  series.forEach((p) => {
    const at = fx(p.startedAt) * plotPx;
    // Drop a label that would sit on top of its neighbour: the scale is time, so
    // two sessions a day apart are close together however wide the plot is.
    if (at - lastPx < 46) return;
    lastPx = at;
    xTicks.push(`<span class="chart-xtick" style="left:${pctX(p.startedAt)}">${esc(shortDate(p.startedAt))}</span>`);
  });

  const yTicks = [0, 1, 2, 3]
    .map((i) => {
      const v = yLo + (i / 3) * (yHi - yLo);
      return `<span class="chart-ytick" style="top:${(6 + py(v)).toFixed(1)}px">${Math.round(v).toLocaleString('en-US')}</span>`;
    })
    .join('');

  /* The guide and the dot are ALWAYS in the DOM, hidden until something is
   * picked, and each hit target carries its own geometry. Picking then moves
   * them with two style writes instead of re-rendering the page.
   *
   * That is not a micro-optimisation. Re-rendering replaced the scroller on
   * every pointer move, and a fresh element starts at scrollLeft 0, so reading
   * a point threw the reader back to the start of their own history. */
  const guide = `
    <span class="chart-guide" data-chart-guide${pickedIndex == null ? ' hidden' : ''}
          style="left:${pickedIndex == null ? '0' : pctX(series[pickedIndex].startedAt)}"></span>
    <span class="chart-dot" data-chart-pick${pickedIndex == null ? ' hidden' : ''}
          style="left:${pickedIndex == null ? '0' : pctX(series[pickedIndex].startedAt)};top:${
            pickedIndex == null ? '0' : py(ys[pickedIndex]).toFixed(1) + 'px'
          }"></span>`;

  const readoutFor = (i) => `${metricText(ys[i], metric, render)} on ${shortDate(series[i].startedAt)}`;
  const readout = pickedIndex != null ? readoutFor(pickedIndex) : '';

  const hits = series
    .map(
      (p, i) =>
        `<button class="chart-hit" type="button" data-point="${i}"` +
        ` data-left="${pctX(p.startedAt)}" data-top="${py(ys[i]).toFixed(1)}px"` +
        ` data-readout="${esc(readoutFor(i))}"` +
        ` style="left:${pctX(p.startedAt)}" aria-label="${esc(readoutFor(i))}"></button>`,
    )
    .join('');

  const label =
    `${metric === 'topSet' ? 'Top set' : metric === 'reps' ? 'Reps' : 'Volume'} for ${exercise.name},` +
    ` ${series.length} sessions from ${shortDate(x0)} to ${shortDate(x1)}`;

  return `
    <p class="chart-readout" data-chart-readout>${esc(readout)}</p>
    <div class="chart-frame">
      <div class="chart-scroll" data-chart-scroll>
        <div class="chart-plot" style="width:max(100%, ${plotPx}px)">
          <svg width="100%" height="${PLOT_HEIGHT}" viewBox="0 0 640 ${PLOT_HEIGHT}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
            <line x1="0" y1="175.5" x2="640" y2="175.5" stroke="var(--color-hairline)" stroke-width="1" vector-effect="non-scaling-stroke"></line>
            <polyline points="${line}" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"></polyline>
          </svg>
          ${guide}
          <span class="chart-dot chart-dot--last" style="left:${pctX(x1)};top:${py(ys[lastIndex]).toFixed(1)}px"></span>
          <span class="chart-lastlabel" style="left:${pctX(x1)};top:${py(ys[lastIndex]).toFixed(1)}px;transform:${lastShift}">${esc(metricText(ys[lastIndex], metric, render))}</span>
          ${hits}
          ${xTicks.join('')}
        </div>
      </div>
      ${yTicks}
    </div>`;
}

/**
 * The bests, in this order: Heaviest weight, Relative strength, Most reps,
 * Estimated 1RM. Every figure is FREE; there is no entitlement on this view.
 * Bests are not green: `success` and the mint accent read as one family, and a
 * best set months ago is a fact, not an event.
 */
function renderBests(history, exercise, model, render) {
  const unit = exercise.unit || 'kg';
  let heaviest = null;
  let bestReps = null;
  let bestEstimate = null;

  for (const session of history) {
    for (const set of session.sets) {
      if (!countsAsWorking(set.setType)) continue;
      if (set.weightMilli != null) {
        if (heaviest == null || set.weightMilli > heaviest) heaviest = set.weightMilli;
        const estimate = estimatedOneRepMaxMilli(set.weightMilli, set.reps);
        if (estimate != null && (bestEstimate == null || estimate > bestEstimate)) bestEstimate = estimate;
      }
      // Ties break toward the heavier weight, so the record reads as the harder set.
      if (
        bestReps == null ||
        set.reps > bestReps.reps ||
        (set.reps === bestReps.reps && (set.weightMilli ?? -1) > (bestReps.atWeightMilli ?? -1))
      ) {
        bestReps = { reps: set.reps, atWeightMilli: set.weightMilli };
      }
    }
  }

  const rows = [];

  // A rep-only exercise has no heaviest weight, so it has no relative strength
  // either: one guard, two rows.
  if (heaviest != null) {
    rows.push(['Heaviest weight', render.text(heaviest, unit), false]);
    const ratio = relativeStrength(heaviest, unit, model.bodyweight);
    rows.push(
      ratio == null
        ? ['Relative strength', 'Add bodyweight in Settings', true]
        : ['Relative strength', relativeStrengthText(ratio), false],
    );
  }

  if (bestReps) rows.push(['Most reps', repsText(bestReps.reps, bestReps.atWeightMilli, unit, render), false]);
  if (bestEstimate != null) rows.push(['Estimated 1RM', estimateText(bestEstimate, unit, render), false]);

  if (rows.length === 0) {
    return '<p class="ex-empty">No working sets logged for this one yet.</p>';
  }

  return `<div class="bests">${rows
    .map(
      ([label, value, absent], i) => `
      <span class="best-row">
        ${i > 0 ? '<span class="divider-60"></span>' : ''}
        ${tile('trophy', 32)}
        <span class="best-row__label">${esc(label)}</span>
        <span class="best-row__value${absent ? ' best-row__value--absent' : ''}">${esc(value)}</span>
      </span>`,
    )
    .join('')}</div>`;
}

/* ================================================================ EXERCISES */

export function renderExercises(model, state) {
  const render = makeRenderer(model.displayUnit);
  const query = (state.exerciseQuery || '').trim().toLowerCase();

  const groups = model.library
    .map((g) => ({
      label: g.label,
      items: query ? g.items.filter((e) => e.name.toLowerCase().includes(query)) : g.items,
    }))
    .filter((g) => g.items.length);

  const editable = state.entitlement === 'active';
  const open = state.selectedExercise;

  // THE EDITOR OPENS UNDER THE ROW IT BELONGS TO, not at the foot of the page.
  // A panel far from the thing it edits makes the reader hunt for what they just
  // clicked, and on a long library it is off screen entirely.
  const list = groups
    .map(
      (g) => `
      <section class="ex-group">
        <h3>${esc(g.label)}</h3>
        <div class="ex-list">
          ${g.items
            .map((e, i) => {
              const row = renderExerciseRow(e, i, open, model, render);
              return e.id === open
                ? row + renderExerciseDetail(e, model, state, render, editable)
                : row;
            })
            .join('')}
        </div>
      </section>`,
    )
    .join('');

  const creating = state.creatingExercise
    ? renderExerciseCreate(model, state)
    : '';

  const empty =
    groups.length === 0 && !state.creatingExercise
      ? `<p class="ex-empty">No matches${query ? ` for &ldquo;${esc(state.exerciseQuery)}&rdquo;` : ''}.${
          editable ? ' <button class="linkish" type="button" data-add-exercise>Add it</button>' : ''
        }</p>`
      : '';

  return `
    <div class="tab-head" style="margin-bottom:14px">
      <h2>Exercises</h2>
      ${editable ? '<button class="btn btn--sm" type="button" data-add-exercise>Add exercise</button>' : ''}
    </div>

    <div style="max-width:340px;margin-bottom:20px">
      <label class="field">
        <span class="sr-only">Search exercises</span>
        <span class="field__box">
          <input type="search" placeholder="Search exercises" data-exercise-query value="${esc(state.exerciseQuery || '')}">
          ${icon('search', 18)}
        </span>
      </label>
    </div>

    ${creating}
    ${list}
    ${empty}
    <p class="notice notice--success" data-exercise-saved hidden style="margin-top:16px"></p>`;
}

function renderExerciseRow(exercise, index, openId, model, render) {
  const isOpen = exercise.id === openId;
  const best = bestLine(exercise, model, render);
  const lastDone = model.lastDoneByExercise.get(exercise.id);

  return `
    <button class="ex-row" type="button" data-exercise="${esc(exercise.id)}" aria-expanded="${isOpen}" aria-selected="${isOpen}">
      ${index > 0 ? '<span class="divider-60"></span>' : ''}
      ${tile('dumbbell', 32)}
      <span class="ex-row__main">
        <span class="ex-row__name">${esc(exercise.name)}</span>
        ${exercise.isBuiltin ? '' : '<span class="ex-row__own">Your own</span>'}
      </span>
      <span class="ex-row__best">${esc(best)}</span>
      <span class="ex-row__last">${lastDone ? esc(shortDate(lastDone)) : ''}</span>
      <span class="ex-row__chevron">${icon(isOpen ? 'chevronD' : 'chevronR', 18)}</span>
    </button>`;
}

/** The exercise's heaviest working set, as "62.5 kg × 8" or "10 reps". */
function bestLine(exercise, model, render) {
  const history = model.historyByExercise.get(exercise.id);
  if (!history) return '';
  const repOnly = model.isRepOnly(exercise);
  const unit = exercise.unit || 'kg';
  let best = null;
  for (const session of history) {
    for (const set of session.sets) {
      if (!countsAsWorking(set.setType)) continue;
      if (repOnly || set.weightMilli == null) {
        if (!best || set.reps > best.reps) best = { reps: set.reps, weightMilli: null };
        continue;
      }
      if (!best || set.weightMilli > (best.weightMilli ?? -1)) best = { reps: set.reps, weightMilli: set.weightMilli };
    }
  }
  if (!best) return '';
  if (best.weightMilli == null) return `${best.reps} reps`;
  return `${render.text(best.weightMilli, unit)} × ${best.reps}`;
}

function equipmentOptions(selected) {
  return EQUIPMENT_TYPES.map(
    (t) => `<option value="${t}"${t === selected ? ' selected' : ''}>${esc(equipmentLabel(t))}</option>`,
  ).join('');
}

function categoryOptions(model, selectedId) {
  return (
    `<option value=""${selectedId ? '' : ' selected'}>Not filed</option>` +
    model.categories
      .map((c) => `<option value="${esc(c.id)}"${c.id === selectedId ? ' selected' : ''}>${esc(c.name)}</option>`)
      .join('')
  );
}

function subtypeOptions(selected) {
  return BODYWEIGHT_SUBTYPES.map(
    (t) => `<option value="${t}"${t === selected ? ' selected' : ''}>${esc(BODYWEIGHT_SUBTYPE_LABELS[t])}</option>`,
  ).join('');
}

/** The panel that opens under a row. Uncontrolled fields, read on save, so
 *  typing never re-renders and never loses the caret. */
function renderExerciseDetail(exercise, model, state, render, editable) {
  const repOnly = model.isRepOnly(exercise);
  const logged = model.lastDoneByExercise.get(exercise.id);
  const link = model.categoryLinkOf.get(exercise.id);
  const isBodyweight = exercise.equipmentType === 'bodyweight';

  if (!editable) {
    return `
      <div class="ex-panel">
        <div class="ex-facts">
          <div><p>Equipment</p><p>${esc(equipmentLabel(exercise.equipmentType))}</p></div>
          <div><p>Muscle</p><p>${esc(model.categoryOf.get(exercise.id) || 'Not filed')}</p></div>
          <div><p>Unit</p><p>${esc(exercise.unit || 'kg')}</p></div>
          <div><p>Logged in</p><p>${repOnly ? 'Reps' : 'Weight and reps'}</p></div>
        </div>
        <p style="margin:0;font-size:15px;line-height:1.55" class="quiet">${
          state.entitlement === 'lapsed'
            ? 'Editing is paused while your subscription is lapsed. Your exercises and their history are all still here.'
            : 'Subscribe to edit your exercises here.'
        }</p>
      </div>`;
  }

  return `
    <div class="ex-panel" data-exercise-form="${esc(exercise.id)}">
      <div class="ex-form">
        <label class="field">
          <span class="field__label">Name</span>
          <span class="field__box"><input type="text" data-field="name" value="${esc(exercise.name)}"></span>
        </label>
        <label class="field">
          <span class="field__label">Muscle</span>
          <span class="field__box"><select data-field="category">${categoryOptions(model, link ? link.categoryId : '')}</select></span>
        </label>
        <label class="field">
          <span class="field__label">Equipment</span>
          <span class="field__box"><select data-field="equipment" data-equipment-select>${equipmentOptions(exercise.equipmentType)}</select></span>
        </label>
        <label class="field" data-subtype-field${isBodyweight ? '' : ' hidden'}>
          <span class="field__label">Loaded by</span>
          <span class="field__box"><select data-field="subtype">${subtypeOptions(exercise.bodyweightSubtype || 'pure')}</select></span>
        </label>
      </div>

      <p class="ex-panel__note">
        ${repOnly ? 'Logged in reps. Added load is recorded per set. ' : ''}Logged in ${esc(exercise.unit || 'kg')}${
          logged ? `, last on ${esc(shortDate(logged))}` : ''
        }. The unit is changed on your phone, because switching it converts every weight you have logged.
      </p>
      ${
        exercise.isBuiltin
          ? '<p class="ex-panel__note">This one came with Jotlift. Editing it makes it your own version, keeping its whole history.</p>'
          : ''
      }

      <div class="ex-actions">
        <div class="ex-actions__left">
          <button class="btn" type="button" data-exercise-save="${esc(exercise.id)}">Save</button>
          <button class="btn btn--text" type="button" data-exercise-cancel>Cancel</button>
        </div>
        ${
          exercise.isBuiltin
            ? ''
            : `<button class="danger-link" type="button" data-exercise-delete="${esc(exercise.id)}">Delete</button>`
        }
      </div>
      ${
        exercise.isBuiltin
          ? ''
          : '<p class="ex-panel__note">Deleting keeps every workout you logged with it.</p>'
      }
    </div>`;
}

/** The new-exercise form, at the top of the list where a new thing belongs. */
function renderExerciseCreate(model, state) {
  return `
    <div class="ex-panel ex-panel--create" data-exercise-create>
      <h3 style="margin:0 0 16px;font-size:17px;font-weight:600;color:var(--color-text)">New exercise</h3>
      <div class="ex-form">
        <label class="field">
          <span class="field__label">Name</span>
          <span class="field__box"><input type="text" data-field="name" value="${esc(state.exerciseQuery || '')}" placeholder="Bench press" autofocus></span>
        </label>
        <label class="field">
          <span class="field__label">Muscle</span>
          <span class="field__box"><select data-field="category">${categoryOptions(model, '')}</select></span>
        </label>
        <label class="field">
          <span class="field__label">Equipment</span>
          <span class="field__box"><select data-field="equipment" data-equipment-select>${equipmentOptions('barbell')}</select></span>
        </label>
        <label class="field" data-subtype-field hidden>
          <span class="field__label">Loaded by</span>
          <span class="field__box"><select data-field="subtype">${subtypeOptions('pure')}</select></span>
        </label>
      </div>
      <p class="ex-panel__note">It is logged in ${esc(model.displayUnit)}, and its step follows the equipment. A bodyweight exercise is logged in reps.</p>
      <div class="ex-actions">
        <div class="ex-actions__left">
          <button class="btn" type="button" data-exercise-create-save>Add exercise</button>
          <button class="btn btn--text" type="button" data-exercise-create-cancel>Cancel</button>
        </div>
      </div>
    </div>`;
}

/* ================================================================= ROUTINES */

export function renderRoutines(model, state) {
  const editable = state.entitlement === 'active';
  const intro =
    'A routine is a named list of exercises in the order you want them. There are no days and nothing is scheduled. Build one here, then start it from your phone whenever you want it.';

  const head = `
    <div class="tab-head" style="margin-bottom:6px">
      <h2>Routines</h2>
      ${editable ? '<button class="btn btn--sm" type="button" data-routine-new>New routine</button>' : ''}
    </div>
    <p style="margin:0 0 16px;font-size:15px;max-width:60ch" class="quiet">${intro}</p>`;

  if (model.routines.length === 0) {
    return `${head}
      <p class="ex-empty">No routines yet.${editable ? ' Build one here, or on your phone.' : ''}</p>
      <p class="notice notice--success" data-routine-saved hidden style="margin-top:16px"></p>`;
  }

  const selected = model.routines.find((r) => r.id === state.selectedRoutine) || model.routines[0];

  // Picking exercises to group is a mode over the routine, the way it is in the
  // app: the list becomes a list of choices and one accent control confirms.
  if (editable && state.supersetSource && selected.items.some((i) => i.id === state.supersetSource)) {
    return `${head}<div class="routine-cards">${routineCards(model, selected)}</div>
      ${renderSupersetPicker(selected, state)}`;
  }

  return `${head}
    <div class="routine-cards">${routineCards(model, selected)}</div>
    ${renderRoutineDetail(selected, model, state, editable)}
    <p class="notice notice--success" data-routine-saved hidden style="margin-top:16px"></p>`;
}

function routineCards(model, selected) {
  return model.routines
    .map(
      (r) => `
      <button class="routine-card" type="button" data-routine="${esc(r.id)}" aria-selected="${r.id === selected.id}">
        <span style="display:flex;flex-direction:column;gap:2px">
          <span class="routine-card__name">${esc(r.name)}</span>
          <span class="routine-card__detail">${r.items.length} ${r.items.length === 1 ? 'exercise' : 'exercises'}</span>
        </span>
        <span class="routine-card__tags">${r.tags.slice(0, 3).map((t) => `<span class="pill">${esc(t)}</span>`).join('')}</span>
      </button>`,
    )
    .join('');
}

/**
 * Fold the ordered rows into the BLOCKS the list actually moves: one exercise,
 * or one contiguous superset. A member cannot move on its own, so the block is
 * what carries a handle and what a drag reorders (the app's buildRows).
 */
export function routineBlocks(items) {
  const out = [];
  let i = 0;
  while (i < items.length) {
    const groupId = items[i].supersetGroupId;
    if (groupId == null) {
      out.push({ kind: 'single', items: [items[i]] });
      i += 1;
      continue;
    }
    const members = [];
    while (i < items.length && items[i].supersetGroupId === groupId) {
      members.push(items[i]);
      i += 1;
    }
    out.push(members.length === 1 ? { kind: 'single', items: members } : { kind: 'group', groupId, items: members });
  }
  return out;
}

function renderRoutineDetail(routine, model, state, editable) {
  const render = makeRenderer(model.displayUnit);

  // The row's number is its place in the routine, so it counts across blocks
  // rather than restarting inside a superset.
  let position = 0;
  const rows = routineBlocks(routine.items)
    .map((block) => {
      const first = position;
      position += block.items.length;
      return block.kind === 'group'
        ? renderSuperset(block, first, state, editable, render)
        : `<div class="routine-block" data-routine-block="${esc(block.items[0].id)}">${renderRoutineItem(block.items[0], first, state, editable, render, { handle: true })}</div>`;
    })
    .join('');

  const addable = model.exercises
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`)
    .join('');

  const empty = `
    <div class="routine-table__row">
      <span></span><span></span>
      <span class="routine-table__name quiet">No exercises yet.</span>
      <span></span><span></span><span></span>
    </div>`;

  const counts = `${routine.items.length} ${routine.items.length === 1 ? 'exercise' : 'exercises'} · ${routine.plannedSetCount} ${routine.plannedSetCount === 1 ? 'set' : 'sets'}`;

  return `
    <div class="routine-detail" data-routine-detail="${esc(routine.id)}">
      <div class="routine-detail__head">
        <div>
          ${
            editable
              ? `<label class="field" style="max-width:340px">
                   <span class="field__label">Routine name</span>
                   <span class="field__box"><input type="text" data-routine-name value="${esc(routine.name)}"></span>
                 </label>`
              : `<h3>${esc(routine.name)}</h3>`
          }
          <p class="routine-detail__counts">${esc(counts)}</p>
        </div>
        ${editable ? '<span style="font-size:14px" class="decorative">Drag the handle to reorder</span>' : '<span style="font-size:14px" class="decorative">Start it on your phone</span>'}
      </div>

      <div class="routine-table">
        <div class="routine-table__row routine-table__head">
          <span></span><span></span><span>Exercise</span><span style="text-align:right">Sets</span><span style="text-align:right">Reps</span><span></span>
        </div>
        <div data-routine-rows>${rows || empty}</div>
      </div>

      <p style="margin:14px 0 0;font-size:14px;max-width:64ch" class="quiet">Open an exercise to plan its sets. Every target is optional: a set with none runs on what you lift.</p>

      ${
        editable
          ? `<div class="routine-add">
               <label class="field" style="max-width:280px">
                 <span class="sr-only">Exercise to add</span>
                 <span class="field__box"><select data-routine-add-pick>${addable}</select></span>
               </label>
               <button class="btn btn--secondary" type="button" data-routine-add>Add exercise</button>
             </div>
             <div class="ex-actions" style="margin-top:18px">
               <div class="ex-actions__left">
                 <button class="btn" type="button" data-routine-save="${esc(routine.id)}">Save routine</button>
               </div>
               <button class="danger-link" type="button" data-routine-delete="${esc(routine.id)}">Delete routine</button>
             </div>`
          : ''
      }
      ${
        state.entitlement === 'lapsed'
          ? '<p style="margin:18px 0 0;font-size:15px" class="quiet">Routines are read only while your subscription is lapsed. Nothing has been deleted, and they work again as soon as you resubscribe.</p>'
          : ''
      }
    </div>`;
}

/** A superset: one recessed well, its own handle, and its members lettered. */
function renderSuperset(block, first, state, editable, render) {
  const members = block.items
    .map((item, i) =>
      renderRoutineItem(item, first + i, state, editable, render, { handle: false, letter: LETTERS[i] }),
    )
    .join('');

  const names = block.items.map((i) => itemName(i)).join(', ');
  const handle = editable
    ? `<button class="grip" type="button" data-routine-grip
               aria-label="Reorder superset, ${esc(names)}. Press the up or down arrow key to move it."
               title="Drag to reorder">${icon('grip', 20, 2.6)}</button>`
    : '';

  return `
    <div class="routine-block routine-superset" data-routine-block="${esc(block.groupId)}">
      <div class="routine-superset__head">${handle}<span>Superset</span></div>
      ${members}
    </div>`;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** A routine row's name. A deleted exercise (D60) is named as what it is. */
function itemName(item) {
  return item.missing ? 'Exercise removed' : item.exercise.name;
}

/**
 * One exercise: the row, plus its plan underneath it.
 *
 * THE PLAN IS RENDERED WHETHER OR NOT IT IS OPEN, and opening it is a `hidden`
 * flip rather than a re-render. Every field in here is uncontrolled, so a
 * re-render is a lost keystroke; opening the plan for the row below the one
 * being typed into must not cost the typing above it.
 *
 * The Sets and Reps cells REPORT the plan. There is nothing to type into them,
 * because the plan is the only place a target is stated: one system here and on
 * the phone, rather than a summary on the web and a set list in the app.
 */
function renderRoutineItem(item, index, state, editable, render, { handle = true, letter = null } = {}) {
  const name = esc(itemName(item));
  const title = letter ? `${letter}. ${name}` : name;
  const open = state.openRoutineItems.has(item.id);
  const planId = `plan-${item.id}`;
  // A row whose exercise is gone has no plan to open, and never crashes the rest.
  const expandable = !item.missing;

  const grip = editable && handle
    ? `<button class="grip" type="button" data-routine-grip
               aria-label="Reorder ${name}. Press the up or down arrow key to move it."
               title="Drag to reorder">${icon('grip', 20, 2.6)}</button>`
    : '';

  const label = `
    <span class="routine-open__chevron">${expandable ? icon('chevronD', 16) : ''}</span>
    <span class="routine-open__main">
      <span class="routine-table__name${item.missing ? ' quiet' : ''}">${title}</span>
      ${item.perSide ? '<span class="routine-table__mode">Per side</span>' : ''}
    </span>`;

  return `
    <div class="routine-item" data-routine-item="${esc(item.id)}">
      <div class="routine-table__row">
        <span class="routine-table__grip">${grip}</span>
        <span class="routine-table__n">${index + 1}</span>
        ${
          expandable
            ? `<button class="routine-open" type="button" data-routine-open
                       aria-expanded="${open}" aria-controls="${esc(planId)}">${label}</button>`
            : `<span class="routine-open">${label}</span>`
        }
        <span class="routine-table__sets">${item.sets.length || ''}</span>
        <span class="routine-table__reps${repsSummary(item) === 'Any' ? ' routine-table__reps--any' : ''}">${esc(repsSummary(item))}</span>
        <span class="routine-table__tools">${
          editable
            ? `<button class="icon-btn icon-btn--danger" type="button" data-routine-remove aria-label="Remove ${name}">${icon('plus', 15)}</button>`
            : ''
        }</span>
      </div>
      ${
        expandable
          ? `<div class="routine-plan" id="${esc(planId)}" data-routine-plan ${open ? '' : 'hidden'}>
               ${renderRoutinePlan(item, editable, render)}
             </div>`
          : ''
      }
    </div>`;
}

/** An exercise's planned sets, one row each, the way the app's builder lists them. */
function renderRoutinePlan(item, editable, render) {
  const name = esc(item.exercise.name);
  const isRepOnlyExercise = isRepOnly(item.exercise);
  const isBodyweight = item.exercise.equipmentType === 'bodyweight';
  const weightLabel = isBodyweight ? 'Added weight' : 'Weight';

  let working = 0;
  const rows = item.sets
    .map((set, i) => {
      if (countsAsWorking(set.setType)) working += 1;
      return renderPlannedSet(set, {
        position: i + 1,
        ordinal: working,
        name,
        editable,
        isRepOnly: isRepOnlyExercise,
        weightLabel,
        unit: item.exercise.unit || 'kg',
        render,
      });
    })
    .join('');

  /* Per side and the superset actions belong to the EXERCISE, not to a set: a
     per-side card logs a left and a right row at one order index (D13), so it
     could never be per-set. They sit at the head of the exercise's own panel,
     which is where everything else about this exercise is edited. */
  const tools = editable
    ? `<div class="plan-tools">
         <label class="check">
           <input type="checkbox" data-per-side ${item.perSide ? 'checked' : ''}>
           <span>Per side</span>
         </label>
         ${
           item.supersetGroupId
             ? '<button class="linkish" type="button" data-superset-remove>Remove from superset</button>'
             : '<button class="linkish" type="button" data-superset-add>Add to superset</button>'
         }
       </div>`
    : item.perSide
      ? '<p class="routine-plan__note">Left and right are logged separately.</p>'
      : '';

  const empty = editable
    ? '<p class="routine-plan__note">No sets planned. Add one to give this exercise a target.</p>'
    : '<p class="routine-plan__note">No sets planned. Every set runs on what you lift.</p>';

  return `
    ${tools}
    ${rows ? `<div class="rsets">${rows}</div>` : empty}
    ${
      editable
        ? `<button class="routine-plan__add" type="button" data-routine-set-add>${icon('plus', 16)}<span>Add set</span></button>`
        : ''
    }`;
}

/**
 * One planned set: its type, its reps target, and an optional weight target.
 *
 * ONE reps number per set, stored as min === max, which is what the app's own
 * builder writes. A stored range (the shape a v1 routine converts to) shows its
 * min, and the next edit rewrites it as a single number, exactly as the app does.
 *
 * The weight is stored in the EXERCISE'S OWN unit and read in the unit on
 * screen, so it goes both ways through the one renderer. An empty field is not
 * a target of 0: null carries whatever was last lifted, 0 asks for zero, and
 * the two stay apart from here down to the envelope.
 */
function renderPlannedSet(set, ctx) {
  const { position, ordinal, name, editable, isRepOnly: repOnly, weightLabel, unit, render } = ctx;
  const tag = SET_TYPE_TAGS[set.setType];
  const spoken = `${SET_TYPE_LABELS[set.setType]} set ${position} of ${name}`;
  const reps = set.repsMin ?? set.repsMax;
  const weight = set.weightMilli == null ? '' : render.value(set.weightMilli, unit);

  const badge = `<span class="rset__badge${tag ? ' rset__badge--tag' : ''}">${esc(tag || String(ordinal))}</span>`;

  if (!editable) {
    const parts = [reps == null ? 'Any reps' : `${reps} reps`];
    if (!repOnly && set.weightMilli != null) parts.push(render.text(set.weightMilli, unit));
    return `
      <div class="rset">
        ${badge}
        <span class="rset__read">${esc(SET_TYPE_LABELS[set.setType])}</span>
        <span class="rset__read rset__read--values">${esc(parts.join(' at '))}</span>
      </div>`;
  }

  const types = SET_TYPES.map(
    (type) =>
      `<option value="${type}"${type === set.setType ? ' selected' : ''}>${esc(SET_TYPE_LABELS[type])}</option>`,
  ).join('');

  const weightField = repOnly
    ? ''
    : `<label class="rset__field rset__field--weight">
         <span class="rset__label">${esc(weightLabel)}</span>
         <span class="rset__box">
           <input class="cell-input" type="text" inputmode="decimal" placeholder="Any"
                  data-set-field="weight" value="${esc(weight === '' ? '' : String(weight))}"
                  aria-label="${esc(weightLabel)} for ${spoken}, in ${esc(render.unit)}">
           <span class="rset__unit">${esc(render.unit)}</span>
         </span>
       </label>`;

  return `
    <div class="rset" data-routine-set="${esc(set.id)}">
      ${badge}
      <label class="rset__field rset__field--type">
        <span class="rset__label">Set type</span>
        <span class="rset__box">
          <select class="cell-select" data-set-field="type" aria-label="Type of ${spoken}">${types}</select>
        </span>
      </label>
      <label class="rset__field rset__field--reps">
        <span class="rset__label">Reps</span>
        <span class="rset__box">
          <input class="cell-input" type="number" min="0" max="999" inputmode="numeric" placeholder="Any"
                 data-set-field="reps" value="${reps == null ? '' : reps}"
                 aria-label="Reps for ${spoken}">
        </span>
      </label>
      ${weightField}
      <button class="icon-btn icon-btn--danger rset__remove" type="button" data-routine-set-remove
              aria-label="Remove set ${position} of ${name}">${icon('plus', 15)}</button>
    </div>`;
}

/** Pick the exercises to group, the app's select mode. Ungrouped rows only. */
function renderSupersetPicker(routine, state) {
  const candidates = routine.items.filter((i) => i.supersetGroupId == null && !i.missing);
  const chosen = state.supersetPicked;

  const rows = candidates
    .map(
      (item) => `
      <label class="pick-row">
        <input type="checkbox" data-superset-pick="${esc(item.id)}" ${chosen.has(item.id) ? 'checked' : ''}>
        <span class="pick-row__name">${esc(itemName(item))}</span>
        <span class="pick-row__meta">${item.sets.length} ${item.sets.length === 1 ? 'set' : 'sets'}</span>
      </label>`,
    )
    .join('');

  const count = chosen.size;
  return `
    <div class="routine-detail">
      <h3 style="margin:0 0 4px;font-size:20px;font-weight:600;color:var(--color-text)">Pick exercises to group</h3>
      <p style="margin:0 0 18px;font-size:15px;max-width:60ch" class="quiet">A superset runs its exercises back to back. They move together and stay together, and the grouping carries into the workout you start from this routine.</p>
      <div class="pick-list">${rows}</div>
      <div class="ex-actions" style="margin-top:18px">
        <div class="ex-actions__left">
          <button class="btn" type="button" data-superset-confirm ${count < 2 ? 'disabled' : ''}>Group ${count} ${count === 1 ? 'exercise' : 'exercises'}</button>
          <button class="btn btn--secondary" type="button" data-superset-cancel>Cancel</button>
        </div>
      </div>
    </div>`;
}

/**
 * The Reps cell. Derived from the planned sets and nowhere else: it says what
 * the sets say, so it reads as one number when they agree and as the span they
 * cover when they do not. Nothing writes a rep target here.
 *
 * The WORKING sets, because that is what the exercise is for. A warmup at 10
 * under two working sets at 5 is not a routine that asks for 5 to 10 reps.
 */
function repsSummary(item) {
  const counted = item.sets.filter((s) => countsAsWorking(s.setType));
  const targets = (counted.length > 0 ? counted : item.sets)
    .map((s) => s.repsMin ?? s.repsMax)
    .filter((v) => v != null);
  if (targets.length === 0) return 'Any';
  const min = Math.min(...targets);
  const max = Math.max(...targets);
  return min === max ? String(min) : `${min}-${max}`;
}

/* =================================================================== EXPORT */

export function renderExport(model, state) {
  const sets = model.sessions.reduce((sum, s) => sum + s.setCount, 0);
  const first = model.sessions.length ? model.sessions[model.sessions.length - 1].startedAt : Date.now();
  const last = model.sessions.length ? model.sessions[0].startedAt : Date.now();
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

  return `
    <h2 style="margin:0 0 6px;font-size:20px;font-weight:600;color:var(--color-text)">Export to a spreadsheet</h2>
    <p style="margin:0 0 20px;max-width:56ch" class="quiet">One row per set, with the date, exercise, weight and reps. Each row keeps the unit you logged it in, and left and right stay in separate columns. Export never depends on a subscription: it works the same whether yours is active, lapsed or gone.</p>

    <div class="export-card">
      <div class="export-dates">
        <label class="field">
          <span class="field__label">From</span>
          <span class="field__box"><input type="date" data-export-from value="${state.exportFrom || iso(first)}"></span>
        </label>
        <label class="field">
          <span class="field__label">To</span>
          <span class="field__box"><input type="date" data-export-to value="${state.exportTo || iso(last)}"></span>
        </label>
      </div>
      <p class="export-label">File</p>
      <div class="export-formats" role="group" aria-label="File format">
        <button type="button" data-format="csv" aria-pressed="${(state.exportFormat || 'csv') === 'csv'}">CSV</button>
        <button type="button" data-format="xlsx" aria-pressed="${state.exportFormat === 'xlsx'}">Excel</button>
      </div>
      <div class="export-foot">
        <span class="export-count">${model.sessions.length.toLocaleString('en-US')} workouts, ${sets.toLocaleString('en-US')} sets</span>
        <button class="btn" type="button" data-export-run>Export</button>
      </div>
      <p class="notice notice--success" data-export-done hidden style="margin:16px 0 0"></p>
    </div>`;
}

/* ================================================================== ACCOUNT */

export function renderAccount(model, state) {
  const render = makeRenderer(model.displayUnit);
  const user = state.user || {};
  const step = fromMilli(state.weightStepMilli ?? model.weightStepMilli);
  const lastBackup = model.sessions.length ? model.sessions[0].endedAt : null;
  const readOnly = state.entitlement !== 'active';

  const provider = { apple: 'Apple', google: 'Google', email: 'Email' }[user.provider] || 'Email';

  const subscription =
    state.entitlement === 'active'
      ? `
        <p style="margin:0 0 6px;font-size:16px;color:var(--color-text)">${esc(planLine(state))}</p>
        ${state.expiresAt ? `<p style="margin:0 0 14px;font-size:15px" class="quiet">Renews ${esc(fullDate(new Date(state.expiresAt).getTime()))}.</p>` : ''}
        <p style="margin:0;font-size:15px" class="quiet">Billed by your app store. Manage or cancel it there, not here.</p>`
      : `
        <p style="margin:0 0 6px;font-size:16px;color:var(--color-text)">Jotlift Pro ended ${esc(state.cutoff ? fullDate(state.cutoff) : 'when your last period ran out')}.</p>
        <p style="margin:0 0 16px;font-size:15px" class="quiet">Your log is still here up to that date and you can still export it. Sync stopped then, so newer workouts stay on your phone. To edit again, and to bring them across, resubscribe in the app.</p>`;

  return `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:var(--color-text)">Account</h2>

    <div class="account-list">
      <div class="account-row">
        <span class="account-row__key">Email</span>
        <span class="account-row__val">${esc(user.email || '')}</span>
      </div>
      <div class="account-row">
        <span class="account-row__key">Signed in with</span>
        <span class="account-row__val">${esc(provider)}</span>
      </div>
      <div class="account-row">
        <span class="account-row__key">Last backup</span>
        <span class="account-row__val account-row__val--num">${lastBackup ? esc(dateTime(lastBackup)) : 'Nothing backed up yet'}</span>
      </div>
      <div class="account-row account-row--control">
        <span class="account-row__key">Weight step</span>
        <span class="stepper">
          <button type="button" data-step="down" aria-label="Decrease"${readOnly || step <= 0.5 ? ' disabled' : ''}>−</button>
          <span class="stepper__value" data-step-value>${step}</span>
          <button type="button" data-step="up" aria-label="Increase"${readOnly || step >= 999 ? ' disabled' : ''}>+</button>
        </span>
      </div>
    </div>
    <p class="account-note">Every + and - on every weight field moves by this, and it is the same number in kg and in lb. It syncs, so each of your devices steps the same way. Changing it never rewrites a weight you already logged.</p>
    <p class="notice notice--success" data-step-saved hidden></p>

    <div class="account-card">
      <div class="account-card__head">
        <h3>Subscription</h3>
        ${
          state.entitlement === 'active'
            ? `<span class="pill pill--success">${icon('check', 12, 2.4)}Active</span>`
            : `<span class="pill pill--warning">${icon('alert', 12, 2)}Lapsed</span>`
        }
      </div>
      ${subscription}
    </div>

    <div class="account-card">
      <h3 style="margin:0 0 8px;font-size:17px;font-weight:600;color:var(--color-text)">Your data</h3>
      <p style="margin:0 0 14px;font-size:15px" class="quiet">Export it from this page any time. Deleting your account removes what we store on our servers and leaves the copy on your phone alone.</p>
      <div class="account-links">
        <a href="/delete/" class="danger-link" style="text-decoration:none">Delete account</a>
        <a href="/privacy/">Privacy</a>
        <a href="/support/">Support</a>
      </div>
    </div>

    <button class="signout" type="button" data-sign-out>Sign out</button>`;
}

function planLine(state) {
  if (!state.product) return 'Jotlift Pro.';
  const yearly = /year|annual/i.test(state.product);
  return `Jotlift Pro, ${yearly ? 'yearly' : 'monthly'}.`;
}
