/**
 * The device probe really filters the source list, and the home hero really
 * moves — proven in a browser, not read off the source.
 *
 * TWO LETTERS, ONE HARNESS, because they share the one expensive thing: a real
 * Chromium with a real media stack, booted against the real index.html.
 *
 *   Letter C — "based on the device and what that device can handle will the
 *   selected sources play. the souce lists gets filtered based on audio/video
 *   quality mainly. always the best for that specfic device."
 *
 *   Letter B — "i absolutly love how on the home page the continue watching
 *   fills the whole screen. all devices should look like this and do this."
 *
 * WHY EACH ASSERTION IS HERE, and every one of them is a failure that has
 * really happened on this fleet rather than a shape someone imagined:
 *
 *  1. A CHECK THAT CANNOT FAIL IS NOT A CHECK. The probe is asserted to have
 *     used navigator.mediaCapabilities.decodingInfo BY NAME and to have
 *     produced a codec answer that is false — because a probe that says YES to
 *     everything filters nothing and would sail through a count-based test
 *     while doing no work at all. This runner has no HEVC decoder, which is
 *     what makes it a good place to check the gate.
 *  2. THE FILTER IS PROVEN IN BOTH DIRECTIONS. The same fixture is ranked
 *     twice: once against caps with no HEVC and a 1080p ceiling, and once
 *     against caps with HEVC 4K and a 2160p ceiling. The 4K HEVC remux must
 *     DISAPPEAR from the first and LEAD the second. One direction alone proves
 *     nothing — an empty list also "drops the 4K row".
 *  3. ONE DEVICE'S FLOOR IS NOT THE FLEET'S CEILING. That is the bug this whole
 *     brief exists against: a flat 1080p cap written for one 921 MB Fire TV
 *     stick was applied to every 4K device on the fleet. Assertion 2's second
 *     half is that bug's regression test.
 *  4. THE HERO IS MEASURED, NOT DESCRIBED. Its bounding box is compared against
 *     the viewport at a width where #app-main is NARROWER than the screen
 *     (1600 > the 1440px column), because at any width below 1440 a plain
 *     width:100% is already edge to edge and the full-bleed rule would pass
 *     while doing nothing.
 *  5. NO YOUTUBE, ANYWHERE. Asserted as: zero <iframe> in the hero, and the
 *     video's src pointing at our fleet's /trailer/play route. An iframe cannot
 *     run on Roku, Apple TV, Fire TV, webOS, Tizen or VegaOS.
 *  6. IT DEGRADES. A second page load answers the trailer route with a 404 and
 *     the artwork must still be there with `.playing` never set.
 *
 *   node caps-hero.smoke.mjs
 */
import { chromium } from 'playwright';
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

// safeMeta() runs every image through safeHttpsUrl(), which takes https only —
// a data: URI is dropped and the meta then has no background, so no row claims
// the hero and nothing seeds the band. These point at a host that does not
// resolve; nothing here needs the bytes, only the URL.
const PIX = 'https://img.invalid/poster.jpg';
const ART = 'https://img.invalid/backdrop.jpg';

const CATALOG = (n, pre) => ({
  metas: Array.from({ length: n }, (_, i) => ({
    id: `tt800${i}0`, name: `${pre} title ${i + 1}`, type: 'movie',
    poster: PIX, background: ART, releaseInfo: '2026',
  })),
});

/**
 * The source list, and every row in it is a real shape off a debrid response.
 *
 * SEVEN ROWS, FOUR OF WHICH THIS RUNNER CANNOT PLAY:
 *   4K HEVC remux    the row that TOPS almost every real list, and the row a
 *                    resolution-only sort puts first.
 *   2160p AV1        decodable (AV1 is supported) but above a 1080p ceiling.
 *   1080p HEVC       THE ROW THAT SEPARATES THE TWO GATES, and it is here
 *                    because the first run of this file did not have it. Both
 *                    4K rows fall to the RESOLUTION rule before the codec rule
 *                    is ever reached, so `dropped.codec` read 0 and the codec
 *                    gate — the one that stops a silent black player — was
 *                    never actually exercised. This row is inside the ceiling
 *                    and undecodable, so only the codec rule can remove it.
 *   infoHash only    no url at all. A browser has no torrent client, so before
 *                    this change clicking it handed openPlayer() `undefined`.
 * ...and three it can:
 *   1080p h264 mp4   the correct answer on this machine.
 *   720p h264 mp4    playable, smaller.
 *   1080p h264 mkv   playable but a container coin toss, so it must rank below
 *                    the mp4 of the same height rather than be removed.
 *
 * The 4K remux names its container ONLY in its url, which is the shape that
 * caught detectContainer() reading the release name alone.
 */
