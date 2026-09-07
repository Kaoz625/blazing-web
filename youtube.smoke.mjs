/**
 * The YouTube destination, driven in a real browser against a stubbed fleet.
 *
 * This is the UI half. The PLAYBACK half is youtube-play.smoke.mjs, which talks
 * to the deployed addon and measures decoded bytes — the two are separate on
 * purpose, because a fixture cannot prove a video decodes and a live video
 * cannot prove an empty shelf is handled.
 *
 * What is pinned here, and why each one is a thing that actually broke or could:
 *
 *  1. THE SECTION MENU IS BUILT FROM THE ANSWER, not from a list in youtube.js.
 *     The fleet went from seven shelves to fifteen once already and the Roku's
 *     hardcoded menu kept offering eight — "half the rooms in the app had no
 *     door". The fixture below serves FOUR shelves; a client with its own list
 *     would draw more chips than there are shelves.
 *  2. THE CARD IS 16:9, NOT THE APP'S 2:3 POSTER. Measured, not asserted by
 *     class name: a thumbnail cropped into a portrait box loses both sides of a
 *     centre-composed frame.
 *  3. ONE CARD IS ONE FOCUS STOP. A channel link per card doubles the DOWN
 *     presses between rows on a remote, because dpad.js moves by geometry.
 *     The count of focusable elements inside a row must equal the card count.
 *  4. KEEP WATCHING IS WRITTEN ON PLAY AND SURVIVES A RELOAD, per profile.
 *  5. A SECOND PROFILE DOES NOT SEE THE FIRST ONE'S ROW.
 *  6. FOLLOW POSTS TO THE FLEET and the button flips to Following.
 *  7. AN EMPTY ANSWER SAYS SO. A blank page and a broken page look identical.
 *  8. THE D-PAD REACHES THE CARDS — ArrowDown/ArrowRight from the search box
 *     lands on real elements inside this view, not on some other view's button.
 *
 *   node youtube.smoke.mjs
 *   BW_DIR=/path/to/checkout node youtube.smoke.mjs
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

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`ok    ${label}${extra ? '  — ' + extra : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${extra ? '  — ' + extra : ''}`); }
};

/* ── the fixture ───────────────────────────────────────────────────────────
   Shaped exactly like the live answer measured on 6 Sep 2026, including the
   two things that are easy to forget: `duration: 0` for a live stream, and an
   EMPTY channelId on some rows (yt-dlp's --flat-playlist prints NA for
   %(channel_id)s on a channel listing, so half a real page has no channel id
   at all). A fixture where every row is complete would never reach the code
   that has to cope with that. */
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const vid = (n, over = {}) => ({
  id: `vid0000${n}`,
  title: `Video number ${n}`,
  duration: 60 * n + 5,
  channel: n % 2 ? 'Lofi Girl' : 'HYBE LABELS',
  channelId: n % 2 ? 'UCSJ4gkVC6NrvII8umztf0Ow' : 'UC3IZKseVpdzPSBaWxBxundA',
  views: 1_200_000 * n,
  thumb: 'https://i.ytimg.com/vi/x/hqdefault.jpg',
  ...over,
});
const SHELVES = [
  { id: 'trending', name: 'Trending', videos: [vid(1), vid(2), vid(3), vid(4)] },
  { id: 'music', name: 'Music', videos: [vid(5), vid(6)] },
  // A live stream: duration 0 and no view count. Its tile must carry no
  // duration badge rather than "0:00".
  { id: 'live', name: 'Live Now', videos: [vid(7, { duration: 0, views: 0 })] },
  // The empty shelf. home() drops these server-side today, but a client that
  // assumes so paints an empty row the day that changes.
  { id: 'sports', name: 'Sports', videos: [] },
];

const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-1', token: 'tok' }));
  localStorage.setItem('blazing-household-approved', '1');
});

const calls = [];
let subs = [];
let searchAnswer = [vid(11), vid(12), vid(13)];

