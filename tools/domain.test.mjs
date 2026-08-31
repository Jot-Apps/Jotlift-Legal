/* Checks the ported domain rules against the app's own expectations.
 *
 * Every case below is taken from a test in the Jotlift app repo
 * (src/engine/__tests__/engine.test.ts, src/features/charts/logic/__tests__),
 * or from a worked example in the design handoff. If one of these fails, the
 * dashboard and the phone would print different numbers for the same log.
 *
 * Run: node tools/domain.test.mjs
 */

import assert from 'node:assert/strict';
import {
  derive,
  estimatedOneRepMaxMilli,
  roundEstimateMilli,
  relativeStrength,
  relativeStrengthText,
  convertMilli,
  fromMilli,
  toMilli,
  makeRenderer,
  setVolumeMilli,
  countsAsWorking,
  countsInTotals,
  durationText,
  weekStart,
} from '../assets/js/dashboard/domain.js';
import { fmt, ROWS, savePercent, yearlyPerMonth } from '../assets/js/prices.js';
import { compareHlc, materialise } from '../assets/js/dashboard/store.js';
import { buildRows, toCsv, toXlsx } from '../assets/js/dashboard/export.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`✗ ${name}\n  ${error.message}`);
  }
}

/* ------------------------------------------------------------ the engine */

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;
const rule = (over = {}) => ({ incrementMilli: 2500, gapDays: 30, ...over });

let cursor = 0;
const resetClock = () => {
  cursor = 0;
};
function workSession(weightMilli, reps, count = 3, daysAfter = 1) {
  cursor += daysAfter;
  return {
    startedAt: T0 + cursor * DAY,
    sets: Array.from({ length: count }, (_, i) => ({
      weightMilli,
      reps,
      side: 'both',
      orderIndex: i,
    })),
  };
}
function perSideSession(weightMilli, left, right, daysAfter = 1) {
  cursor += daysAfter;
  return {
    startedAt: T0 + cursor * DAY,
    sets: [
      { weightMilli, reps: left, side: 'left', orderIndex: 0 },
      { weightMilli, reps: right, side: 'right', orderIndex: 0 },
    ],
  };
}

test('no working history yields no walk at all (D20)', () => {
  assert.equal(derive(rule(), []), null);
});

test('one session is not three: quiet, and no floor', () => {
  resetClock();
  const out = derive(rule(), [workSession(60_000, 8)]);
  assert.equal(out.state, 'quiet');
  assert.equal(out.cleanCount, 1);
  assert.equal(out.floorMilli, null);
});

test('the floor IS the walk: the weight the third session completed at', () => {
  resetClock();
  const out = derive(rule(), [
    workSession(60_000, 8),
    workSession(60_000, 8),
    workSession(60_000, 8),
  ]);
  assert.equal(out.floorMilli, 60_000);
  assert.equal(out.state, 'urge');
});

test('a deload never drags the floor down (D34)', () => {
  resetClock();
  const out = derive(rule(), [
    workSession(60_000, 8),
    workSession(60_000, 8),
    workSession(60_000, 8),
    workSession(40_000, 8),
    workSession(40_000, 8),
    workSession(40_000, 8),
  ]);
  assert.equal(out.floorMilli, 60_000);
  assert.equal(out.runWeightMilli, 40_000);
});

test('no down-ratchet: repeated short sessions hold rather than drop', () => {
  resetClock();
  const out = derive(rule(), [
    workSession(60_000, 8),
    workSession(60_000, 3),
    workSession(60_000, 3),
    workSession(60_000, 3),
  ]);
  assert.equal(out.runWeightMilli, 60_000);
  assert.notEqual(out.state, 'urge');
});

test('a lighter day is forgiven: it neither counts nor resets', () => {
  resetClock();
  // The handoff's worked example: 60x8, 60x8, 60x7 (skipped), 60x8 -> the third
  // COUNTING session lands on the fourth workout, and the floor is 60.
  const out = derive(rule(), [
    workSession(60_000, 8),
    workSession(60_000, 8),
    workSession(60_000, 7),
    workSession(60_000, 8),
  ]);
  assert.equal(out.cleanCount, 3);
  assert.equal(out.sessionsAtWeight, 4);
  assert.equal(out.floorMilli, 60_000);
  assert.equal(out.state, 'urge');
});

test('a gap informs, it never acts (D22)', () => {
  resetClock();
  const out = derive(rule({ gapDays: 14 }), [
    workSession(60_000, 8),
    workSession(60_000, 8),
    workSession(60_000, 8, 3, 1),
    workSession(60_000, 3, 3, 60),
  ]);
  assert.equal(out.state, 'welcome-back');
  assert.equal(out.floorMilli, 60_000);
  assert.equal(out.cleanCount, 3);
});