const STREAMS = {
  streams: [
    { name: '4K HDR', title: 'Some.Film.2026.2160p.UHD.BluRay.REMUX.HEVC.TrueHD.Atmos-GRP\n💾 62.4 GB 👤 41', url: 'https://cdn.invalid/remux.mkv' },
    { name: '4K',     title: 'Some.Film.2026.2160p.WEB-DL.AV1.OPUS-GRP.mp4\n💾 18.2 GB 👤 12',              url: 'https://cdn.invalid/av1-4k.mp4' },
    { name: '1080p',  title: 'Some.Film.2026.1080p.WEB-DL.HEVC.AAC-GRP.mp4\n💾 3.4 GB 👤 150',              url: 'https://cdn.invalid/fhd-hevc.mp4' },
    { name: '1080p',  title: 'Some.Film.2026.1080p.WEB-DL.H264.AAC-GRP.mp4\n💾 4.1 GB 👤 220',              url: 'https://cdn.invalid/fhd.mp4' },
    { name: '1080p',  title: 'Some.Film.2026.1080p.BluRay.x264.DTS-GRP.mkv\n💾 9.8 GB 👤 90',               url: 'https://cdn.invalid/fhd.mkv' },
    { name: '720p',   title: 'Some.Film.2026.720p.WEB-DL.H264.AAC-GRP.mp4\n💾 1.9 GB 👤 300',               url: 'https://cdn.invalid/hd.mp4' },
    { name: '1080p',  title: 'Some.Film.2026.1080p.WEB.H264-HASHONLY\n💾 3.3 GB 👤 7',                      infoHash: 'abc123' },
  ],
};

const CONTINUE = {
  items: [{
    id: 'tt800000', name: 'Continue title one', type: 'movie',
    poster: PIX, background: ART, year: '2026',
    progress: { position: 1800, duration: 7200 },
  }],
};