await ctx.route('https://addon.lyreosai.com/**', (route) => {
  const u = route.request().url();
  if (u.includes('/proxy/yt-resolve')) {
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/proxy/hls?u=https%3A%2F%2Fexample.test%2Fx.m3u8', streamFormat: 'hls' }) });
  }
  if (u.includes('/api/ui/home-config')) return route.fulfill({ status: 404, body: 'no' });
  if (u.includes('/manifest.json')) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ catalogs: [{ id: 'blazing-movies', type: 'movie', name: 'Movies' }] }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

await ctx.route('https://fleet.lyreosai.com/**', async (route) => {
  const req = route.request();
  const u = req.url();
  calls.push(`${req.method()} ${u.replace('https://fleet.lyreosai.com', '')}`);
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

  if (u.includes('/youtube/home')) return json({ shelves: SHELVES });
  if (u.includes('/youtube/search')) return json({ videos: searchAnswer });
  if (u.includes('/youtube/channelinfo/')) {
    return json({ id: 'UCSJ4gkVC6NrvII8umztf0Ow', name: 'Lofi Girl', avatar: GIF, subscribers: 15_800_000 });
  }
  if (u.includes('/youtube/channel/')) return json({ videos: [vid(21), vid(22)] });
  if (u.includes('/youtube/playlist/')) return json({ videos: [vid(31), vid(32), vid(33)] });
  if (u.includes('/youtube/feed')) return json({ videos: subs.length ? [vid(41)] : [] });
  if (u.includes('/youtube/subs')) {
    if (req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      subs = [{ id: body.id, name: body.name }];
      return json({ channels: subs });
    }
    if (req.method() === 'DELETE') { subs = []; return json({ channels: subs }); }
    return json({ channels: subs });
  }
  if (u.includes('/devices/register')) return json({ ok: true, device: { id: 'dev-1', status: 'approved' }, token: 'tok' });
  if (u.includes('/profiles')) return json({ profiles: [
    { id: 'p1', name: 'Mark', maxRating: 'adult', hasPin: false },
    { id: 'p2', name: 'Ada', maxRating: 'adult', hasPin: false },
  ] });
  return json({});
});
await ctx.route('https://upscale.lyreosai.com/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
// The thumbnails are a real host we must never call from a test.
await ctx.route('https://i.ytimg.com/**', (route) =>
  route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from(GIF.split(',')[1], 'base64') }));

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

// isVisible, NOT count. A restored browser closes the gate but leaves its
// tiles in the DOM, so count() is still 1 and the click waits 30s for an
// element that will never be visible again.
const selectProfile = async (name) => {
  const tile = page.locator('.bp-profile', { hasText: name }).first();
  if (await tile.isVisible().catch(() => false)) { await tile.click(); await page.waitForTimeout(1500); }
};

await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await selectProfile('Mark');

// ── 0. It is reachable the way DESIGN.md says ──────────────────────────────
const chips = await page.evaluate(() => ({
  top: [...document.querySelectorAll('.topnav [data-view]')].map((b) => b.dataset.view),
  drawer: [...document.querySelectorAll('.drawer-nav [data-view]')].map((b) => b.dataset.view),
}));
ok(chips.top.includes('youtube'), 'YouTube is a chip in the canonical top nav', chips.top.join(' '));
ok(chips.drawer.includes('youtube'), 'and in the drawer, so a phone can reach it');
ok(chips.top.indexOf('youtube') > chips.top.indexOf('library')
  && chips.top.indexOf('youtube') < chips.top.indexOf('games'),
  'in DESIGN.md order: after Library, before Games');

await page.evaluate(() => document.querySelector('.topnav [data-view="youtube"]').click());
await page.waitForTimeout(1500);

