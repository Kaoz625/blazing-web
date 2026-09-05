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

const browser = await launchBrowser();
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
    body: JSON.stringify({ mode: 'blazing', appName: 'Blazing Stream', theme: 'cinema_dark', homeRows: [
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
/**
 * Hover, and do not measure until the card has actually finished growing.
 *
 * WHY THIS EXISTS. Both width checks here — the desktop one and the phone one —
 * failed about one run in three at 118px and 158px, the RESTING widths, which
 * reads exactly like "the expand is broken" and is not. A width trace taken
 * every 150ms after the pointer landed says what really happens:
 *
 *     H118px H118px H118px H118px H280px H280px H280px H280px
 *
 * The card is hovered (H) for about 600ms at its resting width and then jumps
 * straight to the final 280px — no in-between values at all. That is headless
 * Chromium painting when it feels like it: a CSS transition only advances on a
 * frame, and with the test idle in a `waitForTimeout` no frames are asked for,
 * so the transition sits at 0% and then snaps to 100% on the next frame. The
 * old fixed `waitForTimeout(700)` was a coin toss against that ~600ms stall,
 * and when it lost it measured a resting card and called the feature broken.
 *
 * So wait for the THING, not for a duration: hover, confirm the browser agrees
 * the card is `:hover` (retrying, because a pointer can land beside a card the
 * row-track is still settling), then wait for the computed width to leave its
 * resting value AND then hold still for two polls. Both halves are needed: "not
 * resting any more" alone caught a card in flight and measured 176px of a
 * 158->316px grow. A card that never expands still fails the check — it just
 * fails after a real 4s wait instead of a hopeful 700ms one.
 *
 * `polling: 100` on both waits, NOT the default `raf`: no frames is the very
 * condition being waited out, so an rAF-driven poll would be asleep for exactly
 * as long as the thing it is watching for. A timer poll runs anyway, and its
 * `getComputedStyle` forces the style recalc that moves the transition on.
 */
async function hoverHot(page, card, settle = 0) {
  const rest = await card.evaluate((c) => { delete c.__lastW; return getComputedStyle(c).width; });
  let hot = false;
  for (let attempt = 0; attempt < 3 && !hot; attempt++) {
    // CENTRE THE CARD IN THE VIEWPORT AND DRIVE A REAL POINTER TO IT, rather
    // than calling card.hover().
    //
    // hover() scrolls with scrollIntoViewIfNeeded, which stops the moment the
    // element is technically on screen — and the top bar is `position: sticky`,
    // so "on screen" includes "underneath the bar". Playwright then hit-tests
    // the card's centre, finds the bar, fails the actionability check, and the
    // `.catch(() => {})` throws that away silently. The card never becomes
    // :hover and the measurement below reads the RESTING width, which is
    // indistinguishable from "the expand is broken".
    //
    // MEASURED, 3 Sep 2026, this file unchanged, three consecutive runs:
    //   desktop  158px FAIL / 316px ok  / 158px FAIL     (158 = resting)
    //   phone    ok    / 280->118 FAIL  / 280->118 FAIL
    // Two different legs failing on alternate runs of identical code is a
    // harness that cannot hold a pointer, not a feature that half works.
    //
    // It was survivable while the home page was short. The full-bleed
    // #home-hero band (3 Sep 2026) put 620px above these rows, so the second
    // hero row now sits at y≈1589 instead of ≈969 and every hover on it has to
    // scroll first. `block: 'center'` puts the card in the middle of the
    // viewport, where nothing is sticky, and mouse.move() to its measured
    // centre needs no actionability check at all.
    await card.evaluate((c) => c.scrollIntoView({ block: 'center', inline: 'center' }));
    await page.waitForTimeout(150);
    const box = await card.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    hot = await page.waitForFunction((c) => c.matches(':hover'), card, { timeout: 1500, polling: 100 })
      .then(() => true).catch(() => false);
    if (!hot) { await page.mouse.move(5, 5); await page.waitForTimeout(150); }
  }
  if (hot) {
    await page.waitForFunction(
      ([c, w]) => {
        const now = getComputedStyle(c).width;
        if (now === w) return false;          // still resting
        if (c.__lastW === now) return true;   // two polls the same: it has settled
        c.__lastW = now;                      // still moving
        return false;
      }, [card, rest], { timeout: 4000, polling: 100 },
    ).catch(() => {});
  }
  if (settle) await page.waitForTimeout(settle);
  return hot;
}

const heroEls = await page.$$('#rows .row.row-hero');
let measured = null;
if (heroEls.length >= 2) {
  const row = heroEls[1];
  const card = await row.$('.card');
  if (card) {
    const before = await page.evaluate((r) => {
      const b = r.nextElementSibling;
      // `+ window.scrollY` so this is DOCUMENT-relative, matching `after` below.
      // It was viewport-relative here and document-relative there, and the two
      // were compared against each other. That only agreed because nothing had
      // scrolled the page yet when `before` was taken, so scrollY happened to be
      // 0 — hovering then scrolls the card into view, and `after` compensates
      // for a scroll `before` never accounted for. Same number today, and no
      // longer a check that quietly depends on the page being at the top.
      return {
        row: r.getBoundingClientRect().height,
        below: b ? b.getBoundingClientRect().top + window.scrollY : 0,
      };
    }, row);
    const hot = await hoverHot(page, card);
    const after = await page.evaluate(({ r, c }) => {
      const b = r.nextElementSibling;
      // The widest box inside the card is what actually grew; `.card` itself may
      // be a wrapper that keeps its own layout box.
      const boxes = [c, ...c.querySelectorAll('*')].map((n) => n.getBoundingClientRect());
      const widest = boxes.reduce((a, x) => (x.width > a.width ? x : a), boxes[0]);
      return {
        row: r.getBoundingClientRect().height,
        // DOCUMENT-relative, not viewport-relative. This check is about layout:
        // does the next row get pushed down. getBoundingClientRect().top also
        // moves when the PAGE scrolls, and hovering a card can scroll it into
        // view — so on its own it reported a 30px "shift" for a row that had not
        // moved at all, the moment a heading above it made the page taller.
        below: b ? b.getBoundingClientRect().top + window.scrollY : 0,
        cardW: widest.width, cardH: widest.height,
      };
    }, { r: row, c: card });
    measured = { before, after, hot };
  }
}

if (!measured) {
  ok(false, 'could not measure a second expanding row');
} else {
  const { before, after } = measured;
  // hoverHot ALREADY returned this and both call sites threw it away, so a
  // pointer that never reached the card was reported as "the card did not
  // expand" — a harness fault wearing a product fault's name. Now it says which
  // of the two happened, and the width check below is only meaningful once this
  // one is green.
  ok(measured.hot === true,
    'the pointer actually reached the desktop card — :hover really is set',
    measured.hot ? '' : '(hover never landed; the width below measures a card at rest)');
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
  await hoverHot(page, card, 2600);   // past DWELL_MS (550) and HOVER_TRAILER_MS (1400)
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
  // PARK THE POINTER OFF EVERY CARD, AND PROVE IT IS PARKED.
  //
  // (5,5) on its own is not a neutral point. It is neutral only while the page
  // happens to be scrolled near the top, and the desktop pass above leaves it
  // scrolled deep into the rows — hoverHot() scrolls its card into view. The
  // shrink to 390x844 keeps that scroll offset. Once the full-bleed #home-hero
  // band made the home page 620px taller (3 Sep 2026), the kept offset was 962
  // instead of 30, and (5,5) landed on a `.card-label` INSIDE the first card.
  // `before` then measured an already-expanded 280px, `after` measured the same
  // 280px, and a card that expands exactly as it should reported as broken.
  //
  // Scrolling to the top first makes the park deterministic at any page height,
  // and `resting` turns a bad measurement into a loud failure instead of a
  // silent one: this check is only meaningful if the card starts at rest.
  //
  // PARKED IS NOT THE SAME AS SETTLED, and a fixed 400ms wait cannot tell them
  // apart. Leaving the pointer removes `:hover` in the same frame, but the
  // width is a CSS TRANSITION and keeps moving for a few hundred ms after it.
  // Measured on this machine 3 Sep 2026, alternating between runs of the same
  // unchanged file: `before.card` read 280px on one run — the desktop pass's
  // expanded width, still collapsing — and 118px on the next. On the 280 runs
  // hoverHot() then compared against 280 as if it were the resting width, saw
  // the number settle at 118, and reported the collapse as if it were the
  // expansion: "280px -> 118px", a red test on code that works. `:hover` was 0
  // both times, so the parked check could not catch it.
  //
  // The settle signal is exact rather than timed: every card in a row is the
  // same width at rest, and only a card mid-expand or mid-collapse differs. So
  // wait until they all agree, and take THAT as the resting width.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(5, 5);
  // AGREEING ONCE IS NOT SETTLED, and that is what made this leg fail 3 runs
  // out of 3 with the identical "280px -> 118px".
  //
  // The old poll returned the width the moment every card in the row agreed.
  // Immediately after setViewportSize(390) the row passes THROUGH a state where
  // they all agree at 280 — the desktop track has not been re-laid out for the
  // narrow viewport yet — so the very first poll latched 280 and called it the
  // resting width. By the time the hover was measured the row had finished
  // reflowing to its real resting 118, so the card was recorded as SHRINKING
  // from 280 to 118 and a working expand reported as broken.
  //
  // So require three things, not one: nothing anywhere is still hovered, every
  // card agrees, and the agreed number is the SAME for three polls running
  // (300ms). A transient value cannot survive that; a real resting width does
  // so on the first three polls it is asked.
  const settled = await page.waitForFunction((r) => {
    if (document.querySelector('.card:hover')) { r.__stable = 0; return null; }
    const w = [...r.querySelectorAll('.card')].map((c) => c.getBoundingClientRect().width);
    if (w.length < 2) return null;
    if (!w.every((x) => Math.abs(x - w[0]) < 0.5)) { r.__stable = 0; return null; }
    r.__stable = (typeof r.__lastW === 'number' && Math.abs(r.__lastW - w[0]) < 0.5)
      ? (r.__stable || 0) + 1 : 0;
    r.__lastW = w[0];
    return r.__stable >= 3 ? w[0] : null;
  }, row, { timeout: 8000, polling: 100 }).then((h) => h.jsonValue()).catch(() => null);
  const resting = await page.evaluate(() => document.querySelectorAll('#rows .row.row-hero .card:hover').length);
  const before = await page.evaluate((r) => ({ row: r.getBoundingClientRect().height, card: r.querySelector('.card').getBoundingClientRect().width }), row);
  before.settled = settled;
  const hot = await hoverHot(page, card);
  const after = await page.evaluate((r) => {
    const c = r.querySelector('.card');
    const boxes = [c, ...c.querySelectorAll('*')].map((n) => n.getBoundingClientRect());
    const widest = boxes.reduce((a, x) => (x.width > a.width ? x : a), boxes[0]);
    return { row: r.getBoundingClientRect().height, w: widest.width, h: widest.height };
  }, row);
  return { before, after, resting, hot };
})();

if (!phone) {
  ok(false, 'could not measure an expanding row at phone width');
} else {
  ok(phone.resting === 0,
    'the phone measurement starts from a card at REST — the pointer is off every card',
    `(${phone.resting} card${phone.resting === 1 ? '' : 's'} still hovered, resting width ${phone.before.card.toFixed(0)}px)`);
  ok(phone.before.settled !== null && Math.abs(phone.before.settled - phone.before.card) < 0.5,
    'and the width has stopped moving — every card in the row agrees',
    `(settled ${phone.before.settled === null ? 'never' : phone.before.settled.toFixed(0) + 'px'}, measured ${phone.before.card.toFixed(0)}px)`);
  ok(phone.hot === true,
    'the pointer actually reached the phone card — :hover really is set',
    phone.hot ? '' : '(hover never landed; the width below measures a card at rest)');
  ok(phone.after.w > phone.before.card + 40, 'a phone expands the card too, not just a desktop',
    `(${phone.before.card.toFixed(0)}px -> ${phone.after.w.toFixed(0)}px)`);
  ok(Math.abs(phone.after.row - phone.before.row) < 2, 'and the phone row keeps its height',
    `(${phone.before.row.toFixed(1)}px -> ${phone.after.row.toFixed(1)}px)`);
}

await page.screenshot({ path: process.env.SHOT || '/tmp/rowhero.png' });
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