let pass = 0, fail = 0;
const ok = (cond, what, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch();

/** One configured page. `trailerStatus` lets the degrade run answer 404. */
async function makePage(opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 1600, height: 900 },
    reducedMotion: opts.reducedMotion || 'no-preference',
  });
  await ctx.addInitScript(() => {
    localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-1', token: 'tok' }));
    localStorage.setItem('profileId', 'p1');
  });

  const seen = { trailerPlay: [], ytResolve: 0, ytDotCom: 0 };

  // Continue Watching is the one stub that has to CHANGE while the page is
  // live. The profile-switch check at the bottom of this file needs the next
  // profile's history to be different from this one's, and a `let` the route
  // closes over plus a setter on the returned handle is the whole mechanism.
  let continueBody = CONTINUE;

  await ctx.route('https://addon.lyreosai.com/**', (route) => {
    const u = route.request().url();
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    // 404 on the SDUI config, the same stub home.smoke.mjs pins, so the plain
    // shelves are what draws.
    if (u.includes('/api/ui/home-config')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    if (u.includes('/manifest.json')) return json({ catalogs: [
      { id: 'blazing-movies', type: 'movie', name: 'Movies' },
      { id: 'blazing-series', type: 'series', name: 'Shows' },
    ] });
    if (u.includes('/api/profiles')) return json({ profiles: [{ id: 'p1', name: 'Mark' }] });
    if (u.includes('/api/sync/progress/recent')) return json(continueBody);
    if (u.includes('/stream/')) return json(STREAMS);
    if (u.includes('/meta/')) return json({ meta: {
      id: 'tt800000', name: 'Continue title one', type: 'movie', poster: PIX, background: ART,
      description: 'The synopsis that only the meta route carries.',
      imdbRating: '7.8', runtime: '118 min',
    } });
    if (u.includes('/proxy/yt-resolve')) { seen.ytResolve += 1; return json({ url: '/proxy/hls?u=x', streamFormat: 'hls' }); }
    if (u.includes('/catalog/')) return json(CATALOG(8, 'cat'));
    return json({});
  });

  await ctx.route('https://fleet.lyreosai.com/**', (route) => {
    const u = route.request().url();
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.includes('/trailer/play/')) {
      seen.trailerPlay.push(u);
      if (opts.trailerStatus === 404) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'no' });
      // A one-byte body is enough: this asserts WHICH url is asked for and that
      // the element degrades, never that a real MP4 decodes. Decoding a real
      // trailer would make this a network test of YouTube.
      return route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from([0]) });
    }
    if (u.includes('/trailer/')) return json({ ytId: 'Y1IgAEejvqM' });
    if (u.includes('/devices/register')) return json({ ok: true, device: { id: 'dev-1', status: 'approved' }, token: 'tok' });
    if (u.includes('/profiles')) return json({ profiles: [{ id: 'p1', name: 'Mark', maxRating: 'adult', hasPin: false }] });
    return json({});
  });

  ctx.on('request', (r) => { if (/(^|\.)youtube\.com|youtu\.be|ytimg\.com/.test(r.url())) seen.ytDotCom += 1; });

  const page = await ctx.newPage();
  await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  // Choose who is watching, or ratingAllowed() holds every UNRATED fixture meta
  // under the default 'general' cap, every row empties and the screen reads
  // "Nothing is available right now." with no error thrown.
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('blazing-profile-selected', {
      detail: { id: 'p1', name: 'Mark', maxRating: 'adult' },
    }));
  });
  // profile.js's gate overlay swallows the pointer if it is left standing.
  await page.evaluate(() => { document.querySelectorAll('.bp-layer').forEach((n) => n.remove()); });
  await page.waitForTimeout(4000);
  return { ctx, page, seen, setContinue: (body) => { continueBody = body; } };
}

/* ═══════════════════════════════════════════ LETTER C — the capability probe */

const main = await makePage();
const { page } = main;

const probe = await page.evaluate(async () => {
  const caps = await window.BlazingCaps.probe();
  return { caps, readout: window.BlazingCaps.describe(caps) };
});

console.log('\n── what this browser actually reported ──');
console.log(probe.readout);
console.log('');

ok(probe.caps.probeApi === 'navigator.mediaCapabilities.decodingInfo',
  'the probe used the real API, not the canPlayType fallback', `(${probe.caps.probeApi})`);

// A probe that answers YES to everything filters nothing and would pass a
// count-only test while doing no work. At least one codec must come back false
// on a runner that genuinely lacks one.
const anyFalse = [probe.caps.h264, probe.caps.hevc, probe.caps.vp9, probe.caps.av1].some((v) => v === false);
ok(anyFalse, 'the probe returned at least one NO — it is asking, not rubber-stamping',
  `h264=${probe.caps.h264} hevc=${probe.caps.hevc} vp9=${probe.caps.vp9} av1=${probe.caps.av1}`);

ok(probe.caps.maxHeight >= 1080,
  'the ceiling never falls below 1080p, whatever the panel reports',
  `panel ${probe.caps.panelPx}px -> tier ${probe.caps.panelTier}p, ceiling ${probe.caps.maxHeight}p`);

/* ── THE APPLE TV 4K TRAP ──────────────────────────────────────────────────
   On a real Apple TV 4K every screen-resolution API in the browser reports
   1920x1080, because that is the UI PLANE the app is composited on and not the
   mode the television is driven at. webOS and Tizen do the same on 4K panels.
   So a ceiling taken from screen dimensions caps a 4K set at 1080p, silently,
   for ever — one device's floor becoming the fleet's ceiling again, arriving
   through a different sensor.

   This runner is the same shape: headless Chromium reports a panel tier well
   under 2160. So a caps object whose only change is "the decoder handles
   3840x2160 smoothly" MUST come out at 2160 — and the same object without that
   decoder must NOT, or the check would pass on a function that returns 2160
   unconditionally. Both halves, or neither proves anything. */
