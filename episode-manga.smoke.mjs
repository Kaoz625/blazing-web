/** A web series detail selects real episodes and opens only their mapped manga chapters. */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (value, label, extra = '') => {
  value ? pass++ : fail++;
  console.log(`${value ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const is = (got, want, label) => ok(String(got) === String(want), label,
  String(got) === String(want) ? '' : `(got ${got}, want ${want})`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-1', token: 'tok' }));
});
const seen = [];
const ART = 'https://img.invalid/anime.jpg';
await ctx.route('https://addon.lyreosai.com/**', (route) => {
  const url = route.request().url(); seen.push(url);
  const j = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.includes('/api/ui/home-config')) return j({}, 404);
  if (url.includes('/manifest.json')) return j({ catalogs: [
    { id: 'blazing-anime', type: 'series', name: 'Anime' },
  ] });
  if (url.includes('/catalog/series/blazing-anime.json')) return j({ metas: [{
    id: 'tt9990001', type: 'series', name: 'Titan Story', poster: ART, background: ART,
    isAnime: true, contentRating: 'teen',
  }] });
  if (url.includes('/meta/series/tt9990001.json')) return j({ meta: {
    id: 'tt9990001', type: 'series', name: 'Titan Story', poster: ART, background: ART,
    description: 'Walls and giants.', genres: ['Anime'],
    videos: [
      { id: 'tt9990001:1:1', season: 1, episode: 1, title: 'The Wall' },
      { id: 'tt9990001:1:2', season: 1, episode: 2, title: 'That Day' },
    ],
  } });
  if (url.includes('/stream/series/tt9990001%3A1%3A')) return j({ streams: [
    { url: 'https://cdn.invalid/episode.mp4', name: '1080p', title: 'Episode source' },
  ] });
  if (url.includes('/api/sync/progress/recent')) return j({ items: [] });
  return j({ metas: [], items: [], profiles: [] });
});
await ctx.route('https://fleet.lyreosai.com/**', (route) => {
  const url = route.request().url(); seen.push(url);
  const j = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.includes('/manga/episode-map')) return j({
    schemaVersion: 1,
    anime: { animeId: 'tt9990001', title: 'Titan Story', season: 1, episode: 2 },
    manga: { id: 'm1', title: 'Titan Story', source: 'mangadex' },
    mapping: { exact: false, method: 'estimated', chapterStart: 4, chapterEnd: 5 },
    chapters: [
      { id: 'c4', chapter: 4, title: 'First Battle', pages: 20, readable: true },
      { id: 'c5', chapter: 5, title: 'A Dull Glow', pages: 19, readable: true },
    ],
    error: '',
  });
  if (url.includes('/devices/register')) return j({ ok: true, device: { id: 'dev-1', status: 'approved' }, token: 'tok' });
  if (url.includes('/profiles')) return j({ profiles: [{ id: 'p1', name: 'Mark', maxRating: 'adult', isKids: false, hasPin: false }] });
  return j({ items: [], metas: [] });
});
await ctx.route('https://upscale.lyreosai.com/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
await ctx.route('https://anime-kitsu.strem.fun/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '{"metas":[]}' }));

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  document.dispatchEvent(new CustomEvent('blazing-profile-selected', {
    detail: { id: 'p1', name: 'Mark', maxRating: 'adult', isKids: false },
  }));
  document.querySelectorAll('.bp-layer').forEach((node) => node.remove());
});
await page.waitForSelector('.row-track .card:not(.skeleton)', { timeout: 15000 });
await page.click('.row-track .card:not(.skeleton)');
await page.waitForSelector('#detail-episode-select', { timeout: 10000 });

is(await page.locator('#detail-episode-select option').count(), 2, 'the detail lists both real episodes');
is(await page.locator('#detail-episode-select').inputValue(), 'tt9990001:1:1', 'episode 1 is selected first');
ok(seen.some((url) => url.includes('/stream/series/tt9990001%3A1%3A1.json')),
  'the first episode id fetched streams');
is((await page.locator('#detail-manga').textContent()).trim(), 'Read manga',
  'an Adult anime detail offers the mature-gated manga action');

await page.selectOption('#detail-episode-select', 'tt9990001:1:2');
await page.waitForTimeout(400);
ok(seen.some((url) => url.includes('/stream/series/tt9990001%3A1%3A2.json')),
  'changing the episode changes the stream request');
await page.click('#detail-manga');
await page.waitForSelector('#manga-chapters-dialog[open] #manga-chapters-list .stream-row', { timeout: 10000 });
is((await page.locator('#manga-chapters-status').textContent()).trim(),
  'Estimated match · chapters 4–5', 'an estimate is labelled as an estimate');
is(await page.locator('#manga-chapters-list .stream-row').count(), 2,
  'only the two chapters returned by episode-map are shown');
const mapUrl = seen.find((url) => url.includes('/manga/episode-map')) || '';
ok(mapUrl.includes('animeId=tt9990001') && mapUrl.includes('season=1') && mapUrl.includes('episode=2')
  && mapUrl.includes('absoluteEpisode=2') && mapUrl.includes('episodeTitle=That+Day')
  && mapUrl.includes('episodeCount=2'), 'episode-map receives the full selected episode context');
ok(errors.length === 0, 'no page errors', errors[0] || '');

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
