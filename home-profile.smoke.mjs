// Returning-browser Home, partial SDUI, and profile privacy. All services are fixtures.
import assert from 'node:assert/strict';
import { launchBrowser } from './comet.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const name = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, name === '/' ? 'index.html' : name));
    res.writeHead(200, { 'content-type': TYPES[extname(name)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const art = 'https://images.example.test/poster.png';
const meta = (name, rating = 'general', id = 'tt100') => ({
  id, name, type: 'movie', poster: art, background: art,
  description: 'A fixture title for the profile privacy check.', contentRating: rating,
});
const profiles = [
  { id: 'adult-one', name: 'Alex', maxRating: 'adult', allowAdult: true, hasPin: false },
  { id: 'kids-two', name: 'Sam', maxRating: 'general', isKids: true, hasPin: false },
];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
let browser;
let releaseHistory;
try {
  browser = await launchBrowser();
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-home', token: 'fixture-token' }));
    localStorage.setItem('profileId', 'adult-one');
    localStorage.setItem('blazing-household-approved', '1');
    // This old browser-wide list must never leak into a different viewer's list.
    localStorage.setItem('blazing-my-list-v1', JSON.stringify([{ id: 'tt999', name: 'Legacy private saved', type: 'movie' }]));
  });
  const requests = [];
  let holdAdultHistory = false;
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    requests.push(url.pathname + url.search);
    if (url.hostname === 'images.example.test') {
      return route.fulfill({ contentType: 'image/png', body: await readFile(join(ROOT, 'icon-192.png')) });
    }
    if (url.hostname === 'fleet.lyreosai.com') {
      if (url.pathname === '/profiles') return json(route, { profiles });
      if (url.pathname === '/accounts/me') return json(route, { account: { id: 'acc-fixture', name: 'Home test' }, device: { id: 'dev-home', enrollmentStatus: 'approved' } });
      if (url.pathname.startsWith('/profiles/')) return json(route, { items: [] });
      if (url.pathname.startsWith('/discover/filter/')) return json(route, { items: [meta('Fresh family movie'), meta('Fresh grown movie', 'mature')] });
      if (url.pathname.startsWith('/emby/')) return json(route, { metas: [] });
      return json(route, {});
    }
    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/api/ui/home-config') return json(route, {
        appName: 'Blazing Stream', theme: 'cinema_dark', homeRows: [
          { id: 'hero', type: 'cinematic_hero', catalogSlug: 'blazing-trending-movies', label: 'Featured' },
          { id: 'trending_m', type: 'card_row', catalogSlug: 'blazing-trending-movies', label: 'Trending Movies' },
          { id: 'empty', type: 'card_row', catalogSlug: 'blazing-edu-science', label: 'Empty catalog' },
        ],
      });
      if (url.pathname === '/manifest.json') return json(route, { catalogs: [
        { id: 'blazing-trending-movies', type: 'movie', name: 'Duplicate trending' },
        { id: 'blazing-movies', type: 'movie', name: 'More Movies' },
        { id: 'blazing-series', type: 'series', name: 'More Shows' },
        { id: 'blazing-edu-science', type: 'tv', name: 'Empty duplicate' },
      ] });
      if (url.pathname === '/api/sync/progress/recent') {
        const id = url.searchParams.get('profileId');
        if (id === 'adult-one' && holdAdultHistory) await new Promise((resolve) => { releaseHistory = resolve; });
        return json(route, { items: [meta(id === 'adult-one' ? 'Alex private history' : 'Sam history', 'general', 'tt102')] });
      }
      if (url.pathname.startsWith('/catalog/')) return json(route, {
        metas: url.pathname.includes('blazing-edu-science') ? [] : [meta('Family title'), meta('Grown title', 'mature'), meta('Unrated title', null)],
      });
      return json(route, {});
    }
    return json(route, {});
  });
  const page = await ctx.newPage();
  const faults = [];
  page.on('pageerror', (e) => faults.push(e.message));
  await page.goto(`${base}/index.html`);
  await page.getByRole('button', { name: 'Choose Alex', exact: true }).waitFor({ timeout: 5000 }).catch(async (error) => { console.error({ faults, requests, gate: await page.locator('.bp-layer').innerText().catch(() => 'no layer') }); throw error; });
  assert.equal(await page.locator('#rows .card:not(.skeleton)').count(), 0, 'No old personal Home behind the gate');
  // Profile art has its own history calls. Home must not request its layout yet.
  assert.equal(requests.some((url) => url.startsWith('/api/ui/home-config')), false, 'Home waits for a selection');
  await page.getByRole('button', { name: 'Choose Alex', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#rows')?.textContent.includes('More Shows'));
  await page.waitForFunction(() => document.querySelectorAll('#rows .skeleton').length === 0);
  const text = await page.locator('#rows').innerText();
  assert.match(text, /Grown title/, 'Returning approved adult gets adult rows');
  assert.match(text, /Fresh grown movie/, 'Fresh shelves survive partial SDUI');
  assert.match(text, /More Movies/, 'Manifest shelves survive partial SDUI');
  assert.equal(await page.locator('#rows .row-title').filter({ hasText: /^Trending Movies$/ }).count(), 1, 'Trending is not duplicated');
  assert.equal(requests.filter((url) => url === '/catalog/movie/blazing-trending-movies.json').length, 1, 'Repeated catalog requested once');
  assert.equal(requests.filter((url) => url === '/catalog/tv/blazing-edu-science.json').length, 1, 'Empty SDUI catalog not retried by manifest');
  assert.ok(await page.locator('#rows .row').count() >= 7, 'Home has more than the four surviving rows');
  console.log('PASS returning approval + partial SDUI: populated, distinct Home shelves');

  await page.evaluate((item) => { toggleMyList(item); renderLibrary(); }, meta('Alex saved movie', 'mature', 'tt301'));
  assert.match(await page.locator('#library-results').innerText(), /Alex saved movie/);
  assert.doesNotMatch(await page.locator('#library-results').innerText(), /Legacy private saved/);
  await page.locator('#profile-connect-button').click();
  await page.getByRole('button', { name: 'Choose Sam', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#rows')?.textContent.includes('More Shows') && document.querySelectorAll('#rows .skeleton').length === 0);
  assert.doesNotMatch(await page.locator('#rows').innerText(), /Grown title|Unrated title|Fresh grown movie|Alex private history/, 'Kids never retain the previous Home or history');
  assert.doesNotMatch(await page.locator('#library-results').innerText(), /Alex saved movie|Legacy private saved/, 'Saved list belongs to this profile');
  await page.evaluate((item) => { toggleMyList(item); renderLibrary(); }, meta('Sam saved movie', 'general', 'tt302'));
  assert.match(await page.locator('#library-results').innerText(), /Sam saved movie/);
  await page.locator('#profile-connect-button').click();
  await page.getByRole('button', { name: 'Choose Alex', exact: true }).click();
  assert.match(await page.locator('#library-results').innerText(), /Alex saved movie/);
  assert.doesNotMatch(await page.locator('#library-results').innerText(), /Sam saved movie/);
  console.log('PASS profile switches: whole Home respects new cap and lists stay separate');

  // Hold a former viewer's response until after a new viewer has taken over.
  holdAdultHistory = true;
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('blazing-profile-selected', { detail: { id: 'adult-one', name: 'Alex', maxRating: 'adult' } })));
  for (let i = 0; i < 200 && !releaseHistory; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(releaseHistory, 'Adult history request started');
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('blazing-profile-selected', { detail: { id: 'kids-two', name: 'Sam', maxRating: 'general' } })));
  await page.waitForFunction(() => document.querySelector('#rows')?.textContent.includes('Sam history'));
  releaseHistory();
  await page.waitForTimeout(100);
  assert.doesNotMatch(await page.locator('#rows').innerText(), /Alex private history/, 'Late history cannot overwrite the active profile');
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('blazing-profile-signed-out')));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#rows .row').count(), 0, 'Logout clears rows and ignores pending requests');
  assert.doesNotMatch(await page.locator('#library-results').innerText(), /saved movie/, 'Logout clears personal saved content');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('blazing-my-list-v2:adult-one')).length), 1, 'Logout preserves the private saved list for its next login');
  assert.deepEqual(faults, [], 'No browser errors');
  console.log('PASS late requests + logout: old personal data cannot reappear');
} finally {
  if (releaseHistory) releaseHistory();
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