const appletv = await page.evaluate(() => {
  const B = window.BlazingCaps;
  const decodes4k = B._buildForTest({ hevc: true, hevcSmooth: true, hevc4k: true });
  const no4k = B._buildForTest({ hevc4k: false, av14k: false, vp94k: false, h2644k: false });
  return { panelTier: decodes4k.panelTier, with4k: decodes4k.maxHeight, without4k: no4k.maxHeight };
});
ok(appletv.panelTier < 2160,
  'the runner reports a sub-4K panel — the Apple TV 4K shape this check needs',
  `(tier ${appletv.panelTier}p)`);
ok(appletv.with4k === 2160,
  'a 4K DECODER lifts the ceiling to 2160 even though the screen says 1080',
  `(panel ${appletv.panelTier}p, ceiling ${appletv.with4k}p)`);
ok(appletv.without4k < 2160,
  'and with no 4K decoder it does not — the ceiling is measured, not assumed',
  `(ceiling ${appletv.without4k}p)`);

/* ── THE DELIMITER-ANCHORED MARKER ─────────────────────────────────────────
   A bare substring test for a language tag is true of ordinary words: /ita/
   matches "DIGITAL", /rus/ matches "Rust". app.js carried exactly that test,
   so AMZN DIGITAL releases were demoted as foreign dubs. `\b` fixes that and
   breaks the other way — `_` is a word character, so nothing at all is found
   in `Some_Film_2026_1080p_HEVC`, and a height of 0 walks past the ceiling
   while a codec of '' walks past the hard gate into a silent black player.
   Four cases, both failure directions. */
const markers = await page.evaluate(() => {
  const B = window.BlazingCaps;
  const caps = B._buildForTest({ maxHeight: 2160, h264: true, h264Smooth: true });
  const p = (title) => B.parseStream({ name: '', title, url: 'https://cdn.invalid/x.mp4' }, caps);
  return {
    digital: p('Some.Film.2026.1080p.AMZN.WEB-DL.DIGITAL.H264-GRP.mp4').foreign,
    rust: p('Rust.2024.1080p.WEB-DL.H264-GRP.mp4').foreign,
    realIta: p('Some.Film.2026.1080p.WEB-DL.ITA.ENG.H264-GRP.mp4').foreign,
    underHeight: p('Some_Film_2026_1080p_WEB-DL_H264-GRP_mp4').height,
    underCodec: p('Some_Film_2026_2160p_HEVC_REMUX_mkv').codec,
  };
});
ok(markers.digital === false && markers.rust === false,
  '"DIGITAL" is not Italian and "Rust" is not Russian — no match inside a word',
  `(digital ${markers.digital}, rust ${markers.rust})`);
ok(markers.realIta === true,
  'and a real .ITA. tag is still caught — the check did not just stop working');
ok(markers.underHeight === 1080 && markers.underCodec === 'hevc',
  'an underscore-delimited name still parses — `_` is a delimiter, not a letter',
  `(height ${markers.underHeight}, codec "${markers.underCodec}")`);

/* ── the filter, both directions, one fixture ─────────────────────────────── */

const ranked = await page.evaluate((fixture) => {
  const B = window.BlazingCaps;
  const weak = B._buildForTest({
    h264: true, h264Smooth: true, h2644k: false,
    hevc: false, hevc4k: false,
    vp9: true, vp94k: false, av1: true, av14k: false,
    maxHeight: 1080, highBitrateOk: false, maxSizeGb: 20,
  });
  const strong = B._buildForTest({
    h264: true, h264Smooth: true, h2644k: true,
    hevc: true, hevcSmooth: true, hevcHw: true, hevc4k: true,
    vp9: true, vp94k: true, av1: true, av14k: true,
    maxHeight: 2160, highBitrateOk: true, maxSizeGb: 80,
  });
  const label = (r) => r.streams.map((s) => s.label + ' ' + (s.container || '?') + ' ' + (s.codec || '?') + ' ' + s.height);
  const a = B.rankStreams(fixture.streams, weak, {});
  const b = B.rankStreams(fixture.streams, strong, {});
  return {
    weak: { order: label(a), dropped: a.dropped, total: a.total },
    strong: { order: label(b), dropped: b.dropped, total: b.total },
  };
}, STREAMS);

