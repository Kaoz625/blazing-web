// THE WATCHED REPLAY (BLZ-0109).
//
// Parity with Roku 9754f91, Samsung c0298b8 (test/replay.smoke.mjs), Fire TV
// 26abc38 and Apple TV 68593e3. Markus, 8 Oct 2026: "ive watched list those
// should be the easiest thing to replay".
//
// WHAT IS ASSERTED, every network call a fixture:
//   1. a film played past 95% keeps {videoId, url, label, format} and the cap,
//      per profile — and nothing is kept at 50%
//   2. Library -> Watched -> that film: the saved link is probed (bytes=0-0)
//      and replayed from 0:00 with no search and no Resume offer
//   3. a saved link that does not answer falls back to the normal search
//   4. a saved link that answers the probe but fails in the player falls back
//      to the normal search too
//   5. a link saved under another cap is never replayed: the ordinary sheet
//   6. the store: 30 at most, newest first, one per film, per profile; and only
//      films are ever watched for it
//
//   node replay.smoke.mjs
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
  console.error(`replay: HARD TIMEOUT after ${HARD_TIMEOUT_MS / 1000}s at step "${step}"`);
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

const R = {
  id: 'tt7100001', type: 'movie', name: 'The Rewatch', releaseInfo: '2026', contentRating: 'general',
  description: 'A fixture film watched to the end.',
  poster: 'https://img.example.test/rewatch-poster.jpg',
  background: 'https://img.example.test/rewatch-backdrop.jpg',
};
const STORE = 'blazing-replay-links-v1:p1';
const streams = Array.from({ length: 3 }, (_, i) => ({
  name: '1080p',
  title: `The.Rewatch.2026.1080p.WEB-DL.H264.AAC-GRP${i}.mp4\n1.4 GB 👤 ${200 - i}`,
  url: `https://cdn.example.test/rewatch-${i}.webm`,
}));
const EXPIRED = 'https://cdn.example.test/old-expired.webm';
const BROKEN = 'https://cdn.example.test/answers-but-broken.webm';

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

const seen = { streamed: 0, probes: [], faults: [], logs: [] };
async function wire(ctx) {
  await ctx.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === base) return route.continue();
    if (url.hostname === 'cdn.example.test') {
      if (request.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-headers': 'range', 'access-control-allow-methods': 'GET' } });
      }
      const probe = request.resourceType() === 'fetch' && (request.headers().range || '') === 'bytes=0-0';
      if (probe) seen.probes.push(request.url());
      if (request.url() === EXPIRED) return route.fulfill({ status: 404, headers: CORS, body: 'gone' });
      // Answers the one-byte probe, then refuses the player.
      if (request.url() === BROKEN && !probe) return route.fulfill({ status: 404, headers: CORS, body: 'gone' });
      return serveVideo(route);
    }
    if (url.hostname === 'fleet.lyreosai.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'profiles' && parts[2] === 'lists' && request.method() === 'GET') {
        return json(route, { watchlist: [], collection: [], watched: [{ id: R.id, type: 'movie', name: R.name, poster: R.poster, contentRating: 'general', addedAt: '2026-10-09T10:00:00Z' }] });
      }
      return json(route, { metas: [], items: [] });
    }
    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/manifest.json') return json(route, manifest);
      if (url.pathname === '/catalog/movie/fixture.json') return json(route, { metas: [R] });
      if (url.pathname.startsWith('/catalog/')) return json(route, { metas: [] });
      if (url.pathname.startsWith('/meta/')) return json(route, { meta: R });
      // A stored position, so a Resume offer WOULD appear if fromStart were ignored.
      if (url.pathname.startsWith('/api/sync/progress/')) return json(route, { position: 600, duration: 1800 });
      if (url.pathname.startsWith('/stream/')) { seen.streamed += 1; return json(route, { streams }); }
      if (url.pathname === '/proxy/resolve') return json(route, {});
      return json(route, { metas: [], streams: [] });
    }
    return json(route, { metas: [], items: [], results: [] });
  });
}

