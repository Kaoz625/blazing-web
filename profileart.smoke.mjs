/**
 * The login screen shows each profile's own last-watched art.
 *
 * Markus, 2026-08-30: "when we are logging in we are having artwork ther based
 * on the last thing that profile was watching correct?" It did not — every
 * profile got the same flat tinted gradient, and profile.js said so in a comment
 * claiming the app had no data for it. The fleet had the data all along, at
 * GET /profiles/:id/progress.
 *
 * What this file holds down, and why each one is here:
 *
 *  - The art element cannot be clicked or focused. This is the parental control
 *    surface; a decoration must never sit between somebody and the gate.
 *  - The FRESHEST item wins. The fleet does not sort — getProgress returns the
 *    stored order — so a fixture whose newest item is last would pass by luck if
 *    the client just took items[0].
 *  - An adult-enabled profile gets NO art, and is never even asked for its
 *    history. The progress payload carries no contentRating, so a single title
 *    cannot be filtered; the profile is the only honest filter.
 *  - A non-https background is refused, like every other image in this app.
 *  - A profile with no history, and a profile whose fetch fails, both fall back
 *    to the plain gradient rather than showing the previous profile's art.
 *
 *   node profileart.smoke.mjs
 */
import { launchBrowser } from './comet.mjs';
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

const NEWEST = 'https://img.invalid/newest.jpg';
const OLDER = 'https://img.invalid/older.jpg';
const INSECURE = 'http://img.invalid/insecure.jpg';
// The add-on store, which is the one THIS app writes to. The televisions write
// to the fleet. Both halves have to count.
const ADDON_ONLY = 'https://img.invalid/addon-only.jpg';
const ADDON_NEWER = 'https://img.invalid/addon-newer.jpg';

const PROFILES = [
  { id: 'p-mark', name: 'Mark', maxRating: 'teen', hasPin: false, allowAdult: false, isKids: false },
  { id: 'p-adult', name: 'Grown', maxRating: 'adult', hasPin: false, allowAdult: true, isKids: false },
  { id: 'p-empty', name: 'Fresh', maxRating: 'teen', hasPin: false, allowAdult: false, isKids: false },
  { id: 'p-broken', name: 'Offline', maxRating: 'teen', hasPin: false, allowAdult: false, isKids: false },
  { id: 'p-http', name: 'Insecure', maxRating: 'teen', hasPin: false, allowAdult: false, isKids: false },
  { id: 'p-addon', name: 'Browseronly', maxRating: 'teen', hasPin: false, allowAdult: false, isKids: false },
  { id: 'p-both', name: 'Everywhere', maxRating: 'teen', hasPin: false, allowAdult: false, isKids: false },
];

// Stored order, NOT recency order — the newest sits last on purpose. The fleet
// returns what it stored, so picking items[0] must not pass this.
const PROGRESS = {
  'p-mark': { items: [
    { id: 'tt1', name: 'Older', type: 'movie', background: OLDER, updatedAt: '2026-08-01T10:00:00.000Z' },
    { id: 'tt2', name: 'No art', type: 'movie', updatedAt: '2026-08-29T10:00:00.000Z' },
    { id: 'tt3', name: 'Newest', type: 'movie', background: NEWEST, updatedAt: '2026-08-28T10:00:00.000Z' },
  ] },
  'p-empty': { items: [] },
  'p-http': { items: [
    { id: 'tt9', name: 'Insecure art', type: 'movie', background: INSECURE, updatedAt: '2026-08-29T10:00:00.000Z' },
  ] },
  // Watched on a television a while ago; the browser has something newer.
  'p-both': { items: [
    { id: 'tt20', name: 'On the TV', type: 'movie', background: OLDER, updatedAt: '2026-08-10T10:00:00.000Z' },
  ] },
};

