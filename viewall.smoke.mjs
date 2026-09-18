/**
 * VIEW ALL AND THE 25-CARD SHELF — DESIGN-V2.md §2.11.
 *
 * WHY THIS FILE EXISTS, and it is not "the feature should have a test". §2.11
 * was written on 17 Sep 2026 after an audit found that the number Markus had
 * agreed — 25 per shelf — existed in NONE of the six clients: Roku capped at 30,
 * webOS at 24 (10 on a "Top 10" row), Fire TV at 12/18/30 within one screen,
 * Tizen at 40/12/30/48/60, and this client and tvOS at nothing at all. Six
 * clients each answered a question the contract never asked, which is the same
 * defect that cost §2.6 its focus duration and §2.7.1 the room dim.
 *
 * So the number is asserted HERE rather than trusted to a comment, and it is
 * read out of app.js rather than retyped — a test that hardcodes 25 passes
 * happily on the day somebody changes ROW_CAP to 40, which is the one day it
 * needed to fail.
 *
 * THE ASSERTION THAT MATTERS IS NOT THE COUNT. It is §2.11's real rule: a row
 * carries its OWN source descriptor and View All reads that, never the row's
 * heading. The Roku routes by string-matching the shelf heading through
 * HomeSlugForTitle/HomeGenreForTitle, so an addon-fed shelf opens a DIFFERENT
 * catalogue than the one that filled it, and nothing on screen says so — the
 * page is full of plausible posters. A count check cannot see that. Comparing
 * the grid's first cards against the ROW's cards can, and that is `same source`
 * below: the fixture gives the two catalogues disjoint, self-identifying titles
 * precisely so a wrong destination cannot accidentally look right.
 */
import { launchBrowser } from './comet.mjs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

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

// Read the cap out of the source. See the note above: a retyped 25 would pass
// on the day ROW_CAP changed.
const source = await readFile(join(ROOT, 'app.js'), 'utf8');
const ROW_CAP = Number((source.match(/const ROW_CAP\s*=\s*(\d+)/) || [])[1]);

const PIX = 'https://img.invalid/poster.jpg';
/** Self-identifying titles: `big 1..N` can never be mistaken for `small 1..N`. */
const META = (n, pre) => ({
  metas: Array.from({ length: n }, (_, i) => ({
    id: `tt${pre}${i}`, name: `${pre} ${i + 1}`, type: 'movie', poster: PIX, releaseInfo: '2026',
  })),
});

