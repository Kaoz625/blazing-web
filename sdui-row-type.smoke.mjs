// Headless regression test for BRK-16: does an SDUI row ask for its OWN type?
//
// WHY THIS EXISTS. loadSDUIRow() built every URL as `/catalog/tv/<slug>.json`,
// hardcoded, for every row in the server-described home whatever that row
// actually held. /api/ui/home-config carries no media type at all — its `type`
// field is a WIDGET name (card_row, audio_row, storybook_row, heritage_row,
// progress_row, cinematic_hero) — so the client has to supply one, and this one
// supplied the same one for all of them.
//
// The addon's generic /catalog/:type/:id.json ignores the type segment, which
// is why this looked harmless. It ignores it only AFTER handing a whole family
// of ids off to their own routes (CATALOG_IDS_WITH_OWN_ROUTE: books,
// anime-airing, anime-top, manga-trending, sports, trailers-*, trending-*,
// edu-*, kids-* and family-*), and each of those is registered under exactly
// one type. Ask under another and Express matches nothing. Measured against
// addon.lyreosai.com on 29 Aug 2026 — this is where TRUE_TYPE below comes from:
//
//     /catalog/movie/blazing-kids-movies.json     200  20 metas
//     /catalog/tv/blazing-kids-movies.json        404   0
//     /catalog/series/blazing-kids-series.json    200  19 metas
//     /catalog/tv/blazing-kids-series.json        404   0
//     /catalog/movie/blazing-family-movies.json   200  18 metas
//     /catalog/tv/blazing-family-movies.json      404   0
//     /catalog/movie/blazing-trailers-new.json    200  20 metas
//     /catalog/tv/blazing-trailers-new.json       404   0
//     /catalog/tv/blazing-sports.json             200   3 metas
//     /catalog/tv/blazing-edu-kids.json           200  22 metas
//
// A 404 makes fetchJSON throw, loadSDUIRow's catch removes the section, and the
// shelf is simply absent. No error is logged and no empty row is drawn, which
// is the same silent failure that has eaten catalogues in this codebase twice
// before. PROVED to catch the bug: with the hardcoded `tv` restored this file
// reports 4 wrong-typed requests and 4 of the 4 named rows missing.
//
// THE FIXTURE 404s A WRONG TYPE ON PURPOSE. A fixture that answers any type
// with content — which is what home.smoke.mjs and rowhero.smoke.mjs do, both
// deliberately, because they are testing other things — cannot see this bug at
// all. Keying on (type, slug) the way the real routing table does is the whole
// point of this file.
//
// /api/ui/home-config is served 200 here with the LIVE blazing-mode payload.
// That route 404'd in production as recently as 27 Aug 2026 and answers 200
// today, so the SDUI path is the live path and this bug is a live bug.
//
//   node sdui-row-type.smoke.mjs                            the working tree
//   BW_DIR=/path/to/checkout node sdui-row-type.smoke.mjs   any other checkout
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

