// "Not out yet": a film that is only in cinemas says so, on the sheet and on Play.
//
// The addon answers such a film with an EMPTY streams array and a top-level
// notice { kind, title, text } — see streamNoticeLine() in app.js. Beside real
// rows the notice is ignored, so the second film proves the list still wins.
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
  { id: 'tt401', type: 'movie', name: 'Cinema Only', contentRating: 'general' },
  { id: 'tt402', type: 'movie', name: 'Out Now', contentRating: 'general' },
];
const LINE = 'Not out yet. In theaters since 12 Sep 2026. Not out on digital yet.';
const notice = { kind: 'theatrical', title: 'Not out yet', text: 'In theaters since 12 Sep 2026. Not out on digital yet.' };
const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

let browser;
try {
  browser = await launchBrowser();
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
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
        if (id === 'tt401') return reply(route, { streams: [], notice });
        return reply(route, { notice, streams: [{ name: '1080p', title: `${id}.1080p.H264.AAC.mp4`, url: `https://cdn.example.test/${id}.mp4` }] });
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

  await page.getByRole('button', { name: 'View Cinema Only', exact: true }).click();
  const status = page.locator('#detail-status');
  await page.waitForFunction((line) => document.querySelector('#detail-status')?.innerText.includes(line), LINE);
  assert.equal(await page.locator('#detail-streams .stream-row').count(), 0);
  console.log('PASS the sheet says Not out yet for a film that is only in cinemas');

  await page.locator('#detail-play').click();
  await page.waitForFunction(() => /Checking direct streams/.test(document.querySelector('#detail-status')?.innerText || '') === false);
  await page.waitForFunction((line) => document.querySelector('#detail-status')?.innerText.includes(line), LINE);
  assert.equal(await page.locator('#player').isHidden(), true, 'Nothing to play, so no player');
  console.log('PASS Play says Not out yet too, and opens no player');

  await page.locator('#detail-close').click();
  await page.getByRole('button', { name: 'View Out Now', exact: true }).click();
  await page.locator('#detail-streams .stream-row').waitFor();
  assert.doesNotMatch(await status.innerText(), /Not out yet/, 'A notice beside real rows is ignored');
  assert.deepEqual(faults, [], 'No browser runtime errors');
  console.log('PASS a notice beside real rows is ignored');
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
