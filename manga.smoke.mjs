// Headless smoke test for the Manga tab (manga.js).
//
// Everything the fleet would answer is intercepted, so nothing real is
// contacted. What is proved here:
//   1. a Kids profile (and no profile at all) is refused the section —
//      the Mature-section gate that matches Roku's mangaAllowedNow();
//   2. an Adult profile sees Popular/Latest shelves, newest-first;
//   3. clicking a cover opens the chapters dialog and shows meta/description;
//   4. BOTH chapter-list response shapes are read (bare array, and the
//      {list,error,via} object the fleet also ships) — this is the exact
//      regression Manga.brs documents: a client that only understands one
//      shape shows zero chapters for EVERY title, licensed or not;
//   5. an unreadable (licensed/redirected) chapter cannot be opened, and a
//      readable one opens the reader and turns pages with arrow keys;
//   6. switching to a Kids profile mid-read closes the reader immediately.
import { launchBrowser } from './comet.mjs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const errors = [];
let failures = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const POPULAR = [
  { id: 'm1', title: 'One Piece', description: 'Pirates.', year: '1997', status: 'ongoing', originalLanguage: 'ja', lastChapter: '1120', cover: '/manga/image?id=m1', source: 'MangaDex' },
];
const LATEST = [
  { id: 'm2', title: 'Solo Leveling', description: 'A hunter levels up.', year: '2018', status: 'completed', originalLanguage: 'ko', lastChapter: '200', cover: '/manga/image?id=m2', source: 'Comick' },
];
// The object shape (list/error/via) the fleet also ships — see Manga.brs's
// MangaChapterList() and the "R18" comment right above it in this repo.
const CHAPTERS_OBJECT_SHAPE = {
  chapters: {
    list: [
      { id: 'c1', chapter: '1', volume: '1', title: 'Romance Dawn', pages: 20, readable: true },
      { id: 'c2', chapter: '2', volume: '1', title: '', pages: 0, readable: false },
    ],
    error: '',
    via: 'mangadex',
  },
};
const PAGES = { pages: ['/manga/image?ch=c1&p=1', '/manga/image?ch=c1&p=2', 'https://cdn.example.test/absolute-page.jpg'] };

const browser = await launchBrowser();

async function openApp({ profile = { isKids: false, maxRating: 'adult' }, chaptersBody = CHAPTERS_OBJECT_SHAPE, onCall } = {}) {
  const ctx = await browser.newContext();
  const calls = [];
  await ctx.route('https://fleet.lyreosai.com/**', (route) => {
    const url = route.request().url();
    calls.push({ url });
    if (onCall) onCall({ url });

    if (url.includes('/manga/discover')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ popular: POPULAR, latest: LATEST }) });
    }
    if (url.includes('/manga/search')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ manga: POPULAR }) });
    }
    if (url.includes('/chapters')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(chaptersBody) });
    }
    if (url.includes('/pages')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PAGES) });
    }
    if (url.includes('/party/active')) return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  });
  await ctx.route('https://addon.lyreosai.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ catalogs: [], metas: [] }) }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((detail) => {
    document.dispatchEvent(new CustomEvent('blazing-profile-selected', { detail: { id: 'p1', name: 'Mark', ...detail } }));
    document.querySelectorAll('.bp-layer').forEach((n) => n.remove());
  }, profile);
  // "Manga" lives in the drawer-only "More" nav (see games.smoke.mjs for why
  // this dispatches the click directly instead of clicking a hidden button).
  await page.evaluate(() => document.querySelector('[data-view="manga"]').click());
  return { ctx, page, calls };
}

/**
 * Wait for a status line to say its ANSWER, not its placeholder.
 *
 * `#manga-status` is written twice on every load: the code sets a
 * "Loading…"-style placeholder the moment the request goes out, and replaces it
 * when the answer lands. A wait for "textContent is not empty" is therefore
 * already satisfied by the placeholder, so it returns at once and the check
 * that follows reads whatever happens to be on screen — usually the answer,
 * sometimes the placeholder. That is how
 *
 *     FAIL  the server's own reason is shown, not a generic failure — Loading chapters…
 *
 * happened: the app was right and had simply not been given the millisecond it
 * needed. Waiting for a settled line makes the check honest; a status that
 * never leaves its placeholder now times out and fails on its own account.
 */
async function settledStatus(page, id, timeout = 5000) {
  await page.waitForFunction((el) => {
    const t = (document.getElementById(el).textContent || '').trim();
    return t.length > 0 && !/^(Loading|Searching)\b/i.test(t) && !t.endsWith('…');
  }, id, { timeout, polling: 100 });
  return (await page.locator(`#${id}`).textContent()) || '';
}

