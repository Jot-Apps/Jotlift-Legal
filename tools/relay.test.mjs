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

await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
