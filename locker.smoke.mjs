// Headless smoke test for the "My Locker" shelf (locker.js).
//
// Everything the fleet would answer is intercepted, so nothing real is
// contacted and no device is registered. What is proved here:
//   1. an approved browser sees the shelf, newest-first, one card per file;
//   2. an empty locker is handled (shelf, no cards, a plain empty line);
//   3. a 403 (browser not admin-approved) removes the shelf completely —
//      no error box for a feature almost nobody has;
//   4. no stored device credentials at all means the shelf never appears;
//   5. clicking a card calls /streamtape/resolve and hands the returned URL to
//      the app's own player.
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

const FILES = [
  { id: 'aaaa1111bbbb', name: 'Family reunion 2026.mp4', size: 2_400_000_000, converted: true },
  { id: 'cccc2222dddd', name: 'Dog at the beach.mp4', size: 512_000_000, converted: true },
  { id: 'eeee3333ffff', name: 'Old home video.mp4', size: 84_000_000, converted: true },
];
const RESOLVED = 'https://cdn.example-streamtape.test/get_video/aaaa1111bbbb.mp4?token=xyz';

const browser = await chromium.launch();

// Every scenario gets a clean context: the device credentials live in
// localStorage, which is exactly what decides whether the shelf exists at all.
async function openApp({ credentials = true, listStatus = 200, listBody = FILES, onCall } = {}) {
  const ctx = await browser.newContext();
  if (credentials) {
    await ctx.addInitScript(() => {
      localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-approved-1', token: 'tok-abc' }));
    });
  }
  const calls = [];
  await ctx.route('https://fleet.lyreosai.com/**', (route) => {
    const req = route.request();
    const url = req.url();
    calls.push({ url, token: req.headers()['x-device-token'] || '' });
    if (onCall) onCall({ url });
    if (url.includes('/streamtape/list')) {
      if (listStatus !== 200) {
        return route.fulfill({ status: listStatus, contentType: 'application/json', body: JSON.stringify({ error: 'nope' }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listBody) });
    }
    if (url.includes('/streamtape/resolve/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'aaaa1111bbbb', name: 'Family reunion 2026.mp4', size: 2_400_000_000, url: RESOLVED }),
      });
    }
    // Everything else the app pulls on boot (catalog shelves, party liveness).
    if (url.includes('/party/active')) return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  });
  // The add-on host is not part of this feature; keep boot quiet and fast.
  await ctx.route('https://addon.lyreosai.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ catalogs: [], metas: [] }) }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  // locker.js's own start() waits for profile.js's 'blazing-profile-selected'
  // before it ever fetches or renders the shelf (state.isKids starts true, so
  // an unpicked profile reads as Kids and the shelf never appears at all) —
  // same gate DEP-9/rowhero already hit. Pick a non-Kids profile and drop the
  // gate's own overlay, which otherwise sits over the whole page and would
  // swallow the card click in scenario 5.
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('blazing-profile-selected', {
      detail: { id: 'p1', name: 'Mark', isKids: false },
    }));
    document.querySelectorAll('.bp-layer').forEach((n) => n.remove());
  });
  return { ctx, page, calls };
}

