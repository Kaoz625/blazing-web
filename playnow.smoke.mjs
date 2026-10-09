// PLAY NOW — THE HOME BAND'S DWELL SEARCH (BLZ-0108).
//
// Parity with Roku 6dd9b67 + 795db9d, Samsung 3ed24e2 (test/playnow.smoke.mjs),
// Fire TV 5cef679 and Apple TV a1687f9. Markus, 9 Oct 2026, on the 55": "if ive
// stayed on the stream watching the trailer like this on the home screen it
// should start searching for the sources ... it will then show a button that
// says something like play now".
//
// WHAT IS ASSERTED, every network call a fixture:
//   1. no search before the five-second dwell; then ONE /stream search, the
//      profile's cap on it, and range probes (bytes=0-0) of the top rows only
//   2. the first probe that answers is the one held: the band reads Play Now
//      and the meta line READY TO PLAY. No /precache anywhere
//   3. the held list is refused for another cap or another profile
//   4. Play Now plays the live row at once: no second /stream, sheet closed
//   5. spent on the press, and the next dwell searches again
//   6. not ready: exactly three probes, Play stays, and the next dwell asks again
//   7. a late answer for a film the band has left is ignored
//   8. a Continue Watching card is never searched
//
//   node playnow.smoke.mjs
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
  console.error(`playnow: HARD TIMEOUT after ${HARD_TIMEOUT_MS / 1000}s at step "${step}"`);
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

const film = (id, name) => ({
  id, type: 'movie', name, releaseInfo: '2026', contentRating: 'general',
  description: `${name}: a fixture film.`,
  poster: `https://img.example.test/${id}-poster.jpg`,
  background: `https://img.example.test/${id}-backdrop.jpg`,
});
const A = film('tt7000001', 'The Long Night');
const B = film('tt7000002', 'The Second Feature');
const C = film('tt7000003', 'Half Watched');

// Identical rows bar the group, so the device ranking cannot drop any of them.
const streamsFor = (id) => Array.from({ length: 5 }, (_, i) => ({
  name: '1080p',
  title: `Fixture.${id}.2026.1080p.WEB-DL.H264.AAC-GRP${i}.mp4\n1.4 GB 👤 ${200 - i}`,
  url: `https://cdn.example.test/${id}-${i}.webm`,
}));

const manifest = { catalogs: [{ id: 'fixture', type: 'movie', name: 'Test titles' }] };
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Range, Content-Length' };

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
      ...CORS,
      'accept-ranges': 'bytes',
      'content-length': String(slice.length),
      ...(match ? { 'content-range': `bytes ${start}-${end}/${fixtureVideo.length}` } : {}),
    },
    body: slice,
  });
}

/**
 * One context. `opts.probe(url, n)` answers the n-th probe (true = alive).
 * `opts.streamDelay(id)` holds a /stream answer back, in ms.
 */
async function wire(ctx, seen, opts) {
  await ctx.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === base) return route.continue();
    seen.all.push(url.pathname);
    if (url.hostname === 'cdn.example.test') {
      if (request.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-headers': 'range', 'access-control-allow-methods': 'GET' } });
      }
      const range = request.headers().range || '';
      if (request.resourceType() === 'fetch' && range === 'bytes=0-0') {
        seen.probes.push(request.url());
        const alive = opts.probe(request.url(), seen.probes.length);
        if (!alive) return route.fulfill({ status: 404, headers: CORS, body: 'gone' });
      }
      return serveVideo(route);
    }
    if (url.hostname === 'fleet.lyreosai.com') {
      if (/^\/profiles\/[^/]+\/progress/.test(url.pathname) && opts.progress) return json(route, opts.progress);
      return json(route, { metas: [], items: [] });
    }
    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/manifest.json') return json(route, manifest);
      if (url.pathname === '/catalog/movie/fixture.json') return json(route, { metas: opts.catalog || [A] });
      if (url.pathname.startsWith('/catalog/')) return json(route, { metas: [] });
      if (url.pathname.startsWith('/meta/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop().replace('.json', ''));
        return json(route, { meta: [A, B, C].find((m) => m.id === id) || A });
      }
      if (url.pathname.startsWith('/stream/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop().replace('.json', ''));
        seen.streamed.push({ id, cap: url.searchParams.get('cap'), at: Date.now() });
        const delay = opts.streamDelay ? opts.streamDelay(id) : 0;
        if (delay) await new Promise((r) => setTimeout(r, delay));
        return json(route, { streams: streamsFor(id) });
      }
      return json(route, { metas: [], streams: [] });
    }
    return json(route, { metas: [], items: [], results: [] });
  });
}

