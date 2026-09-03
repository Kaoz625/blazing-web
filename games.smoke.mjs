// Headless smoke test for the Games tab (games.js).
//
// Everything the fleet would answer is intercepted, so nothing real is
// contacted. What is proved here:
//   1. the catalogue renders one card per game, in server order;
//   2. `configured !== true` shows the "not configured" message, not an
//      empty grid (this is the RAW server contract Games.brs itself reads);
//   3. clicking a card opens the detail dialog with meta/description/
//      screenshots and a working trailer button;
//   4. a game with no trailer hides the trailer button;
//   5. search resets to page 1 and "Load more" pages the catalogue.
import { chromium } from 'playwright';
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

const PAGE1 = [
  { id: 'g1', name: 'Freedoom: Phase 1', poster: 'https://media.example.test/g1.jpg' },
  { id: 'g2', name: 'SuperTuxKart', poster: 'https://media.example.test/g2.jpg' },
];
const PAGE2 = [
  { id: 'g3', name: 'Cave Story', poster: 'https://media.example.test/g3.jpg' },
];
const DETAIL = {
  found: true,
  id: 'g1',
  name: 'Freedoom: Phase 1',
  description: 'A free content first-person shooter.',
  released: '2019-08-25',
  rating: '4.1',
  metacritic: '',
  poster: 'https://media.example.test/g1.jpg',
  genres: ['Shooter', 'Action'],
  platforms: ['PC', 'Linux'],
  screenshots: ['https://media.example.test/g1-1.jpg', 'https://media.example.test/g1-2.jpg'],
  trailer: 'https://media.example.test/g1-trailer.mp4',
};

const browser = await chromium.launch();

async function openApp({ configured = true, onCall } = {}) {
  const ctx = await browser.newContext();
  const calls = [];
  await ctx.route('https://fleet.lyreosai.com/**', (route) => {
    const req = route.request();
    const url = req.url();
    calls.push({ url });
    if (onCall) onCall({ url });

    if (url.includes('/games/catalog/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DETAIL) });
    }
    if (url.includes('/games/catalog')) {
      if (!configured) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: false, error: 'RAWG_API_KEY is not set.' }) });
      }
      const u = new URL(url);
      const search = u.searchParams.get('search');
      const page = Number(u.searchParams.get('page') || '1');
      if (search) {
        const matched = search.toLowerCase().includes('cave')
          ? [{ id: 'g3', name: 'Cave Story', poster: 'https://media.example.test/g3.jpg' }]
          : [];
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true, count: matched.length, page: 1, hasNext: false, games: matched }) });
      }
      if (page === 1) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true, count: 3, page: 1, hasNext: true, games: PAGE1 }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true, count: 3, page: 2, hasNext: false, games: PAGE2 }) });
    }
    // Everything else the app pulls on boot (party liveness, etc).
    if (url.includes('/party/active')) return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  });
  await ctx.route('https://addon.lyreosai.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ catalogs: [], metas: [] }) }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  // Same gate every other smoke test in this repo clears first (locker,
  // watch-party, rowhero): profile.js holds the whole app behind a picker
  // until a profile is chosen, and its overlay swallows pointer events.
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('blazing-profile-selected', {
      detail: { id: 'p1', name: 'Mark', isKids: false, maxRating: 'adult' },
    }));
    document.querySelectorAll('.bp-layer').forEach((n) => n.remove());
  });
  // "Games" lives in the drawer-only "More" nav, which styles.css hides at a
  // desktop viewport (the drawer is a mobile pattern). app.js binds every
  // [data-view] button the same way regardless of which nav it renders in
  // (app.js:3026, a plain `$$('[data-view]').forEach(...)`), so dispatching
  // the click directly is exercising the same handler a visible tap would.
  await page.evaluate(() => document.querySelector('[data-view="games"]').click());
  return { ctx, page, calls };
}

// --- 1: catalogue renders, in server order ----------------------------------
{
  const { ctx, page, calls } = await openApp();
  await page.waitForSelector('#games-results .card', { timeout: 10000 });
  check('two cards for page 1', (await page.locator('#games-results .card').count()) === 2);
  const labels = await page.locator('#games-results .card .card-label').allTextContents();
  check('server order kept', JSON.stringify(labels) === JSON.stringify(PAGE1.map((g) => g.name)), JSON.stringify(labels));
  check('cards reuse the app card class', (await page.locator('#games-results .card').first().evaluate((n) => n.classList.contains('card'))) === true);
  check('Load more is visible when hasNext is true', (await page.locator('#games-load-more').isVisible()) === true);

  // --- 5b: Load more appends page 2 ------------------------------------------
  await page.click('#games-load-more');
  await page.waitForFunction(() => document.querySelectorAll('#games-results .card').length === 3, null, { timeout: 5000 });
  const catalogCalls = calls.filter((c) => c.url.includes('/games/catalog') && !c.url.includes('/games/catalog/'));
  check('load more requested page 2', catalogCalls.some((c) => c.url.includes('page=2')));
  check('Load more hides once hasNext is false', (await page.locator('#games-load-more').isVisible()) === false);

  // --- 3: clicking a card opens the detail dialog -----------------------------
  await page.click('#games-results .card >> nth=0');
  await page.waitForFunction(() => document.getElementById('game-detail-title').textContent === 'Freedoom: Phase 1', null, { timeout: 5000 });
  check('detail dialog is open', (await page.locator('#game-detail-dialog').evaluate((d) => d.open)) === true);
  const meta = (await page.locator('#game-detail-meta').textContent()) || '';
  check('meta line has released date, rating and genres', meta.includes('2019-08-25') && meta.includes('★ 4.1') && meta.includes('Shooter'));
  check('description is shown', (await page.locator('#game-detail-desc').textContent()) === DETAIL.description);
  check('platforms line is shown', ((await page.locator('#game-detail-platforms').textContent()) || '').includes('PC'));
  check('two screenshots rendered', (await page.locator('#game-detail-shots img').count()) === 2);
  check('trailer button visible when a trailer url exists', (await page.locator('#game-detail-trailer-btn').isVisible()) === true);

  // --- 3b: playing the trailer builds a <video> with the RAWG clip url -------
  await page.click('#game-detail-trailer-btn');
  await page.waitForSelector('#game-detail-trailer video', { timeout: 5000 });
  check('trailer video src is the catalog trailer url', (await page.locator('#game-detail-trailer video').getAttribute('src')) === DETAIL.trailer);

  await page.click('#game-detail-close');
  await page.waitForTimeout(100);
  check('closing the dialog stops the trailer video', (await page.locator('#game-detail-trailer video').count()) === 0);
  check('dialog is closed', (await page.locator('#game-detail-dialog').evaluate((d) => d.open)) === false);

  // --- 5a: search resets to a filtered page 1 ---------------------------------
  await page.fill('#games-search-input', 'cave');
  await page.click('#games-search-form button[type="submit"]');
  await page.waitForFunction(() => {
    const labels2 = [...document.querySelectorAll('#games-results .card .card-label')].map((n) => n.textContent);
    return labels2.length === 1 && labels2[0] === 'Cave Story';
  }, null, { timeout: 5000 });
  check('search narrows the grid to the match', true);
  const searchCall = calls.find((c) => c.url.includes('search=cave'));
  check('search request carries the query', Boolean(searchCall), searchCall && searchCall.url);
  check('Load more hides for a search with no next page', (await page.locator('#games-load-more').isVisible()) === false);
  await ctx.close();
}

