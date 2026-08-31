/* A change feed shaped exactly like the rows the real relay returns, so the
 * store and the views are exercised on the real payload shapes. */

const OWNER = 'f1d1a13c-4145-48ef-bcad-3a9d75e9e1aa';
const DEVICE = '721ea123-4bdc-4ba5-97d7-b87297e5c22a';
let seq = 0;
let stamp = 1788000000000;

export function row(table, payload) {
  stamp += 1000;
  const hlc = `${String(stamp).padStart(14, '0')}-0000-${DEVICE}`;
  return {
    seq: ++seq,
    entity_table: table,
    entity_id: payload.id,
    hlc,
    deleted: false,
    schema_version: 42,
    payload: { ownerId: OWNER, deviceId: DEVICE, createdAt: stamp, updatedAt: stamp, deletedAt: null, hlc, ...payload },
  };
}

const DAY = 86400000;
// Anchor the demo log to "now" so the week grouping reads This week / Last week.
const now = Date.now();
const at = (daysAgo, hour = 7) => {
  const d = new Date(now - daysAgo * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

const EX = {
  bench: 'e-bench', incline: 'e-incline', fly: 'e-fly', ohp: 'e-ohp',
  row: 'e-row', dbrow: 'e-dbrow', pullup: 'e-pullup', facepull: 'e-facepull',
  squat: 'e-squat', rdl: 'e-rdl', band: 'e-band',
};

const CAT = { chest: 'c-chest', back: 'c-back', shoulders: 'c-shoulders', legs: 'c-legs' };

export function buildFeed() {
  const rows = [];

  for (const [id, name] of [[CAT.chest, 'Chest'], [CAT.back, 'Back'], [CAT.shoulders, 'Shoulders'], [CAT.legs, 'Legs']]) {
    rows.push(row('categories', { id, name, nameNormalized: name.toLowerCase(), isBuiltin: 1 }));
  }

  const exercises = [
    [EX.bench, 'Bench press', 'barbell', 2500, 1, CAT.chest],
    [EX.incline, 'Incline dumbbell press', 'dumbbell', 1250, 1, CAT.chest],
    [EX.fly, 'Cable fly', 'cable', 2500, 1, CAT.chest],
    [EX.ohp, 'Overhead press', 'barbell', 2500, 1, CAT.shoulders],
    [EX.row, 'Barbell row', 'barbell', 2500, 1, CAT.back],
    [EX.dbrow, 'Single-arm dumbbell row', 'dumbbell', 2500, 1, CAT.back],
    [EX.pullup, 'Pull-up', 'bodyweight', null, 1, CAT.back],
    [EX.facepull, 'Face pull', 'cable', 2500, 1, CAT.back],
    [EX.squat, 'Back squat', 'barbell', 5000, 1, CAT.legs],
    [EX.rdl, 'Romanian deadlift', 'barbell', 5000, 1, CAT.legs],
    [EX.band, 'Banded pull-apart', 'banded', 2500, 0, CAT.back],
  ];
  for (const [id, name, equipmentType, incrementMilli, isBuiltin, categoryId] of exercises) {
    rows.push(row('exercises', {
      id, name, nameNormalized: name.toLowerCase(), unit: 'kg', equipmentType,
      incrementMilli, isBuiltin,
      bodyweightSubtype: equipmentType === 'bodyweight' ? 'pure' : null,
    }));
    rows.push(row('exercise_categories', { id: `link-${id}`, exerciseId: id, categoryId }));
  }

  // A deleted exercise, to prove a tombstone is honoured.
  rows.push(row('exercises', { id: 'e-gone', name: 'Deleted lift', nameNormalized: 'deleted lift', unit: 'kg', equipmentType: 'barbell', incrementMilli: 2500, isBuiltin: 0, bodyweightSubtype: null, deletedAt: at(30) }));

  let n = 0;
  function workout(daysAgo, title, mins, blocks) {
    const id = `w-${++n}`;
    const startedAt = at(daysAgo);
    rows.push(row('workouts', { id, title, startedAt, endedAt: startedAt + mins * 60000, notes: null }));
    blocks.forEach(([exerciseId, sets], i) => {
      const weId = `we-${id}-${i}`;
      rows.push(row('workout_exercises', { id: weId, workoutId: id, exerciseId, orderIndex: i, supersetGroupId: null }));
      sets.forEach((s, j) => {
        const base = {
          workoutExerciseId: weId, orderIndex: s.ordinal ?? j,
          setType: s.type || 'working', rir: null, rpeTenths: null, notes: null,
          incrementMilliContext: 2500,
          bodyweightMilliContext: s.bw ?? null,
        };
        if (s.perSide) {
          rows.push(row('sets', { id: `s-${weId}-${j}-l`, ...base, side: 'left', reps: s.left, weightMilli: s.w }));
          rows.push(row('sets', { id: `s-${weId}-${j}-r`, ...base, side: 'right', reps: s.right, weightMilli: s.w }));
        } else {
          rows.push(row('sets', { id: `s-${weId}-${j}`, ...base, side: 'both', reps: s.reps, weightMilli: s.w }));
        }
      });
    });
  }

  const w = (w, reps, extra = {}) => ({ w, reps, ...extra });

  // Bench press: three sessions at 60 kg, so the engine earns a 60 kg floor.
  workout(77, 'Push day', 50, [[EX.bench, [w(55000, 8), w(55000, 8), w(55000, 7)]], [EX.ohp, [w(37500, 8), w(37500, 8)]]]);
  workout(70, 'Push day', 52, [[EX.bench, [w(57500, 8), w(57500, 8), w(57500, 7)]], [EX.fly, [w(17500, 12), w(17500, 12)]]]);
  workout(63, 'Push day', 48, [[EX.bench, [w(60000, 8), w(60000, 8), w(60000, 7)]], [EX.ohp, [w(40000, 6), w(40000, 6)]]]);
  workout(56, 'Push day', 51, [[EX.bench, [w(60000, 8), w(60000, 8), w(60000, 8)]], [EX.incline, [w(22500, 10), w(22500, 10)]]]);
  workout(35, 'Push day', 55, [[EX.bench, [w(60000, 7), w(60000, 8), w(60000, 8)]], [EX.fly, [w(17500, 14)]]]);
  workout(28, 'Push day', 53, [[EX.bench, [w(60000, 8), w(60000, 8), w(60000, 8)]], [EX.ohp, [w(40000, 6), w(40000, 6), w(37500, 6)]]]);
  workout(21, 'Push day', 49, [[EX.bench, [w(62500, 8), w(62500, 8), w(62500, 7)]]]);

  workout(14, 'Legs', 58, [
    [EX.squat, [w(90000, 5), w(90000, 5), w(90000, 5), w(85000, 6)]],
    [EX.rdl, [w(80000, 8), w(80000, 8), w(80000, 8)]],
  ]);
  workout(9, 'Pull day', 47, [
    [EX.row, [w(70000, 8), w(70000, 8), w(70000, 7), w(70000, 7)]],
    [EX.dbrow, [{ w: 30000, perSide: true, left: 10, right: 10 }, { w: 30000, perSide: true, left: 10, right: 9 }]],
    [EX.pullup, [{ w: null, reps: 9, bw: 80000 }, { w: null, reps: 8, bw: 80000 }]],
    [EX.facepull, [w(27500, 15), w(25000, 15, { type: 'drop' })]],
  ]);
  workout(2, 'Push day', 52, [
    [EX.bench, [w(40000, 10, { type: 'warmup' }), w(60000, 8), w(60000, 8), w(60000, 8), w(57500, 8, { type: 'backoff' })]],
    [EX.incline, [w(22500, 10), w(22500, 10), w(22500, 9)]],
    [EX.ohp, [w(40000, 6), w(40000, 6), w(40000, 5)]],
  ]);

  // A workout still open on the phone: History waits until it is finished.
  const openId = 'w-open';
  rows.push(row('workouts', { id: openId, title: 'In progress', startedAt: at(0), endedAt: null, notes: null }));

  rows.push(row('routines', { id: 'r1', name: 'Push day' }));
  [[EX.bench, 4, 6, 8], [EX.incline, 3, 8, 10], [EX.ohp, 4, 5, 6], [EX.fly, 3, 12, 15]].forEach(
    ([exerciseId, targetSets, min, max], i) => {
      rows.push(row('routine_exercises', { id: `re1-${i}`, routineId: 'r1', exerciseId, orderIndex: i, targetSets, targetRepsMin: min, targetRepsMax: max, perSide: 0, supersetGroupId: null }));
    },
  );
  rows.push(row('routines', { id: 'r2', name: 'Pull day' }));
  [[EX.row, 4, 6, 8], [EX.dbrow, 3, 10, 10], [EX.pullup, 3, null, null], [EX.facepull, 3, 15, 15]].forEach(
    ([exerciseId, targetSets, min, max], i) => {
      rows.push(row('routine_exercises', { id: `re2-${i}`, routineId: 'r2', exerciseId, orderIndex: i, targetSets, targetRepsMin: min, targetRepsMax: max, perSide: 0, supersetGroupId: null }));
    },
  );

  rows.push(row('body_metrics', { id: 'bm1', metricType: 'bodyweight', valueMilli: 80200, unit: 'kg', measuredAt: at(3) }));
  rows.push(row('settings', {
    id: '5e771465-0000-4000-8000-000000000000',
    themeMode: 'dark', defaultUnit: 'kg', weightStepMilli: 2500,
    restTimerEnabled: 1, onboardingComplete: 1, notificationCadence: 'off',
    notificationEnabled: 0, restTimerDefaultSeconds: 90,
  }));

  return rows;
}
