// A temporary source lookup failure offers a working retry, with stale replies ignored.
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
const titles = [
  { id: 'tt301', type: 'movie', name: 'Retry Movie', contentRating: 'general' },
  { id: 'tt302', type: 'movie', name: 'Next Movie', contentRating: 'general' },
  { id: 'tt303', type: 'series', name: 'Episode Show', contentRating: 'general', videos: [
    { id: 'tt303:1:1', season: 1, episode: 1, title: 'First' },
    { id: 'tt303:1:2', season: 1, episode: 2, title: 'Second' },
  ] },
];
const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const source = (id) => ({ streams: [{ name: '1080p', title: `${id}.1080p.H264.AAC.mp4`, url: `https://cdn.example.test/${id}.mp4` }] });
const waitFor = async (ready) => {
  for (let n = 0; n < 500; n++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Expected source request did not start');
};
let browser;
let releaseMovie;
let releaseEpisode;
try {
  browser = await launchBrowser();
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  let movieCalls = 0;
  let holdMovie = false;
  const requests = [];
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/manifest.json') return reply(route, { catalogs: [{ id: 'fixture', type: 'movie', name: 'Test titles' }] });
      if (url.pathname === '/catalog/movie/fixture.json') return reply(route, { metas: titles });
      if (url.pathname.startsWith('/meta/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop().replace('.json', ''));
        return reply(route, { meta: titles.find((title) => title.id === id) });
      }
      if (url.pathname.startsWith('/stream/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop().replace('.json', ''));
        requests.push(id);
        if (id === 'tt301') {
          movieCalls++;
          if (holdMovie) {
            await new Promise((resolve) => { releaseMovie = resolve; });
            return reply(route, { streams: [], retryable: true, error: 'metadata unavailable' }, 503);
          }
          if (movieCalls === 1) return reply(route, { streams: [], retryable: true, error: 'metadata unavailable' }, 503);
        }
        if (id === 'tt303:1:1') {
          await new Promise((resolve) => { releaseEpisode = resolve; });
          return reply(route, { streams: [], retryable: true }, 503);
        }
        return reply(route, source(id));
      }
      return reply(route, { metas: [], items: [], catalogs: [] });
    }
    return reply(route, { metas: [], items: [] });
  });
  await prepareProfile(ctx);
  const page = await ctx.newPage();
  const faults = [];
  page.on('pageerror', (error) => faults.push(error.message));
  await page.goto(`${base}/index.html`);
  await selectProfile(page);
  await page.getByRole('button', { name: 'View Retry Movie', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry sources', exact: true });
  await retry.waitFor();
  assert.match(await page.locator('#detail-status').innerText(), /Sources did not load\. Try again\./);
  await page.screenshot({ path: '/tmp/blazing-source-retry.png' });
  await retry.click();
  await page.locator('#detail-streams .stream-row').waitFor();
  assert.equal(movieCalls, 2, 'Retry makes a fresh lookup for this title');
  assert.match(await page.locator('#detail-streams').innerText(), /tt301/);
  assert.equal(await retry.count(), 0, 'Successful retry replaces the error control');
  console.log('PASS 503 source lookup → real Retry sources click → valid source row');

  await page.locator('#detail-close').click();
  holdMovie = true;
  await page.getByRole('button', { name: 'View Retry Movie', exact: true }).click();
  await waitFor(() => releaseMovie);
  await page.locator('#detail-close').click();
  await page.getByRole('button', { name: 'View Next Movie', exact: true }).click();
  await page.locator('#detail-streams .stream-row').waitFor();
  releaseMovie();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#detail-title').innerText(), 'Next Movie');
  assert.match(await page.locator('#detail-streams').innerText(), /tt302/);
  assert.equal(await retry.count(), 0, 'Old title failure cannot replace current sources');
  console.log('PASS late failure from former title leaves current source rows intact');

  await page.locator('#detail-close').click();
  await page.getByRole('button', { name: 'View Episode Show', exact: true }).click();
  await page.locator('#detail-episode-select').waitFor();
  await waitFor(() => releaseEpisode);
  await page.selectOption('#detail-episode-select', 'tt303:1:2');
  await page.locator('#detail-streams .stream-row').waitFor();
  releaseEpisode();
  await page.waitForTimeout(150);
  assert.match(await page.locator('#detail-streams').innerText(), /tt303:1:2/);
  assert.equal(await retry.count(), 0, 'Old episode failure cannot replace current episode');
  assert.ok(requests.includes('tt303:1:1') && requests.includes('tt303:1:2'));
  assert.deepEqual(faults, [], 'No browser runtime errors');
  console.log('PASS late failure from former episode leaves selected episode intact');
} finally {
  if (releaseMovie) releaseMovie();
  if (releaseEpisode) releaseEpisode();
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
