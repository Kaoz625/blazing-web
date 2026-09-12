/**
 * Live TV on the web: the placeholder filter, the honest count, the search, and
 * the ticket that makes a <video> able to authenticate.
 *
 * WHY EACH CHECK IS HERE. All of them are things that look right in the source
 * and are wrong on the device:
 *
 *  - The index is mostly junk at the top. One live page of 500 measured 470
 *    placeholder rows to 30 real ones, so a grid that renders what the server
 *    sends reads as a broken app. isPlaceholder() has to drop them.
 *  - ...but the COUNT must still be the server's own total. Reporting the
 *    filtered number tells a viewer there are 12 channels in a 38,899-channel
 *    index, and they go looking for a bug that is not there.
 *  - The media URL must carry no credential and must point at /live/play, not
 *    at the provider. A provider URL is http and this page is https, so the
 *    browser refuses it silently — no throw, no console, just a black player.
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

// The real shapes, copied off the live index on 6 Sep 2026 rather than invented.
const REAL = [
  { id: 'c1', name: 'CA - CNN INTERNATIONAL HD', logo: 'https://img.invalid/cnn.png', group: 'news', hasGuide: true, streamCount: 1 },
  { id: 'c2', name: 'BBC', logo: 'http://photo-tmdb.com/logo.png', group: 'general', country: 'uk', hasGuide: true, streamCount: 2 },
  { id: 'c3', name: 'CHL: CNN HD', logo: '', group: 'news', hasGuide: false, streamCount: 1 },
];
// The two rows the fleet holds listings for, plus one it does not. hasGuide is
// the server's own answer and the guide store must believe it: 9,708 of the
// 9,910 public channels answer it "no", so asking anyway spends every request
// on channels certain to come back empty.
const GUIDED = [REAL[0], REAL[1]];
// ESPN 3 has streams and no XMLTV, so a guide-only catalogue has no ESPN row at
// all — the exact hole GuideActivity.kt:296-306 merges one brand query to fill.
const ESPN = { id: 'e1', name: 'ESPN 3', logo: '', group: 'sports', hasGuide: false, streamCount: 1 };
const NOW_TITLE = 'Premier League Darts';
const JUNK = [
  { id: 'j1', name: '- NO EVENT STREAMING - | 8K EXCLUSIVE | BR: DISNEY+ PPV 100', group: 'general', streamCount: 1 },
  { id: 'j2', name: '##### CBS ALABAMA #####', group: 'general', streamCount: 1 },
  { id: 'j3', name: '--- National CBS Channels---', group: 'general', streamCount: 1 },
  { id: 'j4', name: '   ', group: 'general', streamCount: 1 },
];
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-live', token: 'tok-live' }));
  localStorage.setItem('blazing-household-approved', '1');
  localStorage.setItem('blazing-web-profile-session-v1', JSON.stringify({
    id: 'p-live', maxRating: 'adult', isKids: false, neededPin: false, allowAdult: true, savedAt: Date.now(),
  }));
  // Record what the player was handed, instead of actually opening one.
  window.__played = [];
});

const seen = [];
const nowAsked = [];
const guideAsked = [];
let tokenHeaderSeen = null;
await ctx.route('https://fleet.lyreosai.com/**', (route) => {
  const url = new URL(route.request().url());
  seen.push(url.pathname + url.search);
  if (url.pathname === '/live/groups') {
    return json(route, { groups: [
      { id: 'news', name: 'News', count: 1063 },
      { id: 'sports', name: 'Sports', count: 4416 },
    ] });
  }
  if (url.pathname === '/live/now') {
    nowAsked.push(url.searchParams.get('channels') || '');
    // 15 minutes in, 45 to go: a bar at exactly a quarter, recomputed from the
    // stamps rather than read off the server's frozen `progress`.
    const start = new Date(Date.now() - 15 * 60000).toISOString();
    const stop = new Date(Date.now() + 45 * 60000).toISOString();
    return json(route, { now: { c1: { title: NOW_TITLE, category: 'Sports', start, stop }, c2: null } });
  }
  if (url.pathname === '/live/guide') {
    guideAsked.push(url.searchParams.get('channels') || '');
    const from = Date.parse(url.searchParams.get('from') || '') || Date.now();
    return json(route, { guide: { c1: [{
      title: NOW_TITLE,
      start: new Date(from + 30 * 60000).toISOString(),
      stop: new Date(from + 90 * 60000).toISOString(),
    }] } });
  }
  if (url.pathname === '/live/channels') {
    tokenHeaderSeen = route.request().headers()['x-device-token'] || null;
    const q = url.searchParams.get('q');
    const group = url.searchParams.get('group');
    if (url.searchParams.get('withGuide') === '1') {
      return json(route, { total: GUIDED.length, channels: GUIDED });
    }
    if (q === 'ESPN') return json(route, { total: 1, channels: [ESPN] });
    if (q === 'cnn') return json(route, { total: 38, channels: REAL.filter((c) => /cnn/i.test(c.name)) });
    if (group === 'news') return json(route, { total: 1063, channels: REAL.filter((c) => c.group === 'news') });
    // THE REAL INDEX, NOT A TIDY ONE. Measured on the live fleet 6 Sep 2026:
    // 41,341 channels whose first 60 rows were placeholders to the last one.
    // A client that reads one page and filters it finds nothing and paints an
    // empty grid — which is exactly what Markus reported as a blank Live TV
    // screen. So page one here is ALL junk and the real rows sit behind it.
    const skip = Number(url.searchParams.get('skip') || 0);
    const limit = Number(url.searchParams.get('limit') || 60);
    if (skip === 0) {
      const wall = Array.from({ length: limit }, (unused, i) => ({
        ...JUNK[i % JUNK.length], id: `wall-${i}`,
      }));
      return json(route, { total: 38899, channels: wall });
    }
    return json(route, { total: 38899, channels: [...JUNK, ...REAL] });
  }
  if (url.pathname.startsWith('/live/ticket/')) {
    return json(route, { ticket: 'abc123def456abc123def456abc12345', url: '/live/play/abc123def456abc123def456abc12345', format: 'hls' });
  }
  if (url.pathname === '/accounts/me') return json(route, { account: { id: 'a' }, device: { id: 'dev-live', enrollmentStatus: 'approved' } });
  if (url.pathname === '/profiles') return json(route, { profiles: [{ id: 'p-live', name: 'Mark', maxRating: 'adult', hasPin: false }] });
  return json(route, {});
});
await ctx.route('https://addon.lyreosai.com/**', (route) => json(route, {}));
// A logo that REALLY loads. Without this the https logo 404s, the card's own
// `error` handler swaps in the initials — correctly — and the check below would
// read 0 images and blame safeHttpsUrl for something it did not do.
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
await ctx.route('https://img.invalid/**', (route) =>
  route.fulfill({ status: 200, contentType: 'image/gif', body: GIF }));

const page = await ctx.newPage();
const faults = [];
page.on('pageerror', (e) => faults.push(e.message));
await page.goto(`${base}/index.html`);
// Stand in for the player so nothing tries to decode a fixture URL.
await page.evaluate(() => {
  window.BlazingPlayer = { open: (title, url, opts) => window.__played.push({ title, url, opts }) };
});

// ── the chip exists and reaches the view ────────────────────────────────────
ok(await page.locator('.topnav [data-view="livetv"]').count() === 1, 'Live TV is a chip in the top nav');
ok(await page.locator('.drawer-nav [data-view="livetv"]').count() === 1,
  'and in the drawer too — .topnav is display:none at 992px, so the drawer is the phone');

// The gate's backdrop covers the nav until somebody says who they are, so a
// click on a chip is intercepted rather than delivered. Get past it first —
// this suite is about Live TV, not about the gate.
//
// It is no longer a click. This fixture stores a remembered session (see
// 'blazing-web-profile-session-v1' above) and a matching PIN-less profile, so
// profile.js restores that viewer and closes the gate ITSELF; the "Choose Mark"
// button is gone before a click could land, and waiting for it timed out. The
// hand-pick is kept as the fallback so this suite still passes for a fixture
// with nothing remembered. See profile-restore.smoke.mjs for the restore's own
// checks.
await page.waitForFunction(() => document.querySelector('.bp-layer')?.hidden !== false, null, { timeout: 20000 })
  .catch(async () => {
    await page.getByRole('button', { name: 'Choose Mark', exact: true }).click({ timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('.bp-layer')?.hidden !== false, null, { timeout: 15000 })
      .catch(() => {});
  });

await page.locator('.topnav [data-view="livetv"]').click();
await page.waitForFunction(() => !document.getElementById('livetv-view').hidden);
ok(true, 'the chip opens #livetv-view');

await page.waitForFunction(() => document.querySelectorAll('#livetv-results .livetv-card').length > 0, null, { timeout: 8000 });

// ── the placeholder filter ──────────────────────────────────────────────────
const names = await page.locator('#livetv-results .livetv-card-name').allInnerTexts();
ok(names.length === 3, 'only the real channels are drawn', `${names.length} of ${JUNK.length + REAL.length} rows`);
ok(seen.filter((u) => u.startsWith('/live/channels')).length >= 2,
  'AND IT READ PAST THE ALL-PLACEHOLDER FIRST PAGE instead of painting an empty grid — one page of the real index can be 60 out of 60 junk rows',
  `${seen.filter((u) => u.startsWith('/live/channels')).length} channel requests`);
ok(seen.some((u) => u.startsWith('/live/channels') && /skip=(?!0\b)\d+/.test(u)),
  'the sweep advanced the cursor rather than asking for the same page again',
  seen.filter((u) => u.startsWith('/live/channels')).join(' | ').slice(0, 120));
ok(!names.some((n) => /NO EVENT STREAMING/i.test(n)), 'the PPV placeholders are gone');
ok(!names.some((n) => /^#+/.test(n.trim())), 'the "##### CBS ALABAMA #####" heading rows are gone');
ok(!names.some((n) => /^-{3}/.test(n.trim())), 'and the "--- National CBS Channels---" rules are gone');
ok(names.includes('CA - CNN INTERNATIONAL HD'),
  'a REAL name starting with a dash survives — the filter is about decoration, not punctuation');

// ── the honest count ────────────────────────────────────────────────────────
const status = await page.locator('#livetv-status').innerText();
ok(/38,899/.test(status), "the SERVER's total is reported, not the filtered count", status);
ok(/Showing 3 /.test(status), 'and what is on screen is stated separately', status);

// ── credentials go in a header, never a URL ─────────────────────────────────
ok(tokenHeaderSeen === 'tok-live', 'the device token travels in X-Device-Token', String(tokenHeaderSeen));
ok(seen.some((u) => u.startsWith('/live/channels') && u.includes('deviceId=dev-live')),
  'the device id is a query param, which is what scopes the index');
ok(!seen.some((u) => /token/i.test(u)), 'NO request URL carries the token', seen.filter((u) => /token/i.test(u)).join(','));

// ── mixed-content logos ─────────────────────────────────────────────────────
const imgs = await page.locator('#livetv-results .livetv-card-art img').count();
ok(imgs === 1, 'only the https logo becomes an <img>; the http one would be blocked as mixed content', `${imgs} images`);

// ── B33. WHAT IS ON, on the card ────────────────────────────────────────────
// Before this the meta line read "News · Guide": the group, and a literal
// string saying the server holds listings this client never went and asked
// for. All three televisions put the programme first.
await page.waitForFunction(
  () => document.querySelector('#livetv-results .livetv-card-meta[data-live="true"]') !== null,
  null, { timeout: 8000 });
const liveLine = await page.locator('#livetv-results .livetv-card').first().locator('.livetv-card-meta').innerText();
ok(new RegExp(NOW_TITLE).test(liveLine), 'the card says what is ON, not the word "Guide"', liveLine);
ok(/^\d{1,2}[:.]\d{2}/.test(liveLine.trim()) || /\d{1,2}:\d{2}/.test(liveLine),
  'and it carries the start time in the viewer\'s own clock, because the guide itself is UTC', liveLine);
ok(!/Guide/.test(liveLine), 'the literal string "Guide" is gone from the card', liveLine);

const fillWidth = await page.locator('#livetv-results .livetv-card').first()
  .locator('.livetv-card-progress-fill').evaluate((el) => el.style.width);
ok(/^2[0-9](\.\d)?%$/.test(fillWidth),
  'the bar is recomputed from start/stop — 15 minutes into a 60-minute programme is a quarter, not the server\'s frozen `progress`',
  fillWidth);

const fallback = await page.locator('#livetv-results .livetv-card').nth(1).locator('.livetv-card-meta').innerText();
ok(/UK/.test(fallback) && /General/.test(fallback),
  'a channel the guide knows nothing about falls back to its country and group, exactly as tvOS does', fallback);
const emptyBar = await page.locator('#livetv-results .livetv-card').nth(1)
  .locator('.livetv-card-progress-fill').evaluate((el) => el.style.width);
ok(emptyBar === '0%', 'and draws NO fill rather than a full or a negative one', emptyBar);

ok(nowAsked.length >= 1, '/live/now was actually called', String(nowAsked.length));
ok(!nowAsked.join(',').split(',').includes('c3'),
  'a channel whose hasGuide is false is never asked about — 9,708 of 9,910 answer that question "no"',
  nowAsked.join(' | '));
ok(nowAsked.every((batch) => batch.split(',').length <= 100),
  'and no batch crosses the server\'s cap of 100 ids', nowAsked.join(' | '));

// ── group filter and search ─────────────────────────────────────────────────
await page.locator('.livetv-chip[data-group="news"]').click();
await page.waitForFunction(() => document.getElementById('livetv-status').textContent.includes('1,063'), null, { timeout: 8000 });
ok(true, 'a group chip refilters and reports that group\'s own total');
ok(await page.locator('.livetv-chip[data-group="news"]').getAttribute('aria-pressed') === 'true',
  'and the chip says so through aria-pressed, which is also what styles it');

await page.fill('#livetv-search-input', 'cnn');
await page.locator('#livetv-search-form button[type="submit"]').click();
await page.waitForFunction(() => document.getElementById('livetv-status').textContent.includes('38 channels'), null, { timeout: 8000 });
const searched = await page.locator('#livetv-results .livetv-card-name').allInnerTexts();
ok(searched.length === 2 && searched.every((n) => /cnn/i.test(n)), 'search asks the SERVER and narrows the grid', searched.join(' | '));
ok(await page.locator('.livetv-chip[data-group="news"]').getAttribute('aria-pressed') === 'false',
  'searching clears the group chip — a search that silently stayed narrowed would hide matches');

// ── tuning ──────────────────────────────────────────────────────────────────
await page.locator('#livetv-results .livetv-card').first().click();
await page.waitForFunction(() => window.__played.length > 0, null, { timeout: 8000 });
const played = await page.evaluate(() => window.__played[0]);
ok(played.url === 'https://fleet.lyreosai.com/live/play/abc123def456abc123def456abc12345',
  'the player is handed /live/play, NOT the provider url — an http provider url is refused as mixed content', played.url);
ok(!/token|tok-live/i.test(played.url), 'and that media url carries no credential at all', played.url);
ok(played.opts.streamFormat === 'hls',
  "the server's declared format is passed through — this URL has no .m3u8 for looksLikeHls() to sniff", played.opts.streamFormat);
ok(seen.some((u) => u.startsWith('/live/ticket/')), 'a ticket was minted first');

// ── B23. THE GRID GUIDE ─────────────────────────────────────────────────────
// The browser had the word "Guide" on a card and nothing behind it while the
// Fire Stick has shipped a real three-hour grid for weeks.
await page.locator('#livetv-guide-open').click();
await page.waitForFunction(() => document.querySelectorAll('#livetv-guide-grid .livetv-guide-row').length > 0,
  null, { timeout: 15000 });
ok(await page.locator('#livetv-channels-panel').isHidden(), 'the Guide button swaps the channel grid out');

const ruler = await page.locator('#livetv-guide-grid .livetv-guide-time').allInnerTexts();
ok(ruler.length === 6, 'the ruler is three hours in half-hour columns, as GuideActivity draws it', `${ruler.length} labels`);

const rowNames = await page.locator('#livetv-guide-grid .livetv-guide-name').allInnerTexts();
ok(rowNames.length === 3, 'every guided channel gets a row', rowNames.join(' | '));
ok(rowNames.join('|') === 'BBC|CA - CNN INTERNATIONAL HD|ESPN 3', 'sorted by name, as Fire TV sorts them', rowNames.join(' | '));
ok(rowNames.includes('ESPN 3'),
  'ESPN 3 is there even though it has NO XMLTV — a guide-only catalogue has no ESPN row at all without the brand merge');
ok(guideAsked.length >= 1 && guideAsked.join(',').includes('c1'), '/live/guide was actually called', guideAsked.join(' | '));

const cnnRow = page.locator('#livetv-guide-grid .livetv-guide-row').nth(1);
const cnnBlocks = await cnnRow.locator('.livetv-guide-block').allInnerTexts();
ok(cnnBlocks.join('|') === `No guide data|${NOW_TITLE}|No guide data`,
  'the gaps around a listing are FILLED, so the row is still three hours wide and its columns line up with the ruler',
  cnnBlocks.join(' | '));
const blockWidth = await cnnRow.locator('.livetv-guide-block').nth(1).evaluate((el) => el.style.width);
ok(blockWidth === '480px', 'and a 60-minute programme is 60 × 8px wide', blockWidth);

const espnBlocks = await page.locator('#livetv-guide-grid .livetv-guide-row').nth(2).locator('.livetv-guide-block').allInnerTexts();
ok(espnBlocks.length === 1 && espnBlocks[0] === 'No guide data',
  'a row with no listings at all is one full-width block, not an empty row', espnBlocks.join(' | '));

const before = await page.evaluate(() => window.__played.length);
await cnnRow.locator('.livetv-guide-block').nth(1).click();
await page.waitForFunction((n) => window.__played.length > n, before, { timeout: 8000 });
const fromGuide = await page.evaluate(() => window.__played[window.__played.length - 1]);
ok(fromGuide.title === 'CA - CNN INTERNATIONAL HD', 'pressing a block tunes that channel', fromGuide.title);
ok(fromGuide.url.startsWith('https://fleet.lyreosai.com/live/play/'),
  'through the same ticket the card grid uses — no provider url, no credential', fromGuide.url);

await page.locator('#livetv-guide-close').click();
await page.waitForFunction(() => !document.getElementById('livetv-channels-panel').hidden);
ok(true, 'and Channels comes back');

ok(faults.length === 0, 'no page errors', faults.join(' | '));

/* ── B24. THE PARENTAL CAP ───────────────────────────────────────────────────
 *
 * A child on a kids profile sees only kids channels on the Roku and on the Fire
 * Stick. The same child in the browser got the whole 38,899-channel index and
 * could tune any of it. A separate context, because the cap is decided by the
 * profile that is restored at boot. */
const kidsCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await kidsCtx.addInitScript(() => {
  localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-live', token: 'tok-live' }));
  localStorage.setItem('blazing-household-approved', '1');
  localStorage.setItem('blazing-web-profile-session-v1', JSON.stringify({
    id: 'p-kid', maxRating: 'general', isKids: true, neededPin: false, allowAdult: false, savedAt: Date.now(),
  }));
  window.__played = [];
});
const kidsSeen = [];
const KIDS_CHANNELS = [
  { id: 'k1', name: 'Cartoon Network HD', logo: '', group: 'kids', country: 'us', hasGuide: false, streamCount: 1 },
  { id: 'k2', name: 'Nick Jr', logo: '', group: 'Kids;Animation', country: 'us', hasGuide: false, streamCount: 1 },
];
await kidsCtx.route('https://fleet.lyreosai.com/**', (route) => {
  const url = new URL(route.request().url());
  kidsSeen.push(url.pathname + url.search);
  if (url.pathname === '/live/groups') {
    return json(route, { groups: [
      { id: 'news', name: 'News', count: 1063 },
      { id: 'sports', name: 'Sports', count: 4416 },
      { id: 'kids', name: 'Kids', count: 427 },
    ] });
  }
  if (url.pathname === '/live/channels') {
    const group = url.searchParams.get('group');
    if (group === 'kids') return json(route, { total: 427, channels: KIDS_CHANNELS });
    return json(route, { total: 38899, channels: [...JUNK, ...REAL] });
  }
  if (url.pathname.startsWith('/live/ticket/')) {
    return json(route, { ticket: 'kid', url: '/live/play/kid', format: 'hls' });
  }
  if (url.pathname === '/accounts/me') return json(route, { account: { id: 'a' }, device: { id: 'dev-live', enrollmentStatus: 'approved' } });
  if (url.pathname === '/profiles') return json(route, { profiles: [{ id: 'p-kid', name: 'Ellie', maxRating: 'general', isKids: true, hasPin: false }] });
  return json(route, {});
});
await kidsCtx.route('https://addon.lyreosai.com/**', (route) => json(route, {}));