// The OTHER store — what this app itself writes. p-addon has nothing on any
// television at all, which is every browser-only household.
const ADDON = {
  'p-addon': { items: [
    { id: 'tt30', name: 'Only in the browser', type: 'movie', background: ADDON_ONLY, updatedAt: '2026-08-20T10:00:00.000Z' },
  ] },
  'p-both': { items: [
    { id: 'tt31', name: 'In the browser, later', type: 'movie', background: ADDON_NEWER, updatedAt: '2026-08-27T10:00:00.000Z' },
  ] },
};

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`ok    ${label}${extra ? '  ' + extra : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-1', token: 'tok' }));
});

const askedAddon = [];
await ctx.route('https://addon.lyreosai.com/**', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/api/sync/progress/recent') {
    const id = u.searchParams.get('profileId') || '';
    askedAddon.push(id);
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(ADDON[id] || { items: [] }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"metas":[],"items":[],"catalogs":[]}' });
});
await ctx.route('https://upscale.lyreosai.com/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

const asked = [];
await ctx.route('https://fleet.lyreosai.com/**', (route) => {
  const u = new URL(route.request().url());
  const progress = u.pathname.match(/^\/profiles\/([^/]+)\/progress$/);
  if (progress) {
    const id = decodeURIComponent(progress[1]);
    asked.push(id);
    // p-broken answers 500 — a profile server that fails must leave the
    // gradient alone, not the previous profile's photograph.
    if (id === 'p-broken') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"nope"}' });
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ progress: PROGRESS[id] || { items: [] } }) });
  }
  if (u.pathname === '/devices/register') return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, device: { id: 'dev-1', status: 'approved' }, token: 'tok' }) });
  if (u.pathname === '/profiles') return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ profiles: PROFILES }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.bp-profile', { timeout: 15000 });

// ── the art layer is decoration and nothing else ────────────────────────────
const layer = await page.evaluate(() => {
  const art = document.querySelector('.bp-layer .bp-art');
  if (!art) return null;
  const cs = getComputedStyle(art);
  return {
    first: art.parentElement.firstElementChild === art,
    pointer: cs.pointerEvents,
    hiddenFromAT: art.getAttribute('aria-hidden'),
    focusable: art.matches('a, button, input, select, textarea, [tabindex]'),
  };
});
ok(Boolean(layer), 'the login screen has an art layer at all');
if (layer) {
  ok(layer.first, 'it is painted first, under the rail and the close-catcher');
  ok(layer.pointer === 'none', 'it cannot take a click away from the gate', `(${layer.pointer})`);
  ok(!layer.focusable && layer.hiddenFromAT === 'true', 'and it is not a focus stop or a screen-reader stop');
}

// ── the freshest title wins, not the first stored ───────────────────────────
const shown = await page.waitForFunction(
  () => { const a = document.querySelector('.bp-art'); return a && a.dataset.shown === 'true'; },
  null, { timeout: 8000, polling: 100 },
).then(() => true).catch(() => false);
const artNow = await page.evaluate(() => document.querySelector('.bp-art').style.backgroundImage);
ok(shown, 'art appears on its own once the histories land');
ok(artNow.includes('newest.jpg'), 'and it is the LAST WATCHED title, not the first stored one', `(${artNow})`);
ok(!artNow.includes('older.jpg'), 'the older title is not the one on screen');

// ── an adult-enabled profile is never even asked ────────────────────────────
ok(!asked.includes('p-adult') && !askedAddon.includes('p-adult'),
  'an adult-enabled profile is never asked for its history, on EITHER store',
  `(fleet: ${asked.join(',')} | addon: ${askedAddon.join(',')})`);
ok(asked.includes('p-mark') && asked.includes('p-empty'), 'the ordinary profiles are');

const focusArt = async (name) => {
  await page.evaluate((n) => {
    const b = [...document.querySelectorAll('.bp-profile')]
      .find((x) => (x.textContent || '').includes(n));
    b.focus();
    b.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
  }, name);
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const a = document.querySelector('.bp-art');
    return { shown: a.dataset.shown, image: a.style.backgroundImage };
  });
};

const adult = await focusArt('Grown');
ok(adult.shown === 'false', 'focusing the adult profile clears the art rather than keeping the last one', `(${adult.shown})`);

const back = await focusArt('Mark');
ok(back.shown === 'true' && back.image.includes('newest.jpg'), 'focusing back returns that profile\'s own art');

const empty = await focusArt('Fresh');
ok(empty.shown === 'false', 'a profile with no history falls back to the plain gradient', `(${empty.shown})`);

await focusArt('Mark');
const broken = await focusArt('Offline');
ok(broken.shown === 'false', 'a profile whose history failed shows the gradient, not the last profile\'s art', `(${broken.shown})`);

await focusArt('Mark');
const insecure = await focusArt('Insecure');
ok(insecure.shown === 'false', 'an http:// background is refused, like every other image here', `(${insecure.image})`);

// ── the two progress stores, both counted ───────────────────────────────────
const addonOnly = await focusArt('Browseronly');
ok(addonOnly.shown === 'true' && addonOnly.image.includes('addon-only.jpg'),
  'a browser-only profile still gets art — nothing of it is on any television',
  `(${addonOnly.image})`);

const both = await focusArt('Everywhere');
ok(both.image.includes('addon-newer.jpg'),
  'when both stores answer, the NEWER one wins whichever store it came from',
  `(${both.image})`);
ok(!both.image.includes('older.jpg'), 'the older television record is not the one shown');

// The gate still works. Everything above is decoration on a parental control.
const gate = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.bp-profile')].find((x) => (x.textContent || '').includes('Mark'));
  b.click();
  return true;
});
await page.waitForTimeout(1200);
const closed = await page.evaluate(() => document.querySelector('.bp-layer').hidden);
ok(gate && closed, 'and choosing a profile still passes the gate');

ok(errors.length === 0, 'nothing threw', errors.slice(0, 2).join(' ; '));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
