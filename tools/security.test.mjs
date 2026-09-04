/* The security guards the pages themselves carry: the Content Security Policy,
 * and the dashboard's refusal to run inside a frame.
 *
 * BOTH ARE CHECKED IN A REAL BROWSER, because neither can be checked any other
 * way. Asserting that a `<meta http-equiv="Content-Security-Policy">` string is
 * present proves that a string is present; it says nothing about whether the
 * browser accepted it, whether the hash in it still matches the inline script
 * it is supposed to allow, or whether an injected script is actually refused.
 * Those are the three things that matter and all three need Chromium.
 *
 * The stale-hash case is the one worth naming. `script-src` allows the pre-paint
 * theme script by its sha256. Edit that script by a byte and the hash no longer
 * matches: the browser silently refuses to run it, every reader who chose light
 * mode gets a dark flash on every navigation, and nothing else breaks, so
 * nothing else notices. `the inline theme script still runs` below is that
 * alarm.
 *
 *   node tools/security.test.mjs
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8137;

const PAGES = [
  'index.html',
  '404.html',
  'delete/index.html',
  'how-it-works/index.html',
  'pricing/index.html',
  'privacy/index.html',
  'support/index.html',
  'terms/index.html',
  'dashboard/index.html',
];

let failures = 0;
const check = (ok, label, extra = '') => {
  if (!ok) {
    failures += 1;
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
};

/* ----------------------------------------------------------- static server */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.csv': 'text/csv',
};

// Serves the repository as GitHub Pages does: files straight off disk, and NO
// headers of our own. That absence is the point. If this server sent a CSP or
// an X-Frame-Options the tests below would be checking the server, not the
// pages, and the pages are all that ships.
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // The attacker's page, generated rather than committed. This repository IS the
  // website, so a fixture file on disk would be a real page at jotlift.app; and
  // it has to be served over http from a private address, because Chromium
  // refuses a subframe navigation from an opaque origin (about:blank) to
  // 127.0.0.1 outright, which would make the frame test pass without the guard
  // ever running. Reached on `localhost`, framing `127.0.0.1`: same address
  // space, different origin, and no policy of its own.
  if (url.pathname === '/__harness/frame.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<iframe src="http://127.0.0.1:${PORT}/dashboard/" width="800" height="600"></iframe>`);
    return;
  }

  let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (rel.endsWith('/')) rel += 'index.html';
  try {
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

/* ------------------------------------------------------- 1. the policy text */

console.log('\n— every page carries a policy, and its hash is the live one —');

const INLINE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const META = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/;

for (const page of PAGES) {
  const html = await readFile(join(ROOT, page), 'utf8');
  const meta = html.match(META);
  if (!meta) {
    check(false, `${page} carries a Content-Security-Policy`);
    continue;
  }
  const policy = meta[1];

  // Hash freshness: every inline script the page actually contains must be
  // named by the policy that page actually carries. Recomputed from the file,
  // never from a constant, so editing the script fails this instead of passing.
  const inline = [...html.matchAll(INLINE)].map((m) => m[1]);
  check(inline.length === 1, `${page} has exactly one inline script`, `${inline.length}`);
  const digest = createHash('sha256').update(inline[0], 'utf8').digest('base64');
  check(policy.includes(`'sha256-${digest}'`), `${page} allows its own inline script by hash`);

  check(!/'unsafe-inline'[^;]*;?\s*$/.test(policy.split('script-src')[1]?.split(';')[0] ?? ''),
    `${page} does not allow arbitrary inline script`);
  check(policy.includes("default-src 'none'"), `${page} denies by default`);
  check(policy.includes("base-uri 'none'"), `${page} pins base-uri`);
  check(policy.includes("form-action 'none'"), `${page} pins form-action`);

  // Only the dashboard talks to the relay, so only the dashboard may.
  const talksToRelay = policy.includes('connect-src https://wyvawvpyiuiqfmegflke.supabase.co');
  check(
    talksToRelay === (page === 'dashboard/index.html'),
    `${page} ${page === 'dashboard/index.html' ? 'may reach' : 'cannot reach'} the relay`,
  );
}

/* ------------------------------------------------- 2. the browser enforces it */

const browser = await chromium.launch();

console.log('\n— Chromium enforces the policy —');
{
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => localStorage.setItem('jotlift.theme', 'light'));
  const page = await ctx.newPage();
  const violations = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });

  await page.goto(`http://127.0.0.1:${PORT}/support/`);

  // THE STALE-HASH ALARM. The inline script's whole job is to set this attribute
  // before first paint. If the hash in the policy no longer matches the script,
  // Chromium refuses to run it and the attribute is simply absent.
  const theme = await page.getAttribute('html', 'data-theme');
  check(theme === 'light', 'the inline theme script still runs', `data-theme=${theme}`);

  // The site's own module scripts are same-origin and must still load.
  check(await page.locator('.site-header').count() > 0, 'the page rendered');

  // An injected inline script is refused. `createElement` + `textContent` is the
  // shape that DOES execute without a policy, so this is a real refusal rather
  // than the HTML parser declining to run markup it never parses as a script.
  const pwned = await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__pwned = true;';
    document.body.appendChild(s);
    return window.__pwned === true;
  });
  check(pwned === false, 'an injected inline script does not execute');

  // And an off-origin fetch from a public page is refused before it leaves.
  const reached = await page.evaluate(async () => {
    try {
      await fetch('https://example.com/', { mode: 'no-cors' });
      return true;
    } catch {
      return false;
    }
  });
  check(reached === false, 'a public page cannot fetch off-origin');

  check(violations.length > 0, 'Chromium reported the refusals');
  await ctx.close();
}

