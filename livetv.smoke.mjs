/**
 * Live TV on the web, in the binged layout (DESIGN-V2 §2.14, BLZ-0113).
 *
 * WHAT THIS PROVES, and why each part is here. All of them are things that look
 * right in the source and are wrong on the device:
 *
 *  - The board is the FLEET'S board. /live/rows decides the rows and their
 *    order; the client only puts its own Favorites row first and gates every
 *    card by its own group. A client that re-sorts, or that reports a row's
 *    unfiltered total to a kids profile, is a client that disagrees with the
 *    Fire Stick, the Apple TV and the Roku about what is on.
 *  - The remote works without a mouse. A TV browser (webOS, Tizen) has only
 *    the arrows, OK and Back, so the rail, the rows, hold-OK-to-favourite,
 *    View All, the guide and the player's channel up/down are all driven here
 *    with keys, never clicks.
 *  - Credentials go in a header, never a URL, and the media URL is the fleet's
 *    /live/play ticket — never the provider, whose http URL an https page
 *    refuses silently (no throw, no console, just a black player).
 *  - An older fleet that answers /live/rows with a 404 still draws a board,
 *    from /live/groups + /live/channels + /live/now, with the placeholder rows
 *    dropped and the kids profile's blocked groups never even asked for.
 *  - A profile switch re-gates what is ALREADY on screen, on the switch.
 *
 *   node livetv.smoke.mjs
 */
import { launchBrowser } from './comet.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, p === '/' ? 'index.html' : p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`ok    ${label}${extra ? '  ' + extra : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/* ── The fixture: the shapes /live/rows really sends (blazing-fleet 02f036e) ── */

const MIN = 60000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const DARTS = 'Premier League Darts';
const LOGO = 'https://img.invalid/logo.png';

const espn = { id: 'ch-espn', name: 'ESPN', logo: LOGO, group: 'networks', number: 1, streamCount: 2,
  // 15 minutes in, 45 to go: the bar is recomputed from the stamps, never read off `progress`.
  now: { title: DARTS, start: iso(NOW - 15 * MIN), stop: iso(NOW + 45 * MIN), progress: 0.9 } };
const espn2 = { id: 'ch-espn2', name: 'ESPN2', logo: 'http://photo-tmdb.com/espn2.png', group: 'networks', number: 2, streamCount: 1,
  now: { title: 'SportsCenter', start: iso(NOW - 30 * MIN), stop: iso(NOW + 30 * MIN) } };
const fs1 = { id: 'ch-fs1', name: '| FS1', logo: '', group: 'networks', number: 3, streamCount: 1, now: null };
const cartoon = { id: 'ch-cn', name: 'Cartoon Network', logo: '', group: 'kids', streamCount: 1, now: { title: 'Regular Show', start: iso(NOW - 5 * MIN), stop: iso(NOW + 25 * MIN) } };
const nickjr = { id: 'ch-nickjr', name: 'Nick Jr.', logo: '', group: 'Kids;Animation', streamCount: 1, now: null };
const cnn = { id: 'ch-cnn', name: 'CNN', logo: '', group: 'news', streamCount: 1, now: { title: 'Smerconish', start: iso(NOW - 20 * MIN), stop: iso(NOW + 40 * MIN) } };
const leeds = { id: 'binged.ev-1', name: 'Leeds at Arsenal · Live', group: 'games', streamCount: 1,
  game: { league: 'EPL', leagueLabel: 'Premier League', state: 'in', start: '2026-10-10T11:30Z', clock: "79'",
    home: { id: null, name: 'Arsenal', short: 'Arsenal', abbr: 'ARS', score: '2' },
    away: { id: null, name: 'Leeds United', short: 'Leeds', abbr: 'LEE', score: '1' }, networks: ['USA Net'] } };
const cards = { id: 'binged.ev-2', name: 'Cardinals at Lions · Later', group: 'games', streamCount: 1,
  game: { league: 'NFL', leagueLabel: 'NFL', state: 'pre', start: iso(NOW + 26 * 60 * MIN),
    // id null on purpose: /live/rows games can carry no team id, and a follow
    // made from /live/teams ("nfl:ari") must still find this game.
    home: { id: null, name: 'Detroit Lions', short: 'Lions', abbr: 'DET' },
    away: { id: null, name: 'Arizona Cardinals', short: 'Cardinals', abbr: 'ARI' }, networks: ['Fox'] } };
