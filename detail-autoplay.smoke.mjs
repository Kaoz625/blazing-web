// THE DETAIL SHEET NEVER STARTS THE FILM, AND THE SOURCE LIST IS ONE PAGE.
//
// Markus, 7 Sep 2026, verbatim: "i think we should just keep the source list
// onto one page that way your seeing more than 5 sources at the detail page and
// lets also kill the auto play of movies and shows when you first click the
// detail page. maybe im watching the trailer and still havent decided to watch
// the movie yet or not but then the movie starts playing i dont like that."
//
// ------------------------------------------------------ WHAT WAS ACTUALLY WRONG
// Both defects were measured before anything was edited, on a fixture serving
// this repo with a title answering 336 streams (the live count for tt34564059):
//
// Named by selector, not by line number, because every line number in this repo
// has drifted at least once and a stale one sends the next reader to the wrong
// function.
//
//   app.js, the #home-hero-play click handler
//                      `openDetail(homeHeroMeta); playSelected();`
//                      The ONE path in the app where the sheet appeared and the
//                      feature began by itself. It reads as an autoplay and not
//                      as a Play press because of the gap between the two
//                      halves: openDetail() is synchronous, so the sheet and its
//                      trailer are up in a frame, and playSelected() then awaits
//                      resolveStreams() for 0.5-16s before the full-screen
//                      player drops on top of the trailer you were watching.
//
//   styles.css, .detail-streams
//                      `max-height: 250px; overflow-y: auto`
//                      MEASURED, 1440x900, 336 sources: 336 rows in the DOM,
//                      scrollHeight 35,608px, clientHeight 250px, rows visible
//                      at once 2. The list was NEVER paginated and there was
//                      never a "show more" — every row was always in the DOM,
//                      shown through a 250px porthole. And that porthole was the
//                      only scrollable box in the whole sheet, because
//                      .detail-dialog and .detail-card are both
//                      `overflow: hidden`.
//
// So the "5 sources" was a CSS window, not a pager, and the autoplay was one
// call on one line. Naming both correctly is why this suite asserts GEOMETRY
// (how many rows a viewer can see) and not just DOM counts (how many exist) —
// the broken code would have passed a DOM count with full marks.
//
// ------------------------------------------------------------- WHAT IS ASSERTED
//   1. a card click opens the sheet, renders sources, and NEVER opens the player
//   2. the trailer is still asked for and still built — the half he likes
//   3. all 336 sources are in ONE scroll container: no pager, no "show more",
//      the last row reachable by scrolling, and well over 5 visible at once
//   4. a source row still starts the film
//   5. #detail-play still starts the film (the fix must not disarm Play)
//   6. the home hero's Play button opens the sheet and NEVER starts the film
//
// Everything is mocked at the network boundary, so this is about THIS CLIENT
// and cannot go red because a scraper had a quiet night.
//
//   node detail-autoplay.smoke.mjs
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
  } catch { res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// The real id and the real count. 336 is what tt34564059 answered live on
// 7 Sep 2026, and the row count is the whole point of part 6 — a fixture with
// twelve sources would pass a porthole 250px tall and prove nothing.
const ID = 'tt34564059';
const STREAM_COUNT = 336;
// The trailer id the live /meta route really carries for it, in the shape
// youtubeTrailerId() reads (`trailers[0].source`).
const TRAILER_YT = 'zz4rsZLcauY';

const title = {
  id: ID, type: 'movie', name: 'The Runner', releaseInfo: '2026',
  contentRating: 'general',
  description: 'A courier with one night to cross a city that wants him gone.',
  poster: 'https://img.example.test/runner-poster.jpg',
  background: 'https://img.example.test/runner-backdrop.jpg',
  trailers: [{ source: TRAILER_YT, type: 'Trailer' }],
};

// Plain h264/AAC at or below 1080p so caps.js keeps every row: this suite is
// about the LIST and the PLAYER, and a capability filter eating the fixture
// would quietly turn part 6 into an assertion about 40 rows.
const RES = ['1080p', '720p', '480p'];
const GROUPS = ['FLUX', 'RARBG', 'YTS', 'GALAXY'];
const streams = Array.from({ length: STREAM_COUNT }, (_, i) => ({
  name: RES[i % RES.length],
  title: `The.Runner.2026.${RES[i % RES.length]}.WEB-DL.H264.AAC-${GROUPS[i % GROUPS.length]}.R${String(i).padStart(3, '0')}.mp4\n1.4 GB 👤 ${100 + i}`,
  url: `https://cdn.example.test/runner-${i}.mp4`,
}));

const manifest = { catalogs: [{ id: 'fixture', type: 'movie', name: 'Test titles' }] };
const reply = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function wire(ctx, seen) {
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/manifest.json') return reply(route, manifest);
      if (url.pathname === '/catalog/movie/fixture.json') return reply(route, { metas: [title] });
      if (url.pathname.startsWith('/catalog/')) return reply(route, { metas: [] });
      if (url.pathname.startsWith('/meta/')) return reply(route, { meta: title });
      if (url.pathname === '/proxy/yt-resolve') {
        seen.trailerAsked.push(url.searchParams.get('id') || '');
        // A URL, so startDetailTrailer() builds its <video> and calls play().
        // It cannot decode — every request in this suite is intercepted — and
        // that is fine: what is being proven is that the TRAILER path runs and
        // the FEATURE path does not.
        return reply(route, { url: 'https://cdn.example.test/runner-trailer.m3u8' });
      }
      if (url.pathname.startsWith('/stream/')) {
        seen.streamed.push(decodeURIComponent(url.pathname.split('/').pop().replace('.json', '')));
        return reply(route, { streams });
      }
      return reply(route, { metas: [], streams: [] });
    }
    return reply(route, { metas: [], items: [], results: [] });
  });
}

