// Headless smoke test for the HOME SCREEN: does anything build any rows?
//
// WHY THIS EXISTS. The BlazeOS Phase 1 patch (48f1be5) replaced boot() with an
// SDUI-only version and deleted the `boot();` call in the same change. From then
// until 27 Aug 2026 NOTHING built the home: no hero, no shelves, no Continue
// Watching. Measured with this file against a pristine HEAD checkout:
//
//     rows in #rows     0        <- 4 after the fix
//     cards in #rows    0        <- 32 after the fix
//     boot() ran?       false    <- true after the fix
//     page errors       0        <- an empty screen throws NOTHING
//
// That last line is the whole point. There was no error to find. The three Emby
// rows are drawn by the blazing-profile-selected listener, not by boot(), so a
// check that looked at the Emby rows passed while the rest of the home was gone.
//
// /api/ui/home-config is stubbed 404 here. That WAS production on 27 Aug 2026;
// it is not any more — the route ships in the deployed addon image today and
// answers 200. The stub stays anyway, because what it pins is still worth
// pinning: SDUI being absent must fall back to the real shelves rather than
// leave an empty page. Read it as "the SDUI route is down", not as a claim
// about what production does. (Closes DEP-9.)
//
// A PROFILE MUST BE CHOSEN BEFORE ANY ROW CAN BE DRAWN, and this test spent
// 29 Aug 2026 failing because it never chose one. ratingAllowed() defaults
// state.profileCap to 'general' and refuses an UNRATED title under a kids cap,
// so with nobody watching, every meta in the fixtures below — none of which
// carry a contentRating — was refused, every row emptied, and each loader
// removed its own section. The screen said "Nothing is available right now."
// and no error was thrown. That is the parental gate working exactly as
// written, not a broken home, so the fix belongs here: pick a profile, the way
// a person does, before counting rows.
//
//   node home.smoke.mjs                 the working tree
//   BW_DIR=/path/to/checkout node home.smoke.mjs    any other checkout
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

const META = (n, pre) => ({
  metas: Array.from({ length: n }, (_, i) => ({
    id: `tt${pre}${i}`, name: `${pre} title ${i + 1}`, type: 'movie',
    poster: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', description: 'x', releaseInfo: '2026',
  })),
});

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-1', token: 'tok' }));
  localStorage.setItem('profileId', 'p1');
});

const seen = [];
// The addon: SDUI 404s exactly as it does in production; catalogs answer.
await ctx.route('https://addon.lyreosai.com/**', (route) => {
  const u = route.request().url();
  seen.push(u.replace('https://addon.lyreosai.com', ''));
  if (u.includes('/api/ui/home-config')) return route.fulfill({ status: 404, body: 'Not found' });
  if (u.includes('/manifest.json')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ catalogs: [
      { id: 'blazing-movies', type: 'movie', name: 'Movies' },
      { id: 'blazing-series', type: 'series', name: 'Shows' },
    ] }) });
  if (u.includes('/api/profiles')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profiles: [{ id: 'p1', name: 'Mark' }] }) });
  if (u.includes('/api/sync/progress/recent')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  if (u.includes('/catalog/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(8, 'cat')) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
await ctx.route('https://fleet.lyreosai.com/**', (route) => {
  const u = route.request().url();
  seen.push(u.replace('https://fleet.lyreosai.com', ''));
  if (u.includes('/discover/filter/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(6, 'fresh')) });
  if (u.includes('/devices/register')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, device: { id: 'dev-1', status: 'approved' }, token: 'tok' }) });
  if (u.includes('/profiles')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profiles: [{ id: 'p1', name: 'Mark', maxRating: 'adult', hasPin: false }] }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 160)); });

await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// Choose a profile. profile.js fires this after a person taps a face, and
// app.js listens for it to set the cap and rebuild the home. Dispatching it
// directly keeps this test off the gate's own markup, which is profile.js's
// job to cover, while still exercising the real listener.
await page.evaluate(() => {
  document.dispatchEvent(new CustomEvent('blazing-profile-selected', {
    detail: { id: 'p1', name: 'Mark', maxRating: 'adult' },
  }));
});
await page.waitForTimeout(6000);

const rows = await page.$$eval('#rows .row', (n) => n.length).catch(() => -1);
const cards = await page.$$eval('#rows .row-track > *', (n) => n.length).catch(() => -1);
const headings = await page.$$eval('#rows .row', (ns) => ns.map((n) => (n.querySelector('h2,h3,.row-title')||{}).textContent||'?').slice(0, 12)).catch(() => []);
const bootCalled = seen.some((u) => u.includes('/api/ui/home-config'));

console.log('DIR              ', ROOT);
console.log('rows in #rows    ', rows);
console.log('cards in #rows   ', cards);
console.log('row headings     ', JSON.stringify(headings));
console.log('boot() ran?      ', bootCalled, '(it is the only caller of /api/ui/home-config)');
console.log('requests seen    ', seen.length);
console.log('page errors      ', errs.length);
for (const e of errs.slice(0, 8)) console.log('   ', e);
await page.screenshot({ path: process.env.SHOT || '/tmp/home.png', fullPage: false });
const ok = rows > 0 && cards > 0 && bootCalled;
console.log(ok ? 'PASS  the home builds rows' : 'FAIL  THE HOME IS EMPTY');
await browser.close(); server.close();
process.exit(ok ? 0 : 1);
