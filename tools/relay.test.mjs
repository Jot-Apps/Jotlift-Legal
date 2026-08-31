/* Drive the dashboard against mock relay edge functions, asserting the REQUESTS
 * it makes as well as what it renders. The failure that shipped was a request
 * the browser refused to send, which a render-only test cannot catch. */

import { chromium } from 'playwright';
import { buildFeed } from './sample-feed.mjs';

const BASE = 'http://127.0.0.1:8099';
const FEED = buildFeed();
const PROJECT = 'https://wyvawvpyiuiqfmegflke.supabase.co';

const browser = await chromium.launch();
let failures = 0;
const check = (ok, label, extra = '') => {
  if (!ok) { failures++; console.log(`  ✗ ${label} ${extra}`); }
  else console.log(`  ✓ ${label}`);
};

async function open({ status = 'active', expires = null, rows = FEED, fail = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const seen = [];
  const posted = [];

  await ctx.addInitScript(() => {
    localStorage.setItem('jotlift.theme', 'dark');
    localStorage.setItem('jotlift.tab', 'history');
    localStorage.setItem('jotlift.session', JSON.stringify({
      access_token: 'test-token', refresh_token: 'r',
      expires_at: Date.now() + 3600_000,
      user: { id: 'f1d1a13c-4145-48ef-bcad-3a9d75e9e1aa', email: 'sam@example.com', provider: 'apple' },
    }));
  });

  await ctx.route(`${PROJECT}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    seen.push({ path: url.pathname, search: url.search, method: req.method(), headers: req.headers() });

    if (fail) return route.fulfill({ status: 500, body: '{}' });

    const ok = (body, extra = {}) => route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { date: new Date().toUTCString(), 'access-control-allow-origin': '*', ...extra },
      body: JSON.stringify(body),
    });

    if (url.pathname === '/functions/v1/entitlement') {
      return ok(status === 'none'
        ? { status: 'none', expires_at: null }
        : { status, expires_at: expires, product: 'jotlift_pro_yearly' });
    }
    if (url.pathname === '/functions/v1/export') {
      // The relay strips seq from the portable export.
      return ok({ owner_id: 'o', exported_at: new Date().toISOString(),
        records: rows.map(({ seq, ...rest }) => rest) });
    }
    if (url.pathname === '/functions/v1/push') {
      const body = JSON.parse(req.postData());
      posted.push(body.envelopes);
      return ok({ results: body.envelopes.map((e) => ({ id: e.id, table: e.table, result: 'applied' })) });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The Google Fonts stylesheet cannot load in this sandbox; it is not a defect.
  page.on('requestfailed', (r) => { if (!r.url().includes('fonts.g')) errors.push('requestfailed ' + r.url()); });
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('fonts.g') && !t.includes('ERR_CONNECTION_RESET')) errors.push(t);
  });
  await page.goto(`${BASE}/dashboard/`, { waitUntil: 'domcontentloaded' });
  // Wait for the controller to SETTLE, rather than guessing at a delay: every
  // terminal phase renders one of these.
  await page.waitForSelector(
    '.dash-head, .dash-gate, .empty-card, [data-state="error"], .signin',
    { timeout: 20000 },
  );
  await page.waitForTimeout(250);
  return { page, seen, posted, errors, ctx };
}

console.log('\n— active subscription, full read —');
{
  const { page, seen, errors } = await open();
  check(await page.isVisible('.dash-head h1'), 'the dashboard renders');
  check(!(await page.isVisible('[data-state="error"]')), 'no error screen');

  const ent = seen.find((r) => r.path === '/functions/v1/entitlement');
  const feed = seen.filter((r) => r.path === '/functions/v1/export');
  check(!!ent, 'the entitlement mirror was read');
  check(feed.length === 1, 'the feed was read once, via export', `${feed.length}`);
  check(!seen.some((r) => r.path === '/functions/v1/pull'),
    'pull is not used: it 402s a lapsed owner');
  check(ent.headers.apikey === 'sb_publishable_Rt8XLJrMJrkgpVir0hhjjg_5JJlyPL7', 'the publishable key is sent');
  check(ent.headers.authorization === 'Bearer test-token', 'the access token is sent');
  check(ent.method === 'POST', 'the relay is called with POST', ent.method);

  console.log('  history:', (await page.textContent('.tab-head__meta')).trim());
  check((await page.textContent('.tab-head__meta')).includes('10 workouts'), 'all ten workouts materialised');
  check(errors.length === 0, 'no page errors', errors.join('|'));
  await page.context().close();
}

console.log('\n— a large feed, as the relay returns it —');
{
  const big = [];
  while (big.length < 2400) for (const r of FEED) big.push({ ...r, seq: big.length + 1 });
  big.length = 2400;
  console.log('  (paged feed rows:', big.length + ')');
  const { page, seen, ctx } = await open({ rows: big });
  check(seen.filter((r) => r.path === '/functions/v1/export').length === 1,
    'one call: the relay pages the feed server-side');
  check(await page.isVisible('.dash-head h1'), '2400 rows still render');
  await ctx.close();
}

console.log('\n— lapsed: the read still works, and freezes —');
{
  const expires = new Date(Date.now() - 7 * 86400000).toISOString();
  const { page, ctx } = await open({ status: 'lapsed', expires });
  check(await page.isVisible('.dash-banner'), 'the lapsed banner shows');
  const meta = await page.textContent('.tab-head__meta');
  check(meta.includes('9 workouts'), 'the log is frozen at the cutoff', meta);
  await page.click('[data-tab="account"]');
  await page.waitForTimeout(300);
  const disabled = await page.$$eval('.stepper button', (n) => n.map((e) => e.disabled));
  check(disabled.every(Boolean), 'the stepper is read only');
  await ctx.close();
}

console.log('\n— free account: the upgrade gate, and no feed read —');
{
  const { page, seen, ctx } = await open({ status: 'none' });
  check(await page.isVisible('.dash-gate'), 'the upgrade screen shows');
  const reads = seen.filter((r) => r.path === '/functions/v1/export');
  check(reads.length === 0, 'a free account never reads the log', `${reads.length} reads`);
  await ctx.close();
}

console.log('\n— the write path —');
{
  const { page, posted, ctx } = await open();
  await page.click('[data-tab="account"]');
  await page.waitForTimeout(300);
  const before = await page.textContent('[data-step-value]');
  await page.click('[data-step="up"]');
  await page.waitForTimeout(600);
  const after = await page.textContent('[data-step-value]');
  check(before === '2.5' && after === '3', 'the weight step moves by 0.5', `${before} -> ${after}`);
  check(posted.length === 1, 'one row was appended', `${posted.length}`);

  const row = posted[0]?.[0] || {};
  check(row.table === 'settings', 'to the settings entity', row.table);
  check(row.owner_id === 'f1d1a13c-4145-48ef-bcad-3a9d75e9e1aa', 'owner_id is the signed-in user');
  check(row.payload?.weightStepMilli === 3000, 'the new step is 3000 milli', row.payload?.weightStepMilli);
  check(row.payload?.defaultUnit === 'kg', 'every other field the app wrote survives');
  check(row.schema_version === 42, 'the schema version is echoed, not invented', row.schema_version);
  check(row.deleted === false, 'an edit is not a tombstone');
  check(/^\d{14}-[0-9a-z]{4,}-[0-9a-f-]{36}$/.test(row.hlc || ''), 'the HLC is well formed', row.hlc);

  const stamp = Number(row.hlc.slice(0, 14));
  check(stamp <= Date.now() + 1000, 'the stamp is not ahead of the clock', String(stamp - Date.now()));
  check(!('__change' in (row.payload || {})), 'the internal handle is not written to the log');
  check(await page.isVisible('[data-step-saved]'), 'the save is confirmed on screen');
  await ctx.close();
}

console.log('\n— the server failing is still an error screen —');
{
  const { page, ctx } = await open({ fail: true });
  check(await page.isVisible('[data-state="error"]'), 'the retry screen shows');
  await ctx.close();
}

console.log('\n— the exercise editor opens under its own row —');
{
  const { page, ctx } = await open();
  await page.click('[data-tab="exercises"]');
  await page.waitForSelector('.ex-row');

  // Open the SECOND row of a group, so "under the clicked row" is falsifiable:
  // a panel at the foot of the page would still be "present".
  const rows = page.locator('.ex-row');
  const target = rows.nth(1);
  const name = (await target.textContent()).trim().split('\n')[0].trim();
  await target.click();
  await page.waitForSelector('.ex-panel');

  const placement = await page.evaluate(() => {
    const panel = document.querySelector('.ex-panel');
    const open = document.querySelector('.ex-row[aria-expanded="true"]');
    return {
      isNextSibling: open?.nextElementSibling === panel,
      insideSameList: panel?.closest('.ex-list') === open?.closest('.ex-list'),
      gapPx: panel && open ? Math.round(panel.getBoundingClientRect().top - open.getBoundingClientRect().bottom) : null,
    };
  });
  check(placement.isNextSibling, 'the panel is the clicked row\'s next sibling');
  check(placement.insideSameList, 'and sits inside the same card');
  check(placement.gapPx !== null && Math.abs(placement.gapPx) < 4, 'flush under the row', String(placement.gapPx));

  check(await page.isVisible('[data-field="name"]'), 'it has a name field');
  check(await page.isVisible('[data-field="category"]'), 'a muscle field');
  check(await page.isVisible('[data-field="equipment"]'), 'and an equipment field');

  // A built-in has no Delete, so it must not carry the note that explains one.
  const builtinNotes = await page.locator('.ex-panel__note').allTextContents();
  check(!builtinNotes.some((t) => t.includes('Deleting keeps')),
    'a row with no Delete does not explain deleting');

  // Clicking the open row closes it again.
  await target.click();
  check(!(await page.isVisible('.ex-panel')), 'clicking it again closes the panel');
  await ctx.close();
}

console.log('\n— editing an exercise writes name, muscle and equipment —');
{
  const { page, posted, ctx } = await open();
  await page.click('[data-tab="exercises"]');
  await page.waitForSelector('.ex-row');
  // Bench press: a built-in, so this also covers the graduate-to-custom rule.
  await page.click('.ex-row:has-text("Bench press")');
  await page.waitForSelector('[data-exercise-form]');

  await page.fill('[data-field="name"]', 'Barbell bench press');
  await page.selectOption('[data-field="equipment"]', 'machine');
  await page.selectOption('[data-field="category"]', { label: 'Shoulders' });
  await page.click('[data-exercise-save]');
  await page.waitForTimeout(500);

  const batch = posted[0] || [];
  const ex = batch.find((e) => e.table === 'exercises');
  const links = batch.filter((e) => e.table === 'exercise_categories');
  check(!!ex, 'the exercise row was pushed');
  check(ex.payload.name === 'Barbell bench press', 'the new name', ex?.payload?.name);
  check(ex.payload.nameNormalized === 'barbell bench press', 'normalised for dedup', ex?.payload?.nameNormalized);
  check(ex.payload.equipmentType === 'machine', 'the new equipment', ex?.payload?.equipmentType);
  check(ex.payload.isBuiltin === 0, 'a built-in graduates to the reader\'s own version (D60)');
  check(ex.payload.incrementMilli === 2500, 'the step is left as it was');
  check(links.length === 2, 're-filing tombstones the old link and writes a new one', `${links.length}`);
  check(links.some((l) => l.deleted === true), 'one is a tombstone');
  check(links.some((l) => l.deleted === false), 'one is the new filing');
  check(await page.isVisible('[data-exercise-saved]'), 'the save is confirmed');
  await ctx.close();
}

console.log('\n— a custom exercise can be deleted —');
{
  const { page, posted, ctx } = await open();
  await page.click('[data-tab="exercises"]');
  await page.click('.ex-row:has-text("Banded pull-apart")');
  await page.waitForSelector('[data-exercise-form]');
  check(await page.isVisible('[data-exercise-delete]'), 'a custom exercise offers Delete');
  const notes = await page.locator('.ex-panel__note').allTextContents();
  check(notes.some((t) => t.includes('Deleting keeps')), 'and explains what deleting keeps');
  await page.click('[data-exercise-delete]');
  await page.waitForTimeout(500);
  const batch = posted.at(-1) || [];
  check(batch.some((e) => e.table === 'exercises' && e.deleted === true), 'deleting tombstones it');
  check(!(await page.isVisible('.ex-row:has-text("Banded pull-apart")')), 'and it leaves the library');
  await ctx.close();
}

console.log('\n— creating an exercise —');
{
  const { page, posted, ctx } = await open();
  await page.click('[data-tab="exercises"]');
  await page.click('[data-add-exercise]');
  await page.waitForSelector('[data-exercise-create]');

  await page.fill('[data-exercise-create] [data-field="name"]', 'Pendlay row');
  await page.selectOption('[data-exercise-create] [data-field="equipment"]', 'bodyweight');
  check(await page.isVisible('[data-exercise-create] [data-subtype-field]'),
    'choosing bodyweight reveals the subtype field');
  await page.selectOption('[data-exercise-create] [data-field="subtype"]', 'weighted');
  await page.selectOption('[data-exercise-create] [data-field="category"]', { label: 'Back' });
  await page.click('[data-exercise-create-save]');
  await page.waitForTimeout(500);

  const batch = posted[0] || [];
  const ex = batch.find((e) => e.table === 'exercises');
  check(!!ex, 'the new exercise was pushed');
  check(ex.payload.name === 'Pendlay row', 'with its name');
  check(ex.payload.isBuiltin === 0, 'as a custom exercise');
  check(ex.payload.incrementMilli === null, 'bodyweight is rep-only, so no step');
  check(ex.payload.bodyweightSubtype === 'weighted', 'carrying its subtype');
  check(ex.payload.unit === 'kg', 'in the reader\'s unit');
  check(ex.payload.createdAt > 0 && ex.payload.deletedAt === null, 'stamped like the app stamps one');
  check(batch.some((e) => e.table === 'exercise_categories' && !e.deleted), 'and filed under a muscle');
  await page.waitForTimeout(200);
  check(await page.isVisible('.ex-row:has-text("Pendlay row")'), 'it appears in the library straight away');
  await ctx.close();
}

console.log('\n— routines: create, add, reorder, save, delete —');
{
  const { page, posted, ctx } = await open();
  await page.click('[data-tab="routines"]');
  await page.waitForSelector('.routine-card');

  await page.click('[data-routine-new]');
  await page.waitForTimeout(400);
  const created = (posted.at(-1) || []).find((e) => e.table === 'routines');
  check(!!created && created.payload.name === 'New routine', 'a routine is created');
  check(await page.isVisible('[data-routine-name]'), 'and opens with its name editable');

  await page.fill('[data-routine-name]', 'Upper body');
  await page.selectOption('[data-routine-add-pick]', { label: 'Bench press' });
  await page.click('[data-routine-add]');
  await page.waitForTimeout(400);
  const added = (posted.at(-1) || []).find((e) => e.table === 'routine_exercises');
  check(!!added, 'an exercise is added to it');
  check(added.payload.orderIndex === 0, 'at the start of an empty routine', String(added?.payload?.orderIndex));
  check(added.payload.perSide === 0 && added.payload.supersetGroupId === null,
    'with the field set the app writes');

  await page.selectOption('[data-routine-add-pick]', { label: 'Overhead press' });
  await page.click('[data-routine-add]');
  await page.waitForTimeout(400);
  check((await page.locator('[data-routine-item]').count()) === 2, 'two exercises now');
  check((await page.textContent('[data-routine-name]')) !== undefined, 'the name survived the add');
  check((await page.inputValue('[data-routine-name]')) === 'Upper body',
    'an unsaved name is not thrown away by a structural change');

  // Sets and reps, then a reorder, then save.
  const firstRow = page.locator('[data-routine-item]').first();
  await firstRow.locator('[data-item-field="sets"]').fill('4');
  await firstRow.locator('[data-item-field="reps"]').fill('6-8');
  await page.locator('[data-routine-item]').nth(1).locator('[data-routine-move="up"]').click();
  await page.waitForTimeout(400);
  const reordered = (posted.at(-1) || []).filter((e) => e.table === 'routine_exercises');
  check(reordered.length === 2, 'a reorder rewrites both positions', `${reordered.length}`);
  check(reordered.every((e) => typeof e.payload.orderIndex === 'number'), 'each with an orderIndex');
  const order = await page.locator('.routine-table__name').allTextContents();
  check(order[0].includes('Overhead press'), 'the moved row is now first', order.join(','));

  // Rename right before saving, so the name genuinely needs writing: a
  // structural change earlier already persisted "Upper body", and an unchanged
  // row is deliberately not rewritten.
  await page.fill('[data-routine-name]', 'Upper body A');
  await page.click('[data-routine-save]');
  await page.waitForTimeout(500);
  const saved = posted.at(-1) || [];
  const rt = saved.find((e) => e.table === 'routines');
  const items = saved.filter((e) => e.table === 'routine_exercises');
  check(rt?.payload?.name === 'Upper body A', 'saving writes the name', rt?.payload?.name);
  check((await page.locator('.routine-card__name').allTextContents()).some((t) => t.includes('Upper body A')),
    'and the card shows it');
  // The targets were carried by the reorder, so assert they ROUND TRIPPED:
  // pushed at some point, and read back out of the rebuilt feed onto the row.
  const everyPush = posted.flat().filter((e) => e.table === 'routine_exercises');
  const withTargets = everyPush.find((e) => e.payload.targetSets === 4);
  check(!!withTargets, 'the sets cell was pushed',
    JSON.stringify(everyPush.map((i) => i.payload.targetSets)));
  check(withTargets?.payload?.targetRepsMin === 6 && withTargets?.payload?.targetRepsMax === 8,
    '"6-8" became a min and a max',
    JSON.stringify([withTargets?.payload?.targetRepsMin, withTargets?.payload?.targetRepsMax]));

  const benchRow = page.locator('[data-routine-item]', { hasText: 'Bench press' });
  check((await benchRow.locator('[data-item-field="sets"]').inputValue()) === '4',
    'and the sets cell reads back from the feed');
  check((await benchRow.locator('[data-item-field="reps"]').inputValue()) === '6-8',
    'as does the rep range');

  await page.locator('[data-routine-item]').first().locator('[data-routine-remove]').click();
  await page.waitForTimeout(400);
  const removed = (posted.at(-1) || []).filter((e) => e.table === 'routine_exercises');
  check(removed.some((e) => e.deleted === true), 'removing a row tombstones it');
  check(removed.some((e) => e.deleted === false && e.payload.orderIndex === 0),
    'and the rest close up behind it');

  await page.click('[data-routine-delete]');
  await page.waitForTimeout(500);
  const gone = posted.at(-1) || [];
  check(gone.some((e) => e.table === 'routines' && e.deleted === true), 'deleting tombstones the routine');
  await ctx.close();
}

console.log('\n— the chart keeps the reader\'s place —');
{
  const { page, ctx } = await open();
  await page.click('[data-tab="progress"]');
  await page.waitForSelector('.chart-hit');

  const scroller = page.locator('[data-chart-scroll]');
  const width = await scroller.evaluate((el) => el.scrollWidth - el.clientWidth);
  if (width <= 0) {
    console.log('  (series too short to scroll here; checking the readout only)');
  }

  // Drag back into the history, then read a point.
  await scroller.evaluate((el) => { el.scrollLeft = 0; });
  await page.waitForTimeout(150);
  const before = await scroller.evaluate((el) => el.scrollLeft);

  await page.locator('.chart-hit').first().hover();
  await page.waitForTimeout(300);
  const after = await scroller.evaluate((el) => el.scrollLeft);
  const readout = (await page.textContent('[data-chart-readout]')).trim();

  check(after === before, 'hovering a point does not move the scroll', `${before} -> ${after}`);
  check(readout.length > 0, 'and the readout fills in', readout);
  check(await page.isVisible('[data-chart-guide]'), 'the guide line appears');

  // A second point updates in place, still without moving.
  const hits = await page.locator('.chart-hit').count();
  if (hits > 1) {
    await page.locator('.chart-hit').nth(1).hover();
    await page.waitForTimeout(250);
    const second = (await page.textContent('[data-chart-readout]')).trim();
    const stillThere = await scroller.evaluate((el) => el.scrollLeft);
    check(second !== readout, 'a second point reads out differently', `${readout} / ${second}`);
    check(stillThere === before, 'and the scroll is still where it was', `${stillThere}`);
  }

  // Changing the metric DOES re-pin to the newest, which is the one case it should.
  await page.click('[data-metric="volume"]');
  await page.waitForTimeout(400);
  const repinned = await scroller.evaluate((el) => el.scrollLeft);
  const max = await scroller.evaluate((el) => el.scrollWidth - el.clientWidth);
  check(repinned >= max - 2, 'switching metric re-pins to the newest session', `${repinned}/${max}`);

  const bar = await page.evaluate(() => {
    const el = document.querySelector('.chart-scroll');
    return getComputedStyle(el).scrollbarWidth;
  });
  check(bar === 'thin', 'the scrollbar is the slim styled one', bar);
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
