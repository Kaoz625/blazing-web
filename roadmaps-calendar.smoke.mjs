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

/* ── THE ZONE IS PINNED, AND THAT IS THE WHOLE POINT OF THE CLOCK CHECKS ───
 *
 * The calendar fixture below can only tell the FIXED calendar.js from the
 * broken one OFF UTC. In Greenwich the old string-slicing clockOf() and the new
 * Date-based one print the same hour and the fleet's UTC bucket IS the viewer's
 * day, so every timezone assertion in this file passes on the defective code —
 * a guard that reports safety it does not have.
 *
 * MEASURED, 12 Sep 2026, this exact fixture run against `git show
 * HEAD:calendar.js` (the pre-fix string-slicing clockOf and no localDays):
 *   TZ=UTC                  days "Today,Tomorrow,Yesterday,18 Sep,8 Sep", row 1
 *                           "Ep 12 · 7:30 pm" under "Tomorrow" — all four
 *                           timezone assertions PASS on the defective code.
 *   TZ=America/Los_Angeles  days "Today,Yesterday,14 Sep,17 Sep,7 Sep", row 1
 *                           "Ch. 220 · 3:00 pm" under "Yesterday" — all four
 *                           FAIL. (3:00 pm is the 8am airing's UTC hour printed
 *                           raw, which is the defect itself.)
 *
 * .github/workflows/pages.yml:173 is `run: npm test`, which reaches
 * scripts/run-smokes.mjs and every *.smoke.mjs in the directory, and the whole
 * workflow sets no TZ anywhere (grepped). GitHub-hosted runners are UTC — so
 * without this line the CI run is the first column. Los Angeles rather than New York because the anime row is pinned to
 * 19:30 local: at -7 (and at -8 in winter) that is 02:30 UTC the NEXT day, so
 * the fleet's bucket and the viewer's day genuinely disagree and localDays() is
 * under test too, not just clockOf(). New York at -4 would leave 23:30 UTC on
 * the same date and only the clock half would discriminate.
 *
 * BOTH HALVES, and they must agree: process.env.TZ is the Node half (the
 * fixture's local wall-clock times are built here) and timezoneId on the
 * context is the browser half. Node honours a runtime TZ assignment from v16 on
 * — verified on v25.9.0 — and this line runs before the first Date in the file.
 * The harness asserts both reads out loud below, because a silently ignored
 * override would put the fixture and the page back in two different frames and
 * the failure would look like a product defect. */
const TZ = 'America/Los_Angeles';
process.env.TZ = TZ;

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
   is the same day calendar.js computes.

   AND THE TIMED ROWS ARE BUCKETED THE WAY THE FLEET BUCKETS THEM: in UTC. The
   response says so in its own window — `tz: 'UTC'`, with the note "Days are
   bucketed in UTC. Re-bucket from each item's `when` if you need local days."
   An airing at 7:30 in the viewer's evening is already TOMORROW in UTC for most
   of the western hemisphere, so a fixture that files it under the local day
   cannot see the defect this is here to catch: the screen used to print the UTC
   hour under a local day name, two halves of one card in two time frames. */
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
/* A row with a REAL clock (exactTime:true — anime and manga, and nothing else),
   pinned to a local wall-clock time, with the UTC day the fleet would file it
   under. `utcDay` is `localDay(offset)` in Greenwich and one day either side of
   it elsewhere, which is the whole point. */
