/**
 * Live TV on the web: the placeholder filter, the honest count, the search, and
 * the ticket that makes a <video> able to authenticate.
 *
 * WHY EACH CHECK IS HERE. All of them are things that look right in the source
 * and are wrong on the device:
 *
 *  - The index is mostly junk at the top. One live page of 500 measured 470
 *    placeholder rows to 30 real ones, so a grid that renders what the server
 *    sends reads as a broken app. isPlaceholder() has to drop them.
 *  - ...but the COUNT must still be the server's own total. Reporting the
 *    filtered number tells a viewer there are 12 channels in a 38,899-channel
 *    index, and they go looking for a bug that is not there.
 *  - The media URL must carry no credential and must point at /live/play, not
 *    at the provider. A provider URL is http and this page is https, so the
 *    browser refuses it silently — no throw, no console, just a black player.
 *
 *   node livetv.smoke.mjs
 */
import { launchBrowser } from './comet.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, p === '/' ? 'index.html' : p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`ok    ${label}${extra ? '  ' + extra : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

// The real shapes, copied off the live index on 6 Sep 2026 rather than invented.
const REAL = [
  { id: 'c1', name: 'CA - CNN INTERNATIONAL HD', logo: 'https://img.invalid/cnn.png', group: 'news', hasGuide: true, streamCount: 1 },
  { id: 'c2', name: 'BBC', logo: 'http://photo-tmdb.com/logo.png', group: 'general', hasGuide: true, streamCount: 2 },
  { id: 'c3', name: 'CHL: CNN HD', logo: '', group: 'news', hasGuide: false, streamCount: 1 },
];
const JUNK = [
  { id: 'j1', name: '- NO EVENT STREAMING - | 8K EXCLUSIVE | BR: DISNEY+ PPV 100', group: 'general', streamCount: 1 },
  { id: 'j2', name: '##### CBS ALABAMA #####', group: 'general', streamCount: 1 },
  { id: 'j3', name: '--- National CBS Channels---', group: 'general', streamCount: 1 },
  { id: 'j4', name: '   ', group: 'general', streamCount: 1 },
];
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-live', token: 'tok-live' }));
  localStorage.setItem('blazing-household-approved', '1');
  localStorage.setItem('blazing-web-profile-session-v1', JSON.stringify({
    id: 'p-live', maxRating: 'adult', isKids: false, neededPin: false, allowAdult: true, savedAt: Date.now(),
  }));
  // Record what the player was handed, instead of actually opening one.
  window.__played = [];
});

const seen = [];
let tokenHeaderSeen = null;
await ctx.route('https://fleet.lyreosai.com/**', (route) => {
  const url = new URL(route.request().url());
  seen.push(url.pathname + url.search);
  if (url.pathname === '/live/groups') {
    return json(route, { groups: [
      { id: 'news', name: 'News', count: 1063 },
      { id: 'sports', name: 'Sports', count: 4416 },
    ] });
  }
  if (url.pathname === '/live/channels') {
    tokenHeaderSeen = route.request().headers()['x-device-token'] || null;
    const q = url.searchParams.get('q');
    const group = url.searchParams.get('group');
    if (q === 'cnn') return json(route, { total: 38, channels: REAL.filter((c) => /cnn/i.test(c.name)) });
    if (group === 'news') return json(route, { total: 1063, channels: REAL.filter((c) => c.group === 'news') });
    return json(route, { total: 38899, channels: [...JUNK, ...REAL] });
  }
  if (url.pathname.startsWith('/live/ticket/')) {
    return json(route, { ticket: 'abc123def456abc123def456abc12345', url: '/live/play/abc123def456abc123def456abc12345', format: 'hls' });
  }
  if (url.pathname === '/accounts/me') return json(route, { account: { id: 'a' }, device: { id: 'dev-live', enrollmentStatus: 'approved' } });
  if (url.pathname === '/profiles') return json(route, { profiles: [{ id: 'p-live', name: 'Mark', maxRating: 'adult', hasPin: false }] });
  return json(route, {});
});
await ctx.route('https://addon.lyreosai.com/**', (route) => json(route, {}));
// A logo that REALLY loads. Without this the https logo 404s, the card's own
// `error` handler swaps in the initials — correctly — and the check below would
// read 0 images and blame safeHttpsUrl for something it did not do.
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
await ctx.route('https://img.invalid/**', (route) =>
  route.fulfill({ status: 200, contentType: 'image/gif', body: GIF }));

const page = await ctx.newPage();
const faults = [];
page.on('pageerror', (e) => faults.push(e.message));
await page.goto(`${base}/index.html`);
// Stand in for the player so nothing tries to decode a fixture URL.
await page.evaluate(() => {
  window.BlazingPlayer = { open: (title, url, opts) => window.__played.push({ title, url, opts }) };
});