console.log('── ranked for a 1080p, no-HEVC device ──');
ranked.weak.order.forEach((l, i) => console.log(`   ${i + 1}. ${l}`));
console.log('   dropped:', JSON.stringify(ranked.weak.dropped));
console.log('── ranked for a 4K, HEVC device (SAME seven rows) ──');
ranked.strong.order.forEach((l, i) => console.log(`   ${i + 1}. ${l}`));
console.log('   dropped:', JSON.stringify(ranked.strong.dropped), '\n');

const weakHas = (s) => ranked.weak.order.some((l) => l.includes(s));
const strongHas = (s) => ranked.strong.order.some((l) => l.includes(s));

ok(!weakHas('hevc'), 'the 4K HEVC remux is GONE on a device with no HEVC decoder',
  `(${ranked.weak.dropped.codec} codec, ${ranked.weak.dropped.codec4k} codec-at-4K)`);
// THE CODEC RULE, ON ITS OWN. Both 4K rows are removed by the RESOLUTION rule
// before rejectReason() ever reaches the codec test, so counting "the 4K HEVC
// went away" proves the resolution ceiling and nothing else. The 1080p HEVC row
// sits INSIDE the ceiling and cannot be decoded here, so it can only leave
// through 'codec'. Exactly one row must do that. This is the assertion that
// stands between a user and a silent black player.
ok(ranked.weak.dropped.codec === 1,
  'exactly one row left through the CODEC gate, not the resolution gate',
  `(codec ${ranked.weak.dropped.codec}, res ${ranked.weak.dropped.res}, nourl ${ranked.weak.dropped.nourl})`);
ok(!ranked.weak.order.some((l) => / 2160$/.test(l)),
  'nothing above the 1080p ceiling is offered', `(${ranked.weak.dropped.res} dropped on resolution)`);
ok(ranked.weak.dropped.nourl === 1,
  'the infoHash-only row is gone — a browser has no torrent client');

// THE WORD-BOUNDARY REGRESSION TEST. Every label ends in the parsed height, and
// `\b1080\b` never matches "1080p" — the p is a word character, so there is no
// boundary and every row came back height 0. A ceiling measured against 0 lets
// everything through. If detectHeight regresses to that, these all end in " 0"
// and this goes red on both devices at once.
const HEIGHT_TAIL = /(?:480|720|1080|1440|2160)$/;
const badHeights = [...ranked.weak.order, ...ranked.strong.order].filter((l) => !HEIGHT_TAIL.test(l));
ok(badHeights.length === 0,
  'every kept row parsed a real height — "1080p" is not read as 0',
  badHeights.length ? `(${JSON.stringify(badHeights)})` : `(${ranked.weak.order.length + ranked.strong.order.length} rows)`);
ok(/1080/.test(ranked.weak.order[0]) && /mp4/.test(ranked.weak.order[0]),
  'the best row THIS device can decode is first', `("${ranked.weak.order[0]}")`);
ok(ranked.weak.order.findIndex((l) => l.includes('mkv')) >
   ranked.weak.order.findIndex((l) => l.includes('mp4')),
  'the mkv is demoted below the mp4 rather than removed');

// THE OTHER DIRECTION. Without this the whole test passes on an empty list.
ok(strongHas('hevc') && / 2160$/.test(ranked.strong.order[0]),
  'the SAME 4K HEVC remux LEADS on a 4K HEVC device — one floor is not the ceiling',
  `("${ranked.strong.order[0]}")`);
ok(ranked.strong.dropped.codec === 0 && ranked.strong.dropped.res === 0,
  'nothing is dropped for codec or resolution on the capable device');

/* ── and it reaches the DOM ───────────────────────────────────────────────── */