// --- 1a: no profile chosen reads as the strictest cap, not "no cap" --------
{
  const { ctx, page, calls } = await openApp({ profile: {} });
  await settledStatus(page, 'manga-status');
  const status = (await page.locator('#manga-status').textContent()) || '';
  check('no profile at all is refused the Mature section', status.toLowerCase().includes('mature'), status);
  check('no manga request is made before a profile clears the gate', !calls.some((c) => c.url.includes('/manga/discover')));
  check('no shelves render', (await page.locator('#manga-rows .row').count()) === 0);
  await ctx.close();
}

// --- 1b: Kids, Guest-as-kids and Teen all fail closed ------------------------
for (const profile of [{ isKids: true }, { isKids: false, maxRating: 'teen' }]) {
  const { ctx, page } = await openApp({ profile });
  await settledStatus(page, 'manga-status');
  const status = (await page.locator('#manga-status').textContent()) || '';
  check(`refused for ${JSON.stringify(profile)}`, status.toLowerCase().includes('mature'), status);
  await ctx.close();
}

// --- 2: an Adult profile sees the shelves -----------------------------------
{
  const { ctx, page } = await openApp();
  await page.waitForSelector('#manga-rows .row', { timeout: 10000 });
  check('two shelves render', (await page.locator('#manga-rows .row').count()) === 2);
  const titles = await page.locator('#manga-rows .row-title').allTextContents();
  check('Popular then Latest, in that order', JSON.stringify(titles) === JSON.stringify(['Popular', 'Latest']), JSON.stringify(titles));
  check('one card in Popular', (await page.locator('#manga-rows .row').first().locator('.card').count()) === 1);
  check('cards reuse the app card class', (await page.locator('#manga-rows .card').first().evaluate((n) => n.classList.contains('card'))) === true);
  check('the source pill is shown', (await page.locator('#manga-rows .card-source').first().textContent()) === 'MangaDex');
  const coverSrc = await page.locator('#manga-rows .card-image').first().getAttribute('src');
  check('a relative cover path is absolute-ised onto the fleet base', coverSrc.startsWith('https://fleet.lyreosai.com/manga/image'), coverSrc);

  // --- 3: clicking a cover opens the chapters dialog --------------------------
  await page.click('#manga-rows .card >> nth=0');
  await page.waitForFunction(() => document.getElementById('manga-chapters-title').textContent === 'One Piece', null, { timeout: 5000 });
  check('chapters dialog is open', (await page.locator('#manga-chapters-dialog').evaluate((d) => d.open)) === true);
  const meta = (await page.locator('#manga-chapters-meta').textContent()) || '';
  check('meta line has year, status and last chapter', meta.includes('1997') && meta.includes('Ongoing') && meta.includes('1120'));
  check('description is shown', (await page.locator('#manga-chapters-desc').textContent()) === POPULAR[0].description);

  // --- 4: the OBJECT chapter-list shape is read, with its readable/dead rows --
  await page.waitForSelector('#manga-chapters-list .stream-row', { timeout: 5000 });
  check('two chapter rows from the {list,error,via} shape', (await page.locator('#manga-chapters-list .stream-row').count()) === 2);
  check('one readable chapter of two, said in words', ((await page.locator('#manga-chapters-status').textContent()) || '').includes('1 readable chapter of 2'));
  check('the unreadable chapter is marked dead', (await page.locator('#manga-chapters-list .stream-row').nth(1).evaluate((n) => n.classList.contains('dead'))) === true);
  check('the unreadable chapter explains why in words', ((await page.locator('#manga-chapters-list .stream-row').nth(1).locator('.stream-tags').textContent()) || '').toLowerCase().includes('licensed'));

  // Clicking the dead row must not open the reader.
  await page.click('#manga-chapters-list .stream-row >> nth=1');
  await page.waitForTimeout(200);
  check('clicking an unreadable chapter opens nothing', (await page.locator('#manga-reader').isHidden()) === true);

  // --- 5: a readable chapter opens the reader and pages turn ------------------
  await page.click('#manga-chapters-list .stream-row >> nth=0');
  await page.waitForFunction(() => !document.getElementById('manga-reader').hidden, null, { timeout: 5000 });
  await page.waitForSelector('#manga-reader .comic-page[src]', { timeout: 10000 });
  const firstSrc = await page.locator('#manga-reader .comic-page').getAttribute('src');
  check('the first page is the fleet-relative path, absolute-ised', firstSrc === 'https://fleet.lyreosai.com/manga/image?ch=c1&p=1', firstSrc);
  check('the counter reads 1 / 3', (await page.locator('#manga-reader .comic-counter').textContent()) === '1 / 3');
  check('the reader label names the manga and chapter', (await page.locator('#manga-reader .comic-label').textContent()) === 'One Piece · Chapter 1');

  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('#manga-reader .comic-counter').textContent === '2 / 3', null, { timeout: 3000 });
  const secondSrc = await page.locator('#manga-reader .comic-page').getAttribute('src');
  check('ArrowRight turns the page forward', secondSrc === 'https://fleet.lyreosai.com/manga/image?ch=c1&p=2', secondSrc);

  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.querySelector('#manga-reader .comic-counter').textContent === '1 / 3', null, { timeout: 3000 });
  check('ArrowLeft turns the page back', true);

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('#manga-reader .comic-counter').textContent === '3 / 3', null, { timeout: 3000 });
  const thirdSrc = await page.locator('#manga-reader .comic-page').getAttribute('src');
  check('an already-absolute page url survives untouched', thirdSrc === 'https://cdn.example.test/absolute-page.jpg', thirdSrc);

  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  check('paging past the last page is a no-op, not an error', (await page.locator('#manga-reader .comic-counter').textContent()) === '3 / 3');

  // --- 6: a profile downgrade mid-read closes the reader immediately ----------
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('blazing-profile-selected', { detail: { id: 'kid', isKids: true } })));
  await page.waitForFunction(() => document.getElementById('manga-reader').hidden, null, { timeout: 3000 });
  check('switching to a Kids profile closes the open reader', (await page.locator('#manga-reader').isHidden()) === true);
  check('the chapters dialog also closes', (await page.locator('#manga-chapters-dialog').evaluate((d) => d.open)) === false);
  const gateStatus = (await page.locator('#manga-status').textContent()) || '';
  check('the tab itself falls back to the gate message', gateStatus.toLowerCase().includes('mature'), gateStatus);
  await ctx.close();
}