// ── the chip exists and reaches the view ────────────────────────────────────
ok(await page.locator('.topnav [data-view="livetv"]').count() === 1, 'Live TV is a chip in the top nav');
ok(await page.locator('.drawer-nav [data-view="livetv"]').count() === 1,
  'and in the drawer too — .topnav is display:none at 992px, so the drawer is the phone');

// The gate's backdrop covers the nav until somebody says who they are, so a
// click on a chip is intercepted rather than delivered. Pass it first — this
// suite is about Live TV, not about the gate.
await page.getByRole('button', { name: 'Choose Mark', exact: true }).click({ timeout: 15000 });
await page.waitForFunction(() => document.querySelector('.bp-layer')?.hidden !== false, null, { timeout: 15000 })
  .catch(() => {});

await page.locator('.topnav [data-view="livetv"]').click();
await page.waitForFunction(() => !document.getElementById('livetv-view').hidden);
ok(true, 'the chip opens #livetv-view');

await page.waitForFunction(() => document.querySelectorAll('#livetv-results .livetv-card').length > 0, null, { timeout: 8000 });

// ── the placeholder filter ──────────────────────────────────────────────────
const names = await page.locator('#livetv-results .livetv-card-name').allInnerTexts();
ok(names.length === 3, 'only the real channels are drawn', `${names.length} of ${JUNK.length + REAL.length} rows`);
ok(!names.some((n) => /NO EVENT STREAMING/i.test(n)), 'the PPV placeholders are gone');
ok(!names.some((n) => /^#+/.test(n.trim())), 'the "##### CBS ALABAMA #####" heading rows are gone');
ok(!names.some((n) => /^-{3}/.test(n.trim())), 'and the "--- National CBS Channels---" rules are gone');
ok(names.includes('CA - CNN INTERNATIONAL HD'),
  'a REAL name starting with a dash survives — the filter is about decoration, not punctuation');

// ── the honest count ────────────────────────────────────────────────────────
const status = await page.locator('#livetv-status').innerText();
ok(/38,899/.test(status), "the SERVER's total is reported, not the filtered count", status);
ok(/Showing 3 /.test(status), 'and what is on screen is stated separately', status);

// ── credentials go in a header, never a URL ─────────────────────────────────
ok(tokenHeaderSeen === 'tok-live', 'the device token travels in X-Device-Token', String(tokenHeaderSeen));
ok(seen.some((u) => u.startsWith('/live/channels') && u.includes('deviceId=dev-live')),
  'the device id is a query param, which is what scopes the index');
ok(!seen.some((u) => /token/i.test(u)), 'NO request URL carries the token', seen.filter((u) => /token/i.test(u)).join(','));

// ── mixed-content logos ─────────────────────────────────────────────────────
const imgs = await page.locator('#livetv-results .livetv-card-art img').count();
ok(imgs === 1, 'only the https logo becomes an <img>; the http one would be blocked as mixed content', `${imgs} images`);

// ── group filter and search ─────────────────────────────────────────────────
await page.locator('.livetv-chip[data-group="news"]').click();
await page.waitForFunction(() => document.getElementById('livetv-status').textContent.includes('1,063'), null, { timeout: 8000 });
ok(true, 'a group chip refilters and reports that group\'s own total');
ok(await page.locator('.livetv-chip[data-group="news"]').getAttribute('aria-pressed') === 'true',
  'and the chip says so through aria-pressed, which is also what styles it');

await page.fill('#livetv-search-input', 'cnn');
await page.locator('#livetv-search-form button[type="submit"]').click();
await page.waitForFunction(() => document.getElementById('livetv-status').textContent.includes('38 channels'), null, { timeout: 8000 });
const searched = await page.locator('#livetv-results .livetv-card-name').allInnerTexts();
ok(searched.length === 2 && searched.every((n) => /cnn/i.test(n)), 'search asks the SERVER and narrows the grid', searched.join(' | '));
ok(await page.locator('.livetv-chip[data-group="news"]').getAttribute('aria-pressed') === 'false',
  'searching clears the group chip — a search that silently stayed narrowed would hide matches');

// ── tuning ──────────────────────────────────────────────────────────────────
await page.locator('#livetv-results .livetv-card').first().click();
await page.waitForFunction(() => window.__played.length > 0, null, { timeout: 8000 });
const played = await page.evaluate(() => window.__played[0]);
ok(played.url === 'https://fleet.lyreosai.com/live/play/abc123def456abc123def456abc12345',
  'the player is handed /live/play, NOT the provider url — an http provider url is refused as mixed content', played.url);
ok(!/token|tok-live/i.test(played.url), 'and that media url carries no credential at all', played.url);
ok(played.opts.streamFormat === 'hls',
  "the server's declared format is passed through — this URL has no .m3u8 for looksLikeHls() to sniff", played.opts.streamFormat);
ok(seen.some((u) => u.startsWith('/live/ticket/')), 'a ticket was minted first');

ok(faults.length === 0, 'no page errors', faults.join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
server.close();
if (fail) process.exit(1);