const kidsPage = await kidsCtx.newPage();
const kidsFaults = [];
kidsPage.on('pageerror', (e) => kidsFaults.push(e.message));
await kidsPage.goto(`${base}/index.html`);
await kidsPage.evaluate(() => {
  window.BlazingPlayer = { open: (title, url, opts) => window.__played.push({ title, url, opts }) };
});
await kidsPage.waitForFunction(() => document.querySelector('.bp-layer')?.hidden !== false, null, { timeout: 20000 })
  .catch(async () => {
    await kidsPage.getByRole('button', { name: 'Choose Ellie', exact: true }).click({ timeout: 15000 });
    await kidsPage.waitForFunction(() => document.querySelector('.bp-layer')?.hidden !== false, null, { timeout: 15000 })
      .catch(() => {});
  });
await kidsPage.locator('.topnav [data-view="livetv"]').click();
await kidsPage.waitForFunction(() => document.querySelectorAll('#livetv-results .livetv-card').length > 0, null, { timeout: 15000 });

const kidsNames = await kidsPage.locator('#livetv-results .livetv-card-name').allInnerTexts();
ok(kidsNames.length === 2 && kidsNames.every((n) => /Cartoon Network|Nick Jr/.test(n)),
  'B24 — a kids profile sees kids channels and nothing else', kidsNames.join(' | '));