const extraSports = [
  { id: 'ch-fs2', name: 'FS2', logo: '', group: 'networks', streamCount: 1, now: null },
  { id: 'ch-cbssn', name: 'CBS Sports Network', logo: '', group: 'networks', streamCount: 1, now: null },
];
const mixedNews = { id: 'ch-bbc', name: 'BBC News', logo: '', group: 'news', streamCount: 1, now: null };

const ROWS = {
  updatedAt: iso(NOW),
  liveNow: 7,
  rows: [
    { key: 'games', title: 'Games Today', kind: 'games', color: null, count: 12, items: [leeds, cards] },
    { key: 'tv-sports', title: 'Sports', kind: 'sports', color: '#98c379', count: 41, items: [espn, espn2, fs1] },
    { key: 'tv-kids', title: 'Kids', kind: 'channels', color: null, count: 9, items: [cartoon] },
    { key: 'tv-mixed', title: 'Family', kind: 'channels', color: null, count: 41, items: [nickjr, mixedNews, cnn] },
    { key: 'tv-news', title: 'News', kind: 'channels', color: null, count: 1, items: [cnn] },
  ],
};
// ESPN has three feeds (a game's home, away and Spanish broadcasts); every
// other channel has one.
const FEEDS = { 'ch-espn': ['Home', 'Away', null] };
const SPORTS = {
  leagues: [{ key: 'EPL', name: 'Premier League', count: 1 }, { key: 'NFL', name: 'NFL', count: 1 }],
  live: [leeds.game],
  byLeague: { EPL: [leeds.game], NFL: [cards.game] },
};
const TEAMS_NFL = { league: 'NFL', name: 'NFL', teams: [
  { id: 'nfl:ari', name: 'Arizona Cardinals', short: 'Cardinals', abbr: 'ARI', logo: '' },
  { id: 'nfl:det', name: 'Detroit Lions', short: 'Lions', abbr: 'DET', logo: '' },
] };

function guideFor(ids, fromMs) {
  const out = {};
  for (const id of ids) {
    if (id !== espn.id) continue;
    out[id] = [
      { title: DARTS, start: iso(NOW - 15 * MIN), stop: iso(NOW + 45 * MIN) },
      { title: 'SportsCenter', start: iso(NOW + 45 * MIN), stop: iso(NOW + 105 * MIN), desc: 'Highlights.' },
    ];
  }
  return { from: iso(fromMs), guide: out };
}

/* ── One page, one context, one recorder ─────────────────────────────────── */

const browser = await launchBrowser();

async function openLive({ cap = 'adult', name = 'Mark', fleet }) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript((maxRating) => {
    localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-live', token: 'tok-live' }));
    localStorage.setItem('blazing-household-approved', '1');
    localStorage.setItem('blazing-web-profile-session-v1', JSON.stringify({
      id: 'p-live', maxRating, isKids: maxRating === 'general', neededPin: false, allowAdult: maxRating === 'adult', savedAt: Date.now(),
    }));
  }, cap);
  const rec = { seen: [], tokenHeaders: [] };
  await ctx.route('https://fleet.lyreosai.com/**', async (route) => {
    const url = new URL(route.request().url());
    rec.seen.push(url.pathname + url.search);
    if (url.pathname.startsWith('/live/')) rec.tokenHeaders.push(route.request().headers()['x-device-token'] || null);
    if (url.pathname === '/accounts/me') return json(route, { account: { id: 'a' }, device: { id: 'dev-live', enrollmentStatus: 'approved' } });
    if (url.pathname === '/profiles') return json(route, { profiles: [{ id: 'p-live', name, maxRating: cap, hasPin: false, isKids: cap === 'general' }] });
    if (url.pathname.startsWith('/live/ticket/')) {
      // blazing-fleet 6d0c503: ?feed=N pins the ticket to one feed and the
      // answer says { feed, feeds, label }; out of range answers feed 0.
      const id = decodeURIComponent(url.pathname.slice('/live/ticket/'.length));
      const labels = FEEDS[id] || [null];
      const want = Number.parseInt(url.searchParams.get('feed') || '0', 10);
      const feed = Number.isInteger(want) && want >= 0 && want < labels.length ? want : 0;
      const ticket = `abc123def456abc123def456abc1234${5 + feed}`;
      return json(route, { ticket, url: `/live/play/${ticket}`, format: 'hls', feed, feeds: labels.length, label: labels[feed] });
    }
    return fleet(route, url);
  });
  await ctx.route('https://addon.lyreosai.com/**', (route) => json(route, {}));
  // A logo that REALLY loads. Without this the https logo 404s, the card's own
  // `error` handler swaps in the name — correctly — and the mixed-content check
  // would read 0 images and blame safeHttpsUrl for something it did not do.
  await ctx.route('https://img.invalid/**', (route) => route.fulfill({ status: 200, contentType: 'image/gif', body: GIF }));
  const page = await ctx.newPage();
  const faults = [];
  page.on('pageerror', (e) => faults.push(e.message));
  await page.goto(`${base}/index.html`);
  // Record what the player is handed. It also shows #player, the way the real
  // HTML5 path does, so the live overlay and channel up/down engage.
  await page.evaluate(() => {
    window.__played = [];
    window.BlazingPlayer = {
      open: (title, url, opts) => {
        window.__played.push({ title, url, opts });
        document.getElementById('player').hidden = false;
      },
      status: () => ({ paused: false }),
      setPaused() {},
    };
  });
  await page.waitForFunction(() => document.querySelector('.bp-layer')?.hidden !== false, null, { timeout: 20000 })
    .catch(async () => {
      await page.getByRole('button', { name: `Choose ${name}`, exact: true }).click({ timeout: 15000 }).catch(() => {});
      await page.waitForFunction(() => document.querySelector('.bp-layer')?.hidden !== false, null, { timeout: 15000 }).catch(() => {});
    });
  return { ctx, page, rec, faults };
}

