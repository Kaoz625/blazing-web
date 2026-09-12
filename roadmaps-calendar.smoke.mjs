/* B25 and B12, driven in a real browser against fixture fleet routes.
 *
 * B25 — the Roadmaps chip opened a static product blurb: three fixed <article>
 * cards ("Search", "Source checks", "My list") with no franchise data, no fetch
 * and nothing to press, while the Roku, the Fire Stick and the Apple TV all
 * browsed the same 170 franchises behind the same word.
 * B12 — Calendar did not exist on the web at all, though /calendar has served
 * the whole window the entire time.
 *
 * The unit tests (roadmaps.test.mjs, calendar.test.mjs) hold the rules. THIS
 * file holds the thing the audit was actually about: that the controls on the
 * screen DO something. Every assertion below is a press — open a franchise,
 * cycle the order button and watch the grid re-sort, switch a calendar filter
 * and watch the days change, press a card that has nothing to open.
 *
 *   node roadmaps-calendar.smoke.mjs
 */
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

const ART = 'https://images.example.test/art.png';
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/* ── the roadmap fixture ───────────────────────────────────────────────────
   Shaped to make every rule visible in one franchise:
     · the fleet's chapter order is NOT date order, so Saga and Release differ;
     · it holds films AND series, so "Films first" is offered;
     · one entry is a `tmdb:` id, which must be shown and must not open;
     · one entry is rated above the profile's cap and must vanish, taking its
       whole chapter and its share of the counts with it. */
const FILM = (id, name, year, date, runtime) => ({ id, type: 'movie', name, year, date, runtime, poster: ART, backdrop: ART, overview: `${name} synopsis.` });
const SHOW = (id, name, year, date, seasons) => ({ id, type: 'series', name, year, date, seasons, poster: ART, backdrop: ART, overview: `${name} synopsis.` });

const STAR_WARS = {
  slug: 'star-wars', name: 'Star Wars', overview: 'A long time ago in a galaxy far, far away.',
  backdrop: ART, poster: ART, titles: 6, films: 4, series: 2,
  chapters: [
    { name: 'The Prequels', items: [
      FILM('tt-tpm', 'The Phantom Menace', '1999', '1999-05-19', 136),
      FILM('tt-rots', 'Revenge of the Sith', '2005', '2005-05-19', 140),
    ] },
    { name: 'The Original Run', items: [
      FILM('tt-anh', 'A New Hope', '1977', '1977-05-25', 121),
      SHOW('tt-and', 'Andor', '2022', '2022-09-21', 2),
      SHOW('tmdb:114461', 'Ahsoka', '2023', '2023-08-22', 1),
    ] },
    // Dropped whole by the teen cap below.
    { name: 'Extras', items: [FILM('tt-adult', 'Adult Special', '2024', '2024-01-01', 90)] },
  ],
};
const ROCKY = {
  slug: 'rocky-and-creed', name: 'Rocky & Creed', overview: '', poster: ART,
  titles: 1, films: 1, series: 0,
  chapters: [{ name: 'In Order', items: [FILM('tt-rocky', 'Rocky', '1976', '1976-11-21', 120)] }],
};
const INDEX = {
  roadmaps: [
    { slug: 'star-wars', name: 'Star Wars', overview: STAR_WARS.overview, backdrop: ART, titles: 6, films: 4, series: 2, chapters: 3 },
    { slug: 'rocky-and-creed', name: 'Rocky & Creed', overview: '', poster: ART, titles: 1, films: 1, series: 0, chapters: 1 },
  ],
};

/* ── the calendar fixture ──────────────────────────────────────────────────
   Built around the RUNNING day so the relative labels are real. The harness and
   the browser are the same machine in the same zone, so a local-time day here
   is the same day calendar.js computes. */
const DAY_MS = 86400000;
const localDay = (offset) => {
  const at = new Date();
  at.setHours(12, 0, 0, 0);
  const shifted = new Date(at.getTime() + offset * DAY_MS);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, '0');
  const d = String(shifted.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};