const kidsChips = await kidsPage.locator('.livetv-chip').allInnerTexts();
ok(kidsChips.length === 1 && /^Kids/.test(kidsChips[0]),
  'a blocked group chip never draws — filtering groups is what makes the cap cost no request at all',
  kidsChips.join(' | '));
ok(!kidsChips.some((c) => /^All/.test(c)),
  '"All" goes with them: a chip that says All and means "the 427 kids channels" is worse than no chip');
ok(kidsSeen.some((u) => u.startsWith('/live/channels') && u.includes('group=kids')),
  'and the request is SCOPED to a kids group rather than sweeping 41,341 rows for 427 of them',
  kidsSeen.filter((u) => u.startsWith('/live/channels')).join(' | '));
ok(!kidsSeen.some((u) => /group=(news|sports)/.test(u)), 'a blocked group is never even asked for');

const kidsStatus = await kidsPage.locator('#livetv-status').innerText();
ok(/2 kids channels/.test(kidsStatus),
  'the count is RECOUNTED under the cap — telling a child’s profile it has 38,899 channels while it can see two is the kind of small lie that gets read as a bug',
  kidsStatus);
ok(!/38,899/.test(kidsStatus), 'so the server total is not printed at all', kidsStatus);

// THE SECOND LOCK. A profile switched while this view sat behind another one
// leaves the old profile's cards in the grid, and the press path builds a
// player URL directly with no gate behind it.
await kidsPage.evaluate(() => {
  const card = document.createElement('button');
  card.className = 'card livetv-card';
  card.type = 'button';
  card.dataset.channelId = 'c1';
  card.dataset.group = 'sports';
  card.innerHTML = '<span class="livetv-card-name">CA - CNN INTERNATIONAL HD</span>';
  document.getElementById('livetv-results').appendChild(card);
  card.click();
});
await kidsPage.waitForTimeout(600);
ok(await kidsPage.evaluate(() => window.__played.length) === 0,
  'B24 — a stale card from a blocked group cannot be tuned, and no ticket is minted for it');
