// THE SHELF CINEMA (BLZ-0110).
//
// Markus, 9 Oct 2026, on the Roku: "when i go to the next row it doesnt fully
// do what the continue watching row does with the trailers where it takes the
// full screen it seems like it trys to though." Parity with Roku
// HomeScreen.brs enterShelfCinema, Apple TV ShelfCinema (blazing-tvos 2494ac4)
// and Fire TV ShelfCinema.kt (firetv aec1482).
//
// WHAT IS ASSERTED, every network call a fixture, driven by focus and keys the
// way an LG remote drives it:
//   1. no cinema before five seconds; after five, on a card in a row that is
//      NOT a .row-hero row, a full-viewport layer with the fleet trailer
//   2. it takes nothing: the card keeps focus, the layer is pointer-events
//      none and holds nothing focusable
//   3. Escape closes it and focus stays on the same card; it does not reopen
//   4. a focus move (ArrowLeft through dpad.js) closes it
//   5. Enter opens Details and the detail trailer carries on from the
//      cinema's second, same file
//   6. scrolling the card away closes it
//   7. a .row-hero card's own trailer is MOVED into the cinema and back, not
//      restarted
//   8. no cinema on another page (Movies)
//
//   node shelfcinema.smoke.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './comet.mjs';
import { prepareProfile, selectProfile } from './scripts/profile-fixture.mjs';

// UNDER LOAD A HEADLESS RUN CAN HANG FOR EVER. A hard stop that names itself.
const HARD_TIMEOUT_MS = 300000;
const killer = setTimeout(() => {
  console.error(`shelfcinema: HARD TIMEOUT after ${HARD_TIMEOUT_MS / 1000}s at step "${step}"`);
  process.exit(2);
}, HARD_TIMEOUT_MS);
let step = 'start';
const t0 = Date.now();
const log = (text) => { step = text; console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${text}`); };

const root = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    res.end(await readFile(join(root, path === '/' ? 'index.html' : path)));
  } catch { res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const fixtureVideo = await readFile(join(root, 'scripts', 'fixture-30min.webm'));

// Row one has backdrops, so it claims .row-hero. Row two has none, so it is the
// kind of row that played NOTHING before this change.
const hero = (n) => ({
  id: `tt720000${n}`, type: 'movie', name: `Hero ${n === 1 ? 'One' : 'Two'}`, releaseInfo: '2026',
  contentRating: 'general', poster: `https://img.example.test/h${n}.jpg`,
  background: `https://img.example.test/h${n}-bg.jpg`,
  // Eleven characters: youtubeTrailerId() drops anything that is not a real id.
  trailers: [{ source: n === 1 ? 'ytHeroOne01' : 'ytHeroTwo02', type: 'Trailer' }],
});
const plain = (n) => ({
  id: `tt730000${n}`, type: 'movie', name: `Plain ${n === 1 ? 'One' : 'Two'}`, releaseInfo: '2025',
  contentRating: 'general', poster: `https://img.example.test/p${n}.jpg`,
});
const HEROES = [hero(1), hero(2)];
const PLAINS = [plain(1), plain(2)];
const FULL = Object.fromEntries([...HEROES, ...PLAINS].map((m) => [m.id, {
  ...m, description: `${m.name}: the full synopsis, which only the meta route carries.`,
}]));

const manifest = { catalogs: [
  { id: 'heroes', type: 'movie', name: 'Hero shelf' },
  { id: 'plain', type: 'movie', name: 'Plain shelf' },
] };
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function serveVideo(route) {
  const range = route.request().headers().range || '';
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match && match[1] ? Number(match[1]) : 0;
  const end = match && match[2] ? Math.min(Number(match[2]), fixtureVideo.length - 1) : fixtureVideo.length - 1;
  const slice = fixtureVideo.subarray(start, end + 1);
  return route.fulfill({
    status: match ? 206 : 200,
    contentType: 'video/webm',
    headers: {
      'access-control-allow-origin': '*',
      'accept-ranges': 'bytes',
      'content-length': String(slice.length),
      ...(match ? { 'content-range': `bytes ${start}-${end}/${fixtureVideo.length}` } : {}),
    },
    body: slice,
  });
}