// 120 is comfortably past the cap and past any plausible future cap, so the
// "row is capped" and "View All is not" assertions cannot both be satisfied by
// an off-by-one. SMALL is 10 — under the cap — to prove the button's absence.
const BIG = 120;
const SMALL = 10;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`ok    ${label}${extra ? '  ' + extra : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

async function stub(ctx) {
  await ctx.addInitScript(() => {
    localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-1', token: 'tok' }));
    localStorage.setItem('blazing-household-approved', '1');
  });
  await ctx.route('https://addon.lyreosai.com/**', (route) => {
    const u = route.request().url();
    if (u.includes('/api/ui/home-config')) return route.fulfill({ status: 404, body: 'no' });
    if (u.includes('/manifest.json')) return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ catalogs: [
        { id: 'blazing-movies', type: 'movie', name: 'Big Shelf' },
        { id: 'blazing-small', type: 'movie', name: 'Small Shelf' },
      ] }),
    });
    if (u.includes('/api/sync/progress/recent')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' });
    // The two catalogues are disjoint by construction — see the header note.
    if (u.includes('/catalog/movie/blazing-small')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(SMALL, 'small')) });
    if (u.includes('/catalog/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(BIG, 'big')) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await ctx.route('https://fleet.lyreosai.com/**', (route) => {
    const u = route.request().url();
    if (u.includes('/devices/register')) return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, device: { id: 'dev-1', status: 'approved' }, token: 'tok' }) });
    if (u.includes('/profiles')) return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ profiles: [{ id: 'p1', name: 'Mark', maxRating: 'adult', hasPin: false }] }) });
    if (u.includes('/discover/filter/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(6, 'fresh')) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await ctx.route('https://upscale.lyreosai.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx.route('https://v3-cinemeta.strem.io/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"addons":[]}' }));
}

const errors = [];
const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await stub(ctx);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
const tile = page.locator('.bp-profile').first();
if (await tile.count()) { await tile.click(); await page.waitForTimeout(2600); }

ok(Number.isInteger(ROW_CAP) && ROW_CAP > 0, `ROW_CAP was read out of app.js  [${ROW_CAP}]`);
ok(ROW_CAP === 25, `and DESIGN-V2 §2.11 says it is 25  [${ROW_CAP}]`);

/* ── 1. THE SHELF IS CAPPED ───────────────────────────────────────────────────
   Every catalogue row, not just the one this test opens: a cap applied in one
   of the three loaders and missed in the other two is exactly the per-loader
   divergence fillRow() exists to prevent. */
const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#home-view section.row')).map((s) => ({
  title: s.querySelector('.row-title')?.textContent || '',
  cards: s.querySelectorAll('.row-track .card:not(.skeleton)').length,
  more: !!s.querySelector('.row-more') && !s.querySelector('.row-more').hidden,
  first: s.querySelector('.row-track .card .card-title, .row-track .card')?.textContent?.trim().slice(0, 40) || '',
})));
console.log('rows on home:', JSON.stringify(rows, null, 1));
ok(rows.length > 0, 'home built at least one row', `[${rows.length}]`);
const over = rows.filter((r) => r.cards > ROW_CAP);
ok(over.length === 0, 'NO row renders more than ROW_CAP cards',
  over.length ? `[${over.map((r) => `${r.title}=${r.cards}`).join(', ')}]` : `[max ${Math.max(0, ...rows.map((r) => r.cards))}]`);

const bigRow = rows.find((r) => r.cards === ROW_CAP);
ok(!!bigRow, `the 120-item catalogue filled a shelf to exactly ${ROW_CAP}`);

/* ── 2. THE BUTTON APPEARS ONLY WHERE THERE IS MORE ───────────────────────────
   §2.11 clause 4: a View All that opens the same cards the viewer is already
   looking at is worse than no button. */
ok(!!bigRow && bigRow.more, 'a shelf with more behind it shows View all');
const smallRow = rows.find((r) => r.cards === SMALL);
ok(!smallRow || !smallRow.more, 'a shelf that is already complete shows NO View all',
  smallRow ? `[${smallRow.title} cards=${smallRow.cards} more=${smallRow.more}]` : '[no small row]');

/* ── 3. IT OPENS THE WHOLE CATALOGUE, AND THE HEADING IS NOT AN ADDRESS ───────
   THE TRAP, ported from blazing-webos/test/viewall.smoke.mjs, whose harness was
   the stronger of the two. Disjoint fixtures alone are a PASSIVE check: they
   catch a heading-matcher only if the heading it read happened to name the other
   catalogue. Nothing here guaranteed that, so the assertion below could go green
   on a client that read the heading and simply failed to match anything.

   So the heading is REWRITTEN, to a real heading on this very screen backed by
   the DISJOINT small catalogue, and only then is View all pressed. A client that
   routed by heading — the Roku's shipped bug, HomeRouteForRow at
   HomeScreen.brs:1066-1112 — now lands in `small` and every card says so. This
   client cannot: there is no string to match, only the `viewAll.load` thunk the
   row closed over when it was built.

   The rewrite is the LAST thing before the click, because a client that read the
   heading at BUILD time and cached it would be unaffected by a later edit — and
   that client is also correct under §2.11, which asks only that the destination
   come from the row's own descriptor rather than its display copy. What must
   never happen is the read at PRESS time, which is what this measures. */
const decoyTitle = smallRow ? smallRow.title : 'Small Shelf';
const rowTitles = await page.evaluate(({ cap, decoy }) => {
  const s = Array.from(document.querySelectorAll('#home-view section.row'))
    .find((x) => x.querySelectorAll('.row-track .card:not(.skeleton)').length === cap);
  const t = s.querySelector('.row-title');
  if (t) t.textContent = decoy;
  return Array.from(s.querySelectorAll('.row-track .card')).slice(0, 5).map((c) => c.textContent.trim());
}, { cap: ROW_CAP, decoy: decoyTitle });
ok(!!decoyTitle && decoyTitle !== '', 'the fixture has a second, disjoint row to impersonate', `[${decoyTitle}]`);

await page.evaluate((cap) => {
  const s = Array.from(document.querySelectorAll('#home-view section.row'))
    .find((x) => x.querySelectorAll('.row-track .card:not(.skeleton)').length === cap);
  s.querySelector('.row-more').click();
}, ROW_CAP);
await page.waitForTimeout(1200);

const grid = await page.evaluate(() => ({
  visible: !document.querySelector('#viewall-view').hidden,
  title: document.querySelector('#viewall-title').textContent,
  count: document.querySelector('#viewall-results').querySelectorAll('.card').length,
  first: Array.from(document.querySelector('#viewall-results').querySelectorAll('.card')).slice(0, 5).map((c) => c.textContent.trim()),
  homeHidden: document.querySelector('#home-view').hidden,
}));
console.log('grid:', JSON.stringify({ ...grid, first: grid.first }, null, 1));

ok(grid.visible, 'View all opened its own page');
ok(grid.homeHidden, 'and home went away with it');
ok(grid.count === BIG, `the page holds the WHOLE catalogue, not the shelf's slice  [${grid.count} of ${BIG}]`);
ok(grid.count > ROW_CAP, `which is more than the shelf showed  [${grid.count} > ${ROW_CAP}]`);

/* ── 4. THE DESTINATION IS THE ROW'S OWN SOURCE ───────────────────────────────
   THE ASSERTION THIS FILE IS FOR, and it is now armed by the rewrite in §3. The
   row was pressed while WEARING THE OTHER ROW'S NAME, and the two fixture
   catalogues are disjoint, so a View All that guessed its destination from the
   heading — the Roku's bug — comes back full of `small N` and is caught below.
   Order is compared too: the shelf is the first 25 OF THIS LIST, so the grid
   must open on the same titles in the same order, not merely on the same
   catalogue re-sorted. */
ok(grid.first.length === 5 && grid.first.every((t, i) => t === rowTitles[i]),
  'the page opens on the ROW\'S OWN source, in the row\'s own order',
  `row=${JSON.stringify(rowTitles)} grid=${JSON.stringify(grid.first)}`);
ok(!grid.first.some((t) => /small/i.test(t)),
  'and NOT on the other catalogue a heading-match would have found');

/* ── 5. NOTHING THREW ────────────────────────────────────────────────────────*/
ok(errors.length === 0, 'no page errors', errors.length ? JSON.stringify(errors.slice(0, 3)) : '');

console.log(`\n${pass} passed, ${fail} failed`);
await ctx.close();
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
