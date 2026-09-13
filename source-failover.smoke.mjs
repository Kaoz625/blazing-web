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
// with it and leaving every recorder below empty, which looks like a real
// result. Hence the DOMContentLoaded wrapper, which also means #video and
// #player are already in the document by the time the two observers below
// attach to them.
const RECORD_TOASTS = () => {
  window.__toasts = [];
  window.__srcs = [];
  // Set the moment #player is RAISED, and never cleared. Scenario 1's wait
  // explains why the harness cannot ask "is the player down?" on its own.
  window.__playerOpened = false;
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
    // WHICH URL THE ELEMENT WAS POINTED AT, each time it changed — read from
    // the attribute mutation itself, never SAMPLED on a timer.
    //
    // This was a 25ms setInterval, and that is half of why this suite was red
    // on every CI push while passing here. Nothing in the product is slow on
    // this fixture: a source is a 404 fulfilled by Playwright's own route
    // handler (see the cdn.example.test branch below), so the `error` event
    // comes back at memory speed and the next src replaces the last almost at
    // once. MEASURED on this fixture, ms from the click:
    //
    //   Comet, macOS        dead-1 138  dead-2 174  dead-3 200   gaps 36/26ms
    //   chromium, CI branch dead-1 212  dead-2 ~225 dead-3 237   gaps ~13/12ms
    //
    // A 25ms sampler cannot see a value that lives 13ms, and it did not — the
    // CI-branch run recorded dead-1 and dead-3 and dropped dead-2 whole. That
    // is also the TimeoutError scenario 2 died on: it waits for
    // `__srcs.length >= 2` and on that run only ever reached 1. The product
    // attached all three, in order, both times. The recorder was simply slower
    // than the thing it was recording, and how much slower is a property of
    // the host — so the old comment's reason for setInterval over rAF was
    // right and its conclusion was still a sampler.
    //
    // An attribute MutationObserver has no window to miss: `video.src = url`
    // in attachSource() (app.js) reflects straight to the attribute, so every
    // assignment queues its own record. #video is static markup — index.html
    // line 1038, inside the #player section — so it is already there at
    // DOMContentLoaded and can be observed directly rather than through the
    // document, which would also pick up every card poster's `src`.
    //
    // AND IT READS THE RECORDS, not the live element. An observer callback is
    // one call per BATCH, so a callback that only re-read `video.src` would
    // see the newest value and lose any that changed earlier in the same
    // batch — the identical hole the 25ms sampler had, just narrower. With
    // `attributeOldValue` every record carries the value that was there BEFORE
    // it, so the batch's oldValues plus the element's current value reconstruct
    // the whole sequence however the records happen to be grouped.
    const video = document.querySelector('#video');
    if (video) {
      // closePlayer() ends the walk with removeAttribute('src'), and the first
      // record's oldValue is the empty state before any attempt. Neither is an
      // attempt, so an empty value is never an entry.
      const takeSrc = (src) => {
        if (src && window.__srcs[window.__srcs.length - 1] !== src) window.__srcs.push(src);
      };
      takeSrc(video.getAttribute('src'));
      new MutationObserver((records) => {
        for (const record of records) takeSrc(record.oldValue);
        takeSrc(video.getAttribute('src'));
      }).observe(video, { attributes: true, attributeFilter: ['src'], attributeOldValue: true });
    }
    // WAS THE PLAYER EVER RAISED. openPlayer() clears `hidden` on #player
    // before it attaches a source, and closePlayer() puts it back.
    //
    // Read from the attribute's own mutation rather than by polling
    // `player.hidden`, because on the CI branch the whole walk — open, three
    // dead sources, close — measured 212ms to 251ms from the click, and an
    // observer callback that re-read the live element could easily find it
    // already hidden again and record nothing. `oldValue !== null` means the
    // attribute WAS present and this record removed it, which is the open.
    const playerSection = document.querySelector('#player');
    if (playerSection) {
      new MutationObserver((records) => {
        for (const record of records) if (record.oldValue !== null) window.__playerOpened = true;
      }).observe(playerSection, {
        attributes: true, attributeFilter: ['hidden'], attributeOldValue: true,
      });
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
  //
  // `__playerOpened` IS LOAD-BEARING, and it is the other half of why this
  // suite was CI-only red. Without it this predicate is ALSO TRUE THE INSTANT
  // PLAY IS PRESSED: #player starts hidden and #detail-dialog is open, which
  // is precisely the state openTitle() just finished waiting for. So the end
  // state and the start state are the same three facts, and whether this is a
  // real wait or an instant false pass comes down to one question — did
  // openPlayer() run before Playwright could install the predicate? That is
  // decided by the HOST, not by the product. MEASURED on this fixture, ms from
  // the click:
  //
  //   Comet, macOS         #player already up when click() returned at +98,
  //                        so the predicate was false and really resolved at
  //                        +424, when the walk ended.
  //   chromium, CI branch  #player still down when click() returned at +149,
  //                        so the predicate matched the START state and
  //                        resolved at +155 — and the first source was not
  //                        attached until +212.
  //
  // Those 57ms are the whole of the CI failure. All six assertions below read
  // a recorder nothing had written to yet and came back empty, on runs where
  // the product did every single thing they ask for: playSelected()'s chain
  // (fetchFullMeta, then resolveStreams, then BlazingCaps.probe) simply lands
  // a little later there than it does here. The flag can only go up when
  // #player is genuinely raised, so the start state cannot satisfy this any
  // more on any host.
  await page.waitForFunction(
    () => window.__playerOpened
      && document.querySelector('#player').hidden
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
