// Headless smoke test for remote-control navigation (dpad.js + app.js), the
// piece the register calls "LG webOS has no client" over. blazing-web already
// packages into a real .ipk (build-tvs.sh, ares-package) and already ships
// dpad.js, a real nearest-neighbor D-pad focus engine wired since BlazeOS
// Phase 1 (48f1be5) — nobody had verified whether it actually works with
// REAL key events, or what a remote's Back button does once inside a dialog.
//
// Playwright's page.keyboard.press() dispatches real, trusted key events —
// the same path a webOS TV's remote driver feeds the page — not a synthetic
// DOM event a click handler could fake past.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, p === '/' ? 'index.html' : p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
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

const PIX = 'https://img.invalid/poster.jpg';
const META = (n, pre) => ({
  metas: Array.from({ length: n }, (_, i) => ({
    id: `tt900${i}0`, name: `${pre} title ${i + 1}`, type: 'movie', poster: PIX, releaseInfo: '2026',
  })),
});

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await ctx.addInitScript(() => {
  localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-1', token: 'tok' }));
  localStorage.setItem('profileId', 'p1');
});
await ctx.route('https://addon.lyreosai.com/**', (route) => {
  const u = route.request().url();
  if (u.includes('/api/ui/home-config')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ mode: 'blazing', appName: 'Blazing Stream', theme: 'cinema_dark', homeRows: [
      { id: 'row_a', type: 'card_row', catalogSlug: 'blazing-movies', label: 'Row A' },
      { id: 'row_b', type: 'card_row', catalogSlug: 'blazing-series', label: 'Row B' },
    ] }) });
  if (u.includes('/manifest.json')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ catalogs: [
      { id: 'blazing-movies', type: 'movie', name: 'Movies' },
      { id: 'blazing-series', type: 'series', name: 'Shows' },
    ] }) });
  if (u.includes('/meta/')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ meta: { id: 'tt90000', name: 'Full title', type: 'movie', poster: PIX,
      description: 'A synopsis.', imdbRating: '7.8', runtime: '118 min', genres: ['Drama'] } }) });
  if (u.includes('/catalog/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(6, 'cat')) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
await ctx.route('https://fleet.lyreosai.com/**', (route) => {
  const u = route.request().url();
  if (u.includes('/discover/filter/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(4, 'fresh')) });
  if (u.includes('/profiles')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profiles: [{ id: 'p1', name: 'Mark', maxRating: 'adult', hasPin: false }] }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  document.dispatchEvent(new CustomEvent('blazing-profile-selected', { detail: { id: 'p1', name: 'Mark', maxRating: 'adult', isKids: false } }));
  document.querySelectorAll('.bp-layer').forEach((n) => n.remove());
});
await page.waitForSelector('#rows .card', { timeout: 10000 });
await page.waitForTimeout(500);

// --- 1: arrow keys move real focus across real cards, with a real KeyboardEvent ---
await page.evaluate(() => document.querySelector('#rows .card').focus());
const before = await page.evaluate(() => document.activeElement.querySelector('.card-label')?.textContent || document.activeElement.className);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(150);
const afterRight = await page.evaluate(() => document.activeElement.querySelector('.card-label')?.textContent || document.activeElement.className);
check('ArrowRight moves focus to a different real card', afterRight !== before, `${before} -> ${afterRight}`);
check('the newly focused element is still a .card', await page.evaluate(() => document.activeElement.classList.contains('card')));

await page.keyboard.press('ArrowDown');
await page.waitForTimeout(150);
const afterDown = await page.evaluate(() => document.activeElement.closest('.row')?.querySelector('.row-title')?.textContent || null);
check('ArrowDown moves focus into the row below', afterDown !== null, String(afterDown));

// --- 2: OK (Enter) on a focused card opens the detail dialog, no click needed ---
await page.keyboard.press('Enter');
await page.waitForSelector('#detail-dialog[open]', { timeout: 5000 }).then(
  () => check('Enter on a focused card opens the detail dialog', true),
  () => check('Enter on a focused card opens the detail dialog', false, 'timed out'),
);

// --- 3: focus must not leak to the page BEHIND an open modal dialog ---------
await page.waitForTimeout(400);
const insideDialogOrNoBody = await page.evaluate(() => {
  const a = document.activeElement;
  return a === document.body || Boolean(a.closest('#detail-dialog'));
});
check('after opening, focus is inside the dialog (or at least not stuck on a background card)', insideDialogOrNoBody);

if (!insideDialogOrNoBody) {
  // If dpad.js's own query does not scope to the open <dialog>, pressing an
  // arrow key while it is open would move focus to a card the modal is
  // supposed to make inert — proving the leak concretely rather than by
  // reading the code.
  const dialogButtonExists = await page.evaluate(() => !!document.querySelector('#detail-dialog button'));
  if (dialogButtonExists) await page.evaluate(() => document.querySelector('#detail-dialog button').focus());
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  const leaked = await page.evaluate(() => !document.activeElement.closest('#detail-dialog'));
  check('arrow keys do not move focus out from behind the open dialog', !leaked);
}

// --- 4: the webOS remote's physical Back button closes the dialog ----------
// webOS TV feeds the physical Back key as keyCode 461 (key: 'Back' on many
// firmwares, sometimes reported as GoBack) rather than as Escape, which is
// only what a desktop keyboard sends. dpad.js/app.js only listened for
// Escape before this test — extended below if this fails.
await page.evaluate(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Back', keyCode: 461, which: 461, bubbles: true }));
});
await page.waitForTimeout(400);
const dialogOpenAfterBack = await page.evaluate(() => document.querySelector('#detail-dialog').open);
check('the webOS remote Back button (keyCode 461) closes the open dialog', dialogOpenAfterBack === false);

await page.screenshot({ path: process.env.SHOT || '/tmp/webos-nav.png' });
check('no page errors', errors.filter((e) => !/Failed to fetch|NetworkError|load resource/i.test(e)).length === 0, errors.join(' | '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