test('the walk self-heals: deleting the third session takes the floor with it (D35)', () => {
  resetClock();
  const base = [workSession(60_000, 8), workSession(60_000, 8), workSession(60_000, 8)];
  assert.equal(derive(rule(), base).floorMilli, 60_000);
  const healed = derive(rule(), [base[0], base[1]]);
  assert.equal(healed.floorMilli, null);
  assert.equal(healed.cleanCount, 2);
  assert.equal(healed.state, 'quiet');
});

test('per side: an ordinal counts as the weaker side (D13)', () => {
  resetClock();
  const out = derive(rule(), [perSideSession(60_000, 8, 6)]);
  // The ordinal reduces to 6, the weaker side, not 8 and not an average of 7.
  assert.equal(out.referenceReps, 6);
});

test('a rep-only exercise has no weight, so it can have no floor', () => {
  resetClock();
  const out = derive(rule({ incrementMilli: null }), [
    workSession(null, 12),
    workSession(null, 12),
    workSession(null, 12),
  ]);
  assert.equal(out.floorMilli, null);
  assert.equal(out.state, 'urge');
});

test('a better session raises the bar and restarts the count at 1', () => {
  resetClock();
  const out = derive(rule(), [
    workSession(60_000, 8),
    workSession(60_000, 8),
    workSession(60_000, 10),
  ]);
  assert.equal(out.referenceReps, 10);
  assert.equal(out.cleanCount, 1);
  assert.equal(out.floorMilli, null);
});

/* ------------------------------------------------------------ estimates */

test('Epley: one rep is the measured load itself', () => {
  assert.equal(estimatedOneRepMaxMilli(100_000, 1), 100_000);
});

test('Epley: 100 kg for 10 is 133.333 kg', () => {
  assert.equal(estimatedOneRepMaxMilli(100_000, 10), 133_333);
});

test('Epley: no weight, or no reps, is no estimate', () => {
  assert.equal(estimatedOneRepMaxMilli(null, 8), null);
  assert.equal(estimatedOneRepMaxMilli(100_000, 0), null);
});

test('an estimate lands on the half-unit grid', () => {
  // The app's own worked example: 213.333 kg reads 213.5 kg.
  assert.equal(roundEstimateMilli(213_333), 213_500);
  assert.equal(roundEstimateMilli(213_800), 214_000);
  assert.equal(roundEstimateMilli(213_100), 213_000);
});

test('an exact half step rounds DOWN, toward the lighter claim', () => {
  assert.equal(roundEstimateMilli(213_250), 213_000);
  assert.equal(roundEstimateMilli(213_251), 213_500);
});

/* --------------------------------------------------- relative strength */

test('relative strength divides by the LATEST bodyweight, to twentieths', () => {
  const ratio = relativeStrength(100_000, 'kg', { valueMilli: 78_000, unit: 'kg' });
  assert.equal(ratio, Math.round((100_000 / 78_000) / 0.05) * 0.05);
  assert.equal(relativeStrengthText(ratio), '1.3x BW');
});

test('units are reconciled before the division', () => {
  // 100 kg lifted, bodyweight recorded as 176.37 lb (= 80 kg): 1.25x, not 0.57x.
  const ratio = relativeStrength(100_000, 'kg', { valueMilli: 176_370, unit: 'lb' });
  assert.equal(relativeStrengthText(ratio), '1.25x BW');
});

test('no bodyweight on record is no figure, not a zero', () => {
  assert.equal(relativeStrength(100_000, 'kg', null), null);
  assert.equal(relativeStrength(100_000, 'kg', { valueMilli: 0, unit: 'kg' }), null);
});

test('trailing zeros go: a whole multiple reads "2x BW"', () => {
  assert.equal(relativeStrengthText(2), '2x BW');
  assert.equal(relativeStrengthText(2.5), '2.5x BW');
});

/* ------------------------------------------------------------- weights */

test('fixed point round trips exactly', () => {
  assert.equal(toMilli(2.5), 2500);
  assert.equal(toMilli(1.25), 1250);
  assert.equal(fromMilli(2500), 2.5);
  assert.equal(fromMilli(60_000), 60);
});

test('lb to kg uses the exact avoirdupois pound', () => {
  assert.equal(convertMilli(1000, 'lb', 'kg'), 454);
  assert.equal(convertMilli(100_000, 'kg', 'lb'), 220_462);
});

test('the renderer prints 60, never 60.0', () => {
  const render = makeRenderer('kg');
  assert.equal(render.text(60_000, 'kg'), '60 kg');
  assert.equal(render.text(62_500, 'kg'), '62.5 kg');
});