async function coldPage(opts) {
  const seen = { streamed: [], probes: [], all: [], logs: [], faults: [] };
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await wire(ctx, seen, opts);
  await prepareProfile(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (error) => seen.faults.push(error.message));
  page.on('console', (msg) => { if (/\[homewarm\]/.test(msg.text())) seen.logs.push(msg.text()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/index.html`);
  await selectProfile(page);
  return { ctx, page, seen };
}

const hero = (page) => page.evaluate(() => ({
  visible: !document.querySelector('#home-hero').hidden,
  title: document.querySelector('#home-hero-title').textContent,
  eyebrow: document.querySelector('#home-hero-eyebrow').textContent,
  button: document.querySelector('#home-hero-play').textContent,
  ready: !document.querySelector('#home-hero-ready').hidden,
  meta: document.querySelector('#home-hero-meta').textContent,
}));
const waitLabel = (page, text, timeout = 30000) => page.waitForFunction(
  (want) => document.querySelector('#home-hero-play')?.textContent === want, text, { timeout });
const playerOpen = (page) => page.evaluate(() => !document.querySelector('#player').hidden);

let browser;
let pass = 0;
const ok = (n, text) => { pass += 1; log(`ok ${n}  ${text}`); };
try {
  log('launching headless Comet');
  browser = await launchBrowser();

  /* ===================================================================== 1-5 */
  log('cold page: first probe dead, the rest alive');
  let { ctx, page, seen } = await coldPage({ probe: (_url, n) => n !== 1 });
  await page.waitForFunction(() => !document.querySelector('#home-hero').hidden
    && document.querySelector('#home-hero-title').textContent === 'The Long Night', null, { timeout: 30000 });
  const heroAt = Date.now();
  log('hero shows the film');
  let h = await hero(page);
  assert.equal(h.button, 'Play', 'the band starts as Play');
  assert.equal(h.ready, false, 'and with no READY TO PLAY');
  await page.waitForTimeout(3000);
  assert.equal(seen.streamed.filter((s) => s.id === A.id).length, 0, 'no search before the five-second dwell');

  await waitLabel(page, 'Play Now');
  log('band reads Play Now');
  const searches = seen.streamed.filter((s) => s.id === A.id);
  assert.equal(searches.length, 1, 'exactly one /stream search');
  assert.ok(searches[0].at - heroAt >= 4500, `the search waits for the dwell (started ${searches[0].at - heroAt} ms in)`);
  assert.equal(searches[0].cap, 'adult', "with the profile's cap on it");
  assert.equal(seen.probes.length, 2, 'probing stops at the first link that answers (dead, then alive)');
  const ranked = await page.evaluate(async (rows) => (await rankForPlay(rows)).map((r) => r.url), streamsFor(A.id));
  assert.deepEqual(seen.probes, ranked.slice(0, 2), 'the probes walk the ranked list from the top');
  ok(1, `dwell then one search (cap=adult) and ${seen.probes.length} range probes of the top rows`);

  h = await hero(page);
  assert.equal(h.ready, true, 'READY TO PLAY shows');
  assert.match(h.meta, /2026/, 'beside the meta words, which are still there');
  assert.ok(!seen.all.some((p) => p.includes('precache')), 'no /precache call');
  ok(2, 'Play Now + READY TO PLAY; no /precache');

  // 3. THE GATE. Another cap, another profile: refused, and the press opens the
  //    sheet the ordinary way instead of playing the held link.
  let label = await page.evaluate(() => { state.profileCap = 'teen'; syncHeroPlayLabel(); return document.querySelector('#home-hero-play').textContent; });
  assert.equal(label, 'Play', 'a held list is refused under another cap');
  await page.locator('#home-hero-play').click();
  await page.locator('#detail-dialog[open]').waitFor({ timeout: 20000 });
  await page.waitForTimeout(2500);
  assert.equal(await playerOpen(page), false, 'and the press does not play the held link');
  await page.evaluate(() => closeDetail());
  label = await page.evaluate(() => {
    state.profileCap = 'adult';
    const id = state.profileId;
    state.profileId = 'p2';
    syncHeroPlayLabel();
    const other = document.querySelector('#home-hero-play').textContent;
    state.profileId = id;
    syncHeroPlayLabel();
    return [other, document.querySelector('#home-hero-play').textContent];
  });
  assert.deepEqual(label, ['Play', 'Play Now'], 'refused for another profile, live again for this one');
  ok(3, 'held list refused for another cap and another profile');

  // 4. THE PRESS.
  const streamedBefore = seen.streamed.length;
  await page.locator('#home-hero-play').click();
  await page.locator('#player').waitFor({ state: 'visible', timeout: 20000 });
  const src = await page.evaluate(() => document.querySelector('#video').getAttribute('src') || document.querySelector('#video').currentSrc);
  assert.equal(src, seen.probes[1], 'Play Now plays the row that answered');
  assert.equal(seen.streamed.length, streamedBefore, 'with no second /stream search');
  assert.equal(await page.evaluate(() => document.querySelector('#detail-dialog').open), false, 'the sheet is not left open behind the player');
  ok(4, 'Play Now plays the live row at once, no second search');

  // 5. SPENT, and the next dwell searches again. (Part 3's ordinary sheet
  //    searched once too, so this counts from here.)
  const searchesBefore = seen.streamed.filter((s) => s.id === A.id).length;
  await page.locator('#player-close').click();
  await page.locator('#player').waitFor({ state: 'hidden', timeout: 10000 });
  h = await hero(page);
  assert.equal(h.button, 'Play', 'spent on the press: the band reads Play again');
  assert.equal(h.ready, false);
  await waitLabel(page, 'Play Now', 30000);
  assert.equal(seen.streamed.filter((s) => s.id === A.id).length, searchesBefore + 1, 'the next dwell searched again, once');
  ok(5, 'spent on the press; the next dwell searches again');
  assert.deepEqual(seen.faults, [], 'no page errors');
  await ctx.close();

  /* ===================================================================== 6 */
  log('cold page: every probe dead');
  ({ ctx, page, seen } = await coldPage({ probe: () => false }));
  await page.waitForFunction(() => document.querySelector('#home-hero-title')?.textContent === 'The Long Night', null, { timeout: 30000 });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && seen.logs.every((l) => !/nothing answered/.test(l))) await page.waitForTimeout(250);
  assert.ok(seen.logs.some((l) => /nothing answered for tt7000001/.test(l)), 'the search finished not ready');
  assert.equal(seen.probes.length, 3, 'exactly the top three are probed');
  h = await hero(page);
  assert.equal(h.button, 'Play', 'Play stays');
  assert.equal(h.ready, false, 'no READY TO PLAY');
  await page.evaluate(() => showRoute('library'));
  await page.evaluate(() => showRoute('home'));
  const again = Date.now() + 15000;
  while (Date.now() < again && seen.streamed.length < 2) await page.waitForTimeout(250);
  assert.equal(seen.streamed.length, 2, 'a not-ready answer is cleared, so the next dwell asks again');
  ok(6, 'not ready: three probes, Play stays, next dwell searches again');
  assert.deepEqual(seen.faults, [], 'no page errors');
  await ctx.close();

  /* ===================================================================== 7 */
  log('cold page: a slow search, and the band moves on before it answers');
  ({ ctx, page, seen } = await coldPage({ probe: () => true, streamDelay: (id) => (id === A.id ? 4000 : 0) }));
  await page.waitForFunction(() => document.querySelector('#home-hero-title')?.textContent === 'The Long Night', null, { timeout: 30000 });
  const asked = Date.now() + 15000;
  while (Date.now() < asked && !seen.streamed.some((s) => s.id === A.id)) await page.waitForTimeout(100);
  assert.ok(seen.streamed.some((s) => s.id === A.id), 'the search for the first film started');
  await page.evaluate((meta) => { resetHomeHero(); seedHomeHero(meta, { priority: 3, eyebrow: 'Featured' }); }, B);
  log('band moved to the second film while the first search is pending');
  await waitLabel(page, 'Play Now', 30000);
  h = await hero(page);
  assert.equal(h.title, 'The Second Feature', 'Play Now is for the film on the band');
  const late = Date.now() + 10000;
  while (Date.now() < late && !seen.logs.some((l) => /ignoring a late answer for tt7000001/.test(l))) await page.waitForTimeout(200);
  assert.ok(seen.logs.some((l) => /ignoring a late answer for tt7000001/.test(l)), 'the late answer for the first film is ignored');
  assert.ok(!seen.probes.some((u) => u.includes(A.id)), 'and none of its rows are probed');
  assert.equal(await page.evaluate(() => homeWarm.ready), B.id, 'what is held is the second film');
  ok(7, 'a late answer for a film the band left is ignored');
  assert.deepEqual(seen.faults, [], 'no page errors');
  await ctx.close();

  /* ===================================================================== 8 */
  log('cold page: Continue Watching holds the band');
  ({ ctx, page, seen } = await coldPage({
    probe: () => true,
    catalog: [],
    progress: { progress: { items: [{ ...C, progress: 40, updatedAt: Date.now() }] } },
  }));
  await page.waitForFunction(() => document.querySelector('#home-hero-eyebrow')?.textContent === 'Continue watching'
    && !document.querySelector('#home-hero').hidden, null, { timeout: 30000 });
  await page.waitForTimeout(7000);
  assert.equal(seen.streamed.filter((s) => s.id === C.id).length, 0, 'a resume card is never searched');
  assert.equal((await hero(page)).button, 'Play');
  ok(8, 'a Continue Watching card is never searched');
  assert.deepEqual(seen.faults, [], 'no page errors');
  await ctx.close();

  console.log(`\nplaynow: ${pass} passed, 0 failed`);
} finally {
  if (browser) await browser.close();
  server.close();
  clearTimeout(killer);
}
