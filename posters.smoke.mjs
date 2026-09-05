/**
 * A poster behaves the same wherever it is — Continue Watching and Search included.
 *
 * Markus, 2026-08-30: "all posters load the trailers like debridstreams? embry
 * continue watching all the posters. even when you search for the movie."
 *
 * They did not. Two places were left out, for two different reasons, and this
 * file pins both:
 *
 *  1. CONTINUE WATCHING never called claimHeroRow(). It was the one
 *     card-building path in app.js that skipped it, so the row could never carry
 *     .row-hero — the very titles a viewer is part-way through were the only
 *     ones whose posters would not open, while the identical film one row down
 *     in Trending would.
 *
 *  2. SEARCH RESULTS are a 5-across GRID, not a track, so the card cannot widen
 *     there without breaking the grid — and DebridStream's own search is a plain
 *     poster grid for exactly that reason (REFERENCE-debridstream-v36.md).
 *     attachHoverTrailer's gate refused anything outside .row-hero, so a search
 *     result played nothing at all. It now plays the trailer IN PLACE:
 *     .card-trailer-wrap is `position:absolute; inset:0` over opaque black, so it
 *     needs no room of its own, and the text panel stays shut because only
 *     `.row-hero .card:hover` reveals it.
 *
 * Both are negative-controlled — see the header of each section for the exact
 * edit that reddens it.
 *
 *   node posters.smoke.mjs
 */
import { launchBrowser } from './comet.mjs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, p === '/' ? 'index.html' : p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
});
// Port 0 — the kernel picks a free one. Several files in this suite bind a FIXED
// port and cannot be run two at a time; this one can.
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// safeMeta() runs every image through safeHttpsUrl(), which takes https ONLY —
// a data: URI is dropped and the meta arrives with background undefined, which
// is the one field claimHeroRow reads. These need to be https and need not resolve.
const PIX = 'https://img.invalid/poster.jpg';
const ART = 'https://img.invalid/backdrop.jpg';

const META = (n, pre) => ({
  metas: Array.from({ length: n }, (_, i) => ({
    id: `tt900${i}0`, name: `${pre} title ${i + 1}`, type: 'movie',
    poster: PIX, background: ART, releaseInfo: '2026',
  })),
});

