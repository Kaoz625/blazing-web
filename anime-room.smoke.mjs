import { launchBrowser } from './comet.mjs';
import { prepareProfile, selectProfile } from './scripts/profile-fixture.mjs';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const OUTPUT = process.env.ANIME_REVIEW_DIR || '/tmp/blazing-anime-room-review';
await mkdir(OUTPUT, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try { const file = join(ROOT, path === '/' ? 'index.html' : path); res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/json' }).end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const art = await readFile(process.env.BW_PROFILE_ART || '/Users/markususche/Desktop/roku channels/images/profiles/kids-backdrop.jpg').catch(() => readFile(join(ROOT, 'icon-192.png')));
const manga = { id: 'm1', title: 'Skyward — reader fixture', description: 'An illustrated story used to check the reader.', year: '2025', status: 'ongoing', cover: 'https://art.invalid/cover.jpg', source: 'Fixture' };
const anime = Array.from({ length: 12 }, (_, i) => ({ id: `tt90010${String(i).padStart(2, '0')}`, type: 'series', name: `${i === 0 ? 'Skyward' : `Story ${i + 1}`} — test title`, description: 'A journey through distant worlds, and the people who make them feel like home.', year: '2025', contentRating: 'teen', poster: 'https://art.invalid/cover.jpg', background: i === 0 ? 'https://art.invalid/backdrop.jpg' : '' }));
const comic = { id: 'c1', name: 'Comic reader fixture', poster: 'https://art.invalid/comic.jpg' };
let failures = 0;
const report = [];
function check(name, pass, detail = '') { report.push({ name, pass, detail }); if (!pass) ++failures; console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); }
const browser = await launchBrowser({ timeoutMs: Number(process.env.ANIME_BROWSER_TIMEOUT_MS || 120000) });
const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const calls = [];
let comicOutage = false;
let catalogMode = 'normal';
let releaseSlow;
const errors = [];
await ctx.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === base) return route.continue();
  calls.push(url.href);
  const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  if (route.request().resourceType() === 'image') return route.fulfill({ status: 200, contentType: 'image/jpeg', body: art });
  if (url.pathname.startsWith('/discover/cat/anime/')) {
    if (url.pathname.endsWith('/comedy')) return json({ error: 'offline' }, 503);
    return json({ name: 'Explore anime', items: catalogMode === 'normal' ? anime : [{ ...anime[0], id: catalogMode === 'restricted' ? 'tt9002002' : 'tt9002000', contentRating: '', background: '', description: '' }] });
  }
  if (url.pathname.includes('/catalog/anime/')) return json({ metas: [catalogMode === 'restricted' ? { ...anime[0], id: 'tt9002001', contentRating: '' } : catalogMode === 'kitsu' ? { ...anime[0], id: 'kitsu:100', name: 'Fullmetal Alchemist' } : anime[0]] });
  if (url.hostname === 'anime-kitsu.strem.fun' && url.pathname.startsWith('/meta/')) return json({ meta: {
    ...anime[0], id: 'kitsu:100', type: 'series', name: 'Fullmetal Alchemist',
    videos: [{ id: 'kitsu:100:1', season: 1, episode: 1, title: 'To Challenge the Sun' }, { id: 'kitsu:100:2', season: 1, episode: 2, title: 'Body of the Sanctioned' }, { id: 'kitsu:100:3', title: 'Mother' }],
  } });
  if (url.pathname === '/manga/discover') return json({ popular: [manga], latest: [manga] });
  if (url.pathname === '/manga/search') return json({ manga: [manga] });
  if (url.pathname === '/comics/search') return comicOutage ? json({}, 503) : json({ comics: [comic] });
  if (url.pathname === '/comics/discover') return json({ popular: [comic], latest: [{ ...comic, id: 'c2', name: 'New comic fixture' }] });
  if (url.pathname === '/manga/m1/chapters') return json({ chapters: [{ id: 'ch1', chapter: '1', title: 'Start here', pages: 3, readable: true }] });
  if (url.pathname === '/manga/slow/chapters') {
    await new Promise((resolve) => { releaseSlow = resolve; });
    return json({ chapters: [{ id: 'late', chapter: '99', pages: 1, readable: true }] });
  }
  if (url.pathname.endsWith('/pages')) return json({ pages: ['https://art.invalid/p1.jpg', 'https://art.invalid/p2.jpg', 'https://art.invalid/p3.jpg'] });
  if (url.pathname.startsWith('/meta/')) return json({ meta: { ...anime[0], background: catalogMode === 'poster' ? '' : anime[0].background, contentRating: catalogMode === 'restricted' ? 'adult' : 'teen', videos: [{ id: `${anime[0].id}:1:1`, season: 1, episode: 1, title: 'First episode' }] } });
  if (url.pathname === '/party/active') return route.fulfill({ status: 204 });
  return json({ catalogs: [], metas: [], items: [], events: [] });
});
await prepareProfile(ctx, { id: 'reader-a', name: 'Reader', maxRating: 'adult', isKids: false });
const page = await ctx.newPage();
page.on('pageerror', (error) => errors.push(String(error)));
page.setDefaultTimeout(30000);
try {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await selectProfile(page, 'Reader');
  await page.locator('.topnav [data-view="anime"]').click();
  await page.waitForSelector('#anime-room-results .card');
  check('Anime opens its own room, outside Home', await page.locator('#home-view').isHidden() && await page.locator('#anime-room-header').isVisible());
  check('All catalog titles render', await page.locator('#anime-room-results .card').count() === 12);
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    const metrics = await page.evaluate(() => {
      const targets = [...document.querySelectorAll('#anime-room-header button, #anime-room-header input, #anime-room-view button')].filter((el) => el.getClientRects().length);
      const primary = [...document.querySelectorAll('#anime-room-search button, #anime-room-query, .anime-feature-actions button')];
      return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1, clipped: primary.filter((el) => { const r = el.getBoundingClientRect(); return r.left < 0 || r.right > document.documentElement.clientWidth + 1; }).map((el) => el.textContent), small: targets.map((el) => ({ label: el.textContent.trim(), width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })).filter((el) => el.width < 44 || el.height < 44), motion: matchMedia('(prefers-reduced-motion: reduce)').matches };
    });
    check(`${width}: no horizontal overflow`, !metrics.overflow);
    check(`${width}: search and feature controls are fully inside the viewport`, metrics.clipped.length === 0, JSON.stringify(metrics.clipped));
    check(`${width}: controls at least44px`, metrics.small.length === 0, JSON.stringify(metrics.small));
    check(`${width}: reduced motion supported`, metrics.motion);
    await page.screenshot({ path: join(OUTPUT, `anime-fixture-${width}.png`), fullPage: true, animations: 'disabled', timeout: 60000 });
  }
  await page.locator('#anime-room-query').focus(); await page.keyboard.press('Tab');
  check('Search works with keyboard focus', await page.locator('#anime-room-search button').evaluate((el) => el === document.activeElement));
  await page.locator('#anime-room-query').fill('Skyward'); await page.locator('#anime-room-search button').click();
  await page.waitForFunction(() => document.querySelectorAll('#anime-room-results .anime-room-shelf').length === 3);
  check('One query returns anime, manga and comics', (await page.locator('#anime-room-results .row-title').allTextContents()).join(',') === 'Anime,Manga,Comics');
  await page.getByRole('button', { name: 'See chapters for Skyward — reader fixture', exact: true }).click();
  await page.locator('#manga-chapters-list [role="button"]').click();
  await page.waitForFunction(() => window.BlazingManga.history()[0]?.index === 0);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.waitForFunction(() => window.BlazingManga.history()[0]?.index === 1);
  check('Reading saves only after a page image loads', await page.locator('#manga-reader .comic-counter').textContent() === '2 / 3');
  await page.locator('#manga-reader .comic-close').click();
  check('Closing the reader returns to its chapter button', await page.locator('#manga-chapters-list [role="button"]').evaluate((el) => el === document.activeElement));
  await page.locator('#manga-chapters-close').click();
  await page.locator('[data-room-view="manga"]').click();
  await page.locator('#manga-continue .manga-history-item').click();
  await page.waitForFunction(() => document.querySelector('#manga-reader .comic-counter').textContent === '2 / 3');
  check('Continue reading reopens the exact chapter and page', true);
  await page.locator('#manga-reader .comic-close').click();
  check('Closing a resumed chapter returns to its refreshed reading card', await page.locator('#manga-continue .manga-history-item').evaluate((el) => el === document.activeElement));
  catalogMode = 'kitsu';
  await page.locator('#anime-room-query').fill('Fullmetal Alchemist'); await page.locator('#anime-room-search button').click();
  await page.locator('#anime-room-results [data-anime-id="kitsu:100"]').click();
  await page.waitForSelector('#detail-episode-select');
  check('Kitsu search hydrates its own real-shaped episode metadata', await page.locator('#detail-episode-select option').count() === 3 && calls.some((url) => url.includes('anime-kitsu.strem.fun/meta/anime/kitsu%3A100.json')));
  check('A Kitsu ID without a season field remains season 1', (await page.locator('#detail-episode-select option').last().textContent()).startsWith('S1 E3'));
  const episodeRequest = page.waitForRequest((req) => req.url().includes('/stream/series/kitsu%3A100%3A2.json'));
  await page.locator('#detail-episode-select').selectOption('kitsu:100:2'); await episodeRequest;
  check('Choosing a Kitsu episode preserves its full stream ID', true);
  await page.locator('#detail-close').click();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('blazing-profile-selected', { detail: { id: 'reader-b', name: 'Other reader', maxRating: 'adult', isKids: false } })));
  check('Another Adult profile has no inherited reading history', await page.evaluate(() => window.BlazingManga.history().length === 0));
  catalogMode = 'poster';
  await page.locator('[data-room-view="anime"]').click();
  await page.waitForSelector('.anime-feature-cover');
  check('A missing backdrop uses the cover, without requesting the fleet root as an image', await page.locator('.anime-feature-art').count() === 0);
  catalogMode = 'restricted';
  const ratingResponse = page.waitForResponse((response) => response.url().includes('/meta/series/tt9002002.json'));
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('blazing-profile-selected', { detail: { id: 'teen', name: 'Teen', maxRating: 'teen', isKids: false } })));
  await ratingResponse;
  await page.waitForFunction(() => document.querySelectorAll('#anime-room-results .anime-room-shelf').length > 0 && document.querySelectorAll('#anime-room-results .card').length === 0);
  check('Hydrated Adult ratings remove both the hero and the clickable card for a Teen', await page.locator('#anime-room-feature').isHidden());
  await page.locator('#anime-room-query').fill('Restricted title');
  await page.locator('#anime-room-search button').click();
  await page.waitForSelector('#anime-room-results .card');
  const detailsResponse = page.waitForResponse((response) => response.url().includes('/meta/series/tt9002001.json'));
  await page.locator('#anime-room-results .card').first().click();
  await detailsResponse;
  await page.waitForFunction(() => !document.getElementById('detail-dialog').open);
  check('A newly learned Adult rating blocks a Teen before any stream request', !calls.some((url) => url.includes('/stream/') && url.includes('tt9002001')));
  catalogMode = 'normal';
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('blazing-profile-selected', { detail: { id: 'reader-b', name: 'Other reader', maxRating: 'adult', isKids: false } })));
  await page.evaluate(() => window.BlazingManga.openTitle({ id: 'slow', title: 'Old pending title' }));
  await page.waitForFunction(() => document.getElementById('manga-chapters-title').textContent === 'Old pending title');
  await page.evaluate(() => window.BlazingManga.openTitle({ id: 'm1', title: 'New title' }));
  await page.waitForSelector('#manga-chapters-list [role="button"]');
  const slowResponse = page.waitForResponse((response) => response.url().includes('/manga/slow/chapters'));
  releaseSlow?.();
  await slowResponse;
  check('Late chapter reply cannot replace another title', !(await page.locator('#manga-chapters-list').textContent()).includes('99'));
  await page.locator('#manga-chapters-close').click();
  comicOutage = true;
  await page.locator('#anime-room-query').fill('Skyward'); await page.locator('#anime-room-search button').click();
  await page.waitForFunction(() => document.getElementById('anime-room-status').textContent.includes('Comics search could not'));
  check('A failed library keeps the other search results and explains the failure', await page.locator('#anime-room-results .anime-room-shelf').count() === 2);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('blazing-profile-selected', { detail: { id: 'kid', name: 'Child', maxRating: 'general', isKids: true } })));
  const before = calls.length;
  await page.locator('#anime-room-query').fill('Skyward'); await page.locator('#anime-room-search button').click();
  await page.waitForFunction(() => document.getElementById('anime-room-status').textContent.includes('need a Mature'));
  check('Kids search never asks unrated reading sources', !calls.slice(before).some((url) => /\/(manga|comics)\/search/.test(url)));
  await page.locator('[data-room-view="comics"]').click();
  check('The comics route also enforces the profile gate', (await page.locator('#comics-rows').textContent()).includes('Mature'));
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('blazing-profile-signed-out')));
  check('Sign-out clears all collection and reader content', await page.locator('#anime-room-results .card').count() === 0 && await page.locator('#manga-reader').isHidden());
  check('No JavaScript errors', errors.length === 0, errors.join(' | '));
} finally {
  releaseSlow?.();
  await writeFile(join(OUTPUT, 'report.json'), JSON.stringify({ failures, checks: report, errors }, null, 2));
  await ctx.close(); await browser.close(); await new Promise((resolve) => server.close(resolve));
}
if (failures) process.exitCode = 1;