const CAL_DAY = (offset, items) => ({ date: localDay(offset), weekday: 'Mon', today: offset === 0, items });
const CALENDAR = {
  window: { from: localDay(-30), to: localDay(30), today: localDay(0), tz: 'UTC' },
  days: [
    // Deliberately in the fleet's own plain ascending order, oldest first —
    // which is what opens the screen on a week of history unless it is re-ordered.
    CAL_DAY(-5, [{ id: 'tt-old', kind: 'movie', name: 'Old Release', poster: ART, when: `${localDay(-5)}T00:00:00Z`, date: localDay(-5), exactTime: false, subtitle: 'In theaters', openable: true }]),
    CAL_DAY(-1, [{ id: 'mangadex:9', kind: 'manga', name: 'Chapter 220', poster: ART, when: `${localDay(-1)}T04:00:00Z`, date: localDay(-1), exactTime: true, subtitle: 'Ch. 220', openable: false }]),
    CAL_DAY(0, [{ id: 'tt-today', kind: 'movie', name: 'Out Today', poster: ART, when: `${localDay(0)}T00:00:00Z`, date: localDay(0), exactTime: false, subtitle: 'In theaters', openable: true }]),
    CAL_DAY(1, [{ id: 'anilist:7', kind: 'anime', name: 'Airing Anime', poster: ART, when: `${localDay(1)}T23:30:00Z`, date: localDay(1), exactTime: true, subtitle: 'Ep 12', openable: true }]),
    CAL_DAY(5, [{ id: 'tt-season', kind: 'series', name: 'New Season', poster: ART, when: `${localDay(5)}T00:00:00Z`, date: localDay(5), exactTime: false, subtitle: 'S3 E1', openable: true }]),
  ],
};

