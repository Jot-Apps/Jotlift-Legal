# Jotlift website

The public site at [jotlift.app](https://jotlift.app), plus the signed-in Pro
dashboard at `/dashboard`.

Built from `design_handoff_jotlift_web` on the Jot Core design system. Every
colour, size, radius, shadow and timing resolves to a token in
`assets/css/tokens/`, which are the design system's own files, copied
unmodified. Nothing invents a value.

## How it is served

Plain HTML, CSS and ES modules. **No build step, no dependencies, no bundler.**
GitHub Pages serves this repository's root directly, so a push is a deploy and
there is nothing to configure.

One folder per route:

| Route | File |
| --- | --- |
| `/` | `index.html` |
| `/how-it-works/` | `how-it-works/index.html` |
| `/pricing/` | `pricing/index.html` |
| `/support/` | `support/index.html` |
| `/privacy/` | `privacy/index.html` |
| `/terms/` | `terms/index.html` |
| `/delete/` | `delete/index.html` |
| `/dashboard/` | `dashboard/index.html` |

Every public page works with JavaScript turned off. The dashboard does not, and
says so.

## Layout

```
assets/css/tokens/   the Jot Core token files, copied unmodified
assets/css/site.css  the design system realised as classes
assets/js/           theme, icons, prices, the hero walk
assets/js/dashboard/ the signed-in surface
assets/img/screens/  eight real app captures (1206x2622), light and dark
data/                the two App Store Connect price exports
tools/                the checks: domain rules, the relay, the page guards
```

## Pricing

`data/price-monthly.csv` and `data/price-yearly.csv` are the App Store Connect
exports and are the source of truth. They are compiled into `ROWS` in
`assets/js/prices.js`, which has been diffed against them row by row.

The picker lists the **66 storefronts that price in their own currency, plus the
United States** (USD is its own currency): 67 rows. The other 108 of the 175 are
billed by Apple in US dollars and are covered by one line under the picker,
because a picker that answers "Kenya" with a USD figure is not telling a Kenyan
what their currency costs.

Decimals belong to the **currency**, not to how the export printed the number:
zero for JPY, KRW, VND, IDR, HUF, CLP, COP, TWD, TZS, PKR, NGN, KZT and RUB, two
for everything else. A symbol ending in a letter takes a non-breaking space
(`CHF 35.00`, `Kč 999.00`, `zł 199.99`); a glyph symbol sits tight (`£39.99`).

**These figures are what the page prints, never what anybody is charged.** In
the app the price is localized from the store (P04). This table only lets the
web page show a figure before a store SDK has answered.

## The dashboard

Signs in against the Jotlift Supabase project and reads the log the phone backed
up. It uses **the app's own edge functions** (`export`, `entitlement`, `push`)
rather than going at the tables directly, so a web edit lands under the same
rules a phone edit does: the relay validates the stamp against its own clock and
settles each envelope.

Reads go through `export`, **not `pull`**. `pull` is the live-sync leg and is
entitlement-gated, so it answers a lapsed owner with 402, and the lapsed
dashboard is supposed to show the log frozen at the day the subscription ended.
`export` is the always-allowed one-off feed read, returns the same records, and
pages the whole feed server-side.

The publishable key in `assets/js/dashboard/api.js` is public by design. It
identifies the project and grants nothing: `authenticated` holds no SELECT on
any table, so PostgREST cannot read one at all, and the relay derives the owner
from the caller's token rather than from anything the caller sends.

Every page carries a Content Security Policy in its own `<meta>` tag, because
GitHub Pages sends no headers we control. `frame-ancestors` is unavailable that
way (browsers ignore it in a meta policy), so the dashboard — the only page that
holds a session — refuses to run framed in JS instead:
`assets/js/dashboard/frame-guard.js`. `tools/security.test.mjs` drives both in a
real browser.

Three gates, in order: no session, then `entitlement` (`none` gets the upgrade
screen and no data), then the working dashboard. `lapsed` gets the same
dashboard read only, **frozen at the day the subscription ended** — sync stopped
then, so the server holds nothing newer and the page must not imply the log
carries on. Export is never gated by subscription status.

### Domain rules

`assets/js/dashboard/domain.js` is a port of the app's own rules, so the
dashboard and the phone can never print different numbers for the same log. Each
block names the file it came from: the progression walk and the protected floor
(`src/engine/`), Epley and its half-unit grid, relative strength, the volume
function, and the two set-type predicates.

`tools/domain.test.mjs` checks that port against the app's own test cases:

```
node tools/domain.test.mjs
```

## Changing the app-store link

Jotlift is on TestFlight and has no public store listing yet, so every "Get the
app" and "Subscribe in the app" button falls back to the How it works page. Set
`APP_STORE_URL` in `assets/js/app-link.js` and every one of them follows it.
That is the only change needed.

## Voice

Sentence case. No em dashes. No emoji. No guilt framing. Plain verbs, and a
control keeps its word through a flow. Every string on the public pages is final
copy from the handoff and is carried verbatim.