// rawCount is READ OFF THE FIXTURE, never typed in. It was typed in as 6, and
// then the fixture grew a seventh row for the codec gate — leaving the DOM
// assertion comparing the rendered count against a number that no longer
// described what the stub returned.
const dom = await page.evaluate(async (rawCount) => {
  const card = document.querySelector('#rows .card');
  if (card) card.click();
  await new Promise((r) => setTimeout(r, 2500));
  const rows = [...document.querySelectorAll('#detail-streams .stream-row')];
  return {
    rowCount: rows.length,
    rawCount,
    text: rows.map((r) => r.textContent).join(' | '),
    note: (document.querySelector('#detail-streams .stream-note') || {}).textContent || '',
    status: (document.querySelector('#detail-status') || {}).textContent || '',
  };
}, STREAMS.streams.length);

console.log('── the rendered source list ──');
console.log('   rows:', dom.rowCount, 'of', dom.rawCount, 'raw');
console.log('   note:', dom.note || '(none)');
console.log('');

ok(dom.rowCount > 0 && dom.rowCount < dom.rawCount,
  'the panel shows fewer rows than the addon returned — the filter ran on the real DOM',
  `(${dom.rowCount} of ${dom.rawCount})`);
ok(!/REMUX\.HEVC/i.test(dom.text),
  'the undecodable 4K HEVC remux is not in the panel at all');
ok(/HASHONLY/i.test(dom.text) === false,
  'the infoHash-only row is not in the panel');
ok(/play on this device/.test(dom.note),
  'the panel says what was hidden and why', `("${dom.note.slice(0, 90)}")`);

/* ══════════════════════════════════════════════ LETTER B — the moving hero */

const hero = await page.evaluate(() => {
  const h = document.querySelector('#home-hero');
  const rows = document.querySelector('#rows');
  const v = document.querySelector('#home-hero-video');
  const art = document.querySelector('#home-hero-art');
  const r = h ? h.getBoundingClientRect() : null;
  const rr = rows ? rows.getBoundingClientRect() : null;
  return {
    exists: !!h,
    hidden: h ? h.hidden : true,
    left: r ? Math.round(r.left) : null,
    width: r ? Math.round(r.width) : null,
    height: r ? Math.round(r.height) : null,
    rowsLeft: rr ? Math.round(rr.left) : null,
    rowsWidth: rr ? Math.round(rr.width) : null,
    clientWidth: document.documentElement.clientWidth,
    title: (document.querySelector('#home-hero-title') || {}).textContent || '',
    eyebrow: (document.querySelector('#home-hero-eyebrow') || {}).textContent || '',
    progressShown: !(document.querySelector('#home-hero-progress') || {}).hidden,
    progressWidth: (document.querySelector('#home-hero-progress-fill') || { style: {} }).style.width,
    artSrc: art ? art.getAttribute('src') : '',
    videoSrc: v ? (v.getAttribute('src') || '') : '',
    videoPlaying: v ? v.classList.contains('playing') : false,
    iframes: h ? h.querySelectorAll('iframe').length : -1,
    pageIframes: document.querySelectorAll('iframe').length,
  };
});

console.log('── the home hero, measured ──');
console.log('   box       ', `left ${hero.left}  width ${hero.width}  height ${hero.height}`);
console.log('   viewport  ', hero.clientWidth, ' #rows:', `left ${hero.rowsLeft} width ${hero.rowsWidth}`);
console.log('   showing   ', JSON.stringify(hero.eyebrow), JSON.stringify(hero.title));
console.log('   resume bar', hero.progressShown ? hero.progressWidth : 'hidden');
console.log('   video src ', hero.videoSrc || '(none)');
console.log('');

ok(hero.exists && !hero.hidden, 'the hero band exists and is showing on the home route');
ok(hero.eyebrow === 'Continue watching' && hero.title === 'Continue title one',
  'it is CONTINUE WATCHING that fills it, not a catalog row',
  `("${hero.eyebrow}" / "${hero.title}")`);
ok(hero.progressShown && hero.progressWidth === '25%',
  'the resume position came with it', `(${hero.progressWidth})`);

// FULL BLEED, measured at 1600px where #app-main is capped at 1440 — so a
// width:100% band would be 1440 wide and inset, and this cannot pass by accident.
ok(Math.abs(hero.left) <= 1 && Math.abs(hero.width - hero.clientWidth) <= 1,
  'it is FULL-BLEED: flush to both edges of the viewport',
  `(left ${hero.left}, ${hero.width} vs viewport ${hero.clientWidth})`);