const video = (page) => page.evaluate(() => {
  const v = document.querySelector('#video');
  return { src: v.getAttribute('src') || '', t: v.currentTime, d: v.duration, ready: v.readyState };
});
const saved = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]'), STORE);
const playerShown = (page) => page.evaluate(() => !document.querySelector('#player').hidden);
async function closePlayerUi(page) {
  await page.locator('#player-close').click();
  await page.locator('#player').waitFor({ state: 'hidden', timeout: 10000 });
}
async function openWatchedCard(page) {
  await page.evaluate(() => showRoute('library'));
  const card = page.locator('#library-results [data-list="watched"] .card').first();
  await card.waitFor({ timeout: 30000 });
  await card.click();
}
async function waitMetadata(page) {
  await page.waitForFunction(() => {
    const v = document.querySelector('#video');
    return !document.querySelector('#player').hidden && v.readyState >= 1 && v.duration > 0;
  }, null, { timeout: 30000 });
}

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
  page.on('console', (msg) => { if (/\[replay\]/.test(msg.text())) seen.logs.push(msg.text()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/index.html`);
  await selectProfile(page);

  /* ===================================================================== 1 */
  log('play the film from its sheet');
  const card = page.getByRole('button', { name: `View ${R.name}`, exact: true }).first();
  await card.waitFor({ timeout: 30000 });
  await card.click();
  await page.locator('#detail-play:not([disabled])').waitFor({ timeout: 30000 });
  await page.locator('#detail-play').click();
  await waitMetadata(page);
  const playing = (await video(page)).src;
  assert.ok(streams.some((s) => s.url === playing), 'the sheet played a row from the search');
  await page.evaluate(() => { const v = document.querySelector('#video'); v.currentTime = v.duration * 0.5; });
  await page.waitForTimeout(1200);
  assert.deepEqual(await saved(page), [], 'nothing is kept at 50%');
  await page.evaluate(() => { const v = document.querySelector('#video'); v.currentTime = v.duration * 0.96; });
  await page.waitForFunction((key) => !!localStorage.getItem(key), STORE, { timeout: 15000 });
  let list = await saved(page);
  assert.equal(list.length, 1, 'one entry');
  assert.equal(list[0].videoId, R.id, 'videoId is the film');
  assert.equal(list[0].url, playing, 'url is the link that was playing');
  assert.equal(list[0].label, '1080p', 'label is its quality');
  assert.equal(typeof list[0].format, 'string', 'format is kept');
  assert.equal(list[0].cap, 'adult', "the profile's cap at save time is kept beside it");
  assert.equal(await page.evaluate(() => localStorage.getItem('blazing-replay-links-v1:p2')), null, 'only under this profile');
  ok(1, 'past 95% the finishing link is kept with the cap; not at 50%');
  await closePlayerUi(page);

  /* ===================================================================== 2 */
  log('Library -> Watched -> the film');
  let streamedBefore = seen.streamed;
  let probesBefore = seen.probes.length;
  await openWatchedCard(page);
  await waitMetadata(page);
  let v = await video(page);
  assert.equal(v.src, playing, 'the saved link is what plays');
  assert.ok(seen.probes.slice(probesBefore).includes(playing), 'after a one-byte probe of it');
  assert.equal(seen.streamed, streamedBefore, 'with no search');
  assert.ok(v.t < 5, `from 0:00 (at ${v.t.toFixed(1)}s)`);
  await page.waitForTimeout(2000);
  assert.equal(await page.evaluate(() => document.querySelector('#resume-btn').hidden), true,
    'and no Resume offer over a replay, though a position is stored');
  assert.equal(await page.evaluate(() => document.querySelector('#detail-dialog').open), false, 'the sheet is not left open');
  ok(2, 'a Watched film replays its saved link from 0:00 with no search');
  await closePlayerUi(page);

  /* ===================================================================== 3 */
  log('a saved link that no longer answers');
  await page.evaluate(([key, url]) => {
    const list = JSON.parse(localStorage.getItem(key));
    list[0].url = url;
    localStorage.setItem(key, JSON.stringify(list));
  }, [STORE, EXPIRED]);
  streamedBefore = seen.streamed;
  probesBefore = seen.probes.length;
  await openWatchedCard(page);
  await waitMetadata(page);
  v = await video(page);
  assert.ok(seen.probes.slice(probesBefore).includes(EXPIRED), 'the saved link was probed');
  assert.equal(seen.streamed, streamedBefore + 1, 'it did not answer, so the normal search ran');
  assert.ok(streams.some((s) => s.url === v.src), 'and its best copy plays');
  assert.ok(v.t < 5, `from 0:00 (at ${v.t.toFixed(1)}s)`);
  assert.ok(seen.logs.some((l) => /did not answer/.test(l)));
  ok(3, 'a dead saved link falls back to the normal search');
  await closePlayerUi(page);

  /* ===================================================================== 4 */
  log('a saved link that answers the probe and then fails in the player');
  await page.evaluate(([key, url]) => {
    const list = JSON.parse(localStorage.getItem(key));
    list[0].url = url;
    localStorage.setItem(key, JSON.stringify(list));
  }, [STORE, BROKEN]);
  streamedBefore = seen.streamed;
  await openWatchedCard(page);
  await page.waitForFunction((urls) => {
    const v = document.querySelector('#video');
    return !document.querySelector('#player').hidden && urls.includes(v.getAttribute('src')) && v.readyState >= 1;
  }, streams.map((s) => s.url), { timeout: 60000 });
  assert.equal(seen.streamed, streamedBefore + 1, 'the player failure fell back to the normal search');
  ok(4, 'a saved link that fails in the player falls back to the normal search');
  await closePlayerUi(page);

  /* ===================================================================== 5 */
  log('a link saved under another cap');
  await page.evaluate(([key, url]) => {
    const list = JSON.parse(localStorage.getItem(key));
    list[0].url = url;
    list[0].cap = 'teen';
    localStorage.setItem(key, JSON.stringify(list));
  }, [STORE, streams[0].url]);
  probesBefore = seen.probes.length;
  await openWatchedCard(page);
  await page.locator('#detail-dialog[open]').waitFor({ timeout: 20000 });
  await page.waitForTimeout(3000);
  assert.equal(await playerShown(page), false, 'never replayed: the ordinary sheet opens instead');
  assert.equal(seen.probes.length, probesBefore, 'the saved link is not even probed');
  assert.ok(seen.logs.some((l) => /saved under cap teen, not adult/.test(l)), 'and the log says why');
  await page.evaluate(() => closeDetail());
  ok(5, 'a link saved under another cap is never replayed');

  /* ===================================================================== 6 */
  log('the store rules');
  const rules = await page.evaluate(() => {
    for (let i = 0; i < 35; i += 1) {
      saveReplayLink('p1', { videoId: `tt80000${String(i).padStart(2, '0')}`, url: `https://cdn.example.test/${i}.mp4`, label: '1080p', format: '', cap: 'adult' });
    }
    const after35 = readReplayLinks('p1');
    saveReplayLink('p1', { videoId: 'tt8000020', url: 'https://cdn.example.test/again.mp4', label: '720p', format: '', cap: 'adult' });
    const again = readReplayLinks('p1');
    const before = replayWatch;
    armReplayWatch(playSession, { id: 'tt0903747', type: 'series' }, 'https://cdn.example.test/ep.mp4', '');
    const series = replayWatch;
    armReplayWatch(playSession, { id: 'emby:1', type: 'movie', embyId: '1' }, 'https://cdn.example.test/e.mp4', '');
    const emby = replayWatch;
    replayWatch = before;
    return {
      n: after35.length, first: after35[0].videoId, last: after35[29].videoId,
      againN: again.length, againFirst: again[0].videoId, againUrl: again[0].url,
      againCount: again.filter((e) => e.videoId === 'tt8000020').length,
      other: readReplayLinks('p2').length, series, emby,
    };
  });
  assert.equal(rules.n, 30, '30 at most');
  assert.equal(rules.first, 'tt8000034', 'newest first');
  assert.equal(rules.last, 'tt8000005', 'the oldest fall off the end');
  assert.equal(rules.againN, 30);
  assert.equal(rules.againFirst, 'tt8000020', 'a re-save moves the film to the front');
  assert.equal(rules.againUrl, 'https://cdn.example.test/again.mp4', 'with its new link');
  assert.equal(rules.againCount, 1, 'one entry per film');
  assert.equal(rules.other, 0, 'per profile');
  assert.equal(rules.series, null, 'a series is never watched for a replay');
  assert.equal(rules.emby, null, 'nor an Emby title');
  ok(6, 'store: 30 max, newest first, one per film, per profile; films only');

  assert.deepEqual(seen.faults, [], 'no page errors');
  console.log(`\nreplay: ${pass} passed, 0 failed`);
} finally {
  if (browser) await browser.close();
  server.close();
  clearTimeout(killer);
}