// ── 1. The menu is the fleet's menu ────────────────────────────────────────
const menu = await page.evaluate(() => ({
  visible: !document.getElementById('youtube-view').hidden,
  sections: [...document.querySelectorAll('#yt-sections .yt-section')].map((b) => b.textContent.trim()),
  rows: [...document.querySelectorAll('#yt-rows .row-title')].map((h) => h.textContent.trim()),
  status: (document.getElementById('yt-status').textContent || '').trim(),
}));
ok(menu.visible, 'the YouTube view opens');
ok(menu.sections.includes('Trending') && menu.sections.includes('Music')
  && menu.sections.includes('Live Now'),
  'the section chips are the shelves the fleet sent', menu.sections.join(' | '));
ok(!menu.sections.includes('Gaming') && !menu.sections.includes('News'),
  'and NOT a list of shelves kept in the client (fixture sent 4, not 15)');
ok(menu.rows.includes('Trending') && menu.rows.includes('Music') && menu.rows.includes('Live Now'),
  'home draws a row per shelf', menu.rows.join(' | '));
ok(!menu.rows.includes('Sports'), 'an empty shelf draws no row at all');
ok(/3 shelves/.test(menu.status), 'and it says how many it found', menu.status);

// ── 2. The tile is a 16:9 YouTube tile, not the 2:3 poster ────────────────
const tile = await page.evaluate(() => {
  const card = document.querySelector('#yt-rows .yt-card');
  const thumb = card.querySelector('.yt-thumb');
  const box = thumb.getBoundingClientRect();
  return {
    ratio: box.width / box.height,
    width: box.width,
    duration: (card.querySelector('.yt-duration') || {}).textContent || '',
    meta: (card.querySelector('.yt-card-meta') || {}).textContent || '',
    isPoster: card.classList.contains('card'),
  };
});
ok(Math.abs(tile.ratio - 16 / 9) < 0.05, 'a YouTube tile is 16:9', `${tile.ratio.toFixed(2)} at ${Math.round(tile.width)}px`);
ok(!tile.isPoster, 'it does not reuse the app\'s 2:3 poster card');
ok(tile.duration === '1:05', 'the duration badge is M:SS', tile.duration);
ok(/1\.2M views/.test(tile.meta), 'and the meta line carries channel and views', tile.meta);

const liveTile = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#yt-rows .row')];
  const live = rows.find((r) => r.querySelector('.row-title').textContent.trim() === 'Live Now');
  const card = live.querySelector('.yt-card');
  return { badge: !!card.querySelector('.yt-duration'), meta: card.querySelector('.yt-card-meta').textContent };
});
ok(!liveTile.badge, 'a live stream (duration 0) wears no duration badge, not "0:00"');
ok(!/views/.test(liveTile.meta), 'and an unknown view count is left off, not printed as 0');

// ── 3. One card is one focus stop ──────────────────────────────────────────
const focusStops = await page.evaluate(() => {
  const track = document.querySelector('#yt-rows .row-track');
  const cards = track.querySelectorAll('.yt-card').length;
  const focusable = track.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])').length;
  return { cards, focusable };
});
ok(focusStops.cards === focusStops.focusable,
  'a row holds exactly one focus stop per card (a d-pad rule, not a style)',
  `${focusStops.cards} cards / ${focusStops.focusable} focusable`);

// ── 4. Search ──────────────────────────────────────────────────────────────
await page.fill('#yt-search-input', 'lofi beats');
await page.locator('#yt-search-form button[type="submit"]').click();
await page.waitForTimeout(900);
const search = await page.evaluate(() => ({
  title: (document.querySelector('#yt-rows .row-title') || {}).textContent || '',
  cards: document.querySelectorAll('#yt-rows .yt-card').length,
  chips: [...document.querySelectorAll('#yt-rows .yt-chip')].map((c) => c.textContent.trim()),
  status: (document.getElementById('yt-status').textContent || '').trim(),
}));
ok(/lofi beats/.test(search.title), 'search draws one row of results', search.title);
ok(search.cards === 3, 'with a card per result', String(search.cards));
ok(search.chips.length === 2 && search.chips.includes('Lofi Girl'),
  'and a channel chip per distinct channel — the way into a channel page',
  search.chips.join(' | '));