const press = async (page, key, n = 1) => {
  for (let i = 0; i < n; i += 1) { await page.keyboard.press(key); await page.waitForTimeout(90); }
};
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  if (!a) return {};
  return { cls: a.className, row: a.dataset.row || '', id: a.dataset.id || '', section: a.dataset.section || '', view: a.dataset.view || '', chip: a.dataset.chip || '', crest: a.dataset.crest || '' };
});
const rowTitles = (page) => page.locator('#livetv-pane .lt-row-title').allInnerTexts();
const select = (page, id) => page.evaluate((s) => window.BlazingLiveTv.select(s), id);

try {
  /* ══════════════════════════════════════════════════════════════════════
     1. AN ADULT PROFILE ON A CURRENT FLEET
     ══════════════════════════════════════════════════════════════════════ */
  const fleet = (route, url) => {
    if (url.pathname === '/live/rows') return json(route, ROWS);
    if (url.pathname === '/live/rows/tv-sports') {
      const all = [espn, espn2, fs1, ...extraSports];
      const skip = Number(url.searchParams.get('skip') || 0);
      return json(route, { key: 'tv-sports', title: 'Sports', kind: 'sports', count: all.length, items: all.slice(skip, skip + 40) });
    }
    if (url.pathname === '/live/sports') return json(route, SPORTS);
    if (url.pathname === '/live/teams/NFL') return json(route, TEAMS_NFL);
    if (url.pathname === '/live/guide') return json(route, guideFor((url.searchParams.get('channels') || '').split(','), Date.parse(url.searchParams.get('from'))));
    if (url.pathname === '/live/now') return json(route, { now: {} });
    return json(route, {}, 404);
  };
  const { ctx, page, rec, faults } = await openLive({ fleet });

  ok(await page.locator('.topnav [data-view="livetv"]').count() === 1, 'Live TV is a chip in the top nav');
  ok(await page.locator('.drawer-nav [data-view="livetv"]').count() === 1, 'and an entry in the drawer');
  await page.locator('.topnav [data-view="livetv"]').click();
  await page.waitForSelector('#livetv-pane .lt-card', { timeout: 15000 });
  await page.waitForTimeout(300);

  // ── the rail (§2.14.1) ──
  const rail = await page.locator('#livetv-rail .lt-rail-item').evaluateAll((els) => els.map((e) => e.dataset.section).join(','));
  ok(rail === 'channels,guide,sports,teams,favorites,search', 'the rail holds the six sections in binged order', rail);
  ok(/7 live now/.test(await page.locator('#livetv-live-count').innerText()), 'the rail reads the fleet\'s own "N live now"');

  // ── the rows are the fleet's, in its order (§2.14.2) ──
  ok((await rowTitles(page)).join('|') === 'Games Today|Sports|Kids|Family|News', 'rows in the fleet\'s order, none re-sorted', (await rowTitles(page)).join(' | '));
  const sportsCount = await page.locator('#livetv-pane .lt-row').nth(1).locator('.lt-row-count').innerText();
  ok(sportsCount === '41', 'the row header is the SERVER\'s total, not the 3 cards in the page', sportsCount);
  ok(await page.locator('[data-row="tv-sports"][data-id="__viewall__"]').count() === 1, '41 > 3: the row ends in a View All card');
  ok(await page.locator('[data-row="tv-news"][data-id="__viewall__"]').count() === 0, 'a row that is whole has none');
  ok(rec.seen.some((u) => u.startsWith('/live/rows?') && /limit=40/.test(u)), 'the board is ONE request: /live/rows?limit=40', rec.seen.filter((u) => u.startsWith('/live/rows')).join(' | '));
  ok(!rec.seen.some((u) => u.startsWith('/live/groups')), 'and the old per-group walk never runs on a fleet that has /live/rows');

  // ── cards ──
  const face = await page.locator('[data-id="binged.ev-1"] .lt-face').innerText();
  ok(/1 – 2/.test(face) && /LIVE/.test(face), 'a live game draws away – home with a LIVE pill', face.replace(/\n/g, ' '));
  const leedsCap = (await page.locator('[data-id="binged.ev-1"] .lt-cap1').innerText()) + ' / ' + (await page.locator('[data-id="binged.ev-1"] .lt-cap2').innerText());
  ok(leedsCap === "Leeds at Arsenal / LIVE 79' · Premier League", 'and its captions say who, the clock and the league', leedsCap);
  ok((await page.locator('[data-id="ch-espn"] .lt-cap2').innerText()) === DARTS, 'a channel card says what is ON');
  const fill = await page.locator('[data-id="ch-espn"] .lt-progress-fill').evaluate((n) => n.style.width);
  ok(/^2[0-9](\.\d)?%$/.test(fill), 'its bar is recomputed from the stamps (~25%), not the server\'s frozen 0.9', fill);
  ok((await page.locator('[data-id="ch-fs1"] .lt-cap2').innerText()) === '', 'nothing known is an EMPTY line, never "No information"');
  ok((await page.locator('[data-id="ch-fs1"] .lt-cap1').innerText()) === 'FS1', 'the playlist\'s sort punctuation is off the name');
  ok(await page.locator('[data-id="ch-espn"] img').count() === 1 && await page.locator('[data-id="ch-espn2"] img').count() === 0,
    'only an https logo becomes an <img>; an http one would be blocked as mixed content');

  // ── credentials ──
  ok(rec.tokenHeaders.length > 0 && rec.tokenHeaders.every((t) => t === 'tok-live'), 'every /live request carries X-Device-Token', String(rec.tokenHeaders.length));
  ok(!rec.seen.some((u) => /token/i.test(u)), 'NO request URL carries the token');

  // ── the remote (§2.6, §2.14.1-2) ──
  await page.evaluate(() => document.querySelector('[data-row="tv-sports"][data-id="ch-espn"]').focus());
  await press(page, 'ArrowRight');
  let f = await focused(page);
  ok(f.row === 'tv-sports' && f.id === 'ch-espn2', 'RIGHT moves along the row', `${f.row}/${f.id}`);
  await press(page, 'ArrowDown');
  f = await focused(page);
  ok(f.row === 'tv-kids', 'DOWN moves to the next row', `${f.row}/${f.id}`);
  await press(page, 'ArrowUp');
  await press(page, 'ArrowLeft', 3);
  f = await focused(page);
  const railOpen = await page.locator('#livetv-rail').evaluate((n) => n.classList.contains('is-open'));
  ok(railOpen && f.section === 'channels', 'LEFT off the first card opens the rail on the current section', `${f.cls} ${f.section}`);
  await press(page, 'ArrowRight');
  f = await focused(page);
  ok(f.row === 'tv-sports' && f.id === 'ch-espn', 'RIGHT closes the rail and gives the card back', `${f.row}/${f.id}`);
  await press(page, 'Escape');
  f = await focused(page);
  ok(f.section === 'channels', 'BACK on a card opens the rail', f.section);
  await press(page, 'Escape');
  f = await focused(page);
  ok(f.view === 'livetv', 'BACK on the rail leaves Live TV for the nav bar\'s own chip', f.view);

  // ── hold OK = favourite (§2.14.2) ──
  const ticketsBefore = rec.seen.filter((u) => u.startsWith('/live/ticket/')).length;
  await page.evaluate(() => document.querySelector('[data-row="tv-news"][data-id="ch-cnn"]').focus());
  await page.keyboard.down('Enter');
  await page.waitForTimeout(800);
  await page.keyboard.up('Enter');
  await page.waitForTimeout(250);
  ok((await rowTitles(page))[0] === 'Favorites', 'holding OK stars the channel and Favorites leads the board', (await rowTitles(page)).join(' | '));
  ok(await page.locator('[data-row="__favorites__"][data-id="ch-cnn"]').count() === 1, 'with that channel in it');
  ok(rec.seen.filter((u) => u.startsWith('/live/ticket/')).length === ticketsBefore, 'and a HELD OK does not also tune');
  const stored = await page.evaluate(() => localStorage.getItem('blazing-live-favorites-v1') || '');
  ok(stored.includes('ch-cnn'), 'the star is kept on this device', stored.slice(0, 80));
  await page.evaluate(() => document.querySelector('[data-row="tv-kids"][data-id="ch-cn"]').focus());
  await press(page, 'MediaPlayPause');
  await page.waitForTimeout(200);
  ok(await page.locator('[data-row="__favorites__"][data-id="ch-cn"]').count() === 1, 'Play/Pause stars too (the TV remotes\' second way)');

  // ── tuning, and the player's channel up/down (§2.14.7) ──
  await page.evaluate(() => document.querySelector('[data-row="tv-sports"][data-id="ch-espn"]').focus());
  await press(page, 'Enter');
  await page.waitForFunction(() => window.__played.length > 0, null, { timeout: 10000 });
  let played = await page.evaluate(() => window.__played[0]);
  ok(played.url === 'https://fleet.lyreosai.com/live/play/abc123def456abc123def456abc12345', 'OK tunes through a fleet ticket, never the provider URL', played.url);
  ok(!/token|tok-live/i.test(played.url), 'and that media url carries no credential');
  ok(played.opts.streamFormat === 'hls', 'the server\'s declared format is handed on (a ticket URL has no .m3u8 to sniff)');
  ok(rec.seen.some((u) => u === '/live/ticket/ch-espn' || u.startsWith('/live/ticket/ch-espn?')), 'a ticket was minted for that channel');
  await page.waitForTimeout(300);
  ok(await page.locator('#livetv-overlay').isVisible(), 'the live overlay is up over the player');
  const feedChip = () => page.locator('#livetv-overlay .lt-ov-feed').innerText().catch(() => '');
  ok(await feedChip() === 'Feed 1/3 · Home', 'the overlay says which feed of how many, from the first ticket', await feedChip());

  // ── feeds: LEFT/RIGHT (§2.14.7, blazing-fleet 6d0c503) ──
  const tickets = () => rec.seen.filter((u) => u.startsWith('/live/ticket/'));
  await press(page, 'ArrowRight');
  await page.waitForFunction(() => window.__played.length > 1, null, { timeout: 10000 });
  await page.waitForTimeout(150);
  ok(/^\/live\/ticket\/ch-espn\?.*feed=1\b/.test(tickets().at(-1)), 'RIGHT mints a ticket for the NEXT feed', tickets().at(-1));
  played = await page.evaluate(() => window.__played.at(-1));
  ok(played.url.endsWith('/live/play/abc123def456abc123def456abc12346'), 'and swaps the player to that feed\'s source', played.url);
  ok(played.title === 'ESPN', 'on the same channel');
  ok(await feedChip() === 'Feed 2/3 · Away', 'the overlay shows the new feed and its name', await feedChip());
  // FEED_SHOT=/path.png keeps a picture of the overlay after the RIGHT press.
  if (process.env.FEED_SHOT) await page.screenshot({ path: process.env.FEED_SHOT });
  await press(page, 'ArrowLeft');
  await page.waitForTimeout(250);
  await press(page, 'ArrowLeft');
  await page.waitForFunction(() => window.__played.length > 3, null, { timeout: 10000 });
  await page.waitForTimeout(150);
  ok(/feed=2\b/.test(tickets().at(-1)), 'LEFT from feed 1 wraps round to the last feed', tickets().at(-1));
  ok(await feedChip() === 'Feed 3/3', 'a feed with no name is just its number', await feedChip());
  ok(!tickets().some((u) => /token/i.test(u)), 'no ticket request carries the token');

  const playedSoFar = await page.evaluate(() => window.__played.length);
  await press(page, 'ArrowDown');
  await page.waitForFunction((n) => window.__played.length > n, playedSoFar, { timeout: 10000 });
  played = await page.evaluate(() => window.__played.at(-1));
  ok(played.title === 'ESPN2', 'DOWN in the player is the next channel IN THE ROW', played.title);
  ok(!/feed=/.test(tickets().at(-1)), 'a new channel starts on its first feed (no ?feed)', tickets().at(-1));
  await page.waitForTimeout(150);
  ok(await page.locator('#livetv-overlay .lt-ov-feed').count() === 0, 'a one-feed channel shows no feed chip');
  const count = tickets().length;
  await press(page, 'ArrowRight');
  await page.waitForTimeout(300);
  ok(tickets().length === count, 'RIGHT on a one-feed channel asks the fleet nothing');
  ok(/one feed/.test(await page.locator('#livetv-overlay').innerText()), 'and says the channel has one feed');
  await press(page, 'Escape');
  await page.waitForTimeout(300);
  ok(await page.locator('#player').isHidden(), 'BACK closes the player');
  f = await focused(page);
  ok(f.row === 'tv-sports' && f.id === 'ch-espn', 'and focus is back on the card it was opened from', `${f.cls} ${f.row}/${f.id}`);

  // ── View All (§2.14.2) ──
  await page.evaluate(() => document.querySelector('[data-row="tv-sports"][data-id="__viewall__"]').focus());
  await press(page, 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('#livetv-pane .lt-grid .lt-card').length >= 5, null, { timeout: 10000 });
  // The board already holds the row's first 3 cards, so the next page starts
  // where the row stopped instead of fetching those 3 again.
  ok(rec.seen.some((u) => u.startsWith('/live/rows/tv-sports?') && /skip=3\b/.test(u)), 'View All pages /live/rows/:key from where the row stopped', rec.seen.filter((u) => u.startsWith('/live/rows/')).join(' | '));
  const grid = await page.locator('#livetv-pane .lt-grid .lt-card').evaluateAll((els) => els.map((e) => e.dataset.id).join(','));
  ok(grid === 'ch-espn,ch-espn2,ch-fs1,ch-fs2,ch-cbssn', 'and draws the whole row as one grid, each card once', grid);
  await press(page, 'Escape');
  await page.waitForTimeout(200);
  f = await focused(page);
  ok(f.row === 'tv-sports' && f.id === '__viewall__', 'BACK from View All lands on the View All card', `${f.row}/${f.id}`);

  // ── the guide (§2.14.3) ──
  await select(page, 'guide');
  await page.waitForSelector('.lt-gcell', { timeout: 15000 });
  await page.waitForTimeout(300);
  const asked = rec.seen.filter((u) => u.startsWith('/live/guide')).map((u) => new URL(`https://x${u}`).searchParams.get('channels') || '');
  ok(asked.length >= 1 && asked.every((c) => c.split(',').length <= 100), '/live/guide is asked in batches of at most 100', String(asked.length));
  ok(!asked.join(',').includes('binged.ev-'), 'Games Today is not listed in the guide');
  const guideNames = await page.locator('.lt-gch-name').allInnerTexts();
  ok(guideNames.join('|') === 'CNN|Cartoon Network|ESPN|ESPN2|FS1|Nick Jr.|BBC News',
    'one guide row per channel, once each: Favorites first, then board order (as on the Apple TV)', guideNames.join(' | '));
  const sc = page.locator('.lt-gcell', { hasText: 'SportsCenter' }).first();
  const scWidth = Math.round((await sc.boundingBox()).width);
  ok(Math.abs(scWidth - 472) <= 2, 'a 60-minute programme is 60 × 8 px less the 8 px gap, on the 1920 canvas', `${scWidth}px`);
  f = await focused(page);
  ok(f.cls.includes('lt-gcell'), 'choosing Guide lands on a programme', f.cls);
  await page.evaluate(() => document.querySelector('.lt-gcell[data-id="ch-espn"]').focus());
  const before = await page.evaluate(() => window.__played.length);
  await press(page, 'Enter');
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => window.__played.length) === before, 'the first OK on a programme PREVIEWS, it does not open the player');
  ok(/Premier League Darts/.test(await page.locator('#livetv-pane').innerText()), 'and the details show what is on');

  // ── Sports and Teams (§2.14.4-5) ──
  await select(page, 'sports');
  await page.waitForSelector('.lt-score', { timeout: 15000 });
  const live = await page.locator('.lt-score').first().innerText();
  ok(/Leeds/.test(live) && /Arsenal/.test(live), 'Sports leads with the live score cards', live.replace(/\n/g, ' '));
  ok(rec.seen.some((u) => u.startsWith('/live/sports')), '/live/sports was read');
  await select(page, 'teams');
  await page.waitForSelector('.lt-crest-tile', { timeout: 15000 });
  const firstChip = await page.locator('#livetv-pane .lt-chip').first().innerText();
  ok(firstChip === 'NFL', 'Teams leads with the US majors whatever the fleet\'s order', firstChip);
  ok(rec.seen.some((u) => u.startsWith('/live/teams/NFL')), '/live/teams/NFL was read');
  await page.evaluate(() => document.querySelector('.lt-crest-tile[data-crest="NFL:ARI"]').focus());
  await press(page, 'Enter');
  await page.waitForTimeout(200);
  const follows = await page.evaluate(() => localStorage.getItem('blazing-live-follows-v1') || '');
  ok(follows.includes('NFL:ARI'), 'OK on a crest follows the team by the fleet\'s own id', follows);
  await select(page, 'favorites');
  await page.waitForTimeout(300);
  const favText = await page.locator('#livetv-pane').innerText();
  ok(/Your teams/.test(favText) && /Cardinals/.test(favText),
    'Favorites shows the followed team\'s game, though that game\'s team carries NO id', favText.replace(/\n/g, ' ').slice(0, 160));

  // ── Search (§2.14.6) ──
  await select(page, 'search');
  await page.waitForSelector('.lt-search-input');
  await page.fill('.lt-search-input', 'darts');
  await page.waitForTimeout(500);
  const found = await page.locator('#livetv-pane .lt-grid .lt-card').evaluateAll((els) => els.map((e) => e.dataset.id).join(','));
  ok(found === 'ch-espn', 'search finds a channel by the programme on NOW, from the board', found);
  ok(!rec.seen.some((u) => u.startsWith('/live/channels')), 'typing asks the fleet nothing');
  await page.press('.lt-search-input', 'Enter');
  await page.waitForTimeout(500);
  ok(rec.seen.some((u) => u.startsWith('/live/channels') && /q=darts/.test(u)), 'Enter searches the whole index on the fleet');

  ok(faults.length === 0, 'no page errors', faults.join(' | '));

  /* ── 4. a profile switch re-gates what is ALREADY on screen ── */
  await select(page, 'channels');
  await page.waitForSelector('[data-row="tv-news"]');
  const strandedAfter = await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('blazing-profile-selected', { detail: { id: 'p-kid', name: 'Ellie', isKids: true, maxRating: 'general' } }));
    // Same tick as the switch: not a request later.
    return [...document.querySelectorAll('#livetv-pane .lt-card:not(.lt-viewall)')].map((c) => c.dataset.id)
      .filter((id) => !['ch-cn', 'ch-nickjr'].includes(id));
  });
  ok(strandedAfter.length === 0, 'a switch to a kids profile takes the other cards off ON the switch', strandedAfter.join(','));
  await ctx.close();

  /* ══════════════════════════════════════════════════════════════════════
     2. A KIDS PROFILE ON A CURRENT FLEET
     ══════════════════════════════════════════════════════════════════════ */
  {
    const kids = await openLive({ cap: 'general', name: 'Ellie', fleet });
    await kids.page.locator('.topnav [data-view="livetv"]').click();
    await kids.page.waitForSelector('#livetv-pane .lt-card', { timeout: 15000 });
    await kids.page.waitForTimeout(300);
    const titles = (await rowTitles(kids.page)).join('|');
    ok(titles === 'Kids|Family', 'B24 — a kids profile sees only the rows its gate leaves anything in', titles);
    const ids = await kids.page.locator('#livetv-pane .lt-card').evaluateAll((els) => els.map((e) => e.dataset.id).join(','));
    ok(ids === 'ch-cn,__viewall__,ch-nickjr', 'and only kids cards (a "Kids;Animation" group counts)', ids);
    const familyCount = await kids.page.locator('#livetv-pane .lt-row').nth(1).locator('.lt-row-count').innerText();
    ok(familyCount === '1', 'a row the gate thinned is RECOUNTED, never "41" to a child\'s profile', familyCount);
    ok(await kids.page.locator('[data-row="tv-mixed"][data-id="__viewall__"]').count() === 0, 'and offers no View All into cards it would hide');
    ok(!/live now/.test(await kids.page.locator('#livetv-rail').innerText()), 'no live-games count for a profile that cannot see games');
    await select(kids.page, 'sports');
    await kids.page.waitForTimeout(300);
    ok(/Sports are off for this profile/.test(await kids.page.locator('#livetv-pane').innerText()), 'Sports says it is off, rather than drawing scores');
    ok(kids.faults.length === 0, 'no page errors on the kids profile', kids.faults.join(' | '));
    await kids.ctx.close();
  }

  /* ══════════════════════════════════════════════════════════════════════
     3. AN OLDER FLEET (no /live/rows): the fallback board, on a kids profile
     ══════════════════════════════════════════════════════════════════════ */
  {
    const JUNK = [
      { id: 'j1', name: '- NO EVENT STREAMING - | 8K EXCLUSIVE | BR: DISNEY+ PPV 100', group: 'kids', streamCount: 1 },
      { id: 'j2', name: '##### CBS ALABAMA #####', group: 'kids', streamCount: 1 },
      { id: 'j3', name: '   ', group: 'kids', streamCount: 1 },
    ];
    const old = (route, url) => {
      if (url.pathname.startsWith('/live/rows') || url.pathname === '/live/sports') return json(route, { error: 'not found' }, 404);
      if (url.pathname === '/live/groups') {
        return json(route, { groups: [{ id: 'news', name: 'News', count: 1063 }, { id: 'sports', name: 'Sports', count: 4416 }, { id: 'kids', name: 'Kids', count: 427 }] });
      }
      if (url.pathname === '/live/channels') {
        const group = url.searchParams.get('group');
        if (group === 'kids') return json(route, { total: 427, channels: [...JUNK, cartoon, nickjr] });
        return json(route, { total: 38899, channels: [cnn, espn] });
      }
      if (url.pathname === '/live/now') {
        return json(route, { now: { 'ch-nickjr': { title: 'Peppa Pig', start: iso(NOW - 5 * MIN), stop: iso(NOW + 5 * MIN) } } });
      }
      return json(route, {});
    };
    const o = await openLive({ cap: 'general', name: 'Ellie', fleet: old });
    await o.page.locator('.topnav [data-view="livetv"]').click();
    await o.page.waitForSelector('#livetv-pane .lt-card', { timeout: 15000 });
    await o.page.waitForTimeout(300);
    ok(o.rec.seen.some((u) => u.startsWith('/live/rows')), 'the client asks /live/rows first');
    ok(o.rec.seen.some((u) => u.startsWith('/live/channels') && /group=kids/.test(u)), 'and on its 404 walks the groups, scoped to kids', o.rec.seen.filter((u) => u.startsWith('/live/channels')).join(' | '));
    ok(!o.rec.seen.some((u) => /group=(news|sports)/.test(u)), 'a blocked group is never even asked for');
    const ids = await o.page.locator('#livetv-pane .lt-card:not(.lt-viewall)').evaluateAll((els) => els.map((e) => e.dataset.id).join(','));
    ok(ids === 'ch-cn,ch-nickjr', 'the placeholder rows are dropped and the real ones drawn', ids);
    ok((await o.page.locator('[data-id="ch-nickjr"] .lt-cap2').innerText()) === 'Peppa Pig', '/live/now fills in what is on');
    await o.page.evaluate(() => document.querySelector('[data-row="kids"][data-id="__viewall__"]').click());
    await o.page.waitForTimeout(600);
    ok(o.rec.seen.some((u) => u.startsWith('/live/rows/kids')) && o.rec.seen.some((u) => u.startsWith('/live/channels') && /group=kids/.test(u) && /skip=0/.test(u)),
      'View All tries /live/rows/:key, and only on its 404 pages the group');
    ok(o.faults.length === 0, 'no page errors on the old-fleet board', o.faults.join(' | '));
    await o.ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
