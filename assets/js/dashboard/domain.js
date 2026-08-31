/* The domain rules, ported from the Jotlift app so the dashboard and the phone
 * can never disagree about a number. Each block names the file it came from.
 *
 * Weights are integer MILLI of the exercise's native unit (D31) end to end, and
 * convert through one renderer, so an axis and a readout can never round
 * differently.
 */

/* =============================================== src/db/weight.ts (D31) */

// 1 lb = 0.45359237 kg exactly (international avoirdupois pound).
const LB_IN_KG_NUM = 45359237;
const LB_IN_KG_DEN = 100000000;

/** Integer milli-units back to a display value (2500 -> 2.5). */
export function fromMilli(milli) {
  return Number(milliToDecimalString(milli));
}

function milliToDecimalString(milli) {
  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(milli);
  const whole = Math.trunc(abs / 1000);
  const frac = String(abs % 1000).padStart(3, '0').replace(/0+$/, '');
  return frac.length > 0 ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

/** A display value to integer milli-units. Exact: 2.5 -> 2500, never 2499.99. */
export function toMilli(value) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return NaN;
  const [, sign, whole, frac = ''] = match;
  const milli = parseInt(whole, 10) * 1000 + parseInt(frac.slice(0, 3).padEnd(3, '0') || '0', 10);
  return sign === '-' ? -milli : milli;
}

/** One-time fixed-point unit conversion, rounded to the nearest milli. */
export function convertMilli(milli, from, to) {
  if (from === to) return milli;
  if (from === 'lb') return Math.round((milli * LB_IN_KG_NUM) / LB_IN_KG_DEN);
  return Math.round((milli * LB_IN_KG_DEN) / LB_IN_KG_NUM);
}

/**
 * The one weight renderer. A weight is stored in its exercise's native unit and
 * read in the unit on screen; everything that prints a weight goes through here.
 * Trailing zeros go, the way every weight in the app prints: 60, never 60.0.
 */
export function makeRenderer(displayUnit) {
  return {
    unit: displayUnit,
    milli: (milli, recordedIn) => convertMilli(milli, recordedIn, displayUnit),
    value: (milli, recordedIn) => fromMilli(convertMilli(milli, recordedIn, displayUnit)),
    text(milli, recordedIn) {
      return `${milliToDecimalString(convertMilli(milli, recordedIn, displayUnit))} ${displayUnit}`;
    },
  };
}

/* ======================================= src/db/schema/sets.ts predicates */

/* TWO PREDICATES, ANSWERING DIFFERENT QUESTIONS.
 *
 * `countsAsWorking` is what the ENGINE and the BESTS see: what the lifter is
 * working AT. A drop set and a back-off set are lighter than the top set by
 * definition, so neither may reach the engine or a personal best.
 *
 * `countsInTotals` is what the USER READS: volume and the number of sets in a
 * session. Everything but a warmup. Spelled out rather than written as
 * `!== 'warmup'`, so a set type added later lands OUTSIDE the totals until
 * somebody decides it belongs in them. */
export function countsAsWorking(setType) {
  return setType === 'working' || setType === 'failure';
}

const TOTALLED_SET_TYPES = ['working', 'failure', 'drop', 'backoff'];
export function countsInTotals(setType) {
  return TOTALLED_SET_TYPES.includes(setType);
}

/* ============================================== src/db/volume.ts (D84) */

/**
 * One set's volume contribution in integer milli of the exercise's native unit.
 * No weight is ever fabricated: a set with no captured bodyweight contributes
 * only what was actually loaded.
 */
export function setVolumeMilli(set, ctx) {
  const reps = set.reps;
  if (ctx.equipmentType !== 'bodyweight') return (set.weightMilli ?? 0) * reps;
  const bw = set.bodyweightMilliContext ?? 0;
  const added = set.weightMilli ?? 0;
  if (ctx.bodyweightSubtype === 'weighted') return (bw + added) * reps;
  if (ctx.bodyweightSubtype === 'assisted') return Math.max(bw - added, 0) * reps;
  // pure (or a null subtype): bodyweight plus any optional added load.
  return (bw + added) * reps;
}

/* ================================ src/features/charts/logic/estimate.ts */

/**
 * Epley: 1RM = w * (1 + reps/30). Computed ON READ, never stored. A single rep
 * returns the measured load itself (1 + 1/30 would inflate a true 1RM).
 */
export function estimatedOneRepMaxMilli(weightMilli, reps) {
  if (weightMilli == null || reps <= 0) return null;
  if (reps === 1) return weightMilli;
  return Math.round(weightMilli * (1 + reps / 30));
}

/* ============================== src/features/charts/ui/format.ts */

/**
 * The grid an ESTIMATE lands on: a half of whichever unit is on screen, in both
 * units. An exact half step rounds DOWN, toward the lighter claim: Epley
 * estimates a lift that was never performed, so on a coin flip we take the
 * smaller number. Rounded at the RENDER site and nowhere else, after the
 * conversion, because the grid belongs to the unit being read.
 */