ok(/3 results/.test(search.status), 'the status line counts them', search.status);
ok(calls.some((c) => c.includes('/youtube/search?q=lofi%20beats')),
  'the search went to the fleet route, not to a YouTube API');

// ── 5. A channel page, and Follow ──────────────────────────────────────────
await page.evaluate(() => [...document.querySelectorAll('#yt-rows .yt-chip')]
  .find((c) => c.textContent.trim() === 'Lofi Girl').click());
await page.waitForTimeout(900);
const channel = await page.evaluate(() => ({
  shown: !document.getElementById('yt-channel').hidden,
  name: (document.querySelector('.yt-channel-name') || {}).textContent || '',
  meta: (document.querySelector('.yt-channel-meta') || {}).textContent || '',
  button: (document.getElementById('yt-follow') || {}).textContent || '',
  cards: document.querySelectorAll('#yt-rows .yt-card').length,
}));
ok(channel.shown && channel.name === 'Lofi Girl', 'a channel page opens with its real name', channel.name);
ok(/15\.8M subscribers/.test(channel.meta), 'and its subscriber count', channel.meta);
ok(channel.button === 'Follow', 'with a Follow button', channel.button);
ok(channel.cards === 2, 'and the channel\'s videos', String(channel.cards));

await page.evaluate(() => document.getElementById('yt-follow').click());
await page.waitForTimeout(700);
const followed = await page.evaluate(() => ({
  button: document.getElementById('yt-follow').textContent,
  pressed: document.getElementById('yt-follow').getAttribute('aria-pressed'),
}));
ok(followed.button === 'Following' && followed.pressed === 'true',
  'pressing Follow flips the button', `${followed.button} / ${followed.pressed}`);
ok(calls.some((c) => c.startsWith('POST /youtube/subs')),
  'and it POSTed the follow to the fleet, so it follows you to the television');

await page.evaluate(() => [...document.querySelectorAll('#yt-sections .yt-section')]
  .find((b) => b.textContent.trim() === 'Following').click());
await page.waitForTimeout(900);
const feed = await page.evaluate(() => ({
  title: (document.querySelector('#yt-rows .row-title') || {}).textContent || '',
  chips: [...document.querySelectorAll('#yt-rows .yt-chip')].map((c) => c.textContent.trim()),
}));
ok(/New from your channels/.test(feed.title), 'Following shows the merged feed', feed.title);
ok(feed.chips.includes('Lofi Girl'), 'and lists the channels you follow', feed.chips.join(' | '));

// ── 6. Playlists ───────────────────────────────────────────────────────────
await page.evaluate(() => [...document.querySelectorAll('#yt-sections .yt-section')]
  .find((b) => b.textContent.trim() === 'Playlists').click());
await page.waitForTimeout(400);
// A pasted LINK, not a bare id: nobody types PLOHoVaTp8R7d… by hand.
await page.fill('#yt-playlist-input', 'https://www.youtube.com/playlist?list=PLOHoVaTp8R7dfrJW5pumS0iD_dhlXKv17');
await page.locator('#yt-playlist-form button[type="submit"]').click();
await page.waitForTimeout(900);
const playlist = await page.evaluate(() => ({
  cards: document.querySelectorAll('#yt-rows .yt-card').length,
  status: (document.getElementById('yt-status').textContent || '').trim(),
}));
ok(playlist.cards === 3, 'a pasted playlist link opens the playlist', String(playlist.cards));
ok(calls.some((c) => c.includes('/youtube/playlist/PLOHoVaTp8R7dfrJW5pumS0iD_dhlXKv17')),
  'the list id was pulled out of the URL, not sent whole', playlist.status);

// ── 7. Keep watching ───────────────────────────────────────────────────────
await page.evaluate(() => [...document.querySelectorAll('#yt-sections .yt-section')]
  .find((b) => b.textContent.trim() === 'Home').click());
await page.waitForTimeout(700);
await page.evaluate(() => document.querySelector('#yt-rows .yt-card').click());
await page.waitForTimeout(1200);
// The player opens over the page; close it the way a viewer would.
await page.evaluate(() => { const b = document.getElementById('player-close'); if (b) b.click(); });
await page.waitForTimeout(500);