// The live payloads, verbatim, 29 Aug 2026. Note that not one entry names a
// media type — `type` here is the widget. Both modes are served because a real
// visit sees both: a browser that has not yet earned 'blazing' boots into the
// BrightMinds 'safe' home, and picking a profile switches it (see the
// blazing-profile-selected listener that sets blazing-household-approved).
const HOME_CONFIG_SAFE = {
  mode: 'safe',
  appName: 'BrightMinds Kids',
  homeRows: [
    { id: 'hero',      type: 'cinematic_hero', catalogSlug: 'blazing-edu-kids',      label: 'Featured Learning' },
    { id: 'kids_m',    type: 'card_row',       catalogSlug: 'blazing-kids-movies',   label: 'Kids Movies' },
    { id: 'kids_s',    type: 'card_row',       catalogSlug: 'blazing-kids-series',   label: 'Kids Shows' },
    { id: 'family_m',  type: 'card_row',       catalogSlug: 'blazing-family-movies', label: 'Family Movies' },
    { id: 'stories',   type: 'storybook_row',  catalogSlug: 'blazing-edu-stories',   label: '📖 My Personal Stories' },
    { id: 'podcasts',  type: 'audio_row',      catalogSlug: 'blazing-edu-podcasts',  label: '🎙️ Deep Dive Studio' },
    { id: 'family',    type: 'heritage_row',   catalogSlug: 'blazing-family-tree',   label: '🌳 Family Heritage' },
  ],
};
const HOME_CONFIG_BLAZING = {
  mode: 'blazing',
  appName: 'Blazing Stream',
  homeRows: [
    { id: 'hero',       type: 'cinematic_hero', catalogSlug: 'blazing-trending-movies', label: 'Featured' },
    { id: 'continue',   type: 'progress_row',   catalogSlug: null,                      label: '▶ Continue Watching' },
    { id: 'trending_m', type: 'card_row',       catalogSlug: 'blazing-trending-movies', label: '🔥 Trending Movies' },
    { id: 'trending_s', type: 'card_row',       catalogSlug: 'blazing-trending-series', label: '🔥 Trending Series' },
    { id: 'trailers',   type: 'card_row',       catalogSlug: 'blazing-trailers-new',    label: '🎬 New in Theaters' },
    { id: 'anime',      type: 'card_row',       catalogSlug: 'blazing-anime',           label: '⛩️ Anime' },
    { id: 'sports',     type: 'card_row',       catalogSlug: 'blazing-sports',          label: '🏆 Sports & Live TV' },
    { id: 'stories',    type: 'storybook_row',  catalogSlug: 'blazing-edu-stories',     label: '📖 BrightMinds: My Stories' },
    { id: 'family',     type: 'heritage_row',   catalogSlug: 'blazing-family-tree',     label: '🌳 Family Heritage' },
    { id: 'podcasts',   type: 'audio_row',      catalogSlug: 'blazing-edu-podcasts',    label: '🎙️ Deep Dive Studio' },
    { id: 'edu_kids',   type: 'card_row',       catalogSlug: 'blazing-edu-kids',        label: '🧒 BrightMinds: Kids' },
    { id: 'kids_m',     type: 'card_row',       catalogSlug: 'blazing-kids-movies',     label: 'Kids Movies' },
    { id: 'kids_s',     type: 'card_row',       catalogSlug: 'blazing-kids-series',     label: 'Kids Shows' },
    { id: 'family_m',   type: 'card_row',       catalogSlug: 'blazing-family-movies',   label: 'Family Movies' },
  ],
};

// The addon's real routing table for the slugs this payload names. A slug not
// listed here has no route of its own, so the generic handler takes it and the
// type segment genuinely does not matter — those accept anything, below.
const TRUE_TYPE = {
  'blazing-trailers-new': 'movie',
  'blazing-sports': 'tv',
  'blazing-edu-stories': 'tv',
  'blazing-edu-podcasts': 'tv',
  'blazing-edu-kids': 'tv',
  'blazing-family-tree': 'tv',
  'blazing-kids-movies': 'movie',
  'blazing-kids-series': 'series',
  'blazing-family-movies': 'movie',
};
// Rows whose shelf disappears entirely when the type is wrong. blazing-edu-*
// and blazing-family-tree are type-sensitive too, but 'tv' is what the broken
// code already sent them, so they are not evidence either way.
const MUST_APPEAR = ['🎬 New in Theaters', 'Kids Movies', 'Kids Shows', 'Family Movies'];

const META = (n, pre, type) => ({
  metas: Array.from({ length: n }, (_, i) => ({
    id: `tt${pre}${i}`, name: `${pre} title ${i + 1}`, type,
    poster: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    background: 'https://example.invalid/art.jpg',
    description: 'x', releaseInfo: '2026',
  })),
});

const browser = await launchBrowser();
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-1', token: 'tok' }));
  localStorage.setItem('profileId', 'p1');
  // 'blazing-household-approved' is deliberately NOT set here. Setting it makes
  // the third blazing-profile-selected listener return on its first line, so
  // the home is never torn down and rebuilt and every assertion below reads the
  // first paint — drawn while state.profileCap is still the default 'general',
  // which refuses every UNRATED meta and empties all of it. Let the profile
  // earn the flag, the way a person does.
});

