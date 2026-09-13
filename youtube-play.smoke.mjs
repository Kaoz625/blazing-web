/**
 * END-TO-END: a real video, out of the real YouTube shelves, DECODING in a real
 * browser. This one stubs nothing that matters.
 *
 * youtube.smoke.mjs is the UI half and it runs against a fixture. A fixture can
 * prove an empty shelf is handled; it cannot prove a single frame ever decodes,
 * and "the poster frame appeared" has read as a pass in this fleet before —
 * `--disable-gpu` silently switches h264 off while canPlayType() still answers
 * "probably", so a capability check never catches it. Hence: decoded BYTES, both
 * tracks, climbing.
 *
 * THE ONE THING THAT IS RELAYED, AND WHY. The fleet's CORS allow-list holds
 * exactly two browser origins — https://kaoz625.github.io and
 * https://blazingstream.lyreosai.com (server.js:170). A page served from
 * 127.0.0.1 is not one of them, and the fleet answers its preflight with 403
 * (measured today: `curl -H 'Origin: http://127.0.0.1:8899'
 * https://fleet.lyreosai.com/youtube/subs` -> HTTP 403, while the same request
 * with the GitHub Pages origin returns 200 and echoes it back). So every
 * /youtube/* call is fetched by NODE and handed to the page with a permissive
 * header. The DATA is the live fleet's, byte for byte — the relay only exists
 * because this harness cannot be served from an allow-listed origin.
 *
 * The ADDON is not relayed at all: /proxy/yt-resolve answers
 * `access-control-allow-origin: *`, so the resolve and every HLS segment below
 * are real cross-origin requests from the page itself.
 *
 *   node youtube-play.smoke.mjs
 *   SHOT=/tmp/x.png node youtube-play.smoke.mjs
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

const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-1', token: 'tok' }));
  localStorage.setItem('blazing-household-approved', '1');
});

// ORDER MATTERS AND IT IS BACKWARDS FROM HOW IT READS. Playwright matches
// routes in REVERSE registration order — the LAST one registered is tried
// first — so the broad fleet stub has to be registered BEFORE the narrow
// /youtube/** relay, not after it. Registered the other way round (which is
// how a reader expects "specific after general" to work) the catch-all won
// every /youtube/* call and answered `{}`: 0 rows, 3 section chips, and a
// harness that reported the live fleet as empty while never once contacting it.
//
// Everything that is not /youtube/* here is the profile gate, and the gate is
// not what is under test.
const relayed = [];
await ctx.route('https://fleet.lyreosai.com/**', (route) => {
  const u = route.request().url();
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (u.includes('/devices/register')) return json({ ok: true, device: { id: 'dev-1', status: 'approved' }, token: 'tok' });
  if (u.includes('/profiles')) return json({ profiles: [{ id: 'p1', name: 'Mark', maxRating: 'adult', hasPin: false }] });
  return json({});
});

// The LIVE half: fetched by Node, so the fleet sees a server request with no
// Origin and answers normally.
await ctx.route('https://fleet.lyreosai.com/youtube/**', async (route) => {
  try {
    // THE ORIGIN HEADER HAS TO GO, and dropping it is the whole point of the
    // relay. route.fetch() forwards the page's own headers by default, so the
    // first version of this sent `Origin: http://127.0.0.1:<port>` from Node and
    // the fleet answered 403 exactly as it does from the browser — a relay that
    // reproduced the thing it exists to get around. A server-to-server request
    // carries no Origin, so allowedCorsOrigin() never runs.
    const res = await route.fetch({ timeout: 90_000, headers: { accept: 'application/json' } });
    const body = await res.text();
    relayed.push(`${res.status()} ${route.request().url().replace('https://fleet.lyreosai.com', '')}`);
    await route.fulfill({
      status: res.status(),
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body,
    });
  } catch (error) {
    relayed.push(`ERR ${String(error).slice(0, 60)}`);
    await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"relay failed"}' });
  }
});
await ctx.route('https://addon.lyreosai.com/api/ui/home-config*', (route) =>
  route.fulfill({ status: 404, body: 'no' }));
await ctx.route('https://upscale.lyreosai.com/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

// WHAT ACTUALLY HAPPENED TO THE RESOLVE, rather than only that it failed.
//
// This suite told the deploy gate "the resolver on the server did not answer"
// three times on 13 Sep 2026 and could not say whether that was a 403, a 429, a
// TLS failure, a DNS failure or a timeout. Those have four different fixes, and
// without the difference the honest options were to guess or to weaken the test.
// Meanwhile the same resolver answered every hand-made request from a developer
// machine in about 4 seconds, cold, with 178 of 180 rate-limit tokens left — so
// the interesting question was never "is it up", it was "what does it say to
// THIS client, from THIS network".
//
// Recorded from the page's own requests, so it is the real cross-origin call
// with the real origin header, not a node-side approximation of it.
const resolveLog = [];
page.on('response', async (res) => {
  if (!res.url().includes('/proxy/yt-resolve')) return;
  resolveLog.push(`HTTP ${res.status()} ${res.statusText()} after ${Date.now() - startedAt}ms`);
});
page.on('requestfailed', (req) => {
  if (!req.url().includes('/proxy/yt-resolve')) return;
  const f = req.failure();
  resolveLog.push(`NETWORK FAILURE ${(f && f.errorText) || 'unknown'} after ${Date.now() - startedAt}ms`);
});
let startedAt = Date.now();

await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
const tile = page.locator('.bp-profile').first();
if (await tile.count()) { await tile.click(); await page.waitForTimeout(1500); }

await page.evaluate(() => document.querySelector('.topnav [data-view="youtube"]').click());
// yt-dlp does fifteen searches behind /youtube/home on a cold cache. The live
// answer measured 2-4s warm today, but a cold one is minutes, so this waits on
// the rows rather than on a clock.
await page.waitForSelector('#yt-rows .yt-card', { timeout: 120_000 }).catch(() => {});

const shelves = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('#yt-rows .row')].map((r) => ({
    name: r.querySelector('.row-title').textContent.trim(),
    cards: r.querySelectorAll('.yt-card').length,
  })),
  sections: [...document.querySelectorAll('#yt-sections .yt-section')].map((b) => b.textContent.trim()),
  status: (document.getElementById('yt-status').textContent || '').trim(),
}));
console.log('\n  LIVE SHELVES RENDERED');
for (const r of shelves.rows) console.log(`    ${String(r.cards).padStart(3)}  ${r.name}`);
console.log(`  sections: ${shelves.sections.join(' | ')}\n`);

ok(shelves.rows.length >= 5, 'the live fleet drew real shelves', `${shelves.rows.length} rows`);
ok(shelves.rows.every((r) => r.cards > 0), 'and every row that drew has cards in it');
ok(shelves.sections.length >= 7, 'the section menu was built from those shelves', shelves.sections.length + ' chips');
ok(relayed.some((r) => r.startsWith('200 /youtube/home')), 'via /youtube/home on the fleet',
  relayed.find((r) => r.includes('/youtube/home')) || relayed.join(' ; ') || 'nothing was relayed');

// Pick a card that is a NORMAL video: it has a duration badge (so not a live
// stream, which never ends) and that duration is under an hour (so hls.js is
// not handed an eight-hour lofi radio manifest to parse before it can start).
const picked = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('#yt-rows .yt-card')];
  const seconds = (text) => {
    const parts = text.split(':').map(Number);
    return parts.reduce((a, p) => a * 60 + p, 0);
  };
  for (const card of cards) {
    const badge = card.querySelector('.yt-duration');
    if (!badge) continue;
    const length = seconds(badge.textContent.trim());
    if (length > 30 && length < 3600) {
      card.scrollIntoView({ block: 'center' });
      return {
        id: card.dataset.videoId,
        title: (card.querySelector('.yt-card-title') || {}).textContent || '',
        length: badge.textContent.trim(),
      };
    }
  }
  return null;
});
ok(!!picked, 'a normal (non-live, under an hour) video is on the shelves',
  picked ? `${picked.title} — ${picked.length} — ${picked.id}` : 'none found');

if (!picked) {
  console.log('\nFAIL  nothing playable to test with');
  await browser.close(); server.close(); process.exit(1);
}

// Click the CARD, not a function. The point is the path a viewer takes.
startedAt = Date.now();
await page.evaluate((id) => {
  document.querySelector(`#yt-rows .yt-card[data-video-id="${id}"]`).click();
}, picked.id);

// The resolver spawns yt-dlp, which has to solve YouTube's player JS.
//
// 75s, AND IT MUST STAY ABOVE youtube.js's OWN BUDGET. That file now makes TWO
// resolve attempts of RESOLVE_TIMEOUT_MS (30s) with a 700ms pause, so its worst
// case is 60.7s. This wait was 45s, which was fine for one attempt and became a
// trap the moment the retry landed: a slow-but-successful second attempt would
// return at ~61s to a harness that had already given up at 45s, and the suite
// would report "the resolver did not answer" about a resolve that answered.
//
// The rule, if youtube.js changes again: this number is RESOLVE_ATTEMPTS x
// RESOLVE_TIMEOUT_MS + the pauses, plus headroom. Never below it.
await page.waitForFunction(() => !document.getElementById('player').hidden, { timeout: 75_000 })
  .catch(() => {});
const opened = await page.evaluate(() => ({
  playerOpen: !document.getElementById('player').hidden,
  title: (document.getElementById('player-title').textContent || '').trim(),
  status: (document.getElementById('yt-status').textContent || '').trim(),
}));
if (resolveLog.length) {
  console.log('\n  RESOLVE ATTEMPTS');
  for (const line of resolveLog) console.log(`    ${line}`);
} else {
  console.log('\n  RESOLVE ATTEMPTS\n    none reached the network at all');
}
ok(opened.playerOpen, 'the app player opened on the card press', opened.status || opened.title);

// ── the measurement ────────────────────────────────────────────────────────
// webkitVideoDecodedByteCount and webkitAudioDecodedByteCount are the only
// numbers here that cannot be faked by a poster frame: they count bytes the
// DECODER consumed. Both must climb. Video alone would pass on a stream whose
// audio track never demuxed, which is the exact half-failure a muted autoplay
// hides.
const decode = await page.evaluate(async () => {
  const v = document.getElementById('video');
  const read = () => ({
    video: v.webkitVideoDecodedByteCount || 0,
    audio: v.webkitAudioDecodedByteCount || 0,
    t: v.currentTime,
  });
  const deadline = Date.now() + 30_000;
  let first = read();
  while (Date.now() < deadline) {
    const now = read();
    if (now.video > 0 && now.audio > 0) { first = now; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 3000));
  const second = read();
  return {
    first,
    second,
    width: v.videoWidth,
    height: v.videoHeight,
    readyState: v.readyState,
    paused: v.paused,
    // A bare identifier, not window.hlsInstance: app.js is a classic script and
    // its top-level `let` binding lives in the global LEXICAL environment, which
    // is not reachable as a property of window.
    levels: typeof hlsInstance !== 'undefined' && hlsInstance ? (hlsInstance.levels || []).length : null,
  };
});

console.log('\n  DECODER COUNTERS');
console.log(`    webkitVideoDecodedByteCount  ${decode.first.video}  ->  ${decode.second.video}`);
console.log(`    webkitAudioDecodedByteCount  ${decode.first.audio}  ->  ${decode.second.audio}`);
console.log(`    currentTime                  ${decode.first.t.toFixed(2)}s -> ${decode.second.t.toFixed(2)}s`);
console.log(`    frame                        ${decode.width}x${decode.height}, readyState ${decode.readyState}\n`);

ok(decode.second.video > 0, 'webkitVideoDecodedByteCount is above zero', String(decode.second.video));
ok(decode.second.audio > 0, 'webkitAudioDecodedByteCount is above zero', String(decode.second.audio));
ok(decode.second.video > decode.first.video, 'and video bytes are still CLIMBING (not one buffered frame)',
  `+${decode.second.video - decode.first.video} bytes in 3s`);
ok(decode.second.audio > decode.first.audio, 'and so are audio bytes',
  `+${decode.second.audio - decode.first.audio} bytes in 3s`);
ok(decode.width > 0 && decode.height > 0, 'a real frame size, not a 0x0 box',
  `${decode.width}x${decode.height}`);
ok(decode.second.t > decode.first.t, 'the clock moved — it is playing, not merely loaded',
  `+${(decode.second.t - decode.first.t).toFixed(2)}s`);

// Keep watching is written from the real play, not from the fixture.
const kept = await page.evaluate(() => window.BlazingYouTube.debug().keepWatching);
ok(kept >= 1, 'the real play wrote a Keep watching row', String(kept));

const noEmbed = await page.evaluate(() =>
  [...document.querySelectorAll('iframe')].filter((f) => /youtube/i.test(f.src || '')).length);
ok(noEmbed === 0, 'and it played with NO YouTube iframe anywhere on the page');

ok(errors.length === 0, 'no uncaught page errors', errors.slice(0, 3).join(' | '));

await page.evaluate(() => { const b = document.getElementById('player-close'); if (b) b.click(); });
await page.waitForTimeout(400);
// Back to the top, and every row rewound. Picking a card above scrolled both
// the page and that card's track, so the shot was of a half-scrolled screen —
// which is not what a viewer opening this tab sees, and the screenshot is the
// only part of this run a human actually looks at.
await page.evaluate(() => {
  window.scrollTo(0, 0);
  document.querySelectorAll('#yt-rows .row-track').forEach((t) => { t.scrollLeft = 0; });
});
await page.waitForTimeout(300);
await page.screenshot({ path: process.env.SHOT || '/tmp/youtube-shelves.png', fullPage: false });

await browser.close();
server.close();
console.log(`\n${picked.title}  (${picked.id})`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