const airing = (offset, hour, minute) => {
  const at = new Date();
  at.setHours(12, 0, 0, 0);
  const when = new Date(at.getTime() + offset * DAY_MS);
  when.setHours(hour, minute, 0, 0);
  const iso = when.toISOString();
  return { iso, utcDay: iso.slice(0, 10) };
};
const MANGA_AT = airing(-1, 8, 0);
const ANIME_AT = airing(1, 19, 30);
const CAL_DAY = (date, items) => ({ date, weekday: 'Mon', today: date === localDay(0), items });
const CALENDAR = {
  window: { from: localDay(-30), to: localDay(30), today: localDay(0), tz: 'UTC' },
  days: [
    // Deliberately in the fleet's own plain ascending order, oldest first —
    // which is what opens the screen on a week of history unless it is re-ordered.
    CAL_DAY(localDay(-5), [{ id: 'tt-old', kind: 'movie', name: 'Old Release', poster: ART, when: `${localDay(-5)}T00:00:00Z`, date: localDay(-5), exactTime: false, subtitle: 'In theaters', openable: true }]),
    CAL_DAY(MANGA_AT.utcDay, [{ id: 'mangadex:9', kind: 'manga', name: 'Chapter 220', poster: ART, when: MANGA_AT.iso, date: MANGA_AT.utcDay, exactTime: true, subtitle: 'Ch. 220', openable: false }]),
    CAL_DAY(localDay(0), [{ id: 'tt-today', kind: 'movie', name: 'Out Today', poster: ART, when: `${localDay(0)}T00:00:00Z`, date: localDay(0), exactTime: false, subtitle: 'In theaters', openable: true }]),
    CAL_DAY(ANIME_AT.utcDay, [{ id: 'anilist:7', kind: 'anime', name: 'Airing Anime', poster: ART, when: ANIME_AT.iso, date: ANIME_AT.utcDay, exactTime: true, subtitle: 'Ep 12', openable: true }]),
    CAL_DAY(localDay(5), [{ id: 'tt-season', kind: 'series', name: 'New Season', poster: ART, when: `${localDay(5)}T00:00:00Z`, date: localDay(5), exactTime: false, subtitle: 'S3 E1', openable: true }]),
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 }, timezoneId: TZ, serviceWorkers: 'block' });
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
      /* Only one title in the whole fixture is rated above a teen cap. The rest
         answer a REAL tier rather than an empty one, which is what the fleet
         does for a `tt` id — and the tier has to survive onto the card, because
         app.js re-reads meta.contentRating at openDetail (app.js:3257) and
         550ms into a hover (app.js:2423). */
      if (url.pathname.startsWith('/rating/')) {
        return json(route, url.pathname.endsWith('/tt-adult')
          ? { certification: 'NC-17', tier: 'adult' }
          : { certification: 'PG-13', tier: 'teen' });
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

  /* THE PIN ITSELF IS CHECKED FIRST. Everything the clock and day assertions
     below prove rests on the fixture and the page reading the same non-UTC
     zone; an override that was silently ignored would put them back in two
     frames and turn a real failure into a mystery. */
  /* AND `TZ !== 'UTC'` IS PART OF THE ASSERTION, not decoration. Without it the
     check is `nodeZone === TZ && pageZone === TZ`, which is TRUE for every
     possible value of the constant on line 59 — including 'UTC', where the
     measurement quoted above says all four timezone assertions PASS on the
     defective string-slicing clockOf(). So editing that constant back to 'UTC'
     would restore the CI hole in silence: .github/workflows/pages.yml:173 runs
     `npm test` on a GitHub-hosted runner, those runners are UTC, and this
     fixture can only separate the fixed calendar.js from the broken one OFF
     UTC. The guard has to refuse the one value that makes everything below it
     vacuous — a self-check that cannot fail is the same shape of bug as a
     budget meter that can only read high.
     MEASURED, 13 Sep 2026, this file with line 59 set back to 'UTC' and
     calendar.js untouched: 62 ok / 1 FAIL, and the one FAIL is THIS line. Every
     other timezone assertion in the file still passed — which is the hole,
     stated as a number. */
  const pageZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const nodeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  ok(TZ !== 'UTC' && nodeZone === TZ && pageZone === TZ,
    'the harness and the page are both pinned off UTC, so the clock checks can fail',
    `(TZ ${TZ}, node ${nodeZone}, page ${pageZone})`);

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
  ok(cal.rows[1].metas[0] === 'Ep 12   ·   7:30 pm',
    'a real airing time prints as twelve-hour with am/pm', `(${cal.rows[1].metas[0]})`);
  /* The fixture filed that airing under the UTC day the fleet would have filed
     it under, which is a different day from the viewer's wherever the local
     evening lands after midnight in Greenwich. Both halves of the card have to
     agree: 7:30 pm because that is when the viewer sees it, and "Tomorrow" for
     the same reason. It used to print the UTC hour under the local day name. */
  ok(cal.rows[1].day === 'Tomorrow',
    'and it is drawn on the viewer\'s day, not on the fleet\'s UTC bucket',
    `(fleet bucket ${ANIME_AT.utcDay}, drawn under ${cal.rows[1].day})`);

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

  // ── B25 AGAIN, UNDER A KIDS CAP — the pass that was missing ─────────────
  /* WHY A SECOND PROFILE AND NOT ANOTHER ASSERTION ON THE FIRST. The context
     above runs maxRating 'teen', and under teen ratingAllowed('') is TRUE at
     every one of app.js's three checks (app.js:5850 — an unknown tier fails
     only against 'general'). So finding 2 — every card drawn, a press answered
     "This title is not available for this profile." (app.js:3257) and a hover
     DELETING the card out of the grid 550ms later (app.js:2423/2430) — is
     invisible up there no matter what is asserted. That is precisely why this
     harness did not catch it. A kids profile is the only cap that can see it:
     scripts/profile-fixture.mjs:5 is `maxRating: profile.isKids ? 'general' :
     'adult'`, and app.js:6209 takes maxRating straight onto state.profileCap.

     THE tt-rots ROUTE IS THE RESIDUAL, deliberately staged. calendar.js and
     roadmaps.js do not remember a FAILED lookup (caching one would pin a title
     to "unknown" for the session), so a `tt` id whose request throws reaches the
     card with contentRating ''. app.js then asks the SAME question again on its
     own budget out of its own cache (app.js:5943-5947), and if THAT one
     succeeds it admits the row on a tier it never writes back — one card, drawn
     and dead, exactly as before. So this route fails the FIRST ask and answers
     the second: our resolveTiers() always runs to completion before
     visibleMetas() (roadmaps.js gateChapters), so the order is deterministic.
     `rotsAsked` is asserted below because a fixture that never exercised the
     retry would make "not drawn" pass for the wrong reason. */
  let rotsAsked = 0;
  /* The SAME staged residual, on the Calendar side. tt-season is the clean
     choice: it is the only calendar row that appears in no other pass, so its
     count is unambiguous, and it sits on a future day so dropping it cannot
     also empty the Today row that the press and the hover below need. */
  let seasonAsked = 0;
  const kidCtx = await browser.newContext({ viewport: { width: 1440, height: 980 }, timezoneId: TZ, serviceWorkers: 'block' });
  await kidCtx.addInitScript(() => {
    localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-rc', token: 'tok' }));
    localStorage.setItem('profileId', 'kid-one');
    localStorage.setItem('blazing-household-approved', '1');
  });
  await kidCtx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    if (url.hostname === 'images.example.test') {
      return route.fulfill({ contentType: 'image/png', body: await readFile(join(ROOT, 'icon-192.png')) });
    }
    if (url.hostname === 'fleet.lyreosai.com') {
      if (url.pathname === '/profiles') {
        return json(route, { profiles: [{ id: 'kid-one', name: 'Bean', maxRating: 'general', isKids: true, hasPin: false }] });
      }
      if (url.pathname === '/accounts/me') return json(route, { account: { id: 'acc', name: 'Fixture' }, device: { id: 'dev-rc', enrollmentStatus: 'approved' } });
      if (url.pathname === '/roadmaps') return json(route, INDEX);
      if (url.pathname === '/roadmaps/star-wars') return json(route, STAR_WARS);
      if (url.pathname === '/roadmaps/rocky-and-creed') return json(route, ROCKY);
      if (url.pathname === '/calendar') return json(route, CALENDAR);
      if (url.pathname.startsWith('/rating/')) {
        if (url.pathname.endsWith('/tt-adult')) return json(route, { certification: 'NC-17', tier: 'adult' });
        if (url.pathname.endsWith('/tt-rots')) {
          rotsAsked += 1;
          // First ask dies, second ask answers. See the block above.
          if (rotsAsked === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
          return json(route, { certification: 'G', tier: 'general' });
        }
        /* Calendar's copy of the residual, for calendar.js:561. Same shape as
           tt-rots: the first ask dies so calendar.js's TIERS (which deliberately
           remembers no failure, calendar.js:143) leaves the card at
           contentRating '', and app.js's own separate cache answers the retry
           and admits the row. See the (d) assertions in the calendar block. */
        if (url.pathname.endsWith('/tt-season')) {
          seasonAsked += 1;
          if (seasonAsked === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
          return json(route, { certification: 'G', tier: 'general' });
        }
        return json(route, { certification: 'G', tier: 'general' });
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

  const kidPage = await kidCtx.newPage();
  const kidFaults = [];
  kidPage.on('pageerror', (error) => kidFaults.push(error.message));
  await kidPage.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  const kidTile = kidPage.locator('.bp-profile').first();
  await kidTile.waitFor({ timeout: 8000 });
  await kidTile.click();
  await kidPage.waitForTimeout(900);
  await kidPage.evaluate(() => document.querySelector('.topnav [data-view="roadmaps"]').click());
  await kidPage.waitForSelector('#roadmaps-grid .roadmap-card', { timeout: 8000 });
  await kidPage.locator('#roadmaps-grid .roadmap-card').first().click();
  await kidPage.waitForSelector('#roadmap-chapters .roadmap-chapter', { timeout: 8000 });

  const kid = await kidPage.evaluate(() => ({
    titles: [...document.querySelectorAll('#roadmap-chapters .card-label')].map((l) => l.textContent),
    cards: document.querySelectorAll('#roadmap-chapters .card').length,
    wrappers: document.querySelectorAll('#roadmap-chapters .roadmap-entry').length,
    captions: document.querySelectorAll('#roadmap-chapters .roadmap-entry-meta').length,
  }));
  /* Ahsoka is the proof the cap really is 'general' and not the teen one above:
     a `tmdb:` id is the one thing no ratings source can classify, so it carries
     an unknown tier, and unknown is refused by exactly one cap. Under teen it
     was drawn and dimmed (assertion further up); here it must be gone. */
  ok(!kid.titles.includes('Ahsoka'),
    'a tmdb: id no ratings source can classify is dropped under a kids cap, not drawn dead',
    `(${kid.titles.join(' | ')})`);
  ok(!kid.titles.includes('Adult Special'), 'the title above the cap is still not on the screen');
  ok(rotsAsked === 2,
    'the residual really was exercised: our lookup failed and app.js asked again',
    `(asked ${rotsAsked}x)`);
  ok(!kid.titles.includes('Revenge of the Sith'),
    'a row whose own rating lookup FAILED is not drawn under a kids cap, even though app.js\'s retry admits it',
    `(${kid.titles.join(' | ')})`);
  ok(kid.titles.join(' | ') === 'The Phantom Menace | A New Hope | Andor',
    'so the kids grid is exactly the rows whose card can carry the tier that admitted it',
    `(${kid.titles.join(' | ')})`);

  // The press. This is finding 2 itself: under this cap it used to answer
  // "This title is not available for this profile." on every card on the screen.
  await kidPage.locator('#roadmap-chapters .card:not(.roadmap-unplayable)').first().click();
  await kidPage.waitForTimeout(600);
  const kidSheet = await kidPage.evaluate(() => ({
    open: document.getElementById('detail-dialog').open,
    title: document.getElementById('detail-title').textContent,
    toast: (document.querySelector('.toast-host')?.textContent || '').trim(),
  }));
  ok(kidSheet.open && kidSheet.title === 'The Phantom Menace',
    'a card drawn under a kids cap really opens on a press',
    `(open ${kidSheet.open}, title ${kidSheet.title}, toast "${kidSheet.toast}")`);
  await kidPage.keyboard.press('Escape');
  await kidPage.waitForTimeout(300);

  // And the hover. DWELL_MS is 550 and HOVER_TRAILER_MS is 1400 (app.js:2236-2237);
  // both re-read meta.contentRating and both call card.remove() on a refusal, so
  // the wait has to clear the later one.
  await kidPage.locator('#roadmap-chapters .card').first().hover();
  await kidPage.waitForTimeout(1700);
  const hovered = await kidPage.evaluate(() => ({
    cards: document.querySelectorAll('#roadmap-chapters .card').length,
    wrappers: document.querySelectorAll('#roadmap-chapters .roadmap-entry').length,
    captions: document.querySelectorAll('#roadmap-chapters .roadmap-entry-meta').length,
  }));
  ok(hovered.cards === kid.cards && hovered.wrappers === kid.wrappers && hovered.captions === kid.captions,
    'and it survives a hover well past both trailer timers, caption and wrapper with it',
    `(${kid.cards}/${kid.wrappers}/${kid.captions} before, ${hovered.cards}/${hovered.wrappers}/${hovered.captions} after)`);

  // ── B12 UNDER THE SAME KIDS CAP — the half of finding 2 that stayed open ──
  /* WHY THIS BLOCK EXISTS. Finding 2 was ONE defect with TWO halves:
     roadmaps.js and calendar.js each handed app.js `contentRating: ''` on every
     card it drew. Everything above only ever walked the kid profile through
     Roadmaps, so the Calendar half could be put straight back with this whole
     file still green. MEASURED, 13 Sep 2026 — each tree built by symlinking
     every repo entry into a fresh directory, replacing the one file, and
     running with BW_DIR — against the harness exactly as it stood before this
     block was written:
       calendar.js:482 back to `contentRating: ''`                 54 ok / 0 FAIL
       calendar.js:561 back to `new Set(visible.map((m) => m.id))` 54 ok / 0 FAIL
     Two confirmed HIGH regressions, both invisible to the suite named after
     them. The same two trees, plus the untouched repo, with this block in
     place, same day, same rig:
       calendar.js:482 reverted   57 ok / 6 FAIL
       calendar.js:561 reverted   62 ok / 1 FAIL
       the repo as it stands      63 ok / 0 FAIL
     482 takes down the day-row wait, the re-render, the row list, the status
     line, the press and the hover — every card carries '' again, so admitted()
     drops the whole window and the screen says "Nothing scheduled in this
     window." 561 takes down exactly one line, (d) below, which is the only
     assertion in this file that can see it.

     AND WHY IT NEEDS THE KID CONTEXT rather than another assertion on the teen
     one further up, which is the same reason the Roadmaps half needed it: under
     cap 'teen' ratingAllowed('') is TRUE at all three of app.js's checks
     (app.js:5850 — an unknown tier fails only against 'general'), so every
     calendar assertion in the teen pass passes on the defective code. 'general'
     is the only cap that can see this at all.

     NOTHING NEW IS FIXTURED HERE. kidCtx already routes /calendar to the same
     CALENDAR window and answers every /rating/* with tier 'general'; only the
     navigation and the assertions were missing. Clicked through the DOM for the
     same reason the teen pass does it: Calendar is a drawer destination and the
     drawer is shut. */
  await kidPage.evaluate(() => document.querySelector('.drawer-nav [data-view="calendar"]').click());
  /* THE WAIT IS ITSELF AN ASSERTION, and it is caught rather than awaited bare.
     With calendar.js:482 reverted every card carries '' again, admitted()
     (calendar.js:561) drops the lot, the screen says "Nothing scheduled in this
     window." and NO .result-row ever appears. A bare await would throw out of
     the run and print a stack trace, and the ok/FAIL tally — the only thing
     anybody reads to decide whether a guard works — would never be printed at
     all. A guard nobody watched go red is not a guard. */
  const kidRows = await kidPage.waitForSelector('#calendar-days .result-row', { timeout: 8000 })
    .then(() => true, () => false);
  ok(kidRows, 'the calendar draws day rows at all under a kids cap');
  await kidPage.waitForTimeout(400);

  /* ── (d) FIRST, because the fixture can only stage it on the FIRST render ──
     tt-season's route fails the first ask and answers the second. calendar.js's
     TIERS map does not remember a failed request (calendar.js:143), so on THIS
     render entryMeta() reaches the card with contentRating '' — while app.js
     asks the same question again out of its own separate cache
     (app.js:5943-5947), gets 'general', and visibleMetas() keeps the row on a
     tier it never writes back. One card, admitted and dead. admitted()
     (calendar.js:561) is the only thing standing between that row and the
     screen, so it must not be drawn now.

     BOTH HALVES ARE ASSERTED. `seasonAsked === 2` proves the retry really was
     exercised — "not drawn" out of a fixture nobody ever asked about would pass
     for the wrong reason. */
  const kidFirst = await kidPage.evaluate(() => ({
    titles: [...document.querySelectorAll('#calendar-days .card-label')].map((l) => l.textContent),
  }));
  ok(seasonAsked === 2,
    'the calendar residual really was exercised: our lookup failed and app.js asked again',
    `(asked ${seasonAsked}x)`);
  ok(!kidFirst.titles.includes('New Season'),
    'a calendar row whose own rating lookup FAILED is not drawn under a kids cap, even though app.js\'s retry admits it',
    `(${kidFirst.titles.join(' | ')})`);

  /* AND THE PROOF THAT "not drawn" MEANS ANYTHING: the same row, same cap, same
     fixture, drawn the moment the lookup answers. TIERS caches no failure, so a
     second pass asks a second time and this one succeeds. It goes through TV
     Shows and back rather than pressing All twice because the tab handler
     returns early when the kind has not changed (calendar.js:602), so
     re-pressing the selected tab re-renders nothing. */
  await kidPage.locator('#calendar-tabs [data-calendar-kind="series"]').click();
  await kidPage.waitForTimeout(700);
  const kidSeries = await kidPage.evaluate(() =>
    [...document.querySelectorAll('#calendar-days .card-label')].map((l) => l.textContent));
  ok(kidSeries.join(' | ') === 'New Season',
    'and the same row IS drawn once a retry lands a tier the card can carry',
    `(${kidSeries.join(' | ')})`);
  await kidPage.locator('#calendar-tabs [data-calendar-kind=""]').click();
  await kidPage.waitForTimeout(700);

  // ── (a) what a kids cap leaves on the calendar ──────────────────────────
  const kidCal = await kidPage.evaluate(() => ({
    days: [...document.querySelectorAll('#calendar-days .result-row .row-title')].map((h) => h.textContent),
    titles: [...document.querySelectorAll('#calendar-days .card-label')].map((l) => l.textContent),
    cards: document.querySelectorAll('#calendar-days .card').length,
    wrappers: document.querySelectorAll('#calendar-days .calendar-entry').length,
    captions: document.querySelectorAll('#calendar-days .calendar-entry-meta').length,
    status: document.getElementById('calendar-status').textContent,
  }));
  /* THE TWO NON-`tt` ROWS ARE THE POINT. mangadex:9 and anilist:7 are ids no
     ratings source can classify — ratingKey() returns '' for anything not
     starting `tt` (calendar.js:151) and app.js's ratingTierFor() says the same
     on its first line (app.js:5907) — so both reach the gate UNKNOWN, and
     unknown fails CLOSED against 'general' and against nothing else
     (app.js:5850). Under the teen cap further up both are on the screen and one
     of them is pressed; here both have to be gone.
     The ORDER is orderedDays(): today, tomorrow, yesterday, the rest of the
     future ascending, then the past nearest-first — and the cap has emptied
     both tomorrow (the anime) and yesterday (the manga), so what is left reads
     Today, +5 days, -5 days. */
  ok(kidCal.titles.join(' | ') === 'Out Today | New Season | Old Release',
    'the kids calendar is exactly the tt rows, in today-then-future-then-past order',
    `(${kidCal.days.join(',')} / ${kidCal.titles.join(' | ')})`);
  ok(!kidCal.titles.includes('Chapter 220') && !kidCal.titles.includes('Airing Anime'),
    'the manga and anime rows no ratings source can classify are dropped, not drawn dead',
    `(${kidCal.titles.join(' | ')})`);
  ok(kidCal.status === '3 in the next few weeks',
    'and the status line counts what survived the cap, not what the fleet sent', `(${kidCal.status})`);

  /* ── (b) the press. THIS is calendar.js:482 itself. With `contentRating: ''`
     back on that line, openDetail() refuses at app.js:3257 — and it refuses
     BEFORE it opens anything, so the sheet stays shut and "This title is not
     available for this profile." lands in the toast host instead. Both halves
     are checked: a build that opened the sheet AND apologised would slip past a
     check on `open` alone. */
  /* CAUGHT, for the reason the day-row wait above is caught: with 482 reverted
     there is no card to press, and a bare .click() would sit out its 30s and
     then throw the run away with a TimeoutError — MEASURED, the press and the
     hover below never printed at all, which is the one thing this block exists
     to make them do. The failure to press IS the failure; it is reported by the
     assertion underneath, which finds the sheet shut. */
  await kidPage.locator('#calendar-days .card:not(.calendar-unopenable)').first()
    .click({ timeout: 5000 }).catch(() => {});
  await kidPage.waitForTimeout(600);
  const kidCalSheet = await kidPage.evaluate(() => ({
    open: document.getElementById('detail-dialog').open,
    title: document.getElementById('detail-title').textContent,
    toast: (document.querySelector('.toast-host')?.textContent || '').trim(),
  }));
  ok(kidCalSheet.open && kidCalSheet.title === 'Out Today' && kidCalSheet.toast === '',
    'a calendar card drawn under a kids cap really opens on a press, with nothing to apologise for',
    `(open ${kidCalSheet.open}, title ${kidCalSheet.title}, toast "${kidCalSheet.toast}")`);
  await kidPage.keyboard.press('Escape');
  await kidPage.waitForTimeout(300);

  /* ── (c) the hover. DWELL_MS is 550 and HOVER_TRAILER_MS is 1400
     (app.js:2236-2237); both re-read meta.contentRating and both call
     card.remove() on a refusal, taking the card out of the grid and leaving its
     .calendar-entry-meta caption behind. The wait clears the later one.

     THE COUNTS ARE PINNED TO 3 AS WELL AS TO "unchanged", and that is not belt
     and braces. With calendar.js:482 reverted the grid is EMPTY before the
     hover, so an unchanged-only check reads 0 === 0 and passes while the screen
     shows nothing at all — exactly the vacuity the zone guard at the top of this
     file had until today. A check that cannot tell "nothing was deleted" from
     "there was nothing to delete" proves nothing. */
  await kidPage.locator('#calendar-days .card').first().hover({ timeout: 5000 }).catch(() => {});
  await kidPage.waitForTimeout(1700);
  const kidHovered = await kidPage.evaluate(() => ({
    cards: document.querySelectorAll('#calendar-days .card').length,
    wrappers: document.querySelectorAll('#calendar-days .calendar-entry').length,
    captions: document.querySelectorAll('#calendar-days .calendar-entry-meta').length,
  }));
  ok(kidCal.cards === 3 && kidCal.wrappers === 3 && kidCal.captions === 3
    && kidHovered.cards === 3 && kidHovered.wrappers === 3 && kidHovered.captions === 3,
    'and all three calendar cards survive a hover past both trailer timers, caption and wrapper with them',
    `(${kidCal.cards}/${kidCal.wrappers}/${kidCal.captions} before, ${kidHovered.cards}/${kidHovered.wrappers}/${kidHovered.captions} after)`);

  ok(kidFaults.length === 0, 'and the kids pass threw nothing either', kidFaults.slice(0, 2).join(' ; '));

  ok(faults.length === 0, 'neither screen threw', faults.slice(0, 2).join(' ; '));
  assert.equal(failed, 0, `${failed} assertion(s) failed`);
  console.log('\nroadmaps + calendar: all checks passed');
} finally {
  await browser?.close();
  server.close();
}
process.exit(failed ? 1 : 0);