test('a weight logged in lb reads in the unit on screen', () => {
  const render = makeRenderer('kg');
  assert.equal(render.text(220_462, 'lb'), '100 kg');
});

/* -------------------------------------------------------------- volume */

test('volume is weight times reps for a loaded exercise', () => {
  const ctx = { equipmentType: 'barbell', bodyweightSubtype: null };
  assert.equal(setVolumeMilli({ weightMilli: 60_000, reps: 8, bodyweightMilliContext: null }, ctx), 480_000);
});

test('a pure bodyweight set folds the captured bodyweight in', () => {
  const ctx = { equipmentType: 'bodyweight', bodyweightSubtype: 'pure' };
  assert.equal(setVolumeMilli({ weightMilli: null, reps: 10, bodyweightMilliContext: 80_000 }, ctx), 800_000);
});

test('an assisted set subtracts the assistance, never below zero', () => {
  const ctx = { equipmentType: 'bodyweight', bodyweightSubtype: 'assisted' };
  assert.equal(setVolumeMilli({ weightMilli: 20_000, reps: 5, bodyweightMilliContext: 80_000 }, ctx), 300_000);
  assert.equal(setVolumeMilli({ weightMilli: 200_000, reps: 5, bodyweightMilliContext: 80_000 }, ctx), 0);
});

test('bodyweight is never invented: no capture, no tonnage from the body', () => {
  const ctx = { equipmentType: 'bodyweight', bodyweightSubtype: 'pure' };
  assert.equal(setVolumeMilli({ weightMilli: null, reps: 10, bodyweightMilliContext: null }, ctx), 0);
});

/* ---------------------------------------------------------- predicates */

test('the engine sees working and failure sets only', () => {
  assert.equal(countsAsWorking('working'), true);
  assert.equal(countsAsWorking('failure'), true);
  assert.equal(countsAsWorking('drop'), false);
  assert.equal(countsAsWorking('backoff'), false);
  assert.equal(countsAsWorking('warmup'), false);
});

test('the totals count everything but a warmup', () => {
  assert.equal(countsInTotals('drop'), true);
  assert.equal(countsInTotals('backoff'), true);
  assert.equal(countsInTotals('warmup'), false);
});

/* -------------------------------------------------------------- format */

test('duration reads "1h 12m" / "34m", no seconds', () => {
  assert.equal(durationText(72 * 60_000), '1h 12m');
  assert.equal(durationText(34 * 60_000), '34m');
});

test('a week starts on Monday', () => {
  const wednesday = new Date(2026, 8, 2, 15, 0, 0).getTime();
  const monday = new Date(2026, 7, 31, 0, 0, 0).getTime();
  assert.equal(weekStart(wednesday), monday);
});

/* -------------------------------------------------------------- prices */

test('a symbol ending in a letter takes a non-breaking space', () => {
  assert.equal(fmt(['', 'CHF', 0, 0, 2], 35), 'CHF 35.00');
  assert.equal(fmt(['', 'CZK', 0, 0, 2], 999), 'Kč 999.00');
  assert.equal(fmt(['', 'PLN', 0, 0, 2], 199.99), 'zł 199.99');
});

test('a glyph symbol sits tight', () => {
  assert.equal(fmt(['', 'GBP', 0, 0, 2], 39.99), '£39.99');
  assert.equal(fmt(['', 'JPY', 0, 0, 0], 6000), '¥6,000');
});

test('free is a bare zero, never 0.00', () => {
  assert.equal(fmt(['', 'USD', 0, 0, 2], 0), 'US$0');
  assert.equal(fmt(['', 'JPY', 0, 0, 0], 0), '¥0');
});

test('decimals belong to the currency, not the export formatting', () => {
  const zero = ['JPY', 'KRW', 'VND', 'IDR', 'HUF', 'CLP', 'COP', 'TWD', 'TZS', 'PKR', 'NGN', 'KZT', 'RUB'];
  for (const row of ROWS) {
    const expected = zero.includes(row[1]) ? 0 : 2;
    assert.equal(row[4], expected, `${row[0]} (${row[1]}) should carry ${expected} decimals`);
  }
});

test('the picker lists 67 storefronts: 66 own-currency, plus the United States', () => {
  assert.equal(ROWS.length, 67);
  assert.equal(ROWS.filter((r) => r[1] === 'USD').length, 1);
  assert.equal(ROWS.find((r) => r[1] === 'USD')[0], 'United States');
});

test('the derived saving is a whole percent off twelve months', () => {
  const us = ROWS.find((r) => r[0] === 'United States');
  assert.equal(savePercent(us), Math.round((1 - 39.99 / (5.99 * 12)) * 100));
  assert.equal(yearlyPerMonth(us), 3.33);
});