const ESTIMATE_ROUND_MILLI = 500;
export function roundEstimateMilli(milli) {
  const lower = Math.floor(milli / ESTIMATE_ROUND_MILLI) * ESTIMATE_ROUND_MILLI;
  const remainder = milli - lower;
  return remainder * 2 > ESTIMATE_ROUND_MILLI ? lower + ESTIMATE_ROUND_MILLI : lower;
}

export function estimateText(milli, recordedIn, render) {
  return render.text(roundEstimateMilli(render.milli(milli, recordedIn)), render.unit);
}

/** A total nobody lifted, so it is rounded to a whole unit and grouped. */
export function volumeText(volumeMilli, recordedIn, render) {
  return `${Math.round(render.value(volumeMilli, recordedIn)).toLocaleString('en-US')} ${render.unit}`;
}

/* ==================== src/features/charts/logic/relative-strength.ts */

/**
 * Heaviest logged weight as a multiple of the LATEST recorded bodyweight,
 * rounded to the nearest 0.05 AT THE SOURCE. Units are reconciled before the
 * division: dividing kg by lb gives a plausible, meaningless number that only
 * ever appears for the users whose two units disagree.
 *
 * Null when there is nothing to divide by, and the row then says so in words
 * rather than printing a figure.
 */
const RATIO_STEP = 0.05;
export function relativeStrength(heaviestMilli, recordedIn, bodyweight) {
  if (bodyweight == null) return null;
  const bodyweightMilli = convertMilli(bodyweight.valueMilli, bodyweight.unit, recordedIn);
  if (bodyweightMilli <= 0) return null;
  return Math.round(heaviestMilli / bodyweightMilli / RATIO_STEP) * RATIO_STEP;
}

/** 2.05 -> "2.05x BW". Trailing zeros go, so a whole multiple reads "2x BW". */
export function relativeStrengthText(ratio) {
  return `${Number(ratio.toFixed(2))}x BW`;
}

/** "8" rep-only, "8 at 60 kg" when a weight was logged. */
export function repsText(reps, atWeightMilli, recordedIn, render) {
  if (atWeightMilli == null) return String(reps);
  return `${reps} at ${render.text(atWeightMilli, recordedIn)}`;
}

/* ================================= src/engine/{scheme,rounding,floor}.ts */

/** Per-side reduction (D13): one ordinal's achieved reps = the WEAKER side. */
function reduceSets(sets) {
  const byOrdinal = new Map();
  for (const set of sets) {
    const existing = byOrdinal.get(set.orderIndex);
    if (!existing) {
      byOrdinal.set(set.orderIndex, { weightMilli: set.weightMilli, reps: set.reps });
      continue;
    }
    existing.reps = Math.min(existing.reps, set.reps);
  }
  return [...byOrdinal.values()];
}