ok(hero.rowsWidth < hero.clientWidth - 20,
  'and the rows below it are still inside the 1440px column — the band really broke out',
  `(#rows ${hero.rowsWidth} wide at left ${hero.rowsLeft})`);
ok(hero.height >= 320, 'it is a band, not a strip', `(${hero.height}px tall)`);

ok(hero.iframes === 0 && hero.pageIframes === 0,
  'NO IFRAME anywhere — an iframe cannot run on Roku, Apple TV, Fire TV, webOS, Tizen or VegaOS');
ok(main.seen.ytDotCom === 0, 'nothing on the page ever talked to youtube.com',
  `(${main.seen.ytDotCom} requests)`);
ok(main.seen.trailerPlay.length > 0, 'the hero asked OUR fleet for the trailer',
  `(${main.seen.trailerPlay.length} call${main.seen.trailerPlay.length === 1 ? '' : 's'})`);

const trailerUrl = main.seen.trailerPlay[0] || '';
console.log('   fleet url ', trailerUrl || '(none)');
ok(/^https:\/\/fleet\.lyreosai\.com\/trailer\/play\//.test(trailerUrl),
  'it is a PLAIN VIDEO URL from our own backend');
ok(/[?&]muxed=1/.test(trailerUrl),
  'muxed=1 is on it — without it the fleet serves video-only and the hero is silent');
const askedHeight = Number((trailerUrl.match(/[?&]h=(\d+)/) || [])[1] || 0);
ok(askedHeight > 0 && askedHeight <= probe.caps.maxHeight,
  'the tier it asked for came from the probe, and is not above what this device can take',
  `(asked h=${askedHeight}, device ceiling ${probe.caps.maxHeight}p)`);
ok(hero.videoSrc.startsWith('https://fleet.lyreosai.com/trailer/play/'),
  'and that is what the <video> element is actually pointing at');

/* ── it hides off the home route ─────────────────────────────────────────── */

const offRoute = await page.evaluate(async () => {
  const btn = document.querySelector('[data-view="movies"]');
  if (btn) btn.click();
  await new Promise((r) => setTimeout(r, 400));
  const h = document.querySelector('#home-hero');
  const v = document.querySelector('#home-hero-video');
  return { hidden: h ? h.hidden : null, videoSrc: v ? (v.getAttribute('src') || '') : 'gone', clicked: !!btn };
});
ok(offRoute.clicked && offRoute.hidden === true,
  'switching to Movies hides the band — that route is the same section with the rows filtered');
ok(offRoute.videoSrc === '',
  'and the trailer was torn down, not left downloading behind a hidden screen',
  `(src "${offRoute.videoSrc}")`);

/* ── and coming BACK to home starts it again ─────────────────────────────── */

// Tearing the <video> down on the way out is right. Nothing else ever puts one
// back: seedHomeHero() is the only other place a trailer is started and it does
// not run again for a title that is already seated. So the band played its
// trailer exactly ONCE per page load — one tap on the 12-tab nav and one tap
// back, which is seconds, and the hero was a still picture for the rest of the
// session. syncHomeHeroVisibility() re-arms the delay timer on the way in.
const backBefore = main.seen.trailerPlay.length;
const backHome = await page.evaluate(async () => {
  const btn = document.querySelector('[data-view="home"]');
  if (btn) btn.click();
  // HERO_TRAILER_DELAY_MS is 1800, and the ytId round trip is stubbed but not
  // free. Waiting on the THING would be better than a duration, but the thing
  // here is "a request the node side counted", which the page cannot see.
  await new Promise((r) => setTimeout(r, 3400));
  const h = document.querySelector('#home-hero');
  const v = document.querySelector('#home-hero-video');
  return {
    clicked: !!btn,
    hidden: h ? h.hidden : null,
    videoSrc: v ? (v.getAttribute('src') || '') : 'gone',
  };
});
ok(backHome.clicked && backHome.hidden === false,
  'coming back to Home shows the band again');
ok(main.seen.trailerPlay.length > backBefore && backHome.videoSrc !== '',
  'and the trailer is re-armed, not dead for the rest of the session',
  `(${backBefore} -> ${main.seen.trailerPlay.length} fleet calls)`);

