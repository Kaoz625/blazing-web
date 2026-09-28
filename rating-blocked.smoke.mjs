// A title the add-on's parental gate refuses says so, stops, and is reported
// ONCE, by name.
//
// THE INCIDENT, 28 Sep 2026. A teen profile ("Tiny") pressed Play on Blink
// Twice (tt14858658, rated R). The add-on log said exactly what happened:
//
//   [gate] refused tt14858658 tier=mature cap=teen
//   [gate] /dl refused tt14858658 tier=mature cap=teen
//
// and her browser said none of it. A <video> turns the gate's 403 into
// MediaError code 4, so she saw "This stream cannot play in this browser", the
// failover walked every other source of the same title into the same refusal,
// and the fleet received ~24 rows of
//
//   play_failed {"id": "", "code": "4", "source": "web", "message": "html5 media error"}
//
// — an EMPTY id, because the error listener read state.selected after
// closeDetail() had nulled it. Nobody could have joined the two logs.
//
// WHAT THIS PROVES, one scenario per half of the fix:
//   1. Play on a refused title: the rating sentence is on screen, the walk
//      stopped at the first row, the row was not marked dead, the url was
//      probed once for one byte, and exactly ONE play_failed went out, with the
//      id, the title, code 'rating_blocked', status 403 and no url in it.
//   2. The same list answering 404 instead: NO rating sentence, the walk still
//      runs every row (the stop is for the gate only), and every attempt sends
//      one play_failed carrying the id and status 404.
//   3. A row picked BY HAND on a refused title — the other openPlayer() call
//      site — behaves exactly like scenario 1.
//
// Every refusal is a real HTTP answer to the real <video> element, fulfilled by
// the route below, so the error path under test is the genuine one.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './comet.mjs';
import { prepareProfile, selectProfile } from './scripts/profile-fixture.mjs';

const root = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    res.end(await readFile(join(root, path === '/' ? 'index.html' : path)));
  } catch { res.writeHead(404).end(); }
});
// Port 0: never a fixed port, so a second suite running cannot collide with it.
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const TITLE = { id: 'tt14858658', type: 'movie', name: 'Blink Twice' };
// No contentRating, on purpose: that is the incident's shape. The client did
// not know Blink Twice was R, so it let Play through, and only the server's own
// certificate lookup knew better.
const titles = [TITLE];
// Three of OUR playback urls, the kind the add-on mints for a capped profile.
const STREAMS = [1, 2, 3].map((n) => ({
  name: '1080p',
  title: `Blink.Twice.2024.1080p.H264.AAC.source${n}.mp4`,
  url: `https://addon.lyreosai.com/play/cap-${n}`,
  _from: `host${n}`,
}));
const REFUSAL = { error: 'This title is above the current profile\'s rating limit' };
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
};
const reply = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });

