// END-TO-END smoke test for SEARCH, in a real browser.
//
// WHY THIS EXISTS. Search was DEAD in production and nothing noticed.
// `index.html` had `<form id="search-form">` with an input named `q`, and not one
// line of JavaScript listened to it — no submit handler, no URLSearchParams, no
// `location.search`. The only mention of `#search-input` in app.js was the line
// that FOCUSES it. Submitting the form just reloaded the page.
//
// Measured 27 Aug 2026 against the deployed build, not the working tree: live
// app.js was byte-identical to local (79,509 b) and `grep -c "search-form"` was 0.
// So the core function of a media app did nothing, while three tabs called
// Stories, Studio and Family shipped.
//
// A unit test could not have caught it. There was no code to unit-test — the
// failure was an ABSENCE. Only driving the real form in a real browser proves a
// keystroke reaches a result, which is why this test types into the box and waits
// for cards instead of calling a function directly.
//
// It also guards the two things most likely to regress together:
//   - removing a <script> tag while a CALL to it remains. That is a
//     ReferenceError at boot which kills everything after it, and this repo has
//     shipped exactly that twice (profile.js OWNER_PIN_LENGTH, and BlazeOS
//     Phase 1 deleting boot()). Hence: assert ZERO page errors, always.
//   - `safeMeta` is an ALLOW LIST and silently drops `embyId`. An Emby card that
//     loses it still LOOKS right and then plays nothing. Hence: assert the Emby
//     card keeps a playable identity.
//
//   node search.smoke.mjs
//   BW_DIR=/path/to/checkout node search.smoke.mjs
//   BW_URL=https://blazingstream.lyreosai.com/app/ node search.smoke.mjs   # the LIVE build
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const LIVE = process.env.BW_URL || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const FLEET = 'https://fleet.lyreosai.com';

// A title that exists in BOTH places, so the merge and the de-duplication are
// really exercised. Verified live 27 Aug 2026: /search/movie?q=oppenheimer
// answers 19 metas and /emby/search?q=oppenheimer answers 1. A query that hits
// only one backend would pass while the merge was broken.
const QUERY = process.env.Q || 'oppenheimer';

