/**
 * Every tab is the same shape of page, and the nav is the same nav on all of them.
 *
 * Markus, 2026-08-30: "please also make sure the side nav matches and works how
 * it should on all pages. all tabs and sections should have more or less the
 * same things."
 *
 * The nav itself never drifted — the header and the drawer are one piece of
 * markup shared by all 15 destinations, so it cannot. This file pins it anyway,
 * because "cannot drift" stops being true the moment somebody renders it per
 * view. What HAD drifted was the content, in three places:
 *
 *  1. Home / Movies / Shows / Anime had NO heading. All four are one section
 *     with the rows filtered, and the other ten views all open with an
 *     eyebrow + <h1> + a line. Search has none by its own deliberate design
 *     (index.html) and is the single exemption here.
 *  2. ADMIN rendered a heading over blank space and said nothing, so an empty
 *     panel looked exactly like a broken one. Every other view that can be
 *     empty says why.
 *  3. REQUESTS was the one card builder painting its poster as a CSS
 *     background instead of an <img>, so a dead poster URL had nothing to
 *     catch it — no lazy load, no async decode, no `error` event.
 *
 *   node navparity.smoke.mjs
 */
import { chromium } from 'playwright';
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

const PIX = 'https://img.invalid/poster.jpg';
const ART = 'https://img.invalid/backdrop.jpg';
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const META = (n, pre) => ({
  metas: Array.from({ length: n }, (_, i) => ({
    id: `tt700${i}0`, name: `${pre} ${i + 1}`, type: 'movie',
    poster: PIX, background: ART, releaseInfo: '2026',
  })),
});

// All 15, in nav order. `heading: false` is the ONE deliberate exemption.
const VIEWS = [
  { id: 'home', heading: 'Home' },
  { id: 'movies', heading: 'Movies' },
  { id: 'shows', heading: 'TV Shows' },
  { id: 'anime', heading: 'Anime' },
  { id: 'search', heading: false },
  { id: 'library', heading: true },
  { id: 'emby', heading: true },
  { id: 'comics', heading: true },
  { id: 'manga', heading: true },
  { id: 'games', heading: true },
  { id: 'trailers', heading: true },
  { id: 'requests', heading: true },
  { id: 'education', heading: true },
  { id: 'roadmaps', heading: true },
  { id: 'admin', heading: true },
];

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`ok    ${label}${extra ? '  ' + extra : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-1', token: 'tok' }));
  localStorage.setItem('blazing-household-approved', '1');
});

await ctx.route('https://addon.lyreosai.com/**', (route) => {
  const u = route.request().url();
  if (u.includes('/api/ui/home-config')) return route.fulfill({ status: 404, body: 'no' });
  if (u.includes('/manifest.json')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ catalogs: [{ id: 'blazing-movies', type: 'movie', name: 'Movies' }] }) });
  if (u.includes('/api/sync/progress/recent')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' });
  if (u.includes('/catalog/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(6, 'cat')) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
await ctx.route('https://fleet.lyreosai.com/**', (route) => {
  const u = route.request().url();
  // Two results, and the SECOND has no poster at all — that is the case the
  // <img> change exists for, and a fixture where every poster resolves would
  // never reach it.
  if (u.includes('/seerr/search')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ results: [
      // A poster that REALLY loads — a 1x1 gif. img.invalid would fire `error`
      // and mark this one .no-image too, which would make the "exactly one is
      // marked" check below pass for the wrong reason.
      { tmdbId: 1, mediaType: 'movie', title: 'Has a poster', releaseInfo: '2026', poster: GIF, status: 1, statusText: 'Not requested' },
      { tmdbId: 2, mediaType: 'movie', title: 'No poster at all', releaseInfo: '2026', poster: '', status: 1, statusText: 'Not requested' },
    ] }) });
  if (u.includes('/devices/register')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, device: { id: 'dev-1', status: 'approved' }, token: 'tok' }) });
  if (u.includes('/profiles')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ profiles: [{ id: 'p1', name: 'Mark', maxRating: 'adult', hasPin: false }] }) });
  if (u.includes('/discover/filter/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(6, 'fresh')) });
  if (u.includes('/emby/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"metas":[]}' });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
await ctx.route('https://upscale.lyreosai.com/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
const tile = page.locator('.bp-profile').first();
if (await tile.count()) { await tile.click(); await page.waitForTimeout(2000); }

// The nav as it stands on the very first view. Every other view is compared
// against THIS, so the test measures drift rather than a hardcoded count that
// would have to be edited every time a tab is added.
const navOf = () => page.evaluate(() => ({
  top: [...document.querySelectorAll('.topnav [data-view]')].map((b) => b.dataset.view).join(','),
  drawer: [...document.querySelectorAll('.drawer-nav [data-view]')].map((b) => b.dataset.view).join(','),
  searchButton: !!document.getElementById('search-button'),
}));
const baseline = await navOf();
ok(baseline.top.length > 0 && baseline.drawer.split(',').length === VIEWS.length,
  'the drawer offers every one of the 15 destinations', `(${baseline.drawer.split(',').length})`);

const titles = new Set();
for (const view of VIEWS) {
  await page.evaluate((v) => {
    const b = document.querySelector(`.drawer-nav [data-view="${v}"]`) || document.querySelector(`[data-view="${v}"]`);
    b.click();
  }, view.id);
  await page.waitForTimeout(view.id === 'home' ? 900 : 700);

  const now = await navOf();
  ok(now.top === baseline.top && now.drawer === baseline.drawer && now.searchButton,
    `${view.id}: the same nav, and the search button, are still there`);

  const active = await page.evaluate((v) => {
    // aria-current is set to the STRING "false" on every inactive button, and
    // "false" is truthy — testing for the attribute's presence marks all 15.
    const marked = [...document.querySelectorAll('[data-view]')]
      .filter((b) => b.classList.contains('active') || b.getAttribute('aria-current') === 'page');
    return { views: [...new Set(marked.map((b) => b.dataset.view))].join(','), want: v };
  }, view.id);
  ok(active.views === view.id, `${view.id}: it is the one marked active`, `(${active.views || 'none'})`);

  const head = await page.evaluate((v) => {
    const section = document.querySelector(`#${v}-view`)
      || (['movies', 'shows', 'anime'].includes(v) ? document.getElementById('home-view') : null);
    if (!section || section.hidden) return null;
    const h = section.querySelector('.page-heading h1');
    // Text alone is not enough. showRoute() writes into #browse-title whether or
    // not the block is on screen, so a heading hidden by a `hidden` attribute or
    // display:none would still read back its own words. A heading nobody can see
    // is the same as no heading: measure the box.
    if (!h) return '';
    const box = h.getBoundingClientRect();
    if (!box.height || !box.width || h.offsetParent === null) return '';
    return (h.textContent || '').trim();
  }, view.id);

  if (view.heading === false) {
    ok(head === '', `${view.id}: no heading, and that is on purpose`, `(${head})`);
  } else {
    ok(Boolean(head), `${view.id}: opens with a heading, like every other view`, `(${head})`);
    if (typeof view.heading === 'string') {
      ok(head === view.heading, `${view.id}: and the heading says which one it is`, `(${head})`);
      titles.add(head);
    }
  }
}

