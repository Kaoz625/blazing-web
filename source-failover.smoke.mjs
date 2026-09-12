// B10. The browser walks the ranked list when links turn out to be dead.
//
// WHAT THIS PROVES, and why it is worth a whole harness. Until this landed the
// web client tried ONE row, asked /proxy/resolve about that same row, and then
// put an error on the screen — while the ranked list of several hundred other
// sources it had just built was thrown away at the point of the pick. The Roku
// (MainScene.brs onTryNextStream) and the Fire TV (PlayerActivity tryNextCandidate)
// have walked that list for months, so a dead debrid link is invisible on both
// televisions and was the end of the film in a browser.
//
// Nothing here decodes video. It does not need to: every assertion is about
// WHICH url the element was pointed at next, what the viewer was told, and
// where they landed when the list ran out — which is the entire defect. Dead
// sources are served as 404s, which fire a real `error` event on the element,
// so the failure path under test is the genuine one and not a stub.
import assert from 'node:assert/strict';
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
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const titles = [{ id: 'tt900', type: 'movie', name: 'Failover Movie', contentRating: 'general' }];
// Three ordinary H264/AAC rows so the capability ranker keeps all three and the
// order under test is the order the list was built in.
const STREAMS = [1, 2, 3].map((n) => ({
  name: '1080p',
  title: `Failover.Movie.1080p.H264.AAC.source${n}.mp4`,
  url: `https://cdn.example.test/dead-${n}.mp4`,
}));
const reply = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// Every toast the app raised, in order. The toast host is re-parented into
// whichever dialog is open, so this watches the whole document rather than one
// container.
// An init script runs at document-start, where `document.documentElement` does
// not exist yet and `observe()` on it throws — taking the rest of this function
// with it and leaving two empty arrays that look like a real result. Hence the
// DOMContentLoaded wrapper.
const RECORD_TOASTS = () => {
  window.__toasts = [];
  window.__srcs = [];
  const start = () => {
    // BY NODE IDENTITY, because ensureToastHost() RE-PARENTS the whole toast
    // host into whichever dialog is open — so an unexpired toast is added to
    // the document a second time and a naive recorder reports it twice.
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
    // Which url the element was pointed at, each time it changed. setInterval
    // rather than requestAnimationFrame: rAF does not run while the tab is
    // considered hidden, and a missed src is a missed assertion.
    setInterval(() => {
      const video = document.querySelector('#video');
      const src = video && video.getAttribute('src');
      if (src && window.__srcs[window.__srcs.length - 1] !== src) window.__srcs.push(src);
    }, 25);
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
  // Play is disabled until the meta settles.
  await page.waitForFunction(() => !document.querySelector('#detail-play').disabled,
    null, { timeout: 20000 });
}

async function fixture() {
  const ctx = await browser.newContext();
  await ctx.addInitScript(RECORD_TOASTS);
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/manifest.json') {
        return reply(route, { catalogs: [{ id: 'fixture', type: 'movie', name: 'Test titles' }] });
      }
      if (url.pathname === '/catalog/movie/fixture.json') return reply(route, { metas: titles });
      if (url.pathname.startsWith('/meta/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop().replace('.json', ''));
        return reply(route, { meta: titles.find((t) => t.id === id) });
      }
      if (url.pathname.startsWith('/stream/')) return reply(route, { streams: STREAMS });
      // The one-shot proxy retry must have nothing, so the failure falls
      // through to the next SOURCE instead of stopping at the same one.
      if (url.pathname === '/proxy/resolve') return reply(route, { error: 'not found' }, 404);
      return reply(route, {}, 404);
    }
    // Every source is dead. A 404 to a <video src> fires a real `error` event.
    if (url.hostname === 'cdn.example.test') {
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await prepareProfile(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await selectProfile(page);
  return { ctx, page };
}

// --- scenario 1: Play walks every source, then lands on the source list -----
{
  const { ctx, page } = await fixture();
  await openTitle(page);
  await page.click('#detail-play');

  // The walk ends by putting the detail sheet — the source list — back up.
  await page.waitForFunction(
    () => document.querySelector('#player').hidden
      && document.querySelector('#detail-dialog')?.hasAttribute('open'),
    null, { timeout: 45000 },
  );

  const srcs = await page.evaluate(() => window.__srcs);
  check('every one of the three ranked sources was attempted, in order',
    srcs.length === 3
      && srcs[0].endsWith('dead-1.mp4')
      && srcs[1].endsWith('dead-2.mp4')
      && srcs[2].endsWith('dead-3.mp4'),
    JSON.stringify(srcs));

  const toasts = await page.evaluate(() => window.__toasts);
  const progress = toasts.filter((t) => /trying \d+ of \d+/.test(t));
  check('the viewer is told each time, counted from 1 and with the total',
    progress.length === 2
      && progress[0].includes('trying 2 of 3')
      && progress[1].includes('trying 3 of 3'),
    JSON.stringify(progress));
  check('the reason leads the sentence, the way the Roku words it',
    progress.length > 0 && progress.every((t) => t.startsWith('That link was dead -')),
    JSON.stringify(progress));
  check('running out lands on the source list, never on Home',
    toasts.some((t) => t === 'Tried 3 sources and none of them started. Pick one from the list.'),
    JSON.stringify(toasts));

  // Every failure is remembered, so the SECOND attempt at this title starts
  // below the rows that already failed rather than repeating them.
  const dead = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('dead_links') || '{}')));
  check('all three dead links are recorded in the Roku-shaped store',
    dead.length === 3, JSON.stringify(dead));

  await page.waitForSelector('#detail-streams .stream-row', { timeout: 20000 });
  const deadRows = await page.locator('#detail-streams .stream-row.dead').count();
  check('the list that comes back draws all three as dead', deadRows === 3, String(deadRows));

  await ctx.close();
}

// --- scenario 2: a row picked by hand falls through too ---------------------
//
// Roku's startPlayback() searches the ranked list for the row the viewer chose
// so that a manual pick is not a dead end either. This is that rule.
{
  const { ctx, page } = await fixture();
  await openTitle(page);
  await page.waitForSelector('#detail-streams .stream-row', { timeout: 20000 });
  // The SECOND row, so there is exactly one source left below it.
  await page.locator('#detail-streams .stream-row').nth(1).click();

  await page.waitForFunction(() => window.__srcs.length >= 2, null, { timeout: 45000 });
  const srcs = await page.evaluate(() => window.__srcs);
  check('a hand-picked row falls through to the one below it, not to an error',
    srcs[0].endsWith('dead-2.mp4') && srcs[1].endsWith('dead-3.mp4'), JSON.stringify(srcs));

  const progress = (await page.evaluate(() => window.__toasts)).filter((t) => /trying \d+ of \d+/.test(t));
  check('the count is the row’s place in the whole list, not a restart at 1',
    progress.length === 1 && progress[0].includes('trying 3 of 3'), JSON.stringify(progress));
  await ctx.close();
}

const real = errors.filter((e) => !/Failed to fetch|NetworkError|CORS|load resource/i.test(e));
check('no page errors', real.length === 0, real.join(' | '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