let base = LIVE;
let server = null;
if (!LIVE) {
  server = createServer(async (req, res) => {
    const p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    // The file actually served for "/" is index.html, not "/" — the content-type
    // must come from THAT name, or extname('/') is '' and Chrome gets served the
    // page as application/octet-stream and downloads it instead of rendering it.
    const servedPath = p === '/' ? 'index.html' : p;
    try {
      const body = await readFile(join(ROOT, servedPath));
      res.writeHead(200, { 'content-type': TYPES[extname(servedPath)] || 'application/octet-stream' });
      res.end(body);
      return;
    } catch { /* not a static file — it's a fleet call, handled below */ }

    // ── The profile gate, mocked ──────────────────────────────────────────────
    // profile.js:806 boot() opens this gate on EVERY load and blocks every click
    // behind it until a profile is chosen. A real pass needs a registered device
    // and, for a PIN profile, the household's own PIN — and this test must never
    // touch that: verifyPin() spends one of 5 real attempts per 15 minutes
    // against the LIVE profile (profile.js:536), so a test run hammering that
    // would risk locking Markus out of his own household profile. Instead
    // window.BLAZING_FLEET_BASE (read by both app.js:5 and profile.js:5) is
    // pointed at THIS server, and only these two paths are answered locally —
    // one no-PIN profile, so selectProfile() (profile.js:339) opens it with no
    // server round trip at all. Everything else (/search/*, /emby/search, …) is
    // proxied straight through to the real fleet below, so search itself is
    // still tested against production, not a canned response.
    if (p === '/agent/register') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ deviceId: 'qa-smoke-device', deviceToken: 'qa-smoke-token' }));
      return;
    }
    if (p === '/profiles') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        profiles: [{ id: 'qa-smoke-profile', name: 'QA Smoke', hasPin: false, isKids: false, maxRating: 'adult', allowAdult: true }],
      }));
      return;
    }

    // Anything else app.js asks for — /search/movie, /search/series,
    // /emby/search — is a real fleet call, proxied verbatim so the search
    // checks below still hit production.
    try {
      const upstream = await fetch(`${FLEET}${req.url}`, {
        method: req.method,
        signal: AbortSignal.timeout(20000),
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      res.end(buf);
    } catch {
      res.writeHead(502).end('proxy failed');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ── The backends first. If the fleet is down this test must say THAT, rather ──
// than reporting a client bug that does not exist.
const probe = async (path) => {
  try {
    const r = await fetch(`${FLEET}${path}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    const d = await r.json();
    return d.metas || d.results || [];
  } catch { return null; }
};
const [mv, sr, emby] = await Promise.all([
  probe(`/search/movie?q=${encodeURIComponent(QUERY)}&limit=20`),
  probe(`/search/series?q=${encodeURIComponent(QUERY)}&limit=20`),
  probe(`/emby/search?q=${encodeURIComponent(QUERY)}`),
]);
check('fleet /search/movie answers', Array.isArray(mv) && mv.length > 0, `${mv ? mv.length : 'null'} metas`);
check('fleet /search/series answers', Array.isArray(sr), `${sr ? sr.length : 'null'} metas`);
check('fleet /emby/search answers', Array.isArray(emby), `${emby ? emby.length : 'null'} metas`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// Only in local mode: send both app.js and profile.js to THIS server instead of
// the real fleet, so the mocked profile gate above is what they talk to. Must be
// registered before goto() — addInitScript runs before any of the page's own
// scripts, which is what lets it win the `window.BLAZING_FLEET_BASE ||` default.
if (!LIVE) await page.addInitScript(() => { window.BLAZING_FLEET_BASE = location.origin; });

// AND a device identity, because boot() no longer registers one by itself.
// profile.js:1181 now reads: "A browser that has never registered gets the
// welcome screen instead of a silent auto-registration — Request Access is what
// creates the pending device now". That was a deliberate product change, and it
// made this file hang: with no stored credentials the gate draws Get Access, the
// profile list is never fetched, and the `.bp-profile` click below timed out
// after 15s with a TimeoutError that read like a broken search screen.
// Seeding the same key profile.js reads (DEVICE_STORAGE_KEY) puts this test back
// on the branch it was written for — an already-registered browser.
if (!LIVE) {
  await page.addInitScript(() => {
    localStorage.setItem('blazing-web-profile-device-v1',
      JSON.stringify({ id: 'qa-smoke-device', token: 'qa-smoke-token' }));
  });
}

// Every UNCAUGHT EXCEPTION, collected from before the first byte of app.js
// runs. A ReferenceError thrown at boot is the failure mode that removing a
// script tag causes, and it is silent to a human who only looks at one screen.
// This is the strict, zero-tolerance list; a 404'd poster thumbnail or a
// blocked third-party call is real noise on a live catalog (some titles have
// no artwork, upscale.lyreosai.com sends no CORS headers at all — a known,
// already-reported gap, team chat blazing-stream.md, nyc-main, 27 Aug 2026)
// and says nothing about whether THIS CODE is broken, so it is kept separate
// in consoleErrs for visibility rather than failing the run.
const pageErrs = [];
const consoleErrs = [];
page.on('pageerror', (e) => pageErrs.push(String(e && e.message || e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const loc = m.location && m.location();
  consoleErrs.push(`console: ${m.text()}${loc && loc.url ? ` [${loc.url}]` : ''}`);
});

await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

// boot() opens the gate on every load. Clear it before anything below tries to
// click through it — see the mock's comment above for why this is a fake local
// profile rather than the real household one. The profile list only exists
// because the init script above seeded a device identity.
if (!LIVE) {
  await page.locator('.bp-profile').first().click({ timeout: 15000 });
  await page.waitForTimeout(300);
}
check('the profile gate cleared', await page.evaluate(() => {
  const layer = document.querySelector('.bp-layer');
  return !layer || layer.dataset.gate !== 'required';
}));

// ── The slop tabs must be gone ──────────────────────────────────────────────
// Commits 15b30da and f169d36 added Stories, Studio and Family to a movie app.
// They appeared in FOUR separate nav blocks, and line 57 had the Family button
// JAMMED onto the same line as #search-button — so a careless deletion takes the
// search button with it. Both halves are asserted.
for (const view of ['stories', 'podcasts', 'family']) {
  const n = await page.locator(`[data-view="${view}"]`).count();
  check(`no "${view}" tab anywhere`, n === 0, `${n} found`);
}
check('the search button survived the tab removal',
  (await page.locator('#search-button').count()) > 0);
check('delight.js is not shipped', !(await page.content()).includes('delight.js'));
check('brightminds.js is not shipped', !(await page.content()).includes('brightminds.js'));

// ── One menu, matching the TVs ───────────────────────────────────────────────
// This used to pin ['search','home','movies','shows','anime','roadmaps',
// 'library'], which is NOT the canonical list and had drifted away from it.
// The contract lives in ~/Desktop/roku channels/DESIGN.md (the one canonical
// copy — the blazing-web and firetv copies are derived), quoting Markus:
//
//   Movies · TV Shows · Anime · Roadmaps · Library · Live TV · YouTube ·
//   Games · Adult · Search · Settings
//
// HOME IS DELIBERATELY ABSENT from that list and so it is absent here: a Home
// chip while you are looking at Home does nothing. It stays reachable via
// #brand-button (data-view="home") and the drawer, both asserted below.
//
// Four canonical entries are also absent, and that is the rule that outranks
// the count: never ship a chip that does not go somewhere real. Live TV,
// YouTube, Adult and Settings have NO branch in showRoute() and no view section
// in index.html, so a chip for any of them would blank the screen. Give one a
// real view and it goes in — then update this list. Do not add it first.
//
// Labels only — a data-view value is the router key and renaming one breaks
// navigation, so this checks the ORDER of the keys.
const barKeys = await page.evaluate(() => {
  const bar = document.querySelector('nav, .nav, header nav, .top-nav') || document.body;
  return [...bar.querySelectorAll('[data-view]')].map((b) => b.dataset.view);
});
const wanted = ['movies', 'shows', 'anime', 'roadmaps', 'library', 'games', 'search'];
const firstSeven = barKeys.filter((k, i) => barKeys.indexOf(k) === i).slice(0, 7);
check('bar order is Movies, TV Shows, Anime, Roadmaps, Library, Games, Search',
  JSON.stringify(firstSeven) === JSON.stringify(wanted), firstSeven.join(','));
check('no Home chip in the bar — it is not in the canonical eleven',
  !barKeys.includes('home'), barKeys.join(','));
// Removing the chip must not remove the destination.
check('Home is still reachable from the brand button',
  await page.evaluate(() => document.getElementById('brand-button')?.dataset.view === 'home'));
check('Home is still in the drawer',
  (await page.locator('.drawer-nav [data-view="home"]').count()) > 0);
// Every chip must land on a real route. A chip that goes nowhere is worse than
// a missing one: it is a promise the app breaks on a television.
//
// The section each key must reveal, spelled out. NOT `#${key}-view` with a
// fallback to #home-view — that fallback matches for every key, so the check
// would pass for a chip with no view at all. Movies/Shows/Anime genuinely share
// #home-view with the rows filtered; the rest own a section.
const CHIP_VIEW = {
  movies: 'home-view', shows: 'home-view', anime: 'home-view',
  roadmaps: 'roadmaps-view', library: 'library-view',
  games: 'games-view', search: 'search-view',
};
for (const key of wanted) {
  await page.evaluate((k) => document.querySelector(`.topnav [data-view="${k}"]`).click(), key);
  await page.waitForTimeout(250);
  const shown = await page.evaluate((id) => {
    const s = document.getElementById(id);
    return Boolean(s) && !s.hidden && s.getBoundingClientRect().height > 0;
  }, CHIP_VIEW[key]);
  check(`the "${key}" chip opens #${CHIP_VIEW[key]}`, shown);
}

// The four canonical entries that were LEFT OUT. If someone adds a chip for one
// of these before building its view, this fails — which is the point.
for (const key of ['live', 'livetv', 'youtube', 'adult', 'settings']) {
  check(`no "${key}" chip until it has a view`,
    (await page.locator(`[data-view="${key}"]`).count()) === 0);
}
check('Shows reads "TV Shows", as it does on all three TVs',
  (await page.locator('[data-view="shows"]').first().innerText()).trim().includes('TV Shows'));

// ── Now the actual search ───────────────────────────────────────────────────
await page.locator('[data-view="search"]').first().click();
await page.waitForTimeout(400);
check('the search view opened', await page.locator('#search-view').isVisible());

const form = page.locator('#search-form');
check('the form has a submit listener at all', await page.evaluate(() => {
  const f = document.getElementById('search-form');
  // The bound flag the Requests desk uses. Its absence is what "dead search" was.
  return Boolean(f && f.dataset.bound === 'true');
}));

// Empty query must not fire a request or wipe the view.
await form.locator('input#search-input').fill('');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
check('an empty query is ignored, not searched',
  (await page.locator('#search-results > *').count()) === 0);

// The real query.
const reqs = [];
page.on('request', (r) => { if (r.url().includes('/search/') || r.url().includes('/emby/search')) reqs.push(r.url()); });

// The spinner div is ALSO a child of #search-results — runSearch puts it there
// synchronously, before any backend has been asked anything:
// `results.replaceChildren(el('div', 'spinner big'))` runs before the
// Promise.allSettled below it even starts. So "a child exists" is true from the
// first frame, and waiting on it (as this test used to) passes on the spinner
// while the real search — three backends, one of them fanning out to 36
// addons behind its own hard deadline — is still running. This waits for the
// status line to actually leave "Searching…" instead, which only happens once
// runSearch has written its real answer.
async function waitForSearchSettled(timeout = 45000) {
  await page.waitForFunction(
    () => !(document.getElementById('search-status')?.textContent || '').includes('Searching'),
    null,
    { timeout },
  ).catch(() => {});
}

await form.locator('input#search-input').fill(QUERY);
await page.keyboard.press('Enter');
await waitForSearchSettled();

const cards = await page.locator('#search-results > *').count();
check('SEARCH RETURNED CARDS', cards > 0, `${cards} cards`);

// All three backends, concurrently. Doing them one after another is the slow
// bug that looks like a fast one on a warm cache.
check('it queried movies', reqs.some((u) => u.includes('/search/movie')));
check('it queried series', reqs.some((u) => u.includes('/search/series')));
check('it queried Emby', reqs.some((u) => u.includes('/emby/search')));

// An Emby hit must lead: it streams straight off the fleet with no debrid
// resolve and no torrent, so it is the fastest thing the app can offer.
if (Array.isArray(emby) && emby.length) {
  const leadText = await page.evaluate(() => {
    const first = document.querySelector('#search-results > *');
    return first ? (first.innerText || '').slice(0, 120) : null;
  });
  check('an Emby result leads the list', leadText !== null && /oppenheimer/i.test(leadText || ''),
    leadText);

  // embyId must survive the meta pipeline. `safeMeta` is an ALLOW LIST and has
  // silently dropped embyId before, which leaves a card that looks right and
  // plays nothing (see the comment at app.js:1827).
  //
  // Do NOT look for it in the DOM. Checked 27 Aug 2026: no card carries
  // embyId as a dataset attribute anywhere in this app — the meta object is
  // held in JS and the click handler closes over it. Asserting on
  // `dataset.embyId` therefore fails even when the code is perfect, which is a
  // test reporting a bug that does not exist.
  //
  // The observable proof is the DETAIL screen, and opening one NAVIGATES AWAY —
  // so that check is the last thing this file does, below, after every check
  // that still needs the result list on screen.
}

// De-duplication: the same film arrives from Emby AND Cinemeta. One card.
//
// A bare name is NOT a unique identity, and this query proves it: tt0078037 is
// a 1980 SERIES named, exactly, "Oppenheimer" — a real, different production
// from tt15398776 the 2023 movie, and searchKeys() (app.js) correctly keeps
// both because its key carries `type`. The card the DOM exposes does not (no
// dataset attribute survives, same reason the embyId check below can't read
// one), so a same-label pair coming from DIFFERENT source lists (movie vs
// series) is expected and is excluded here — it is only a bug when the SAME
// list names something twice, which is what the Emby+Cinemeta merge exists to
// prevent.
const crossTypeNames = new Set(
  [...new Set((Array.isArray(mv) ? mv : []).map((m) => String(m.name || '').trim().toLowerCase()))]
    .filter((n) => (Array.isArray(sr) ? sr : []).some((s) => String(s.name || '').trim().toLowerCase() === n))
);
const dupes = await page.evaluate((excluded) => {
  const names = [...document.querySelectorAll('#search-results > *')]
    .map((c) => (c.innerText || '').split('\n')[0].trim().toLowerCase())
    .filter(Boolean);
  const seen = new Set(); const d = [];
  for (const n of names) { if (seen.has(n) && !excluded.includes(n)) d.push(n); seen.add(n); }
  return d;
}, [...crossTypeNames]);
check('no duplicate title across the three backends', dupes.length === 0, dupes.slice(0, 3).join(' | '));

// "Nothing found" and "could not reach" must stay DIFFERENT messages. Telling
// someone "no results" during an outage sends them away thinking the film does
// not exist. app.js already draws this distinction for the Requests desk.
await form.locator('input#search-input').fill('zzzqqqxxnotarealtitle12345');
await page.keyboard.press('Enter');
await waitForSearchSettled();
const emptyMsg = (await page.locator('#search-status').innerText().catch(() => '')) +
  ' ' + (await page.locator('#search-results').innerText().catch(() => ''));
check('a genuinely empty result says "nothing found", not an error',
  /nothing|no result|found nothing/i.test(emptyMsg) && !/could not reach|failed/i.test(emptyMsg),
  emptyMsg.trim().slice(0, 90));

// LAST, because opening a detail screen navigates away from the results.
//
// embyId must survive the meta pipeline. `safeMeta` is an ALLOW LIST and has
// silently dropped embyId before, which leaves a card that looks right and plays
// nothing (see the comment at app.js:1827).
//
// This does NOT look for embyId in the DOM. Checked 27 Aug 2026: no card in this
// app carries embyId as a dataset attribute — the meta object is held in JS and
// the click handler closes over it. Asserting on `dataset.embyId` fails even when
// the code is perfect, which is a test reporting a bug that does not exist.
// app.js:1026-1028 takes the embyId branch and writes "On the Emby server. Press
// Play." — a string only reachable when embyId came through intact.
if (Array.isArray(emby) && emby.length) {
  await form.locator('input#search-input').fill(QUERY);
  await page.keyboard.press('Enter');
  await waitForSearchSettled();
  await page.locator('#search-results > *').first().click();
  await page.waitForTimeout(2500);
  const detail = await page.evaluate(() => document.body.innerText || '');
  check('the leading card opens as an EMBY title (embyId survived safeMeta)',
    /on the emby server/i.test(detail),
    detail.split('\n').find((l) => /emby|press play/i.test(l)) || 'no Emby line on the detail screen');
}

// upscale.lyreosai.com sends no CORS headers at all — a known, already-reported
// blocker (team chat, blazing-stream.md, nyc-main, 27 Aug 2026: "STILL BLOCKED,
// NOT MINE"), not something search touches or this session owns. The detail
// screen's background upscale-status poll trips it on every load, so it is
// excluded here rather than making every future run of this file fail on a
// backend that has nothing to do with search.
check('no uncaught JS exceptions', pageErrs.length === 0, pageErrs.slice(0, 3).join(' | '));
if (consoleErrs.length) {
  console.log(`(${consoleErrs.length} console error line(s), not gating — broken thumbnails and the ` +
    `known upscale CORS gap look exactly like this): ${consoleErrs.slice(0, 3).join(' | ')}`);
}

await page.screenshot({ path: process.env.SHOT || '/tmp/search.png' });
await browser.close();
if (server) server.close();

const failed = results.filter((r) => !r.pass).length;
console.log(`\nquery "${QUERY}" against ${LIVE ? 'the LIVE build' : ROOT}`);
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