// The Continue Watching payload. `background` is what decides the row's fate, so
// it is here on purpose — a real resume item carries one (profiles.js's
// sanitizeProgressPayload whitelists `background`).
const PROGRESS = {
  items: Array.from({ length: 4 }, (_, i) => ({
    id: `tt800${i}0`, name: `Resume ${i + 1}`, type: 'movie',
    poster: PIX, background: ART, releaseInfo: '2026',
    progress: { position: 600, duration: 6000 },
  })),
};

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`ok    ${label}${extra ? '  ' + extra : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-1', token: 'tok' }));
  // profileId is deliberately NOT seeded. profile.js never writes that key, so
  // seeding it here would hide the very bug this file exists to hold down: the
  // app must learn the profile from the selection EVENT, not from storage
  // somebody put there by hand.
});

const seen = [];
await ctx.route('https://addon.lyreosai.com/**', (route) => {
  const u = route.request().url();
  seen.push(u.replace('https://addon.lyreosai.com', ''));
  if (u.includes('/api/ui/home-config')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ mode: 'blazing', appName: 'Blazing Stream', theme: 'cinema_dark', homeRows: [
      { id: 'trending_m', type: 'card_row', catalogSlug: 'blazing-movies', label: 'Trending Movies' },
    ] }) });
  if (u.includes('/manifest.json')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ catalogs: [{ id: 'blazing-movies', type: 'movie', name: 'Movies' }] }) });
  if (u.includes('/meta/')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ meta: {
      id: 'tt900000', name: 'Full title', type: 'movie', poster: PIX, background: ART,
      description: 'The synopsis that only the meta route carries.',
      imdbRating: '7.8', runtime: '118 min', genres: ['Drama'],
      trailers: [{ source: 'Y1IgAEejvqM', type: 'Trailer' }],
    } }) });
  // OUR OWN resolver, never a YouTube iframe — no Roku, Apple TV, Fire TV, LG,
  // Samsung or VegaOS can run one, so the browser must not be special.
  if (u.includes('/proxy/yt-resolve')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ url: '/proxy/hls?u=https%3A%2F%2Fmanifest.googlevideo.com%2Ffake.m3u8', streamFormat: 'hls' }) });
  if (u.includes('/api/sync/progress/recent')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROGRESS) });
  if (u.includes('/catalog/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(8, 'cat')) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
await ctx.route('https://fleet.lyreosai.com/**', (route) => {
  const u = route.request().url();
  // Search is a FLEET route, not an addon one — runSearch() calls
  // `${FLEET_BASE}/search/movie` and `/search/series` side by side (app.js:698).
  // Only the movie leg answers, so the 5 cards below are 5, not 10.
  if (u.includes('/search/movie')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(5, 'found')) });
  if (u.includes('/search/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ metas: [] }) });
  if (u.includes('/discover/filter/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(6, 'fresh')) });
  if (u.includes('/devices/register')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, device: { id: 'dev-1', status: 'approved' }, token: 'tok' }) });
  if (u.includes('/emby/search')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ metas: [] }) });
  if (u.includes('/profiles')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profiles: [{ id: 'p1', name: 'Mark', maxRating: 'adult', hasPin: false }] }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
// The upscale host is a THIRD origin and an earlier session had to learn this the
// hard way: leave it uninterceded and the page makes real requests that fail as
// CORS errors in the console, which then read as app bugs.
await ctx.route('https://upscale.lyreosai.com/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

const page = await ctx.newPage();
// A row that never gets built looks exactly like a row built wrong, so keep the
// page's own errors where the failure text can quote them.
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

// Choose a profile, or ratingAllowed() holds state.profileCap at 'general', every
// UNRATED fixture meta is refused, and every row empties itself with no error.
const tile = page.locator('.bp-profile').first();
if (await tile.count()) { await tile.click(); await page.waitForTimeout(2500); }
await page.waitForSelector('#rows .row', { timeout: 15000 });

/**
 * Hover, and do not measure until the browser agrees the pointer landed.
 * Same reasoning as rowhero.smoke.mjs: headless Chromium does not paint while
 * the test sleeps, so a fixed wait measures a resting card and calls the feature
 * broken. Poll on a timer, never on rAF — no frames is the condition being
 * waited out, so an rAF poll sleeps exactly as long as the thing it watches for.
 */
let lastHot = false;
async function hoverUntil(page, locator, predicate, timeout = 6000) {
  // A Locator is NOT a valid waitForFunction argument — it serialises to {} and
  // every predicate throws on the first line, so the wait "finishes" in about a
  // millisecond and the test measures a card the hover never had time to reach.
  // waitForFunction needs a real ElementHandle.
  const el = await locator.elementHandle();
  lastHot = false;
  for (let attempt = 0; attempt < 3 && !lastHot; attempt += 1) {
    // NOT locator.hover(). That runs an actionability check first, and this app
    // has a sticky top bar: when it covers the card, hover() throws
    // "intercepts pointer events", the .catch swallows it, and the test then
    // measures a card the pointer never reached — which reads as "the trailer
    // is broken" when the pointer simply never arrived. Scroll it to the middle
    // and drive the real mouse to its centre instead.
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const box = await el.boundingBox().catch(() => null);
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    lastHot = await page.waitForFunction((c) => c.matches(':hover'), el, { timeout: 1500, polling: 100 })
      .then(() => true).catch(() => false);
    if (lastHot) break;
    await page.mouse.move(5, 5);
    await page.waitForTimeout(200);
  }
  return page.waitForFunction(predicate, el, { timeout, polling: 150 })
    .then(() => true).catch(() => false);
}

// ── 1: Continue Watching is a real row, not a lesser one ────────────────────
// NEGATIVE CONTROL: delete the `claimHeroRow(section, metas)` call at the end of
// loadContinueWatching() in app.js and the first two of these three go red.
const cw = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#rows .row')];
  const row = rows.find((r) => /continue watching/i.test((r.querySelector('h2,h3,.row-title') || {}).textContent || ''));
  if (!row) return null;
  return {
    hero: row.classList.contains('row-hero'),
    cards: row.querySelectorAll('.card').length,
    bars: row.querySelectorAll('.progress-bar').length,
    firstIsCard: !!row.querySelector('.card .card-backdrop'),
  };
});

if (!cw) {
  const names = await page.evaluate(() => [...document.querySelectorAll('#rows .row')]
    .map((r) => (r.querySelector('.row-title') || {}).textContent || '?'));
  ok(false, 'a Continue Watching row was built at all',
    `rows=[${names.join(' | ')}] hit=[${seen.join(' ')}] errors=[${errors.slice(0, 3).join(' ; ')}]`);
} else {
  ok(cw.cards === 4, 'Continue Watching built its cards', `(${cw.cards})`);
  ok(cw.hero, 'Continue Watching is a .row-hero, like every other row that can be');
  ok(cw.firstIsCard, 'its cards carry the same backdrop markup as a catalogue card');
  ok(cw.bars === 4, 'and it keeps its resume progress bars', `(${cw.bars})`);
}

// The expand has to actually happen, not just be permitted by a class.
if (cw && cw.hero) {
  const card = page.locator('[data-row-id="continue-watching"] .card').first();
  // Stamp the resting width ON the node before waiting, so the predicate can
  // tell "still at rest" from "moving" from "arrived". Doing it afterwards left
  // c.__rest undefined and the very first poll counted as a change.
  const rest = await card.evaluate((c) => {
    delete c.__seen;
    c.__rest = getComputedStyle(c).width;
    return c.__rest;
  });
  const grew = await hoverUntil(page, card, (c) => {
    const now = getComputedStyle(c).width;
    if (now === c.__rest) return false;      // still resting
    if (c.__seen === now) return true;       // two polls the same: it has settled
    c.__seen = now;                          // still moving
    return false;
  });
  const now = await card.evaluate((c) => getComputedStyle(c).width);
  ok(grew && parseFloat(now) > parseFloat(rest) + 40,
    'a Continue Watching poster really expands on hover', `(${rest} -> ${now}, hot=${lastHot})`);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
}

// ── 2: a search result plays a trailer, in place ────────────────────────────
// NEGATIVE CONTROL: put attachHoverTrailer's gate back to
// `if (!card.closest('.row-hero')) return;` and the trailer check goes red.
await page.evaluate(() => document.querySelector('[data-view="search"]').click());
await page.waitForTimeout(600);
await page.fill('#search-input', 'found');
await page.locator('#search-form button[type="submit"]').click();
const drew = await page.waitForSelector('#search-results .card', { timeout: 10000 })
  .then(() => true).catch(() => false);
if (!drew) {
  const why = await page.locator('#search-status').textContent().catch(() => '');
  ok(false, 'the search grid rendered its results', `status="${(why || '').trim()}"`);
  await browser.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

const grid = await page.evaluate(() => {
  const box = document.getElementById('search-results');
  return {
    cards: box.querySelectorAll('.card').length,
    // It must NOT be a .row-hero — the grid cannot take a widening card.
    inHero: !!box.closest('.row-hero'),
    cols: getComputedStyle(box).gridTemplateColumns.split(' ').length,
  };
});
ok(grid.cards === 5, 'the search grid rendered its results', `(${grid.cards})`);
ok(!grid.inHero, 'the search grid is NOT a .row-hero — a 5-across grid cannot widen a card');

const hit = page.locator('#search-results .card').first();
const restW = await hit.evaluate((c) => getComputedStyle(c).width);
const played = await hoverUntil(page, hit, (c) => !!c.querySelector('.card-trailer-wrap video'), 9000);
const after = await page.evaluate(() => {
  const c = document.querySelector('#search-results .card');
  const v = c.querySelector('.card-trailer-wrap video');
  return {
    hasVideo: !!v,
    isIframe: !!c.querySelector('.card-trailer-wrap iframe'),
    width: getComputedStyle(c).width,
    previewing: c.classList.contains('card-previewing'),
    stillHot: c.matches(':hover, :focus-within'),
  };
});
ok(played && after.hasVideo, 'a SEARCH result plays its trailer on hover',
  played ? '' : `wentHot=${lastHot} previewing=${after.previewing} stillHot=${after.stillHot} hit=[${seen.join(' ')}]`);
// Tied to hasVideo on purpose: "no iframe" is satisfied by an empty card, so on
// its own this check would stay green for a feature that does nothing at all.
ok(after.hasVideo && !after.isIframe, 'and it is a <video>, not a YouTube iframe no TV could run');
ok(after.width === restW, 'the search card does NOT widen — the grid stays intact', `(${restW})`);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