// Toasts, and every src the element was given. The same recorder as
// source-failover.smoke.mjs — read that file for why it is a MutationObserver
// reading oldValue and not a timer.
const RECORD = () => {
  window.__toasts = [];
  window.__srcs = [];
  window.__playerOpened = false;
  const start = () => {
    const counted = new WeakSet();
    const take = (node) => {
      if (counted.has(node)) return;
      counted.add(node);
      window.__toasts.push(node.textContent);
    };
    const seen = (node) => {
      if (!(node instanceof HTMLElement)) return;
      if (node.classList.contains('toast')) take(node);
      node.querySelectorAll('.toast').forEach(take);
    };
    new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach(seen);
    }).observe(document.documentElement, { childList: true, subtree: true });
    const video = document.querySelector('#video');
    if (video) {
      const takeSrc = (src) => {
        if (src && window.__srcs[window.__srcs.length - 1] !== src) window.__srcs.push(src);
      };
      takeSrc(video.getAttribute('src'));
      new MutationObserver((records) => {
        for (const record of records) takeSrc(record.oldValue);
        takeSrc(video.getAttribute('src'));
      }).observe(video, { attributes: true, attributeFilter: ['src'], attributeOldValue: true });
    }
    const playerSection = document.querySelector('#player');
    if (playerSection) {
      new MutationObserver((records) => {
        for (const record of records) if (record.oldValue !== null) window.__playerOpened = true;
      }).observe(playerSection, { attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
};

const browser = await launchBrowser();
const errors = [];

async function openTitle(page) {
  await page.waitForSelector('.card', { timeout: 20000 });
  await page.locator('.card').first().click();
  await page.waitForSelector('#detail-dialog[open]', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('#detail-play').disabled,
    null, { timeout: 20000 });
}

/** `playStatus` is what every /play/<capability> answers: 403 (the gate) or 404. */
async function fixture(playStatus) {
  const seen = { events: [], probes: [], media: 0, streamQueries: [] };
  const ctx = await browser.newContext();
  await ctx.addInitScript(RECORD);
  await ctx.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === base) return route.continue();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
    // The telemetry sender's POST. Read from the request, so this sees the
    // body whatever the browser then does with the answer.
    if (url.hostname === 'fleet.lyreosai.com' && url.pathname === '/events') {
      try { seen.events.push(...(JSON.parse(request.postData() || '{}').events || [])); } catch { /* counted as missing */ }
      return reply(route, { ok: true }, 202);
    }
    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/manifest.json') {
        return reply(route, { catalogs: [{ id: 'fixture', type: 'movie', name: 'Test titles' }] });
      }
      if (url.pathname === '/catalog/movie/fixture.json') return reply(route, { metas: titles });
      if (url.pathname.startsWith('/meta/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop().replace('.json', ''));
        return reply(route, { meta: titles.find((t) => t.id === id) });
      }
      if (url.pathname.startsWith('/stream/')) {
        seen.streamQueries.push(url.search);
        return reply(route, { streams: STREAMS });
      }
      if (url.pathname === '/proxy/resolve') return reply(route, { error: 'Could not resolve embed' }, 404);
      if (url.pathname.startsWith('/play/')) {
        if (request.resourceType() === 'fetch') {
          seen.probes.push({ path: url.pathname, range: request.headers().range || '' });
        } else {
          seen.media += 1;
        }
        return playStatus === 403
          ? reply(route, REFUSAL, 403)
          : reply(route, { error: 'Playback link expired or invalid' }, 404);
      }
      return reply(route, {}, 404);
    }
    return route.fulfill({ status: 404, body: '' });
  });
  // maxRating 'teen' — Tiny's profile. The cap rides on /stream as cap=teen.
  await prepareProfile(ctx, { maxRating: 'teen' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await selectProfile(page);
  return { ctx, page, seen };
}

/** Flush the telemetry buffer and return every play_failed the fleet received. */
async function playFailed(page, seen, { atLeast = 1, settleMs = 1500 } = {}) {
  const deadline = Date.now() + 15000;
  const got = () => seen.events.filter((e) => e.name === 'play_failed');
  while (Date.now() < deadline && got().length < atLeast) {
    await page.evaluate(() => window.BlazingTelemetry && window.BlazingTelemetry.flush());
    await page.waitForTimeout(250);
  }
  // Then give a duplicate every chance to arrive before counting.
  await page.waitForTimeout(settleMs);
  await page.evaluate(() => window.BlazingTelemetry && window.BlazingTelemetry.flush());
  await page.waitForTimeout(500);
  return got();
}

const RATING_TEXT = /above this profile.s rating limit/i;

/**
 * A wait that FAILS a check instead of killing the run. A TimeoutError thrown
 * out of top-level await ends the process before a single line is printed, so
 * a red run said "Timeout 45000ms exceeded" and nothing about which of the
 * checks after it — the empty id, the missing status — were also broken.
 */
async function waited(name, promise) {
  try { await promise; check(name, true); return true; }
  catch (error) { check(name, false, String(error && error.message || error).split('\n')[0]); return false; }
}

/** The rating sentence is up in #player-msg. */
const ratingShown = (page) => page.waitForFunction(
  (re) => {
    const msg = document.querySelector('#player-msg');
    return msg && !msg.hidden && new RegExp(re, 'i').test(msg.textContent || '');
  },
  RATING_TEXT.source, { timeout: 45000 },
);

const noUrlKey = (props) => Object.keys(props || {}).every((k) => !/url/i.test(k));
const noUrlValue = (props) => Object.values(props || {}).every((v) => !/https?:|\/play\/|\/dl\//i.test(String(v)));

// --- scenario 1: Play on a refused title --------------------------------------
{
  const { ctx, page, seen } = await fixture(403);
  await openTitle(page);
  await page.click('#detail-play');
  await waited('the rating sentence appeared in the player', ratingShown(page));
  const msg = await page.locator('#player-msg').textContent();
  check('the player says the title is above the rating limit, in plain words',
    RATING_TEXT.test(msg) && /account owner/i.test(msg), JSON.stringify(msg));
  check('the source list asked for cap=teen (the incident shape)',
    seen.streamQueries.some((q) => /(?:^|[?&])cap=teen(?:&|$)/.test(q)), JSON.stringify(seen.streamQueries));

  // Give a walk every chance to show itself before counting what was tried.
  await page.waitForTimeout(2000);
  const srcs = await page.evaluate(() => window.__srcs);
  check('the walk STOPPED at the first row — no other source of a refused title was tried',
    srcs.length === 1 && srcs[0].endsWith('/play/cap-1'), JSON.stringify(srcs));
  const toasts = await page.evaluate(() => window.__toasts);
  check('no "trying 2 of 3" toast for a title that can never start',
    !toasts.some((t) => /trying \d+ of \d+/.test(t)), JSON.stringify(toasts));
  const dead = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('dead_links') || '{}')));
  check('the refused row is NOT marked dead (it is a good source)', dead.length === 0, JSON.stringify(dead));
  check('the failing url was probed exactly once, for one byte',
    seen.probes.length === 1 && seen.probes[0].path === '/play/cap-1' && seen.probes[0].range === 'bytes=0-0',
    JSON.stringify(seen.probes));

  const failed = await playFailed(page, seen);
  const p = failed[0] ? failed[0].props : {};
  check('exactly ONE play_failed for the refused title', failed.length === 1, JSON.stringify(failed.map((e) => e.props)));
  check('play_failed names the title: id and title are not empty',
    p.id === TITLE.id && p.title === TITLE.name, JSON.stringify(p));
  check("play_failed says why: code 'rating_blocked', status 403",
    p.code === 'rating_blocked' && p.status === 403, JSON.stringify(p));
  check('play_failed carries the type and the host it came from', p.type === 'movie' && p.source === 'host1', JSON.stringify(p));
  check('play_failed has no key containing "url"', noUrlKey(p), JSON.stringify(Object.keys(p)));
  check('play_failed has no url in any value either', noUrlValue(p), JSON.stringify(p));
  await ctx.close();
}