let browser;
let failed = 0;
const ok = (condition, label, extra = '') => {
  if (condition) console.log(`ok    ${label}${extra ? '  ' + extra : ''}`);
  else { failed += 1; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

try {
  browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-rc', token: 'tok' }));
    localStorage.setItem('profileId', 'teen-one');
    localStorage.setItem('blazing-household-approved', '1');
  });

  const seen = [];
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    seen.push(url.pathname + url.search);
    if (url.hostname === 'images.example.test') {
      return route.fulfill({ contentType: 'image/png', body: await readFile(join(ROOT, 'icon-192.png')) });
    }
    if (url.hostname === 'fleet.lyreosai.com') {
      if (url.pathname === '/profiles') {
        return json(route, { profiles: [{ id: 'teen-one', name: 'Robin', maxRating: 'teen', hasPin: false }] });
      }
      if (url.pathname === '/accounts/me') return json(route, { account: { id: 'acc', name: 'Fixture' }, device: { id: 'dev-rc', enrollmentStatus: 'approved' } });
      if (url.pathname === '/roadmaps') return json(route, INDEX);
      if (url.pathname === '/roadmaps/star-wars') return json(route, STAR_WARS);
      if (url.pathname === '/roadmaps/rocky-and-creed') return json(route, ROCKY);
      if (url.pathname === '/calendar') return json(route, CALENDAR);
      // Only one title in the whole fixture is rated above a teen cap.
      if (url.pathname.startsWith('/rating/')) {
        return json(route, url.pathname.endsWith('/tt-adult')
          ? { certification: 'NC-17', tier: 'adult' }
          : { certification: '', tier: '' });
      }
      if (url.pathname.startsWith('/profiles/')) return json(route, { items: [], watchlist: [], collection: [], watched: [] });
      if (url.pathname.startsWith('/emby/')) return json(route, { metas: [] });
      return json(route, {});
    }
    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/manifest.json') return json(route, { catalogs: [{ id: 'blazing-movies', type: 'movie', name: 'Movies' }] });
      if (url.pathname === '/api/sync/progress/recent') return json(route, { items: [] });
      if (url.pathname.startsWith('/catalog/')) return json(route, { metas: [] });
      return json(route, {});
    }
    return json(route, {});
  });

  const page = await ctx.newPage();
  const faults = [];
  page.on('pageerror', (error) => faults.push(error.message));
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });

  const tile = page.locator('.bp-profile').first();
  await tile.waitFor({ timeout: 8000 });
  await tile.click();
  await page.waitForTimeout(900);

  // ── B25, the index ──────────────────────────────────────────────────────
  await page.evaluate(() => document.querySelector('.topnav [data-view="roadmaps"]').click());
  await page.waitForSelector('#roadmaps-grid .roadmap-card', { timeout: 8000 });

  const index = await page.evaluate(() => ({
    heading: document.querySelector('#roadmaps-view .page-heading h1').textContent.trim(),
    blurb: document.querySelector('#roadmaps-view .page-heading p:last-of-type').textContent.trim(),
    cards: [...document.querySelectorAll('#roadmaps-grid .roadmap-card')].map((card) => ({
      name: card.querySelector('.roadmap-card-name').textContent,
      meta: card.querySelector('.roadmap-card-meta').textContent,
    })),
    // The three static blurb cards this screen used to be.
    stale: document.querySelector('#roadmaps-view').textContent.includes('Source checks'),
    hint: document.getElementById('roadmaps-hint').textContent.trim(),
  }));
  ok(index.heading === 'Franchise Roadmaps', 'the heading is the one the three televisions print', `(${index.heading})`);
  ok(index.blurb === 'Every film and series in a universe, in the order worth watching them.', 'and so is the line under it');
  ok(!index.stale, 'the static "What is next" blurb is gone');
  ok(index.cards.length === 2, 'the fleet index is drawn as franchise cards', `(${index.cards.length})`);
  ok(index.cards[0].name === 'Star Wars' && index.cards[0].meta === '6 titles  ·  3 chapters  ·  4 films, 2 series',
    'a card caption is the televisions\' caption', `(${index.cards[0].meta})`);
  ok(index.cards[1].meta === '1 titles', 'a films-only franchise says nothing about series', `(${index.cards[1].meta})`);
  ok(index.hint === '2 franchises', 'the index says how many there are', `(${index.hint})`);

  // ── B25, one franchise ──────────────────────────────────────────────────
  await page.locator('#roadmaps-grid .roadmap-card').first().click();
  await page.waitForSelector('#roadmap-chapters .roadmap-chapter', { timeout: 8000 });

  const saga = await page.evaluate(() => ({
    name: document.getElementById('roadmap-name').textContent,
    stats: document.getElementById('roadmap-stats').textContent,
    order: document.getElementById('roadmap-order').textContent,
    indexHidden: document.getElementById('roadmaps-index').hidden,
    chapters: [...document.querySelectorAll('#roadmap-chapters .roadmap-chapter')].map((s) => ({
      name: s.querySelector('.row-title').textContent,
      sub: s.querySelector('.roadmap-chapter-sub').textContent,
      positions: [...s.querySelectorAll('.roadmap-pos')].map((p) => p.textContent),
      titles: [...s.querySelectorAll('.card-label')].map((l) => l.textContent),
    })),
    dimmed: [...document.querySelectorAll('#roadmap-chapters .card.roadmap-unplayable')].map((c) => ({
      label: c.querySelector('.card-label').textContent, disabled: c.disabled,
    })),
  }));
  ok(saga.indexHidden, 'opening a franchise replaces the index rather than stacking on it');
  ok(saga.name === 'Star Wars', 'the franchise name is the header', `(${saga.name})`);
  ok(saga.chapters.length === 2, 'the chapter emptied by the rating cap is dropped, not drawn bare', `(${saga.chapters.length})`);
  ok(saga.stats === '5 titles  ·  3 films, 2 series  ·  6h 37m of film',
    'the stats line is recomputed from what survived the cap', `(${saga.stats})`);
  ok(saga.chapters[0].name === 'The Prequels' && saga.chapters[1].name === 'The Original Run',
    'saga order is the fleet\'s order, not date order', `(${saga.chapters.map((c) => c.name).join(' / ')})`);
  ok(saga.chapters[0].sub === '1999 - 2005  ·  2 titles', 'a chapter subline is its years and its count', `(${saga.chapters[0].sub})`);
  ok(saga.chapters[0].positions.join(',') === '1,2' && saga.chapters[1].positions.join(',') === '3,4,5',
    'the numbering runs continuously across chapters',
    `(${saga.chapters.map((c) => c.positions.join(',')).join(' | ')})`);
  ok(saga.dimmed.length === 1 && saga.dimmed[0].label === 'Ahsoka' && saga.dimmed[0].disabled,
    'a tmdb: entry is shown, dimmed and cannot be pressed', `(${JSON.stringify(saga.dimmed)})`);
  ok(!saga.chapters.some((c) => c.titles.includes('Adult Special')), 'the title above the cap is not on the screen');

  // The order button is a real control: it re-sorts, and the wire is untouched.
  const before = seen.length;
  await page.locator('#roadmap-order').click();
  await page.waitForTimeout(300);
  const release = await page.evaluate(() => ({
    order: document.getElementById('roadmap-order').textContent,
    chapters: [...document.querySelectorAll('#roadmap-chapters .roadmap-chapter')].map((s) => ({
      name: s.querySelector('.row-title').textContent,
      titles: [...s.querySelectorAll('.card-label')].map((l) => l.textContent),
    })),
  }));
  ok(saga.order === 'Saga order', 'the order button opens on Saga order', `(${saga.order})`);
  ok(release.order === 'Release order', 'and one press moves it to Release order', `(${release.order})`);
  ok(release.chapters.length === 1 && release.chapters[0].name === 'Release order',
    'release order is one flat section', `(${release.chapters.map((c) => c.name).join(' / ')})`);
  ok(release.chapters[0].titles.join(' | ') === 'A New Hope | The Phantom Menace | Revenge of the Sith | Andor | Ahsoka',
    'and it really is in date order', `(${release.chapters[0].titles.join(' | ')})`);
  ok(seen.length === before, 'changing the order costs nothing on the wire', `(${seen.length - before} requests)`);

  await page.locator('#roadmap-order').click();
  await page.waitForTimeout(300);
  const films = await page.evaluate(() => ({
    order: document.getElementById('roadmap-order').textContent,
    chapters: [...document.querySelectorAll('#roadmap-chapters .roadmap-chapter')].map((s) => ({
      name: s.querySelector('.row-title').textContent,
      positions: [...s.querySelectorAll('.roadmap-pos')].map((p) => p.textContent),
    })),
  }));
  ok(films.order === 'Films first', 'a roadmap holding both kinds offers the third order', `(${films.order})`);
  ok(films.chapters.map((c) => c.name).join(',') === 'Films,Series',
    'and it is two sections, so the grouping is visible', `(${films.chapters.map((c) => c.name).join(',')})`);
  ok(films.chapters[0].positions.join(',') === '1,2,3' && films.chapters[1].positions.join(',') === '4,5',
    'the numbering still runs continuously across the two',
    `(${films.chapters.map((c) => c.positions.join(',')).join(' | ')})`);

  // Three stops, and it wraps rather than ending.
  await page.locator('#roadmap-order').click();
  await page.waitForTimeout(300);
  ok(await page.locator('#roadmap-order').textContent() === 'Saga order', 'the order button wraps back round');

  // A films-only roadmap must not offer an order that would sort nothing.
  await page.locator('#roadmap-back').click();
  await page.waitForTimeout(200);
  await page.locator('#roadmaps-grid .roadmap-card').nth(1).click();
  await page.waitForSelector('#roadmap-chapters .roadmap-chapter', { timeout: 8000 });
  const rocky = await page.evaluate(() => ({
    disabled: document.getElementById('roadmap-order').disabled,
    stats: document.getElementById('roadmap-stats').textContent,
  }));
  ok(!rocky.disabled, 'a films-only roadmap still has Saga and Release, so the button stays live');
  ok(rocky.stats === '1 title  ·  1 films  ·  2h 0m of film', 'its stats line drops the series clause', `(${rocky.stats})`);

  // A playable entry opens the ordinary detail sheet — the same one a Home card
  // opens. That is the whole point of the fleet resolving IMDb ids server-side.
  await page.locator('#roadmap-chapters .card:not(.roadmap-unplayable)').first().click();
  await page.waitForTimeout(600);
  const sheet = await page.evaluate(() => ({
    open: document.getElementById('detail-dialog').open,
    title: document.getElementById('detail-title').textContent,
  }));
  ok(sheet.open && sheet.title === 'Rocky', 'a roadmap card opens the ordinary detail sheet', `(${sheet.title})`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ── B12, the calendar ───────────────────────────────────────────────────
  /* Clicked through the DOM rather than through the pointer: Calendar is a
     drawer destination and the drawer is shut, so a real click would wait for a
     button that is deliberately off screen. navparity.smoke.mjs reaches the
     other drawer-only destinations the same way. */
  await page.evaluate(() => document.querySelector('.drawer-nav [data-view="calendar"]').click());
  await page.waitForSelector('#calendar-days .result-row', { timeout: 8000 });
  const calendarCalls = seen.filter((u) => u.startsWith('/calendar')).length;

  const cal = await page.evaluate(() => ({
    heading: document.querySelector('#calendar-view .page-heading h1').textContent.trim(),
    status: document.getElementById('calendar-status').textContent,
    rows: [...document.querySelectorAll('#calendar-days .result-row')].map((row) => ({
      day: row.querySelector('.row-title').textContent,
      titles: [...row.querySelectorAll('.card-label')].map((l) => l.textContent),
      metas: [...row.querySelectorAll('.calendar-entry-meta')].map((m) => m.textContent),
    })),
    tabs: [...document.querySelectorAll('#calendar-tabs [data-calendar-kind]')].map((b) => b.textContent),
  }));
  ok(cal.heading === 'Calendar', 'the calendar has a heading like every other view', `(${cal.heading})`);
  ok(cal.tabs.join(',') === 'All,Movies,TV Shows,Anime,Manga', 'the five filters are the Roku\'s five, in its order', `(${cal.tabs.join(',')})`);
  ok(cal.rows.map((r) => r.day).join(',') === `Today,Tomorrow,Yesterday,${cal.rows[3].day},${cal.rows[4].day}`,
    'today comes first, then tomorrow, then yesterday', `(${cal.rows.map((r) => r.day).join(',')})`);
  ok(cal.rows.length === 5, 'every day with something on it is a row', `(${cal.rows.length})`);
  ok(cal.status === '5 in the next few weeks', 'the status line counts what is on screen', `(${cal.status})`);
  ok(cal.rows[0].metas[0] === 'In theaters',
    'a date with no clock time prints no hour at all', `(${cal.rows[0].metas[0]})`);
  ok(cal.rows[1].metas[0] === 'Ep 12   ·   11:30 pm',
    'a real airing time prints as twelve-hour with am/pm', `(${cal.rows[1].metas[0]})`);

  // Switching a filter must not cost a second round trip.
  await page.locator('#calendar-tabs [data-calendar-kind="anime"]').click();
  await page.waitForTimeout(400);
  const filtered = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#calendar-days .result-row')].map((row) => row.querySelector('.row-title').textContent),
    titles: [...document.querySelectorAll('#calendar-days .card-label')].map((l) => l.textContent),
    status: document.getElementById('calendar-status').textContent,
    selected: [...document.querySelectorAll('#calendar-tabs [data-calendar-kind]')]
      .filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => b.textContent).join(','),
  }));
  ok(filtered.titles.join(',') === 'Airing Anime', 'the Anime filter narrows the whole window', `(${filtered.titles.join(',')})`);
  ok(filtered.rows.join(',') === 'Tomorrow', 'and drops every day it emptied', `(${filtered.rows.join(',')})`);
  ok(filtered.selected === 'Anime', 'the chosen filter is the marked one', `(${filtered.selected})`);
  ok(seen.filter((u) => u.startsWith('/calendar')).length === calendarCalls,
    'filtering is local — the fleet already sent the whole window');

  // A manga chapter has no details page. Pressing it says so rather than
  // opening an empty sheet.
  await page.locator('#calendar-tabs [data-calendar-kind="manga"]').click();
  await page.waitForTimeout(400);
  await page.locator('#calendar-days .card').first().click();
  await page.waitForTimeout(400);
  const manga = await page.evaluate(() => ({
    toast: (document.querySelector('.toast-host')?.textContent || '').trim(),
    sheet: document.getElementById('detail-dialog').open,
    dimmed: document.querySelectorAll('#calendar-days .card.calendar-unopenable').length,
  }));
  ok(!manga.sheet, 'pressing a manga chapter does not open an empty detail sheet');
  ok(manga.toast === 'Chapter 220 — released, nothing to open here.',
    'it says what it is instead', `(${manga.toast})`);
  ok(manga.dimmed === 1, 'and the card was dimmed before the press', `(${manga.dimmed})`);

  // An openable calendar card reaches the same sheet every other card does.
  await page.locator('#calendar-tabs [data-calendar-kind="movie"]').click();
  await page.waitForTimeout(400);
  await page.locator('#calendar-days .card').first().click();
  await page.waitForTimeout(600);
  const calSheet = await page.evaluate(() => ({
    open: document.getElementById('detail-dialog').open,
    title: document.getElementById('detail-title').textContent,
  }));
  ok(calSheet.open && calSheet.title === 'Out Today', 'an openable calendar card opens the detail sheet', `(${calSheet.title})`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  ok(faults.length === 0, 'neither screen threw', faults.slice(0, 2).join(' ; '));
  assert.equal(failed, 0, `${failed} assertion(s) failed`);
  console.log('\nroadmaps + calendar: all checks passed');
} finally {
  await browser?.close();
  server.close();
}
process.exit(failed ? 1 : 0);