/** The session's working weight: the MODAL weight across its working sets. */
function sessionWeight(reduced) {
  if (reduced.length === 0) return null;
  const counts = new Map();
  for (const set of reduced) counts.set(set.weightMilli, (counts.get(set.weightMilli) ?? 0) + 1);
  let best = reduced[0].weightMilli;
  let bestCount = -1;
  for (const [weight, count] of counts) {
    if (count > bestCount) {
      best = weight;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The session's working reps: the MODAL rep count, a mirror of sessionWeight.
 * Ties break to the HIGHER value, so 8/8/10/10 reads as 10 and the lifter is
 * credited with the work they did.
 */
function sessionReps(reduced) {
  if (reduced.length === 0) return 0;
  const counts = new Map();
  for (const set of reduced) counts.set(set.reps, (counts.get(set.reps) ?? 0) + 1);
  let best = reduced[0].reps;
  let bestCount = -1;
  for (const [reps, count] of counts) {
    if (count > bestCount || (count === bestCount && reps > best)) {
      best = reps;
      bestCount = count;
    }
  }
  return best;
}

const MILLI_DAY = 24 * 60 * 60 * 1000;
function isGap(rule, prevStartedAt, startedAt) {
  if (rule.gapDays == null) return false;
  return startedAt - prevStartedAt > rule.gapDays * MILLI_DAY;
}

/** Three counting sessions at one weight earn the urge (D19). */
export const SESSIONS_TO_URGE = 3;

function liveTarget(rule, weightMilli) {
  const target = rule.targetReps;
  if (target == null || target <= 0) return null;
  if (rule.targetAtWeightMilli !== weightMilli) return null; // stale: ignore, never clear
  return target;
}

function startRun(rule, reduced) {
  const weightMilli = sessionWeight(reduced);
  const reps = sessionReps(reduced);
  const target = liveTarget(rule, weightMilli);
  if (target === null) return { weightMilli, reference: reps, count: 1, sessions: 1, below: false };
  return {
    weightMilli,
    reference: target,
    count: reps >= target ? 1 : 0,
    sessions: 1,
    below: reps < target,
  };
}

function continueRun(rule, run, reps) {
  const sessions = run.sessions + 1;
  const target = liveTarget(rule, run.weightMilli);
  if (target !== null) {
    return {
      ...run,
      reference: target,
      count: reps >= target ? run.count + 1 : run.count,
      sessions,
      below: reps < target,
    };
  }
  // A better session raises the bar and restarts the count at 1. NOT the raw
  // count: the weight did not change, so the run of sessions at it did not end.
  if (reps > run.reference) return { ...run, reference: reps, count: 1, sessions, below: false };
  if (reps === run.reference) return { ...run, count: run.count + 1, sessions, below: false };
  // Under the derived reference: FORGIVEN. The odd 7 under an 8 is neither
  // progress nor punishment, so it neither counts nor resets.
  return { ...run, sessions, below: false };
}

/** The floor IS this walk: the heaviest weight three counting sessions completed at. */
function raiseFloor(floor, run) {
  if (run.count < SESSIONS_TO_URGE || run.weightMilli === null) return floor;
  return floor === null || run.weightMilli > floor ? run.weightMilli : floor;
}

/**
 * Walk history and derive the floor and the run the lifter is inside. Pure, and
 * nothing is stored, so editing a past session and recomputing yields the right
 * answer with no drift (D35). `history` is CHRONOLOGICAL, warmups excluded.
 *
 * Returns null when there is no working-set history to learn from (D20).
 */
export function derive(rule, history) {
  const sessions = history
    .map((s) => ({ startedAt: s.startedAt, reduced: reduceSets(s.sets) }))
    .filter((s) => s.reduced.length > 0);
  if (sessions.length === 0) return null;

  let run = startRun(rule, sessions[0].reduced);
  let floor = raiseFloor(null, run);
  let gapAtEnd = false;

  for (let i = 1; i < sessions.length; i++) {
    // Gaps inform, never act: the session is skipped, no counter moves (D22).
    if (isGap(rule, sessions[i - 1].startedAt, sessions[i].startedAt)) {
      gapAtEnd = true;
      continue;
    }
    gapAtEnd = false;
    const reduced = sessions[i].reduced;
    run =
      sessionWeight(reduced) === run.weightMilli
        ? continueRun(rule, run, sessionReps(reduced))
        : startRun(rule, reduced);
    floor = raiseFloor(floor, run);
  }

  let state = 'quiet';
  if (gapAtEnd) state = 'welcome-back';
  else if (run.below) state = 'below-target';
  else if (run.count > 0 && run.count % SESSIONS_TO_URGE === 0) state = 'urge';

  return {
    state,
    floorMilli: floor,
    cleanCount: run.count,
    runWeightMilli: run.weightMilli,
    referenceReps: run.reference,
    sessionsAtWeight: run.sessions,
  };
}

/* ==================================================== display helpers */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "1 Sep". Not toLocaleDateString: en-GB writes September as "Sept". */
export function shortDate(ms) {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "Mon 1 Sep", the way a session row is dated. */
export function longDate(ms) {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "1 September 2026", for a sentence rather than a column. */
export function fullDate(ms) {
  const d = new Date(ms);
  const full = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d.getDate()} ${full[d.getMonth()]} ${d.getFullYear()}`;
}

/** "1 Sep 2026, 7:12 pm". */
export function dateTime(ms) {
  const d = new Date(ms);
  let hours = d.getHours();
  const suffix = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hours}:${minutes} ${suffix}`;
}

/** "1h 12m" / "34m". No seconds, no padding. */
export function durationText(durationMs) {
  const totalMinutes = Math.max(0, Math.round(durationMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** The Monday of a timestamp's week, as epoch millis. History groups by it (C04). */
export function weekStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const shift = (d.getDay() + 6) % 7; // Monday is the first day
  d.setDate(d.getDate() - shift);
  return d.getTime();
}

/** "This week", "Last week", then "Week of 18 Aug". */
export function weekLabel(startMs, nowMs) {
  const thisWeek = weekStart(nowMs);
  if (startMs === thisWeek) return 'This week';
  if (startMs === thisWeek - 7 * MILLI_DAY) return 'Last week';
  return `Week of ${shortDate(startMs)}`;
}

const EQUIPMENT_LABELS = {
  barbell: 'Barbell',
  dumbbell: 'Dumbbell',
  machine: 'Machine',
  cable: 'Cable',
  bodyweight: 'Bodyweight',
  banded: 'Banded',
  other: 'Other',
};

export function equipmentLabel(type) {
  return EQUIPMENT_LABELS[type] || 'Other';
}

/**
 * A rep-only exercise is marked by a null increment (D135). It stays on the
 * exercise as the engine's rung; NO UI edits it, because the weight step is one
 * app-wide value now.
 */
export function isRepOnly(exercise) {
  return exercise.incrementMilli == null;
}