// --- 4b: the plain-array chapter-list shape is read too ---------------------
{
  const { ctx, page } = await openApp({
    chaptersBody: { chapters: [{ id: 'c9', chapter: '9', title: '', pages: 5, readable: true }] },
  });
  await page.waitForSelector('#manga-rows .card', { timeout: 10000 });
  await page.click('#manga-rows .card >> nth=0');
  await page.waitForSelector('#manga-chapters-list .stream-row', { timeout: 5000 });
  check('a bare array response also renders its chapter', (await page.locator('#manga-chapters-list .stream-row').count()) === 1);
  check('bare-array chapter reads as readable, not dead', (await page.locator('#manga-chapters-list .stream-row').first().evaluate((n) => !n.classList.contains('dead'))) === true);
  await ctx.close();
}

// --- 4c: zero chapters, with a server-given reason, is not a generic error --
{
  const { ctx, page } = await openApp({ chaptersBody: { chapters: { list: [], error: 'Officially licensed. Removed at the publisher’s request.', via: 'mangadex' } } });
  await page.waitForSelector('#manga-rows .card', { timeout: 10000 });
  await page.click('#manga-rows .card >> nth=0');
  await settledStatus(page, 'manga-chapters-status');
  const status = (await page.locator('#manga-chapters-status').textContent()) || '';
  // NOT `includes('licensed')`. The app's OWN fallback sentence — "No English
  // chapters are available. This often means the title is officially licensed
  // and removed from this source." — contains that word too, so the check
  // passed even with the server's reason thrown away. Proven: swallowing `why`
  // in manga.js left this green. It now names a phrase only the fixture's
  // reason has, and refuses the fallback outright.
  check('the server\'s own reason is shown, not a generic failure',
    status.includes('Removed at the publisher') && !status.includes('This often means'), status);
  check('zero chapters renders no rows', (await page.locator('#manga-chapters-list .stream-row').count()) === 0);
  await ctx.close();
}

// --- 7: search --------------------------------------------------------------
{
  const { ctx, page, calls } = await openApp();
  await page.waitForSelector('#manga-rows .row', { timeout: 10000 });
  await page.fill('#manga-search-input', 'One Piece');
  await page.click('#manga-search-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelectorAll('#manga-rows .row').length === 1, null, { timeout: 5000 });
  const searchCall = calls.find((c) => c.url.includes('/manga/search') && c.url.includes('q=One'));
  check('search request carries the query', Boolean(searchCall), searchCall && searchCall.url);
  check('search replaces the shelves with one results row', (await page.locator('#manga-rows .row-title').first().textContent()).includes('One Piece'));
  await ctx.close();
}

const real = errors.filter((e) => !/Failed to fetch|NetworkError|CORS|load resource/i.test(e));
check('no page errors', real.length === 0, real.join(' | '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