/* ── a profile switch moves the BAND, not just the row ───────────────────── */

// The Continue Watching ROW is removed and refetched on every
// blazing-profile-selected, so that the previous profile's history is never
// left on screen under a new name. The band is the other place that history
// shows, and it did NOT move: seedHomeHero() refuses any priority that is not
// higher than the seated one, Continue Watching always seats itself at 2, so
// the second seed at 2 was dropped and the band kept the first profile's title,
// artwork, synopsis and resume percentage. resetHomeHero() clears the latch at
// the same moment the row is dropped.
main.setContinue({ items: [{
  id: 'tt800009', name: 'Second profile title', type: 'movie',
  poster: PIX, background: ART, year: '2026',
  progress: { position: 5400, duration: 7200 },   // 75%, not the first profile's 25%
}] });
const swapped = await page.evaluate(async () => {
  document.dispatchEvent(new CustomEvent('blazing-profile-selected', {
    detail: { id: 'p2', name: 'Ada', maxRating: 'adult' },
  }));
  await new Promise((r) => setTimeout(r, 3000));
  return {
    title: (document.querySelector('#home-hero-title') || {}).textContent || '',
    eyebrow: (document.querySelector('#home-hero-eyebrow') || {}).textContent || '',
    progressWidth: (document.querySelector('#home-hero-progress-fill') || { style: {} }).style.width,
    hidden: (document.querySelector('#home-hero') || {}).hidden,
  };
});
ok(swapped.title === 'Second profile title' && swapped.eyebrow === 'Continue watching',
  'switching profile moves the band to the NEW profile\'s Continue Watching',
  `("${swapped.eyebrow}" / "${swapped.title}")`);
ok(swapped.progressWidth === '75%',
  'and the resume bar is the new profile\'s position, not the old one\'s 25%',
  `(${swapped.progressWidth})`);
ok(swapped.hidden === false, 'and the band is still on screen after the switch');

await main.ctx.close();

/* ── reduced motion: the fleet is never even called ──────────────────────── */

const reduced = await makePage({ reducedMotion: 'reduce' });
const rm = await reduced.page.evaluate(() => {
  const h = document.querySelector('#home-hero');
  const v = document.querySelector('#home-hero-video');
  return {
    heroShown: h ? !h.hidden : false,
    art: (document.querySelector('#home-hero-art') || {}).getAttribute ? document.querySelector('#home-hero-art').getAttribute('src') : '',
    videoSrc: v ? (v.getAttribute('src') || '') : 'gone',
  };
});
ok(rm.heroShown && !!rm.art, 'under prefers-reduced-motion the band is still there, as artwork');
ok(reduced.seen.trailerPlay.length === 0 && rm.videoSrc === '',
  'and the fleet was never asked for a trailer at all — not fetched-then-hidden',
  `(${reduced.seen.trailerPlay.length} trailer calls)`);
await reduced.ctx.close();

/* ── the trailer 404s: back to the artwork, silently ─────────────────────── */

const broken = await makePage({ trailerStatus: 404 });
const br = await broken.page.evaluate(() => {
  const v = document.querySelector('#home-hero-video');
  const h = document.querySelector('#home-hero');
  return {
    heroShown: h ? !h.hidden : false,
    art: (document.querySelector('#home-hero-art') || {}).src || '',
    playing: v ? v.classList.contains('playing') : false,
    muteShown: !(document.querySelector('#home-hero-mute') || {}).hidden,
  };
});
ok(broken.seen.trailerPlay.length > 0, 'the 404 run really did ask for a trailer',
  `(${broken.seen.trailerPlay.length} calls)`);
ok(br.heroShown && !!br.art, 'a 404 trailer leaves the band showing its artwork');
ok(!br.playing, 'the video never got .playing, so it never covered the still');
ok(!br.muteShown, 'and no mute button appeared for a trailer that is not there');
await broken.ctx.close();

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  the device probe filters the list and the hero moves   (${pass} ok, ${fail} failed)`);
await browser.close();
server.close();
process.exit(fail === 0 ? 0 : 1);