// Four routes, four different titles — not one title reused, which would leave
// them as indistinguishable as having none at all.
ok(titles.size === 4, 'the four browse routes each say a different thing', `(${[...titles].join(' / ')})`);

// ── Admin says why it is empty ──────────────────────────────────────────────
await page.evaluate(() => document.querySelector('[data-view="admin"]').click());
await page.waitForTimeout(500);
const admin = await page.evaluate(() => ['admin-upscale-list', 'admin-activity-list']
  .map((id) => (document.getElementById(id).textContent || '').trim()));
ok(admin.every((t) => t.length > 10), 'both Admin panels say why they are empty', `(${admin.map((t) => t.slice(0, 24)).join(' | ')})`);

// ── A Requests card is a real <img>, and survives a dead poster ─────────────
await page.evaluate(() => document.querySelector('[data-view="requests"]').click());
await page.waitForTimeout(500);
await page.fill('#requests-input', 'anything');
await page.locator('#requests-form button[type="submit"]').click();
await page.waitForSelector('#requests-results .seerr-card', { timeout: 8000 });
const req = await page.evaluate(() => {
  const arts = [...document.querySelectorAll('#requests-results .seerr-art')];
  return {
    cards: arts.length,
    imgs: arts.filter((a) => a.querySelector('img.card-image')).length,
    lazy: arts.every((a) => { const i = a.querySelector('img.card-image'); return i && i.loading === 'lazy' && i.decoding === 'async'; }),
    // The old code set the poster here. Nothing should any more.
    inlineBg: arts.filter((a) => a.style.backgroundImage && a.style.backgroundImage !== 'none').length,
    // Second result has no poster: it must be marked, not left blank.
    marked: arts.filter((a) => a.classList.contains('no-image')).length,
  };
});
ok(req.cards === 2, 'the Requests search drew its results', `(${req.cards})`);
ok(req.imgs === 2, 'every Requests poster is an <img class="card-image">', `(${req.imgs}/2)`);
ok(req.lazy, 'and carries the same loading="lazy" decoding="async" as every other card');
ok(req.inlineBg === 0, 'no card paints its poster as a CSS background any more', `(${req.inlineBg})`);
ok(req.marked === 1, 'a result with no poster is marked .no-image, not left blank', `(${req.marked})`);

ok(errors.length === 0, 'no page threw on the way through all 15', errors.slice(0, 2).join(' ; '));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