/* --------------------------------------------- 3. the dashboard, in a frame */

console.log('\n— the dashboard refuses to run framed —');
{
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    // A REAL session, so a pass cannot be "there was nothing to steal anyway".
    localStorage.setItem(
      'jotlift.session',
      JSON.stringify({
        access_token: 'test-token',
        refresh_token: 'r',
        expires_at: Date.now() + 3600_000,
        user: { id: 'f1d1a13c-4145-48ef-bcad-3a9d75e9e1aa', email: 'sam@example.com' },
      }),
    );
  });
  const page = await ctx.newPage();

  // Unframed first: the same URL, the same storage, and the dashboard is there.
  // Without this the framed check below would pass just as well on a 404.
  await page.goto(`http://127.0.0.1:${PORT}/dashboard/`);
  await page.waitForTimeout(300);
  check(await page.locator('.site-header').count() > 0, 'unframed, the dashboard renders');

  // Now the same page, framed by another origin. `localhost` and `127.0.0.1`
  // are different origins to a browser and the same address space, which is
  // what lets the frame load at all (see the harness route above).
  await page.goto(`http://localhost:${PORT}/__harness/frame.html`);
  await page.waitForTimeout(800);

  const frame = page.frames().find((f) => f.url().includes(`127.0.0.1:${PORT}/dashboard/`));
  // NOT an accepted outcome. A missing frame means the browser refused the load
  // for its own reasons and the guard was never asked, which is the shape this
  // test took before and passed while proving nothing.
  check(Boolean(frame), 'the dashboard did load in the frame, so the guard ran');
  if (frame) {
    const body = await frame.evaluate(() => ({
      text: document.documentElement.textContent.trim().length,
      root: document.querySelectorAll('[data-dash-root]').length,
      header: document.querySelectorAll('.site-header').length,
    }));
    check(body.text === 0, 'the framed dashboard renders nothing', `${body.text} chars`);
    check(body.root === 0, 'the framed dashboard has no mount point left');
    check(body.header === 0, 'the framed dashboard shows no chrome');
  }
  await ctx.close();
}

await browser.close();
server.close();

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