ok(!kidsSeen.some((u) => u.startsWith('/live/ticket/')), 'the refusal happens BEFORE the network, not after it');
const refusal = await kidsPage.locator('#livetv-status').innerText();
ok(/rating limit hides/.test(refusal), 'and it says why, in Fire TV’s own words', refusal);

// The guide is the other door into the same 38,899 channels.
await kidsPage.locator('#livetv-guide-open').click();
await kidsPage.waitForFunction(() => document.getElementById('livetv-guide-status').textContent.length > 0,
  null, { timeout: 15000 });
await kidsPage.waitForTimeout(500);
ok(await kidsPage.locator('#livetv-guide-grid .livetv-guide-row').count() === 0,
  'B24/B23 — the grid guide carries the same cap, so it is not a way around it');
ok(!kidsSeen.some((u) => u.startsWith('/live/guide')),
  'and with nothing left to list it asks for no listings either');

ok(kidsFaults.length === 0, 'no page errors on the kids profile', kidsFaults.join(' | '));


/* ── B24 / B23. THE SWITCH THAT LANDS MID-REQUEST ────────────────────────────
 *
 * The two checks above both switch profiles on a screen that is sitting still,
 * and that is the easy half. Live TV is the slowest screen in this client — a
 * channel sweep is up to eight sequential requests and the guide walk is up to
 * twelve, so "the viewer switched profile while something was in flight" is the
 * ordinary case here, not a race that needs contriving.
 *
 * Two things were wrong, and both are invisible on a fast fixture:
 *
 *   1. adoptProfile() left the previous profile's cards on screen for the whole
 *      length of the /live/groups request it awaits before reloading. play()
 *      refuses them, so nothing could be tuned — but a kids profile showing a
 *      wall of adult channels has not switched as far as anyone watching it is
 *      concerned.
 *   2. loadGuide() refused to start while a build was in flight, and the build
 *      it refused for was the one adoptProfile() had just superseded. The
 *      superseded build then returned at its checkpoint WITHOUT releasing
 *      state.guideLoading — so nothing ever released it, and the Guide panel
 *      read "Building the guide…" for the rest of the session and could not be
 *      rebuilt. A hard lock, one profile switch away, every time.
 *
 * Both are reproduced by holding the fleet's answer open, which is the one
 * thing a local fixture never does by itself. */
const slowCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await slowCtx.addInitScript(() => {
  localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-live', token: 'tok-live' }));
  localStorage.setItem('blazing-household-approved', '1');
  localStorage.setItem('blazing-web-profile-session-v1', JSON.stringify({
    id: 'p-live', maxRating: 'adult', isKids: false, neededPin: false, allowAdult: true, savedAt: Date.now(),
  }));
  window.__played = [];
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Turned up only for the window each check needs, so the rest of this context
// runs at fixture speed.
let holdGroupsMs = 0;
let holdGuideCatalogueMs = 0;
const slowSeen = [];
await slowCtx.route('https://fleet.lyreosai.com/**', async (route) => {
  const url = new URL(route.request().url());
  slowSeen.push(url.pathname + url.search);
  if (url.pathname === '/live/groups') {
    if (holdGroupsMs) await sleep(holdGroupsMs);
    return json(route, { groups: [
      { id: 'news', name: 'News', count: 1063 },
      { id: 'sports', name: 'Sports', count: 4416 },
      { id: 'kids', name: 'Kids', count: 427 },
    ] });
  }
  if (url.pathname === '/live/now') return json(route, { now: {} });
  if (url.pathname === '/live/guide') return json(route, { guide: {} });
  if (url.pathname === '/live/channels') {
    const group = url.searchParams.get('group');
    if (url.searchParams.get('withGuide') === '1') {
      if (holdGuideCatalogueMs) await sleep(holdGuideCatalogueMs);
      return json(route, { total: GUIDED.length, channels: GUIDED });
    }
    if (url.searchParams.get('q') === 'ESPN') return json(route, { total: 1, channels: [ESPN] });
    if (group === 'kids') return json(route, { total: 427, channels: KIDS_CHANNELS });
    return json(route, { total: 38899, channels: REAL });
  }
  if (url.pathname.startsWith('/live/ticket/')) {
    return json(route, { ticket: 'abc123def456abc123def456abc12345', url: '/live/play/abc123def456abc123def456abc12345', format: 'hls' });
  }
  if (url.pathname === '/accounts/me') return json(route, { account: { id: 'a' }, device: { id: 'dev-live', enrollmentStatus: 'approved' } });
  if (url.pathname === '/profiles') return json(route, { profiles: [{ id: 'p-live', name: 'Mark', maxRating: 'adult', hasPin: false }] });
  return json(route, {});
});
await slowCtx.route('https://addon.lyreosai.com/**', (route) => json(route, {}));
await slowCtx.route('https://img.invalid/**', (route) =>
  route.fulfill({ status: 200, contentType: 'image/gif', body: GIF }));

const slowPage = await slowCtx.newPage();
const slowFaults = [];
slowPage.on('pageerror', (e) => slowFaults.push(e.message));
await slowPage.goto(`${base}/index.html`);
await slowPage.evaluate(() => {
  window.BlazingPlayer = { open: (title, url, opts) => window.__played.push({ title, url, opts }) };
});
await slowPage.waitForFunction(() => document.querySelector('.bp-layer')?.hidden !== false, null, { timeout: 20000 })
  .catch(async () => {
    await slowPage.getByRole('button', { name: 'Choose Mark', exact: true }).click({ timeout: 15000 });
    await slowPage.waitForFunction(() => document.querySelector('.bp-layer')?.hidden !== false, null, { timeout: 15000 })
      .catch(() => {});
  });
await slowPage.locator('.topnav [data-view="livetv"]').click();
await slowPage.waitForFunction(() => document.querySelectorAll('#livetv-results .livetv-card').length > 0, null, { timeout: 15000 });

const adultOnScreen = await slowPage.locator('#livetv-results .livetv-card-name').allInnerTexts();
ok(adultOnScreen.length === 3, 'the adult profile starts with the full index on screen', `${adultOnScreen.length} cards`);

// ── 1. the cards come off the screen ON the switch, not a request later ──────
// The broadcast livetv.js listens to is the one profile.js fires; dispatching it
// directly is what a switch looks like from this file's side of the wire.
holdGroupsMs = 1500;
await slowPage.evaluate(() => {
  document.dispatchEvent(new CustomEvent('blazing-profile-selected', {
    detail: { id: 'p-kid', name: 'Ellie', maxRating: 'general', isKids: true, allowAdult: false },
  }));
});
await slowPage.waitForTimeout(350);
const strandedCards = await slowPage.locator('#livetv-results .livetv-card').count();
ok(strandedCards === 0,
  'B24 — the previous profile’s channels are off the screen immediately, not after the /live/groups request that follows',
  `${strandedCards} cards still drawn 350ms into a 1500ms request`);
const midSwitchStatus = await slowPage.locator('#livetv-status').innerText();
ok(!/38,899/.test(midSwitchStatus),
  'and the old count goes with them — "Showing 3 of 38,899 channels" over an empty grid reads as a bug',
  midSwitchStatus);

// ── 2. and the reload that follows is NOT dropped by the load it interrupted ──
holdGroupsMs = 0;
await slowPage.waitForFunction(
  () => /kids channel/.test(document.getElementById('livetv-status').textContent),
  null, { timeout: 15000 });
const afterSwitch = await slowPage.locator('#livetv-results .livetv-card-name').allInnerTexts();
ok(afterSwitch.length === 2 && afterSwitch.every((n) => /Cartoon Network|Nick Jr/.test(n)),
  'B24 — and the kids grid actually arrives: a switch must supersede the sweep it lands in, not be refused by it',
  afterSwitch.join(' | '));
ok(await slowPage.locator('.livetv-chip').count() === 1,
  'the chips are re-drawn under the new cap too');

// ── 3. the guide is not wedged by a switch that lands mid-build ──────────────
// Back to an adult profile so the guide has rows to draw at all.
await slowPage.evaluate(() => {
  document.dispatchEvent(new CustomEvent('blazing-profile-selected', {
    detail: { id: 'p-live', name: 'Mark', maxRating: 'adult', isKids: false, allowAdult: true },
  }));
});
await slowPage.waitForFunction(
  () => document.querySelectorAll('#livetv-results .livetv-card').length === 3,
  null, { timeout: 15000 });

holdGuideCatalogueMs = 1500;
await slowPage.locator('#livetv-guide-open').click();
await slowPage.waitForFunction(
  () => /Building the guide/.test(document.getElementById('livetv-guide-status').textContent),
  null, { timeout: 8000 });
ok(true, 'the guide build is genuinely in flight before the switch is fired');
// THE SWITCH THAT USED TO KILL IT. Same cap, so the grid it rebuilds has the
// same rows — this check is about the panel still being able to rebuild at all.
await slowPage.evaluate(() => {
  document.dispatchEvent(new CustomEvent('blazing-profile-selected', {
    detail: { id: 'p-live', name: 'Mark', maxRating: 'adult', isKids: false, allowAdult: true },
  }));
});
holdGuideCatalogueMs = 0;
const rebuilt = await slowPage.waitForFunction(
  () => document.querySelectorAll('#livetv-guide-grid .livetv-guide-row').length > 0,
  null, { timeout: 15000 }).then(() => true).catch(() => false);
ok(rebuilt,
  'B23/B24 — a profile switch landing mid-build rebuilds the guide; it used to leave it on "Building the guide…" for the rest of the session, unrecoverably');
const guideStatusAfter = await slowPage.locator('#livetv-guide-status').innerText();
ok(!/Building the guide/.test(guideStatusAfter),
  'and state.guideLoading was released — a superseded build must not keep a flag its replacement owns',
  guideStatusAfter);

// ── 4. pressing Guide twice does not start the twelve-page walk twice ────────
const walkBefore = slowSeen.filter((u) => u.includes('withGuide=1')).length;
holdGuideCatalogueMs = 1200;
await slowPage.locator('#livetv-guide-close').click();
await slowPage.locator('#livetv-guide-open').click();
await slowPage.locator('#livetv-guide-close').click();
await slowPage.locator('#livetv-guide-open').click();
await slowPage.waitForTimeout(400);
const walkAfter = slowSeen.filter((u) => u.includes('withGuide=1')).length;
ok(walkAfter - walkBefore <= 1,
  'a viewer pressing Guide/Channels/Guide is a double-press, not a new profile — the build in flight for this window is left to finish',
  `${walkAfter - walkBefore} catalogue walks for 2 presses`);
holdGuideCatalogueMs = 0;
await slowPage.waitForFunction(
  () => document.querySelectorAll('#livetv-guide-grid .livetv-guide-row').length > 0,
  null, { timeout: 15000 }).catch(() => {});

ok(slowFaults.length === 0, 'no page errors across the switches', slowFaults.join(' | '));


console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
server.close();
if (fail) process.exit(1);