// --- 1: an approved browser sees its files ---------------------------------
{
  const { ctx, page, calls } = await openApp();
  await page.waitForSelector('.locker-row .locker-card', { timeout: 10000 });

  const listCall = calls.find((c) => c.url.includes('/streamtape/list'));
  check('the list call carries the registered deviceId', Boolean(listCall) && listCall.url.includes('deviceId=dev-approved-1'), listCall && listCall.url);
  check('the list call carries the X-Device-Token header from profile.js storage', Boolean(listCall) && listCall.token === 'tok-abc', listCall && listCall.token);
  check('exactly one shelf is added', (await page.locator('.locker-row').count()) === 1);
  check('the shelf is titled My Locker', (await page.locator('.locker-row .row-title').textContent()) === 'My Locker');
  check('the shelf lives in #rows with the other shelves', (await page.locator('#rows > .locker-row').count()) === 1);
  check('one card per file', (await page.locator('.locker-card').count()) === FILES.length);

  const labels = await page.locator('.locker-card .card-label').allTextContents();
  check('server order (newest first) is kept', JSON.stringify(labels) === JSON.stringify(FILES.map((f) => f.name)), JSON.stringify(labels));
  check('a card shows a readable size', (await page.locator('.locker-card .locker-meta').first().textContent()) === '2.4 GB');
  check('cards reuse the app card class', (await page.locator('.locker-card').first().evaluate((n) => n.classList.contains('card'))) === true);
  check('the shelf is visible on Home', (await page.locator('.locker-row').isVisible()) === true);

  // The shelf carries no media type, so the type-filtered routes must hide it.
  await page.click('.topnav button[data-view="movies"]');
  await page.waitForTimeout(120);
  check('Movies hides the locker shelf', (await page.locator('.locker-row').isVisible()) === false);
  await page.click('.topnav button[data-view="home"]');
  await page.waitForTimeout(120);
  check('Home shows it again', (await page.locator('.locker-row').isVisible()) === true);

  // --- 5: clicking a file resolves it and reaches the app's player ---------
  const card = page.locator('.locker-card').first();
  await card.click();
  await page.waitForFunction(() => {
    const v = document.getElementById('video');
    return v && v.getAttribute('src');
  }, null, { timeout: 15000 });

  const resolveCall = calls.find((c) => c.url.includes('/streamtape/resolve/'));
  check('clicking calls resolve for that file id', Boolean(resolveCall) && resolveCall.url.includes('/streamtape/resolve/aaaa1111bbbb'), resolveCall && resolveCall.url);
  check('resolve also carries the deviceId', Boolean(resolveCall) && resolveCall.url.includes('deviceId=dev-approved-1'));
  check('resolve carries the device token', Boolean(resolveCall) && resolveCall.token === 'tok-abc');
  check('the app player is open', (await page.locator('#player').evaluate((n) => n.hidden)) === false);
  check('the resolved URL is what the app player was given', (await page.locator('#video').getAttribute('src')) === RESOLVED);
  check('the player title is the file name', (await page.locator('#player-title').textContent()) === 'Family reunion 2026.mp4');
  check('the card is no longer busy', (await card.getAttribute('aria-busy')) === null);
  await ctx.close();
}

// --- 2: an empty locker -----------------------------------------------------
{
  const { ctx, page } = await openApp({ listBody: [] });
  await page.waitForSelector('.locker-row', { timeout: 10000 });
  check('an empty list still renders the shelf', (await page.locator('.locker-row').count()) === 1);
  check('an empty list renders no cards', (await page.locator('.locker-card').count()) === 0);
  const status = (await page.locator('.locker-status').textContent()) || '';
  check('an empty list says so in plain words', status.toLowerCase().includes('nothing in your locker'), status);
  check('an empty list is not an error', (await page.locator('.locker-status').getAttribute('data-state')) !== 'error');
  await ctx.close();
}

// --- 3: not approved (403) --------------------------------------------------
for (const status of [403, 400, 503]) {
  const { ctx, page } = await openApp({ listStatus: status });
  await page.waitForTimeout(1500);
  check(`a ${status} hides the shelf completely`, (await page.locator('.locker-row').count()) === 0);
  check(`a ${status} shows no error text anywhere`, (await page.locator('.locker-status').count()) === 0);
  check(`a ${status} leaves the rest of the app alone`, (await page.locator('header.topbar').isVisible()) === true);
  await ctx.close();
}

// --- 4: no device credentials at all ---------------------------------------
{
  let touched = false;
  const { ctx, page } = await openApp({ credentials: false, onCall: ({ url }) => { if (url.includes('/streamtape/')) touched = true; } });
  await page.waitForTimeout(1500);
  check('an unregistered browser never renders the shelf', (await page.locator('.locker-row').count()) === 0);
  check('an unregistered browser never calls the locker routes', touched === false);
  await ctx.close();
}

const real = errors.filter((e) => !/Failed to fetch|NetworkError|CORS|load resource/i.test(e));
check('no page errors', real.length === 0, real.join(' | '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
