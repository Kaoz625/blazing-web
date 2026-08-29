/**
 * EVERY row expands on hover, not just the first — and no row moves when one does.
 *
 * Markus, 2026-08-29: "only the first row pops out, all rows should do this".
 * claimHeroRow() used to set a `heroRowClaimed` flag and give `.row-hero` to the
 * first qualifying row only, so the expand-on-hover treatment read as a one-off
 * banner instead of as how this app shows a card.
 *
 * Three things are checked, and the last two are why this file exists rather
 * than a one-line diff being called done:
 *
 *  1. MORE THAN ONE row carries .row-hero.
 *  2. A row whose cards have NO background still does not get it. Live TV
 *     channel-logo rows have no backdrop and no description, so expanding one
 *     reveals an empty black panel — worse than a plain poster. That guard is
 *     the reason claimHeroRow is not simply classList.add on everything.
 *  3. THE ROW HEIGHT DOES NOT CHANGE when a card expands. This is the part that
 *     only breaks once every row does it: a resting card is 132x198, and an
 *     expanded card taller than 198px would shove every row below it down the
 *     page on every pointer crossing. The CSS caps the expanded width at 316px
 *     so that 16/10 lands on 197.5px. This test measures it rather than
 *     trusting the arithmetic.
 *
 *   node rowhero.smoke.mjs
 */
import { chromium } from '/Users/markususche/.hermes/hermes-agent/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.env.BW_DIR || '/Users/markususche/Desktop/blazing-web';
const CHROME = '/Users/markususche/Library/Caches/ms-playwright/chromium-1208/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, p === '/' ? 'index.html' : p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// safeMeta() runs every image through safeHttpsUrl(), which accepts https URLs
// ONLY — a data: URI is dropped. So a fixture built on data: pixels arrives with
// background undefined and NO row ever qualifies as a hero. These point at a
// host that does not resolve; nothing here needs the bytes, only the URL.
const PIX = 'https://img.invalid/poster.jpg';
const ART = 'https://img.invalid/backdrop.jpg';
// WITH a background — these rows are the ones that may expand.
const META = (n, pre) => ({
  metas: Array.from({ length: n }, (_, i) => ({
    id: `tt900${i}0`, name: `${pre} title ${i + 1}`, type: 'movie',
    poster: PIX, background: ART, releaseInfo: '2026',
    // NO description ON PURPOSE. 171 of the live catalog's 300 metas have none,
    // and that is the case that has to work: the panel fills itself from
    // /meta/ on dwell. A card that already has one keeps it - mergeFullMeta
    // only fills what is empty - so seeding one here would test nothing.
  })),
});
// WITHOUT a background — the channel-logo shape that must stay a plain poster.
const LOGOS = (n) => ({
  metas: Array.from({ length: n }, (_, i) => ({
    id: `tv${i}`, name: `Channel ${i + 1}`, type: 'tv', poster: PIX,
  })),
});

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-1', token: 'tok' }));
  localStorage.setItem('profileId', 'p1');
});