/**
 * Wait for a status line to say its ANSWER, not its placeholder.
 *
 * `#games-status` is written twice on every load: the code sets a
 * "Loading…"-style placeholder the moment the request goes out, and replaces it
 * when the answer lands. A wait for "textContent is not empty" is therefore
 * already satisfied by the placeholder, so it returns at once and the check
 * that follows reads whatever happens to be on screen — usually the answer,
 * sometimes the placeholder. The identical wait in manga.smoke.mjs did lose
 * that race and reported the app broken:
 *
 *     FAIL  the server's own reason is shown, not a generic failure — Loading chapters…
 *
 * The app was right and had simply not been given the millisecond it needed.
 * This file had the same latent flake, so it gets the same fix. Waiting for a
 * settled line makes the check honest; a status that never leaves its
 * placeholder now times out and fails on its own account.
 */
async function settledStatus(page, id, timeout = 5000) {
  await page.waitForFunction((el) => {
    const t = (document.getElementById(el).textContent || '').trim();
    return t.length > 0 && !/^(Loading|Searching)\b/i.test(t) && !t.endsWith('…');
  }, id, { timeout, polling: 100 });
  return (await page.locator(`#${id}`).textContent()) || '';
}

// --- 2: not configured on the server ----------------------------------------
{
  const { ctx, page } = await openApp({ configured: false });
  await settledStatus(page, 'games-status');
  check('no cards render when not configured', (await page.locator('#games-results .card').count()) === 0);
  const status = (await page.locator('#games-status').textContent()) || '';
  check('the not-configured message is shown, not a silent empty grid', status.includes('RAWG_API_KEY is not set.'), status);
  check('Load more stays hidden', (await page.locator('#games-load-more').isVisible()) === false);
  await ctx.close();
}

// --- 4: a game with no trailer hides the button ------------------------------
{
  const { ctx, page } = await openApp();
  await page.waitForSelector('#games-results .card', { timeout: 10000 });
  await page.click('#games-results .card >> nth=1'); // SuperTuxKart — same DETAIL fixture, but this proves the hide path
  await page.waitForFunction(() => document.getElementById('game-detail-title').textContent !== 'Loading…', null, { timeout: 5000 });
  // Re-fetch the dialog with a trailer-less payload by opening a second, distinct id.
  await ctx.close();
}
{
  const ctx = await browser.newContext();
  await ctx.route('https://fleet.lyreosai.com/**', (route) => {
    const url = route.request().url();
    if (url.includes('/games/catalog/g4')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...DETAIL, id: 'g4', name: 'No Trailer Game', trailer: '' }) });
    }
    if (url.includes('/games/catalog')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true, count: 1, page: 1, hasNext: false, games: [{ id: 'g4', name: 'No Trailer Game', poster: '' }] }) });
    }
    if (url.includes('/party/active')) return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  });
  await ctx.route('https://addon.lyreosai.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ catalogs: [], metas: [] }) }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('blazing-profile-selected', { detail: { id: 'p1', isKids: false, maxRating: 'adult' } }));
    document.querySelectorAll('.bp-layer').forEach((n) => n.remove());
  });
  await page.evaluate(() => document.querySelector('[data-view="games"]').click());
  await page.waitForSelector('#games-results .card', { timeout: 10000 });
  check('a poster-less game gets the no-image placeholder', (await page.locator('#games-results .card').first().evaluate((n) => n.classList.contains('no-image'))) === true);
  await page.click('#games-results .card >> nth=0');
  await page.waitForFunction(() => document.getElementById('game-detail-title').textContent === 'No Trailer Game', null, { timeout: 5000 });
  check('no trailer button when the catalogue has no trailer url', (await page.locator('#game-detail-trailer-btn').isVisible()) === false);
  await ctx.close();
}

const real = errors.filter((e) => !/Failed to fetch|NetworkError|CORS|load resource/i.test(e));
check('no page errors', real.length === 0, real.join(' | '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
