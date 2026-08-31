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

  const guide =
    pickedIndex != null
      ? `<span class="chart-guide" style="left:${pctX(series[pickedIndex].startedAt)}"></span>
         <span class="chart-dot" style="left:${pctX(series[pickedIndex].startedAt)};top:${py(ys[pickedIndex]).toFixed(1)}px"></span>`
      : '';

  const readout =
    pickedIndex != null
      ? `${metricText(ys[pickedIndex], metric, render)} on ${shortDate(series[pickedIndex].startedAt)}`
      : '';

  const hits = series
    .map(
      (p, i) =>
        `<button class="chart-hit" type="button" data-point="${i}" style="left:${pctX(p.startedAt)}" aria-label="${esc(metricText(ys[i], metric, render))} on ${esc(shortDate(p.startedAt))}"></button>`,
    )
    .join('');

  const label =
    `${metric === 'topSet' ? 'Top set' : metric === 'reps' ? 'Reps' : 'Volume'} for ${exercise.name},` +
    ` ${series.length} sessions from ${shortDate(x0)} to ${shortDate(x1)}`;

  return `
    <p class="chart-readout">${esc(readout)}</p>
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

  const all = model.library.flatMap((g) => g.items);
  const selected = all.find((e) => e.id === state.selectedExercise) || all[0] || null;

  const list = groups
    .map(
      (g) => `
      <section class="ex-group">
        <h3>${esc(g.label)}</h3>
        <div class="ex-list">
          ${g.items.map((e, i) => renderExerciseRow(e, i, selected, model, render)).join('')}
        </div>
      </section>`,
    )
    .join('');

  const empty =
    groups.length === 0
      ? `<p class="ex-empty">No matches. Create &ldquo;${esc(state.exerciseQuery || '')}&rdquo;?</p>`
      : '';

  return `
    <div class="tab-head" style="margin-bottom:14px">
      <h2>Exercises</h2>
      ${state.entitlement === 'active' ? '<button class="btn btn--sm" type="button" data-add-exercise>Add exercise</button>' : ''}
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

    ${list}
    ${empty}
    ${selected ? renderExerciseDetail(selected, model, state, render) : ''}`;
}

function renderExerciseRow(exercise, index, selected, model, render) {
  const isSelected = selected && exercise.id === selected.id;
  const best = bestLine(exercise, model, render);
  const lastDone = model.lastDoneByExercise.get(exercise.id);
  const custom = !exercise.isBuiltin;

  return `
    <button class="ex-row" type="button" data-exercise="${esc(exercise.id)}" aria-selected="${!!isSelected}">
      ${index > 0 ? '<span class="divider-60"></span>' : ''}
      ${tile('dumbbell', 32)}
      <span class="ex-row__main">
        <span class="ex-row__name">${esc(exercise.name)}</span>
        ${custom ? '<span class="ex-row__own">Your own</span>' : ''}
      </span>
      <span class="ex-row__best">${esc(best)}</span>
      <span class="ex-row__last">${lastDone ? esc(shortDate(lastDone)) : ''}</span>
      <span class="ex-row__chevron">${icon('chevronR', 18)}</span>
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