const kept = await page.evaluate(() => ({
  debug: window.BlazingYouTube.debug(),
  first: (document.querySelector('#yt-rows .row-title') || {}).textContent || '',
}));
ok(kept.debug.keepWatching === 1, 'playing a video writes Keep watching', JSON.stringify(kept.debug.keepWatching));
ok(kept.first === 'Keep watching', 'and it is the FIRST row — yours before everyone\'s', kept.first);

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await selectProfile('Mark');
await page.evaluate(() => document.querySelector('.topnav [data-view="youtube"]').click());
await page.waitForTimeout(1500);
const afterReload = await page.evaluate(() => (document.querySelector('#yt-rows .row-title') || {}).textContent || '');
ok(afterReload === 'Keep watching', 'Keep watching survives a reload', afterReload);

// A second profile must not read the first one's history back off this device.
await page.evaluate(() => document.dispatchEvent(new CustomEvent('blazing-profile-selected', { detail: { id: 'p2', name: 'Ada' } })));
await page.waitForTimeout(900);
const otherProfile = await page.evaluate(() => ({
  keep: window.BlazingYouTube.debug().keepWatching,
  first: (document.querySelector('#yt-rows .row-title') || {}).textContent || '',
}));
ok(otherProfile.keep === 0 && otherProfile.first !== 'Keep watching',
  'a second profile does not see the first one\'s Keep watching',
  `${otherProfile.keep} / ${otherProfile.first}`);

// ── 8. An empty answer says so ─────────────────────────────────────────────
searchAnswer = [];
await page.fill('#yt-search-input', 'nothing at all here');
await page.locator('#yt-search-form button[type="submit"]').click();
await page.waitForTimeout(800);
const empty = await page.evaluate(() => ({
  status: (document.getElementById('yt-status').textContent || '').trim(),
  cards: document.querySelectorAll('#yt-rows .yt-card').length,
}));
ok(empty.cards === 0 && empty.status.length > 10,
  'an empty search says why instead of drawing a blank page', empty.status);

// ── 9. The d-pad reaches the cards ─────────────────────────────────────────
searchAnswer = [vid(11), vid(12), vid(13)];
await page.evaluate(() => [...document.querySelectorAll('#yt-sections .yt-section')]
  .find((b) => b.textContent.trim() === 'Home').click());
await page.waitForTimeout(800);
const dpad = await page.evaluate(() => {
  document.querySelector('#yt-sections .yt-section').focus();
  return document.activeElement.className;
});
ok(/yt-section/.test(dpad), 'a section chip takes focus', dpad);
for (let i = 0; i < 6; i += 1) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(120); }
const landed = await page.evaluate(() => {
  const el = document.activeElement;
  return { cls: el.className, inView: !!el.closest('#youtube-view'), label: el.getAttribute('aria-label') || '' };
});
ok(landed.inView, 'ArrowDown keeps focus inside the YouTube view', `${landed.cls} ${landed.label}`);
ok(/yt-card/.test(landed.cls), 'and reaches a video tile', landed.cls);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(200);
const right = await page.evaluate(() => document.activeElement.getAttribute('aria-label') || '');
ok(/^Play /.test(right), 'ArrowRight moves along the row to the next tile', right);

// ── 10. No embed, anywhere ─────────────────────────────────────────────────
const embeds = await page.evaluate(() => ({
  iframes: document.querySelectorAll('iframe').length,
  ytIframes: [...document.querySelectorAll('iframe')].filter((f) => /youtube/i.test(f.src || '')).length,
}));
ok(embeds.ytIframes === 0,
  'no YouTube iframe exists on the page — it could not run on Roku, Apple TV, Fire TV, webOS, Tizen or VegaOS',
  `${embeds.iframes} iframes total`);

ok(errors.length === 0, 'nothing threw on the way through', errors.slice(0, 2).join(' ; '));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