const catalogHits = [];   // { type, slug, ok }
await ctx.route('https://addon.lyreosai.com/**', (route) => {
  const u = route.request().url();
  const path = u.replace('https://addon.lyreosai.com', '').split('?')[0];
  if (path.startsWith('/api/ui/home-config')) {
    const safe = /mode=safe/.test(u);
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(safe ? HOME_CONFIG_SAFE : HOME_CONFIG_BLAZING) });
  }
  if (path.startsWith('/manifest.json')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ catalogs: [{ id: 'blazing-movies', type: 'movie', name: 'Movies' }] }) });
  if (path.startsWith('/api/profiles')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profiles: [{ id: 'p1', name: 'Mark' }] }) });
  if (path.startsWith('/api/sync/progress/recent')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });

  const cat = path.match(/^\/catalog\/([^/]+)\/(.+)\.json$/);
  if (cat) {
    const [, type, slug] = cat;
    const want = TRUE_TYPE[slug];
    // Exactly what the addon does: an id with its own route is served under one
    // type and 404s under every other; an id without one is type-agnostic.
    const ok = !want || want === type;
    catalogHits.push({ type, slug, ok });
    if (!ok) return route.fulfill({ status: 404, body: 'Cannot GET ' + path });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(8, slug, want || 'movie')) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
await ctx.route('https://fleet.lyreosai.com/**', (route) => {
  const u = route.request().url();
  if (u.includes('/devices/register')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, device: { id: 'dev-1', status: 'approved' }, token: 'tok' }) });
  if (u.includes('/profiles')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profiles: [{ id: 'p1', name: 'Mark', maxRating: 'adult', hasPin: false }] }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

// Nobody is watching until a profile is picked, and ratingAllowed() then
// refuses every UNRATED meta under its default 'general' cap — which empties
// every row and would hide this bug behind the parental gate instead. Pick a
// profile the way a person does, exactly as home.smoke.mjs does.
await page.evaluate(() => {
  document.dispatchEvent(new CustomEvent('blazing-profile-selected', {
    detail: { id: 'p1', name: 'Mark', maxRating: 'adult' },
  }));
});
await page.waitForTimeout(6000);

const headings = await page.$$eval('#rows .row .row-title', (ns) => ns.map((n) => n.textContent.trim()));
const wrong = catalogHits.filter((h) => !h.ok);
const missing = MUST_APPEAR.filter((label) => !headings.includes(label));

// Unit-level proof, independent of the DOM: ask the resolver itself.
const resolved = await page.evaluate((slugs) =>
  Object.fromEntries(slugs.map((s) => [s, typeof catalogTypeFor === 'function' ? catalogTypeFor(s) : 'MISSING'])),
  Object.keys(TRUE_TYPE));
const badResolve = Object.entries(TRUE_TYPE).filter(([slug, want]) => resolved[slug] !== want);

console.log('DIR                    ', ROOT);
console.log('catalog requests       ', catalogHits.length);
console.log('wrong-typed requests   ', wrong.length, JSON.stringify(wrong.map((h) => `/catalog/${h.type}/${h.slug}`)));
console.log('row headings           ', JSON.stringify(headings));
console.log('rows that must appear  ', MUST_APPEAR.length - missing.length, '/', MUST_APPEAR.length,
  missing.length ? 'MISSING ' + JSON.stringify(missing) : '');
console.log('catalogTypeFor()       ', JSON.stringify(resolved));
console.log('resolver disagreements ', badResolve.length, JSON.stringify(badResolve));
console.log('page errors            ', errs.length);
for (const e of errs.slice(0, 6)) console.log('   ', e);

const ok = catalogHits.length > 0 && wrong.length === 0 && missing.length === 0 && badResolve.length === 0;
console.log(ok
  ? 'PASS  every SDUI row asked for its own catalog type'
  : 'FAIL  an SDUI row asked under the wrong type and its shelf vanished');
await browser.close(); server.close();
process.exit(ok ? 0 : 1);