/** Everything about the player, read straight off the live DOM. */
const playerState = (page) => page.evaluate(() => ({
  hidden: document.querySelector('#player').hidden,
  paused: document.querySelector('#video').paused,
  src: document.querySelector('#video').currentSrc || document.querySelector('#video').getAttribute('src') || '',
  noScroll: document.body.classList.contains('no-scroll'),
}));

/**
 * How the sources actually sit on screen, not how many exist.
 *
 * `visibleAtTop` is the count with the sheet unscrolled — the heading, synopsis
 * and action row are still on screen there, so the list gets what is left.
 * `visibleInList` is the count once the list has been scrolled to, which is the
 * state a viewer choosing a source is in, and it is the number that answers
 * "more than 5". Both are reported because quoting only the flattering one is
 * how a measurement turns into a claim.
 */
const listGeometry = (page) => page.evaluate(async () => {
  const box = document.querySelector('#detail-streams');
  const body = document.querySelector('#detail-dialog .detail-body');
  const rows = [...box.querySelectorAll('.stream-row')];
  const count = () => {
    const clip = body.getBoundingClientRect();
    return rows.filter((r) => {
      const t = r.getBoundingClientRect();
      return t.top < clip.bottom && t.bottom > clip.top;
    }).length;
  };
  body.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 250));
  const visibleAtTop = count();
  // Park the top of the list at the top of the sheet.
  body.scrollTop = box.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
  await new Promise((r) => setTimeout(r, 250));
  const visibleInList = count();
  const boxStyle = getComputedStyle(box);
  const bodyStyle = getComputedStyle(body);
  return {
    rows: rows.length,
    visibleAtTop,
    visibleInList,
    rowHeight: Math.round(box.scrollHeight / Math.max(1, rows.length)),
    boxMaxHeight: boxStyle.maxHeight,
    boxOverflowY: boxStyle.overflowY,
    bodyOverflowY: bodyStyle.overflowY,
    scroller: { client: body.clientHeight, scroll: body.scrollHeight },
    // A pager or a "show more" would be a <button> or a link inside the list.
    controls: [...box.querySelectorAll('button, a')].map((n) => n.textContent.trim()),
  };
});

const card = (page, name) => page.getByRole('button', { name: `View ${name}`, exact: true });