await ctx.route('https://addon.lyreosai.com/**', (route) => {
  const u = route.request().url();
  // 200 WITH A REAL PAYLOAD, because that is what production does now.
  // home.smoke.mjs deliberately keeps the opposite stub — a 404 — to pin the
  // fallback to the plain shelves. Between the two files both paths are covered.
  if (u.includes('/api/ui/home-config')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ mode: 'blazing', appName: 'BlazeOS', theme: 'cinema_dark', homeRows: [
      { id: 'trending_m', type: 'card_row', catalogSlug: 'blazing-movies',      label: 'Trending Movies' },
      { id: 'kids_m',     type: 'card_row', catalogSlug: 'blazing-kids-movies', label: 'Kids Movies' },
      { id: 'trending_s', type: 'card_row', catalogSlug: 'blazing-series',      label: 'Trending Series' },
      { id: 'live',       type: 'card_row', catalogSlug: 'blazing-livetv',      label: 'Live TV' },
    ] }) });
  if (u.includes('/manifest.json')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ catalogs: [
      { id: 'blazing-movies', type: 'movie', name: 'Movies' },
      { id: 'blazing-series', type: 'series', name: 'Shows' },
      { id: 'blazing-kids-movies', type: 'movie', name: 'Kids Movies' },
      { id: 'blazing-livetv', type: 'tv', name: 'Live TV' },
    ] }) });
  // /meta/ carries what a CATALOG meta does not: the synopsis, the runtime and
  // the trailer. Measured on the live addon - 0 of 300 catalog metas carry a
  // trailer of any kind, so the pop-out had nothing to play and, for 171 of
  // them, nothing to say either.
  if (u.includes('/meta/')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ meta: {
      id: 'tt900000', name: 'Full title', type: 'movie', poster: PIX, background: ART,
      description: 'The synopsis that only the meta route carries.',
      imdbRating: '7.8', runtime: '118 min', genres: ['Drama'],
      trailers: [{ source: 'Y1IgAEejvqM', type: 'Trailer' }],
    } }) });
  // OUR OWN resolve, not YouTube. This is the route the education player has
  // always used; it runs yt-dlp server-side and hands back an HLS manifest, so
  // a Roku / Apple TV / Fire TV / LG / Samsung / VegaOS can play the same
  // trailer the browser does. An <iframe> could not run on any of them.
  if (u.includes('/proxy/yt-resolve')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ url: '/proxy/hls?u=https%3A%2F%2Fmanifest.googlevideo.com%2Ffake.m3u8', streamFormat: 'hls' }) });
  if (u.includes('/api/profiles')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profiles: [{ id: 'p1', name: 'Mark' }] }) });
  if (u.includes('/api/sync/progress/recent')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  // KEYED ON THE SLUG, NOT THE PATH TYPE, and that distinction is the whole
  // fixture. loadSDUIRow() builds its URL as `/catalog/tv/${catalogSlug}.json`
  // for EVERY row whatever the row's real type is, so a `/catalog/tv/` branch
  // catches Movies and Series too and starves the entire home of backdrops.
  if (u.includes('blazing-livetv')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LOGOS(8)) });
  if (u.includes('/catalog/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(8, 'cat')) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
await ctx.route('https://fleet.lyreosai.com/**', (route) => {
  const u = route.request().url();
  if (u.includes('/discover/filter/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(6, 'fresh')) });
  if (u.includes('/devices/register')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, device: { id: 'dev-1', status: 'approved' }, token: 'tok' }) });
  if (u.includes('/profiles')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profiles: [{ id: 'p1', name: 'Mark', maxRating: 'adult', hasPin: false }] }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

let resolveHits = 0;
ctx.on('request', (r) => { if (r.url().includes('/proxy/yt-resolve')) resolveHits += 1; });
const page = await ctx.newPage();
if (process.env.DEBUG_NET) {
  page.on('response', (r) => { const u=r.url(); if(!u.startsWith('data:')&&!u.includes('127.0.0.1')) console.log('NET', r.status(), u.slice(0,120)); });
  page.on('requestfailed', (r) => console.log('FAILED', r.url().slice(0,120), r.failure()?.errorText));
}
await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// PICK A PROFILE FIRST, or there are no rows to measure at all. ratingAllowed()
// defaults state.profileCap to 'general' while nobody has chosen, and it refuses
// an UNRATED title under a kids cap — so every fixture meta below is refused,
// every row empties, each loader removes its own section, and the screen reads
// "Nothing is available right now." with no error thrown. That is the parental
// gate doing its job. It cost an hour on 29 Aug 2026 to tell apart from a broken
// home, so it is written down here: a row test must choose who is watching.
await page.evaluate(() => {
  document.dispatchEvent(new CustomEvent('blazing-profile-selected', {
    detail: { id: 'p1', name: 'Mark', maxRating: 'adult' },
  }));
});
// And take the gate's own overlay down with it. profile.js owns that panel and
// only removes it when a face is actually tapped; left standing it sits over the
// whole page (.bp-layer[data-gate="required"]) and swallows the pointer, so the
// real hover below times out. The gate's markup is profile.js's test to write,
// not this one's.
await page.evaluate(() => { document.querySelectorAll('.bp-layer').forEach((n) => n.remove()); });
await page.waitForTimeout(6000);

let pass = 0, fail = 0;
const ok = (cond, what, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };

if (process.env.DEBUG_DOM) {
  const d = await page.evaluate(() => ({
    rowsWrapExists: !!document.querySelector('#rows'),
    rowsWrapChildren: document.querySelector('#rows') ? document.querySelector('#rows').children.length : -1,
    rowsWrapClasses: [...(document.querySelector('#rows')?.children || [])].slice(0,6).map(c=>c.tagName+'.'+c.className),
    anySection: document.querySelectorAll('section').length,
    anyCard: document.querySelectorAll('.card').length,
    gateVisible: !!document.querySelector('#profile-gate:not([hidden])') || document.body.className,
    html: (document.querySelector('#rows')?.innerHTML || '').slice(0, 400),
  }));
  console.log('DEBUG', JSON.stringify(d, null, 1));
}
const totalRows = await page.$$eval('#rows .row', (n) => n.length);
const heroRows = await page.$$eval('#rows .row.row-hero', (n) => n.length);
console.log(`rows: ${totalRows}   of which expand on hover: ${heroRows}\n`);

ok(totalRows >= 2, 'the home built more than one row', `(${totalRows})`);
ok(heroRows >= 2, 'MORE THAN ONE row expands on hover — the actual fix', `(${heroRows})`);

// A row built from cards with no background must stay a plain poster row.
// Found by its HEADING, not by looking for cards without backdrop art: every
// card gets a .card-backdrop, because buildCard falls back to the poster when a
// meta carries no background (app.js ~935). So the DOM cannot tell you which
// row was starved of art — only the fixture knows, and Live TV is the row it
// serves logos to.
const logoRowIsPlain = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#rows .row')];
  const logo = rows.find((r) => /live tv/i.test((r.querySelector('h2,h3,.row-title') || {}).textContent || ''));
  return logo ? !logo.classList.contains('row-hero') : null;
});
ok(logoRowIsPlain !== false, 'a row with no backdrop art does NOT expand', logoRowIsPlain === null ? '(no such row in this fixture)' : '');

// THE LAYOUT-SHIFT CHECK, with a REAL hover. An earlier version of this block
// faked it by writing the hover declaration onto card.style, and it measured a
// card that had not moved at all - 164x238, the resting size - because the
// element that carries the width is not the one `.card` matches. Playwright can
// move a real pointer, so it does. Nothing here trusts the arithmetic.
const heroEls = await page.$$('#rows .row.row-hero');
let measured = null;
if (heroEls.length >= 2) {
  const row = heroEls[1];
  const card = await row.$('.card');
  if (card) {
    const before = await page.evaluate((r) => {
      const b = r.nextElementSibling;
      return { row: r.getBoundingClientRect().height, below: b ? b.getBoundingClientRect().top : 0 };
    }, row);
    await card.hover();
    await page.waitForTimeout(700);   // the expand is a transition, not a jump
    const after = await page.evaluate(({ r, c }) => {
      const b = r.nextElementSibling;
      // The widest box inside the card is what actually grew; `.card` itself may
      // be a wrapper that keeps its own layout box.
      const boxes = [c, ...c.querySelectorAll('*')].map((n) => n.getBoundingClientRect());
      const widest = boxes.reduce((a, x) => (x.width > a.width ? x : a), boxes[0]);
      return {
        row: r.getBoundingClientRect().height,
        below: b ? b.getBoundingClientRect().top : 0,
        cardW: widest.width, cardH: widest.height,
      };
    }, { r: row, c: card });
    measured = { before, after };
  }
}

if (!measured) {
  ok(false, 'could not measure a second expanding row');
} else {
  const { before, after } = measured;
  ok(Math.abs(after.row - before.row) < 2,
    'the row does not get taller when a card expands',
    `(${before.row.toFixed(1)}px -> ${after.row.toFixed(1)}px)`);
  ok(Math.abs(after.below - before.below) < 2,
    'the row BELOW it does not move down the page',
    `(top ${before.below.toFixed(1)} -> ${after.below.toFixed(1)})`);
  ok(after.cardW > 200, 'the expanded card really is wider than a poster', `(${after.cardW.toFixed(0)}px wide)`);
  ok(after.cardH <= before.row + 1, 'the expanded card still fits inside the row',
    `(${after.cardH.toFixed(1)}px in a ${before.row.toFixed(1)}px row)`);
}

// THE POP-OUT MUST SAY SOMETHING AND PLAY SOMETHING. Markus: "wheres the
// descriptions and the movie trailers playing with the pop out?" The markup was
// always built and always mostly empty, because a catalog meta carries neither.
const filled = await (async () => {
  const rows = await page.$$('#rows .row.row-hero');
  const card = rows.length ? await rows[0].$('.card') : null;
  if (!card) return null;
  await card.hover();
  await page.waitForTimeout(2600);   // past DWELL_MS (550) and HOVER_TRAILER_MS (1400)
  return page.evaluate((c) => ({
    synopsis: (c.querySelector('.card-synopsis') || {}).textContent || '',
    metaLine: (c.querySelector('.card-meta-line') || {}).textContent || '',
    tag: (c.querySelector('.card-trailer-wrap > *') || {}).tagName || '',
    hasIframe: !!c.querySelector('.card-trailer-wrap iframe'),
    wrapVisible: !!c.querySelector('.card-trailer-wrap.visible'),
  }), card);
})();

if (!filled) {
  ok(false, 'could not hover a card to fill it');
} else {
  ok(/only the meta route carries/.test(filled.synopsis), 'the pop-out shows a description', `("${filled.synopsis.slice(0, 40)}...")`);
  ok(/7\.8/.test(filled.metaLine) && /118 min/.test(filled.metaLine), 'and the rating and runtime line', `("${filled.metaLine}")`);
  ok(filled.tag === 'VIDEO', 'the trailer is a <video>, playable on a TV', `(<${filled.tag.toLowerCase()}>)`);
  ok(!filled.hasIframe, 'and NOT a YouTube iframe — no Roku, Apple TV, Fire TV, LG, Samsung or VegaOS can run one');
  ok(resolveHits > 0, 'it resolved through OUR backend, /proxy/yt-resolve', `(${resolveHits} call${resolveHits === 1 ? '' : 's'})`);
  ok(filled.wrapVisible, 'and it is faded in, not left at opacity 0');
}
await page.mouse.move(5, 5);
await page.waitForTimeout(400);

// AND ON A PHONE. "this should also be on all devices" — the <=640px rule used
// to pin the expanded width back to the resting 118px, switching the treatment
// off on every phone, and the 16/10 ratio still applied so a focused card went
// SHORTER than its row. Same two rules as the desktop check: it must actually
// grow, and it must not change the row's height.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const phone = await (async () => {
  const rows = await page.$$('#rows .row.row-hero');
  if (!rows.length) return null;
  const row = rows[0];
  const card = await row.$('.card');
  if (!card) return null;
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  const before = await page.evaluate((r) => ({ row: r.getBoundingClientRect().height, card: r.querySelector('.card').getBoundingClientRect().width }), row);
  await card.hover();
  await page.waitForTimeout(700);
  const after = await page.evaluate((r) => {
    const c = r.querySelector('.card');
    const boxes = [c, ...c.querySelectorAll('*')].map((n) => n.getBoundingClientRect());
    const widest = boxes.reduce((a, x) => (x.width > a.width ? x : a), boxes[0]);
    return { row: r.getBoundingClientRect().height, w: widest.width, h: widest.height };
  }, row);
  return { before, after };
})();

if (!phone) {
  ok(false, 'could not measure an expanding row at phone width');
} else {
  ok(phone.after.w > phone.before.card + 40, 'a phone expands the card too, not just a desktop',
    `(${phone.before.card.toFixed(0)}px -> ${phone.after.w.toFixed(0)}px)`);
  ok(Math.abs(phone.after.row - phone.before.row) < 2, 'and the phone row keeps its height',
    `(${phone.before.row.toFixed(1)}px -> ${phone.after.row.toFixed(1)}px)`);
}

await page.screenshot({ path: process.env.SHOT || '/tmp/rowhero.png' });
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