test('a zero-decimal currency derives a whole monthly figure', () => {
  const japan = ROWS.find((r) => r[0] === 'Japan');
  assert.equal(yearlyPerMonth(japan), 500);
  assert.equal(fmt(japan, yearlyPerMonth(japan)), '¥500');
});

/* ---------------------------------------------------------------- HLC */

test('HLC orders by millis, then counter, then device', () => {
  const a = '01788152625037-0000-aaa';
  const b = '01788152625038-0000-aaa';
  assert.ok(compareHlc(b, a) > 0);
  assert.ok(compareHlc('01788152625037-0001-aaa', a) > 0);
  // A widened counter still orders correctly against a legacy four-wide one.
  assert.ok(compareHlc('01788152625037-10000-aaa', '01788152625037-zzzz-aaa') > 0);
});

test('the newest write wins, whatever order it arrived in', () => {
  const tables = materialise([
    { entity_table: 'exercises', entity_id: 'x', hlc: '01788152625038-0000-a', deleted: false, payload: { id: 'x', name: 'New' } },
    { entity_table: 'exercises', entity_id: 'x', hlc: '01788152625037-0000-a', deleted: false, payload: { id: 'x', name: 'Old' } },
  ]);
  assert.equal(tables.exercises[0].name, 'New');
});

test('a tombstone drops the entity, by either marker', () => {
  const byFlag = materialise([
    { entity_table: 'exercises', entity_id: 'x', hlc: '01788152625038-0000-a', deleted: true, payload: { id: 'x' } },
  ]);
  assert.equal(byFlag.exercises, undefined);
  const byField = materialise([
    { entity_table: 'exercises', entity_id: 'y', hlc: '01788152625038-0000-a', deleted: false, payload: { id: 'y', deletedAt: 123 } },
  ]);
  assert.equal(byField.exercises, undefined);
});

/* ------------------------------------------------------------- export */

const exportModel = {
  sessions: [
    {
      id: 'w1',
      title: 'Push day',
      startedAt: new Date(2026, 8, 1, 7, 0).getTime(),
      entries: [
        {
          exercise: { id: 'e1', name: 'Bench press', unit: 'kg' },
          sets: [
            { orderIndex: 0, reps: 8, weightMilli: 60_000, side: 'both', setType: 'working' },
            { orderIndex: 1, reps: 8, weightMilli: 60_000, side: 'both', setType: 'warmup' },
          ],
        },
        {
          exercise: { id: 'e2', name: 'Single-arm row', unit: 'lb' },
          sets: [
            { orderIndex: 0, reps: 10, weightMilli: 66_000, side: 'left', setType: 'working' },
            { orderIndex: 0, reps: 9, weightMilli: 66_000, side: 'right', setType: 'working' },
          ],
        },
      ],
    },
  ],
};

test('export writes one row per set, warmups excluded from the totals filter', () => {
  const rows = buildRows(exportModel);
  assert.equal(rows.length, 2);
});

test('each row keeps the unit it was logged in: no silent conversion (D47)', () => {
  const rows = buildRows(exportModel);
  assert.equal(rows[0][7], 'kg');
  assert.equal(rows[1][7], 'lb');
  assert.equal(rows[1][2], 'Single-arm row');
});

test('left and right stay in separate columns, never averaged', () => {
  const [, perSide] = buildRows(exportModel);
  assert.equal(perSide[5], ''); // no single "the" weight for a two-sided set
  assert.equal(perSide[6], '');
  assert.equal(perSide[8], 66); // left weight
  assert.equal(perSide[9], 10); // left reps
  assert.equal(perSide[10], 66); // right weight
  assert.equal(perSide[11], 9); // right reps
});

test('a date range filters by session', () => {
  assert.equal(buildRows(exportModel, { from: Date.parse('2027-01-01') }).length, 0);
  assert.equal(buildRows(exportModel, { to: Date.parse('2026-09-30') }).length, 2);
});

test('the CSV quotes a field containing a comma', () => {
  const csv = toCsv([['a,b', 'c']]);
  assert.ok(csv.includes('"a,b",c'));
});

test('the xlsx is a real ZIP with the parts Excel needs', async () => {
  const blob = toXlsx([['Hello', 1]]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Local file header magic, then the central directory and EOCD at the end.
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const text = Buffer.from(bytes).toString('latin1');
  for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', '_rels/.rels']) {
    assert.ok(text.includes(part), `missing part ${part}`);
  }
  assert.ok(text.includes('<t xml:space="preserve">Hello</t>'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