const seen = { fleetTrailer: [], resolve: 0, faults: [], logs: [] };
async function wire(ctx) {
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    if (url.hostname === 'cdn.example.test') return serveVideo(route);
    if (url.hostname === 'fleet.lyreosai.com') {
      const m = /^\/trailer\/(movie|series)\/([^/]+)$/.exec(url.pathname);
      if (m) return json(route, { ytId: `yt-${decodeURIComponent(m[2])}` });
      if (url.pathname.startsWith('/trailer/play/')) { seen.fleetTrailer.push(url.pathname); return serveVideo(route); }
      return json(route, { metas: [], items: [] });
    }
    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/manifest.json') return json(route, manifest);
      if (url.pathname === '/catalog/movie/heroes.json') return json(route, { metas: HEROES });
      if (url.pathname === '/catalog/movie/plain.json') return json(route, { metas: PLAINS });
      if (url.pathname.startsWith('/catalog/')) return json(route, { metas: [] });
      if (url.pathname.startsWith('/meta/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop().replace('.json', ''));
        return json(route, { meta: FULL[id] || FULL[HEROES[0].id] });
      }
      if (url.pathname === '/proxy/yt-resolve') {
        seen.resolve += 1;
        return json(route, { url: `https://cdn.example.test/card-${url.searchParams.get('id')}.webm` });
      }
      if (url.pathname.startsWith('/stream/')) return json(route, { streams: [] });
      return json(route, { metas: [], streams: [] });
    }
    return json(route, { metas: [], items: [], results: [] });
  });
}

const card = (page, name) => page.getByRole('button', { name: `View ${name}`, exact: true }).first();
const cinema = (page) => page.evaluate(() => {
  const layer = document.querySelector('#shelf-cinema');
  const video = layer.querySelector('#shelf-cinema-video video');
  const box = layer.getBoundingClientRect();
  return {
    open: !layer.hidden && layer.classList.contains('open'),
    title: document.querySelector('#shelf-cinema-title').textContent,
    synopsis: document.querySelector('#shelf-cinema-synopsis').textContent,
    active: document.activeElement && document.activeElement.getAttribute('aria-label'),
    pointer: getComputedStyle(layer).pointerEvents,
    focusables: layer.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])').length,
    // clientWidth, not innerWidth: a classic scrollbar sits outside a fixed layer.
    full: Math.round(box.width) === document.documentElement.clientWidth && Math.round(box.height) === document.documentElement.clientHeight,
    box: `${Math.round(box.width)}x${Math.round(box.height)} vs ${document.documentElement.clientWidth}x${document.documentElement.clientHeight}`,
    src: video ? (video.getAttribute('src') || '') : '',
    t: video ? video.currentTime : 0,
    mark: video ? video.dataset.mark || '' : '',
  };
});
const waitOpen = (page, title, timeout = 15000) => page.waitForFunction((t) => {
  const layer = document.querySelector('#shelf-cinema');
  return !layer.hidden && layer.classList.contains('open') && document.querySelector('#shelf-cinema-title').textContent === t;
}, title, { timeout });
const waitClosed = (page, timeout = 3000) => page.waitForFunction(
  () => document.querySelector('#shelf-cinema').hidden, null, { timeout });
const waitPlaying = (page, past) => page.waitForFunction((s) => {
  const v = document.querySelector('#shelf-cinema-video video');
  return !!v && v.currentTime > s;
}, past, { timeout: 20000 });