function renderExerciseDetail(exercise, model, state, render) {
  const custom = !exercise.isBuiltin;
  const editable = custom && state.entitlement === 'active';
  const repOnly = model.isRepOnly(exercise);
  const logged = model.lastDoneByExercise.get(exercise.id);

  const builtin = `
    <div class="ex-facts">
      <div><p>Equipment</p><p>${esc(equipmentLabel(exercise.equipmentType))}</p></div>
      <div><p>Unit</p><p>${esc(exercise.unit || 'kg')}</p></div>
      <div><p>Logged in</p><p>${repOnly ? 'Reps' : 'Weight and reps'}</p></div>
    </div>
    <p style="margin:0;font-size:15px;line-height:1.55" class="quiet">This one comes with Jotlift, so its details are fixed. To change how it behaves, add your own version and log against that instead.</p>`;

  const form = `
    <div class="ex-form">
      <label class="field">
        <span class="field__label">Name</span>
        <span class="field__box"><input type="text" data-exercise-name value="${esc(exercise.name)}"></span>
      </label>
      <label class="field">
        <span class="field__label">Equipment</span>
        <span class="field__box"><input type="text" data-exercise-equipment value="${esc(equipmentLabel(exercise.equipmentType))}" readonly></span>
      </label>
    </div>
    ${repOnly ? '<p style="margin:16px 0 0;font-size:15px" class="quiet">Logged in reps. Added load is recorded per set.</p>' : ''}
    <div class="ex-actions">
      <div class="ex-actions__left">
        <button class="btn" type="button" data-exercise-save>Save</button>
      </div>
    </div>
    <p style="margin:14px 0 0;font-size:14px" class="quiet">Renaming keeps every workout you logged with it. Merging and deleting an exercise happen on your phone.</p>`;

  const lapsed = custom && state.entitlement === 'lapsed'
    ? '<p style="margin:16px 0 0;font-size:15px" class="quiet">Editing is paused while your subscription is lapsed. Your exercises and their history are all still here.</p>'
    : '';

  return `
    <div class="ex-detail">
      <h3>${custom ? 'Edit exercise' : 'Exercise details'}</h3>
      <p class="ex-detail__name">${esc(exercise.name)}${logged ? ` · last logged ${esc(shortDate(logged))}` : ''}</p>
      ${editable ? form : builtin}
      ${lapsed}
      <p class="notice notice--success" data-exercise-saved hidden style="margin:16px 0 0"></p>
    </div>`;
}

/* ================================================================= ROUTINES */

export function renderRoutines(model, state) {
  if (model.routines.length === 0) {
    return `
      <div class="tab-head" style="margin-bottom:6px"><h2>Routines</h2></div>
      <p style="margin:0 0 16px;font-size:15px;max-width:60ch" class="quiet">A routine is a named list of exercises in the order you want them. There are no days and nothing is scheduled. Build one on your phone and it appears here.</p>`;
  }

  const selected = model.routines.find((r) => r.id === state.selectedRoutine) || model.routines[0];

  const cards = model.routines
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

  const rows = selected.items
    .map(
      (item, i) => `
      <div class="routine-table__row">
        <span class="routine-table__n">${i + 1}</span>
        <span class="routine-table__name">${esc(item.exercise.name)}</span>
        <span class="routine-table__sets">${item.targetSets ?? ''}</span>
        <span class="routine-table__reps${repsRange(item) === 'Any' ? ' routine-table__reps--any' : ''}">${esc(repsRange(item))}</span>
        <span class="routine-table__grip">${icon('grip', 16)}</span>
      </div>`,
    )
    .join('');

  return `
    <div class="tab-head" style="margin-bottom:6px">
      <h2>Routines</h2>
    </div>
    <p style="margin:0 0 16px;font-size:15px;max-width:60ch" class="quiet">A routine is a named list of exercises in the order you want them. There are no days and nothing is scheduled. Build one here, then start it from your phone whenever you want it.</p>

    <div class="routine-cards">${cards}</div>

    <div class="routine-detail">
      <div class="routine-detail__head">
        <h3>${esc(selected.name)}</h3>
        <span style="font-size:14px" class="decorative">Start it on your phone</span>
      </div>
      <div class="routine-table">
        <div class="routine-table__row routine-table__head">
          <span></span><span>Exercise</span><span style="text-align:right">Sets</span><span style="text-align:right">Reps</span><span></span>
        </div>
        ${rows}
      </div>
      <p style="margin:14px 0 0;font-size:14px" class="quiet">Sets and reps are optional. Leave them blank and the routine just sets the order.</p>
      ${
        state.entitlement === 'lapsed'
          ? '<p style="margin:18px 0 0;font-size:15px" class="quiet">Routines are read only while your subscription is lapsed. Nothing has been deleted, and they work again as soon as you resubscribe.</p>'
          : ''
      }
    </div>`;
}

/** "4 sets of 6 to 8". A routine with no target just sets the order. */
function repsRange(item) {
  const { repsMin, repsMax } = item;
  if (repsMin == null && repsMax == null) return 'Any';
  if (repsMin != null && repsMax != null) return repsMin === repsMax ? String(repsMin) : `${repsMin} to ${repsMax}`;
  return String(repsMin ?? repsMax);
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
