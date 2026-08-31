/* Materialise the change feed into the entities the tabs read.
 *
 * The server holds an append-only log of changes, one row per write, so the
 * current state of an entity is its LATEST change. "Latest" is the HLC order the
 * app itself uses, not arrival order: a phone that was offline pushes older
 * writes after newer ones, and taking the last row to arrive would let a stale
 * edit win.
 *
 * Everything below is READ ONLY. The dashboard writes through api.push, and only
 * while the entitlement is active.
 */

import {
  countsAsWorking,
  countsInTotals,
  setVolumeMilli,
  derive,
  isRepOnly,
  weekStart,
} from './domain.js';

/**
 * HLC order: `<millis, 14 digits>-<counter, base36>-<device_id>`. The millis and
 * the counter compare NUMERICALLY, so a widened 5-character counter still orders
 * correctly against a legacy 4-character one; the device id breaks a full tie.
 */
export function compareHlc(a, b) {
  const [aMs, aCount, ...aRest] = a.split('-');
  const [bMs, bCount, ...bRest] = b.split('-');
  const ms = Number(aMs) - Number(bMs);
  if (ms !== 0) return ms;
  const count = parseInt(aCount, 36) - parseInt(bCount, 36);
  if (count !== 0) return count;
  return aRest.join('-').localeCompare(bRest.join('-'));
}

/**
 * Fold the feed down to the winning row per entity, keeping the raw change so a
 * write can echo back every field the app wrote and change only what was edited.
 */
export function materialise(rows) {
  const winners = new Map(); // `${table}:${id}` -> row
  for (const row of rows) {
    const key = `${row.entity_table}:${row.entity_id}`;
    const held = winners.get(key);
    if (!held || compareHlc(row.hlc, held.hlc) > 0) winners.set(key, row);
  }

  const tables = {};
  for (const row of winners.values()) {
    // A tombstone, either as the relay's flag or as the row's own deletedAt.
    if (row.deleted || (row.payload && row.payload.deletedAt != null)) continue;
    if (!row.payload) continue;
    (tables[row.entity_table] ||= []).push({ ...row.payload, __change: row });
  }
  return tables;
}

const EMPTY = [];
const at = (tables, name) => tables[name] || EMPTY;