let browser;
let pass = 0;
const ok = (n, text) => { pass += 1; log(`ok ${n}  ${text}`); };
try {
  log('launching headless Comet');
  browser = await launchBrowser();
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await wire(ctx);
  await prepareProfile(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (error) => seen.faults.push(error.message));
  page.on('console', (msg) => { if (/\[cinema\]/.test(msg.text())) seen.logs.push(msg.text()); });
  await page.setViewportSize({ width: 1440, height: 760 });
  await page.goto(`${base}/index.html`);
  await selectProfile(page);
  await card(page, 'Plain One').waitFor({ timeout: 30000 });
  await card(page, 'Hero One').waitFor({ timeout: 30000 });
  assert.equal(await card(page, 'Plain One').evaluate((c) => !!c.closest('.row-hero')), false,
    'the plain shelf is NOT a .row-hero row — the rows that used to play nothing');
  assert.equal(await card(page, 'Hero One').evaluate((c) => !!c.closest('.row-hero')), true);

  /* ===================================================================== 1-2 */
  log('focus a card in the plain shelf');
  await card(page, 'Plain One').focus();
  const focusedAt = Date.now();
  await page.waitForTimeout(3500);
  assert.equal((await cinema(page)).open, false, 'no cinema before five seconds');
  await waitOpen(page, 'Plain One');
  const openedAfter = Date.now() - focusedAt;
  assert.ok(openedAfter >= 4500, `the cinema waits for the dwell (${openedAfter} ms)`);
  let c = await cinema(page);
  assert.equal(c.full, true, `the layer covers the whole viewport (${c.box})`);
  assert.match(c.src, /\/trailer\/play\/yt-tt7300001/, "with the fleet's trailer for that film");
  ok(1, `no cinema at 3.5 s; full screen with the fleet trailer at ${(openedAfter / 1000).toFixed(1)} s on a non-row-hero card`);
  assert.equal(c.active, 'View Plain One', 'the card keeps focus');
  assert.equal(c.pointer, 'none', 'the layer takes no pointer');
  assert.equal(c.focusables, 0, 'and holds nothing focusable');
  await page.waitForFunction(() => /only the meta route carries/.test(document.querySelector('#shelf-cinema-synopsis').textContent), null, { timeout: 10000 });
  ok(2, 'focus stays on the card; pointer-events none; nothing focusable; synopsis filled');

  /* ===================================================================== 3 */
  log('Escape');
  await waitPlaying(page, 0.3);
  await page.keyboard.press('Escape');
  await waitClosed(page);
  c = await cinema(page);
  assert.equal(c.active, 'View Plain One', 'focus stays on the same card');
  await page.waitForTimeout(1500);
  assert.equal((await cinema(page)).open, false, 'and the cinema does not come straight back');
  assert.equal(await page.evaluate(() => document.querySelector('#detail-dialog').open), false, 'Escape opened nothing else');
  ok(3, 'Escape closes it; focus stays on the same card');

  /* ===================================================================== 4 */
  log('ArrowRight to the next card, dwell, then ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'View Plain Two', null, { timeout: 5000 });
  await waitOpen(page, 'Plain Two');
  await page.keyboard.press('ArrowLeft');
  await waitClosed(page, 2000);
  c = await cinema(page);
  assert.equal(c.active, 'View Plain One', 'the remote moved focus');
  ok(4, 'a focus move closes it');

  /* ===================================================================== 5 */
  log('dwell again, then Enter');
  await waitOpen(page, 'Plain One');
  await waitPlaying(page, 1.5);
  c = await cinema(page);
  const cinemaSrc = c.src;
  const cinemaTime = c.t;
  await page.keyboard.press('Enter');
  await page.locator('#detail-dialog[open]').waitFor({ timeout: 15000 });
  assert.equal((await cinema(page)).open, false, 'the sheet replaces the cinema');
  await page.waitForFunction(() => {
    const v = document.querySelector('#detail-trailer video');
    return !!v && v.readyState >= 1;
  }, null, { timeout: 20000 });
  const detail = await page.evaluate(() => {
    const v = document.querySelector('#detail-trailer video');
    return { src: v.getAttribute('src') || '', t: v.currentTime };
  });
  assert.equal(detail.src, cinemaSrc, 'the detail trailer is the same file');
  assert.ok(detail.t >= cinemaTime - 0.5, `and carries on from the cinema's second (${cinemaTime.toFixed(1)} -> ${detail.t.toFixed(1)})`);
  ok(5, `Enter opens Details; trailer carried on at ${detail.t.toFixed(1)} s`);

  /* ===================================================================== 6 */
  log('close the sheet, dwell, then scroll');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#detail-dialog').open, null, { timeout: 5000 });
  await card(page, 'Plain One').focus();
  await waitOpen(page, 'Plain One');
  const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight - scrollY);
  const delta = room > 60 ? 200 : -200;
  await page.evaluate((d) => window.scrollBy(0, d), delta);
  await waitClosed(page, 3000);
  assert.ok(seen.logs.some((l) => /closed \(scroll\)/.test(l)), 'closed by the scroll');
  ok(6, 'scrolling the card away closes it');

  /* ===================================================================== 7 */
  log('a row-hero card: its own trailer moves');
  await card(page, 'Hero One').focus();
  await page.waitForFunction(() => {
    const v = document.querySelector('[aria-label="View Hero One"] .card-trailer-wrap video');
    if (v) v.dataset.mark = 'in-card';
    return !!v;
  }, null, { timeout: 10000 });
  await waitOpen(page, 'Hero One');
  c = await cinema(page);
  assert.equal(c.mark, 'in-card', 'the cinema shows the very <video> the card was playing');
  assert.match(c.src, /card-ytHeroOne01/, 'the card trailer, not a second one');
  await page.keyboard.press('Escape');
  await waitClosed(page);
  const back = await page.evaluate(() => {
    const v = document.querySelector('[aria-label="View Hero One"] .card-trailer-wrap video');
    return v ? v.dataset.mark : '';
  });
  assert.equal(back, 'in-card', 'and it goes back into the card');
  ok(7, 'a row-hero card trailer is moved into the cinema and back, not restarted');

  /* ===================================================================== 8 */
  log('Movies page');
  await page.evaluate(() => showRoute('movies'));
  await card(page, 'Plain Two').focus();
  await page.waitForTimeout(6500);
  assert.equal((await cinema(page)).open, false, 'no cinema off Home');
  ok(8, 'no cinema on another page');

  assert.deepEqual(seen.faults, [], 'no page errors');
  console.log(`\nshelfcinema: ${pass} passed, 0 failed`);
} finally {
  if (browser) await browser.close();
  server.close();
  clearTimeout(killer);
}