// --- scenario 2: the same list answering 404 ------------------------------------
{
  const { ctx, page, seen } = await fixture(404);
  await openTitle(page);
  await page.click('#detail-play');
  // The walk ends on the source list, as source-failover.smoke.mjs proves.
  await waited('the walk ran out and landed on the source list', page.waitForFunction(
    () => window.__playerOpened
      && document.querySelector('#player').hidden
      && document.querySelector('#detail-dialog')?.hasAttribute('open'),
    null, { timeout: 60000 },
  ));
  const srcs = await page.evaluate(() => window.__srcs);
  check('a 404 is not the gate: the walk still tries every row',
    srcs.length === 3 && srcs[2].endsWith('/play/cap-3'), JSON.stringify(srcs));
  const text = await page.evaluate(() => document.body.innerText);
  check('no rating sentence anywhere for a 404', !RATING_TEXT.test(text) && !/rating limit/i.test(text));

  const failed = await playFailed(page, seen, { atLeast: 3 });
  const props = failed.map((e) => e.props);
  check('one play_failed per failed attempt — three rows, three events', failed.length === 3, JSON.stringify(props));
  check('every play_failed carries the title id', props.length > 0 && props.every((q) => q.id === TITLE.id), JSON.stringify(props));
  check('every play_failed carries status 404 and the original media code',
    props.length > 0 && props.every((q) => q.status === 404 && q.code !== 'rating_blocked' && q.code !== ''),
    JSON.stringify(props));
  check('each event names the host that failed, in walk order',
    props.map((q) => q.source).join(',') === 'host1,host2,host3', JSON.stringify(props.map((q) => q.source)));
  check('no key containing "url" in any of them', props.every(noUrlKey));
  await ctx.close();
}

// --- scenario 3: a row picked by hand on a refused title ------------------------
{
  const { ctx, page, seen } = await fixture(403);
  await openTitle(page);
  await page.waitForSelector('#detail-streams .stream-row', { timeout: 20000 });
  await page.locator('#detail-streams .stream-row').nth(1).click();
  await waited('the rating sentence appeared for the hand-picked row', ratingShown(page));
  await page.waitForTimeout(2000);
  const srcs = await page.evaluate(() => window.__srcs);
  check('a hand-picked refused row stops too — the row below it is never tried',
    srcs.length === 1 && srcs[0].endsWith('/play/cap-2'), JSON.stringify(srcs));
  const failed = await playFailed(page, seen);
  const p = failed[0] ? failed[0].props : {};
  check('one play_failed from the source-row path, with the id (closeDetail ran after openPlayer)',
    failed.length === 1 && p.id === TITLE.id && p.code === 'rating_blocked' && p.status === 403 && p.source === 'host2',
    JSON.stringify(failed.map((e) => e.props)));
  await ctx.close();
}

const real = errors.filter((e) => !/Failed to fetch|NetworkError|CORS|load resource/i.test(e));
check('no page errors', real.length === 0, real.join(' | '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