/** Append to a Map of lists, creating the list on first use. */
function group(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Everything the six tabs read, derived once from one feed.
 *
 * `cutoff` freezes the log at a moment. A LAPSED subscription stops sync, so the
 * server holds nothing newer than the day it ended, and the page must not imply
 * the log carries on: every session, series and best stops there.
 */
export function buildModel(tables, { cutoff = Infinity } = {}) {
  const exercises = at(tables, 'exercises');
  const exercisesById = new Map(exercises.map((e) => [e.id, e]));

  const categories = at(tables, 'categories');
  const categoriesById = new Map(categories.map((c) => [c.id, c]));
  const categoryOf = new Map();
  for (const link of at(tables, 'exercise_categories')) {
    if (!categoryOf.has(link.exerciseId) && categoriesById.has(link.categoryId)) {
      categoryOf.set(link.exerciseId, categoriesById.get(link.categoryId).name);
    }
  }

  /* ------------------------------------------------------------- settings */

  const settings = at(tables, 'settings')[0] || null;
  const displayUnit = settings?.defaultUnit === 'lb' ? 'lb' : 'kg';
  const weightStepMilli = settings?.weightStepMilli ?? 2500;

  /* ---------------------------------------------------------- bodyweight */

  // The LATEST reading, which is what relative strength divides by: it answers
  // "what can I lift relative to what I weigh now".
  let bodyweight = null;
  for (const metric of at(tables, 'body_metrics')) {
    if (metric.metricType !== 'bodyweight') continue;
    if (metric.measuredAt > cutoff) continue;
    if (!bodyweight || metric.measuredAt > bodyweight.measuredAt) {
      bodyweight = { valueMilli: metric.valueMilli, unit: metric.unit || 'kg', measuredAt: metric.measuredAt };
    }
  }

  /* ------------------------------------------------------------- sessions */

  const setsByWorkoutExercise = new Map();
  for (const set of at(tables, 'sets')) {
    group(setsByWorkoutExercise, set.workoutExerciseId, set);
  }
  for (const list of setsByWorkoutExercise.values()) list.sort((a, b) => a.orderIndex - b.orderIndex);

  const workoutExercisesByWorkout = new Map();
  for (const we of at(tables, 'workout_exercises')) {
    group(workoutExercisesByWorkout, we.workoutId, we);
  }
  for (const list of workoutExercisesByWorkout.values()) list.sort((a, b) => a.orderIndex - b.orderIndex);

  const sessions = at(tables, 'workouts')
    // A workout with no endedAt is still in progress on the phone. History is a
    // record of what was finished, so it waits until the workout does.
    .filter((w) => w.endedAt != null && w.startedAt <= cutoff)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((workout) => {
      const entries = (workoutExercisesByWorkout.get(workout.id) || [])
        .map((we) => {
          const exercise = exercisesById.get(we.exerciseId);
          if (!exercise) return null;
          const sets = setsByWorkoutExercise.get(we.id) || [];
          return { workoutExerciseId: we.id, exercise, sets };
        })
        .filter(Boolean);

      let setCount = 0;
      let volumeMilli = 0;
      let volumeUnit = null;
      let mixedUnits = false;
      for (const entry of entries) {
        const ctx = {
          equipmentType: entry.exercise.equipmentType,
          bodyweightSubtype: entry.exercise.bodyweightSubtype ?? null,
        };
        for (const set of entry.sets) {
          if (!countsInTotals(set.setType)) continue;
          setCount += 1;
          const unit = entry.exercise.unit || 'kg';
          if (volumeUnit === null) volumeUnit = unit;
          else if (volumeUnit !== unit) mixedUnits = true;
          volumeMilli += setVolumeMilli(set, ctx);
        }
      }

      return {
        id: workout.id,
        title: workout.title || 'Workout',
        startedAt: workout.startedAt,
        endedAt: workout.endedAt,
        durationMs: Math.max(0, workout.endedAt - workout.startedAt),
        entries,
        setCount,
        // Volume is summed in each exercise's own unit. When a log mixes kg and
        // lb the sum is reconciled by the caller through the one renderer.
        volumeMilli,
        volumeUnit: volumeUnit || 'kg',
        mixedUnits,
      };
    });

  /* -------------------------------------------------- per-exercise history */

  /* One chronological history per exercise, which is what the engine walks and
   * what the chart plots. Built once here rather than per tab. */
  const historyByExercise = new Map();
  for (let i = sessions.length - 1; i >= 0; i--) {
    const session = sessions[i];
    for (const entry of session.entries) {
      group(historyByExercise, entry.exercise.id, {
        workoutId: session.id,
        startedAt: session.startedAt,
        sets: entry.sets,
        exercise: entry.exercise,
      });
    }
  }

  /* The protected floor per exercise, from the engine's own walk. Warmups are
   * excluded before the engine sees them, and the walk reads working sets only. */
  const floorByExercise = new Map();
  for (const [exerciseId, history] of historyByExercise) {
    const exercise = exercisesById.get(exerciseId);
    if (!exercise) continue;
    const walk = derive(
      { incrementMilli: exercise.incrementMilli ?? null, unit: exercise.unit || 'kg' },
      history.map((s) => ({
        startedAt: s.startedAt,
        sets: s.sets
          .filter((set) => countsAsWorking(set.setType))
          .map((set) => ({ weightMilli: set.weightMilli, reps: set.reps, side: set.side, orderIndex: set.orderIndex })),
      })),
    );
    if (walk && walk.floorMilli != null) floorByExercise.set(exerciseId, walk.floorMilli);
  }

  /* ------------------------------------------------------------- routines */

  const routineSetsByExercise = new Map();
  for (const rs of at(tables, 'routine_sets')) {
    group(routineSetsByExercise, rs.routineExerciseId, rs);
  }

  const routineExercisesByRoutine = new Map();
  for (const re of at(tables, 'routine_exercises')) {
    group(routineExercisesByRoutine, re.routineId, re);
  }
  for (const list of routineExercisesByRoutine.values()) list.sort((a, b) => a.orderIndex - b.orderIndex);

  const routines = at(tables, 'routines')
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map((routine) => {
      const items = (routineExercisesByRoutine.get(routine.id) || [])
        .map((re) => {
          const exercise = exercisesById.get(re.exerciseId);
          if (!exercise) return null;
          const planned = routineSetsByExercise.get(re.id) || [];
          // Target sets can be stated on the exercise or implied by the planned
          // set rows; neither is required, and a routine with neither just sets
          // the order.
          const targetSets = re.targetSets ?? (planned.length || null);
          return {
            id: re.id,
            raw: re,
            exercise,
            targetSets,
            repsMin: re.targetRepsMin ?? null,
            repsMax: re.targetRepsMax ?? null,
            perSide: !!re.perSide,
          };
        })
        .filter(Boolean);

      const tags = [];
      for (const item of items) {
        const label = categoryOf.get(item.exercise.id);
        if (label && !tags.includes(label)) tags.push(label);
      }

      return { id: routine.id, raw: routine, name: routine.name || 'Routine', items, tags };
    });

  /* ------------------------------------------------------ exercise library */

  const lastDoneByExercise = new Map();
  for (const session of sessions) {
    for (const entry of session.entries) {
      if (!lastDoneByExercise.has(entry.exercise.id)) lastDoneByExercise.set(entry.exercise.id, session.startedAt);
    }
  }

  const groups = new Map();
  for (const exercise of exercises) {
    // An exercise nobody has logged and nobody has filed still belongs in the
    // library: this is the list you pick from, not a list of what you have done.
    const label = categoryOf.get(exercise.id) || 'Other';
    group(groups, label, exercise);
  }
  const library = [...groups.entries()]
    .map(([label, items]) => ({
      label,
      items: items.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    }))
    .sort((a, b) => (a.label === 'Other' ? 1 : b.label === 'Other' ? -1 : a.label.localeCompare(b.label)));

  /* ---------------------------------------------------------------- totals */

  const totals = sessions.reduce(
    (acc, s) => {
      acc.workouts += 1;
      acc.ms += s.durationMs;
      acc.sets += s.setCount;
      return acc;
    },
    { workouts: 0, ms: 0, sets: 0 },
  );

  /* --------------------------------------------------------- week grouping */

  const weeks = [];
  let current = null;
  for (const session of sessions) {
    const start = weekStart(session.startedAt);
    if (!current || current.start !== start) {
      current = { start, sessions: [] };
      weeks.push(current);
    }
    current.sessions.push(session);
  }

  return {
    exercises,
    exercisesById,
    categoryOf,
    library,
    sessions,
    weeks,
    totals,
    historyByExercise,
    floorByExercise,
    lastDoneByExercise,
    routines,
    bodyweight,
    settings,
    displayUnit,
    weightStepMilli,
    isRepOnly,
  };
}