let browser;
try {
  browser = await launchBrowser();

  const seen = { streamed: [], trailerAsked: [] };
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await wire(ctx, seen);
  // THE TRAILER ELEMENT HAS TO BE WATCHED, NOT SAMPLED. startDetailTrailer()
  // builds its <video>, calls play(), and stopDetailTrailer() empties the host
  // on the first `error` — which is guaranteed here, because every request in
  // this suite is intercepted and no fixture serves decodable h264. So a
  // querySelector taken any time later counts 0 and says nothing about whether
  // the trailer ran. A recorder set before the page's own scripts does.
  await ctx.addInitScript(() => {
    window.__trailerBuilt = 0;
    addEventListener('DOMContentLoaded', () => {
      const host = document.querySelector('#detail-trailer');
      if (!host) return;
      new MutationObserver(() => {
        if (host.querySelector('video')) window.__trailerBuilt += 1;
      }).observe(host, { childList: true });
    });
  });
  await prepareProfile(ctx);
  const page = await ctx.newPage();
  const faults = [];
  page.on('pageerror', (error) => faults.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/index.html`);
  await selectProfile(page);

  /* ===================================================================== 1
     A CARD CLICK OPENS THE SHEET AND NOTHING PLAYS ITSELF.
  */
  await card(page, 'The Runner').waitFor({ timeout: 30000 });
  await card(page, 'The Runner').click();
  await page.locator('#detail-streams .stream-row').first().waitFor({ timeout: 40000 });
  assert.ok(seen.streamed.includes(ID), '/stream was asked for the title');

  // The window matters. playSelected() used to fire AFTER resolveStreams(),
  // which is seconds behind the sheet appearing, so an assertion taken the
  // instant the sheet opens would have passed against the broken code. Wait
  // past the whole resolve+rank+trailer sequence before believing it.
  await page.waitForTimeout(6000);
  let p = await playerState(page);
  assert.equal(p.hidden, true, 'opening a title from a card must NOT open the player');
  assert.equal(p.paused, true, 'the feature <video> must not be playing');
  assert.equal(p.src, '', 'the feature <video> must have no source yet');
  assert.equal(p.noScroll, false, 'the page must not be locked behind a player nobody asked for');

  /* ===================================================================== 2
     THE TRAILER IS UNTOUCHED — the half he asked to keep.
  */
  assert.ok(seen.trailerAsked.includes(TRAILER_YT),
    'the detail trailer is still resolved and started; killing the autoplay must not kill the trailer');
  assert.ok(await page.evaluate(() => window.__trailerBuilt) >= 1,
    'the trailer <video> is built and started inside #detail-trailer');

  /* ===================================================================== 3
     ONE PAGE OF SOURCES. No porthole, no pager, everything reachable.
  */
  const geo = await listGeometry(page);
  console.log(`sources: ${geo.rows} rows, ${geo.rowHeight}px each; ` +
    `${geo.visibleAtTop} visible with the sheet unscrolled, ${geo.visibleInList} once the ` +
    `list is scrolled to, at 1440x900. List max-height ${geo.boxMaxHeight} overflow-y ` +
    `${geo.boxOverflowY}; the sheet scrolls ${geo.scroller.client}px of ${geo.scroller.scroll}px.`);
  assert.equal(geo.rows, STREAM_COUNT, `all ${STREAM_COUNT} sources are drawn`);
  assert.deepEqual(geo.controls, [],
    'no pager and no "show more" inside the source list — a button here means the list is chopped again');
  assert.equal(geo.boxMaxHeight, 'none',
    'the source list must not be a fixed-height porthole (this is the 250px that showed about 5 rows)');
  assert.equal(geo.bodyOverflowY, 'auto',
    'the sheet itself is the scroll container, so the sources are one continuous page');
  // "more than 5 sources at the detail page", measured where a viewer reads the
  // list. The 250px porthole showed 2 out of 336 anywhere in the sheet.
  assert.ok(geo.visibleInList > 5,
    `more than 5 sources must be visible at once; saw ${geo.visibleInList}`);
  assert.ok(geo.visibleAtTop > 2,
    `even unscrolled the sheet must beat the old 250px porthole's 2 rows; saw ${geo.visibleAtTop}`);

  // Every row REACHABLE by scrolling alone. The last row is the one a pager
  // used to hide, so it is the one worth naming.
  const reach = await page.evaluate(async () => {
    const body = document.querySelector('#detail-dialog .detail-body');
    body.scrollTop = body.scrollHeight;
    await new Promise((r) => setTimeout(r, 500));
    const rows = [...document.querySelectorAll('#detail-streams .stream-row')];
    const last = rows[rows.length - 1];
    const clip = body.getBoundingClientRect();
    const t = last.getBoundingClientRect();
    return {
      count: rows.length,
      lastVisible: t.top < clip.bottom && t.bottom > clip.top,
      lastText: last.innerText.replace(/\s+/g, ' ').slice(0, 90),
    };
  });
  assert.equal(reach.count, STREAM_COUNT, 'nothing is destroyed by scrolling');
  assert.equal(reach.lastVisible, true,
    `source ${STREAM_COUNT} of ${STREAM_COUNT} must be reachable by scrolling: ${reach.lastText}`);
  console.log(`last source reached by scrolling: ${reach.lastText}`);

  /* ===================================================================== 4
     A SOURCE ROW STILL PLAYS. The fix must not disarm the list.
  */
  await page.evaluate(() => { document.querySelector('#detail-dialog .detail-body').scrollTop = 0; });
  await page.locator('#detail-streams .stream-row').first().click();
  await page.locator('#player').waitFor({ state: 'visible', timeout: 15000 });
  p = await playerState(page);
  assert.equal(p.hidden, false, 'clicking a source row opens the player');
  assert.match(p.src, /cdn\.example\.test\/runner-/, 'and it is pointed at that row');
  await page.locator('#player-close').click();
  await page.locator('#player').waitFor({ state: 'hidden', timeout: 10000 });

  /* ===================================================================== 5
     #detail-play STILL PLAYS. Killing the autoplay must not kill Play.
  */
  await card(page, 'The Runner').click();
  await page.locator('#detail-play:not([disabled])').waitFor({ timeout: 40000 });
  await page.locator('#detail-play').click();
  await page.locator('#player').waitFor({ state: 'visible', timeout: 30000 });
  p = await playerState(page);
  assert.equal(p.hidden, false, 'pressing Play starts the feature');
  assert.match(p.src, /cdn\.example\.test\/runner-/, 'with a real source behind it');
  await page.locator('#player-close').click();
  await page.locator('#player').waitFor({ state: 'hidden', timeout: 10000 });

  /* ===================================================================== 6
     THE HOME HERO'S PLAY BUTTON. This is the line that was the defect.

     From a RELOAD, not from the state parts 4 and 5 left behind. Two reasons:
     it is the cold path Markus actually takes — land on Home, hero band, press
     Play — and `video.currentSrc` does NOT clear when closePlayer() removes the
     src attribute, so "carries no source" can only be asserted on an element
     that has never been handed one.
  */
  await page.reload();
  await selectProfile(page);
  const hero = page.locator('#home-hero-play');
  await hero.waitFor({ state: 'visible', timeout: 30000 });
  await hero.click();
  await page.locator('#detail-dialog[open]').waitFor({ timeout: 20000 });
  // Waited on the DIALOG and not on a source row, so that this part FAILS ON
  // THE PLAYER rather than on a timeout. Under the old code playSelected() ran
  // openPlayer() and then closeDetail(), which empties #detail-streams — so
  // `waitFor('.stream-row')` timed out at 40s and reported "locator timeout"
  // for what is really "the film started on its own". A gate has to name the
  // defect it caught.
  //
  // The window is longer than the whole resolve+rank sequence, because the old
  // play landed seconds behind the sheet: that delay is exactly why this read
  // as an autoplay and not as a Play press.
  await page.waitForTimeout(12000);
  p = await playerState(page);
  assert.equal(p.hidden, true,
    'the home hero Play button must open the title, NOT start the film — app.js, the #home-hero-play handler');
  assert.equal(p.paused, true, 'and the feature <video> stays paused');
  assert.equal(p.src, '', 'and carries no source');
  assert.equal(await page.evaluate(() => document.querySelector('#detail-dialog').open), true,
    'the sheet stays OPEN so a source can be chosen — the old path closed it behind the player');
  assert.ok(await page.locator('#detail-streams .stream-row').count() > 5,
    'and the sources are listed there, ready to pick');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'detail-play',
    'Play is focused instead, so it is one press away');
  console.log('home hero Play: sheet open with sources listed, player closed, focus on #detail-play');

  assert.deepEqual(faults, [], 'no page errors');
  console.log('\ndetail-autoplay: all checks passed');
} finally {
  if (browser) await browser.close();
  server.close();
}
