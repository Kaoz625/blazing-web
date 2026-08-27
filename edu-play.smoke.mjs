// END-TO-END smoke test for EDUCATION playback in a real browser.
//
// This one does NOT stub the addon. It talks to the deployed
// https://addon.lyreosai.com, picks a real card out of a real catalog, resolves
// it, and then checks that a real Chrome actually DECODES it — width, height and
// a moving currentTime, not just "no error was thrown".
//
// WHY IT HAS TO BE A REAL BROWSER. Three separate things had to be true at once
// and each one failed silently on its own:
//
//   1. The catalog hands out a `yt:edu:<videoId>` id whose own stream entry is a
//      youtube.com/watch PAGE. No <video> element can open that. Before this
//      change the web app fed it straight to `video.src` and showed a black box.
//   2. YouTube no longer serves a combined audio+video progressive format, so the
//      single playable link is an HLS VARIANT MANIFEST. `?json=1` exists to say
//      so, because the signed manifest URL cannot always be sniffed.
//   3. Chrome cannot play HLS from a bare <video src> at all. Safari and every
//      TV can, which is exactly why this went unnoticed: it works on a Mac in
//      Safari and fails for every Chrome user. hls.js is vendored for this.
//
// Any one of those three regressing puts the black box back, and none of them
// raises a page error. Hence: measure the pixels.
//
//   node edu-play.smoke.mjs
//   BW_DIR=/path/to/checkout node edu-play.smoke.mjs
import { chromium } from '/Users/markususche/.hermes/hermes-agent/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.env.BW_DIR || '/Users/markususche/Desktop/blazing-web';
const CHROME = '/Users/markususche/Library/Caches/ms-playwright/chromium-1208/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const ADDON = 'https://addon.lyreosai.com';

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

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ── Find a real education card on the deployed addon ────────────────────────
// Not a fixed video id: a hardcoded one rots the day that channel deletes it,
// and then this test reports a client bug that does not exist.
let eduId = '';
let eduName = '';
for (const slug of ['blazing-edu-kids', 'blazing-edu-science', 'blazing-edu-stem']) {
  const r = await fetch(`${ADDON}/catalog/tv/${slug}.json`).catch(() => null);
  if (!r || !r.ok) continue;
  const d = await r.json().catch(() => null);
  const hit = (d?.metas || []).find((m) => String(m.id || '').startsWith('yt:edu:'));
  if (hit) { eduId = hit.id; eduName = hit.name || 'lesson'; break; }
}
// A fallback id, and a deliberate one. The education CATALOGS depend on the
// YouTube Data API, whose free tier allows 10,000 units a day and whose
// search.list costs 100 units per call — so the catalogs go empty for the rest of
// the day once that runs out (measured 27 Aug 2026: HTTP 429 rateLimitExceeded,
// "Search Queries per day"). /proxy/yt-resolve does NOT use that quota; it uses
// yt-dlp. Falling back keeps this test measuring PLAYBACK rather than reporting
// someone else's rate limit as a playback failure.
const FALLBACK_ID = 'yt:edu:Lo-PFoUhBZk';
const usedFallback = !eduId;
if (!eduId) { eduId = FALLBACK_ID; eduName = 'fallback id (catalogs are quota-limited today)'; }
check('an education id is available to test', !!eduId,
  usedFallback ? 'catalogs empty — using the known-good fallback id' : eduId);

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-1', token: 'tok' }));
  localStorage.setItem('profileId', 'p1');
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// ── 1. The library is present, and Chrome genuinely needs it ───────────────
const libState = await page.evaluate(() => ({
  hasHls: !!window.Hls,
  hlsSupported: !!(window.Hls && window.Hls.isSupported()),
  nativeHlsOnly: typeof nativeHlsOnly === 'function' ? nativeHlsOnly() : null,
  // Kept as evidence, not as a check: this is the value that lied.
  claimsApple: document.createElement('video').canPlayType('application/vnd.apple.mpegurl'),
  hasAttach: typeof attachSource === 'function',
  hasResolve: typeof resolveEduStream === 'function',
  hasIsEdu: typeof isEduId === 'function',
}));
check('hls.min.js loaded (window.Hls)', libState.hasHls);
check('hls.js reports MSE support', libState.hlsSupported);
// Chrome HAS MediaSource, so hls.js must win the branch — and note what
// canPlayType claims while that is true. That gap is the bug this file caught.
check('Chrome does not take the native-only branch (hls.js must win)',
  libState.nativeHlsOnly === false,
  `nativeHlsOnly() = ${libState.nativeHlsOnly}, while canPlayType claims ` +
  `${JSON.stringify(libState.claimsApple)} — which is why truthiness was wrong`);
check('attachSource / resolveEduStream / isEduId all defined',
  libState.hasAttach && libState.hasResolve && libState.hasIsEdu);

// ── 2. The id is recognised and the resolver answers with a DECLARED format ─
const resolved = await page.evaluate(async (id) => {
  const recognised = isEduId(id);
  const r = await resolveEduStream(id);
  return { recognised, r };
}, eduId);
check('isEduId() recognises the real catalog id', resolved.recognised === true);
check('resolveEduStream() returned a url', !!resolved.r?.url,
  resolved.r?.url ? resolved.r.url.slice(0, 72) + '…' : 'null');
check('the server DECLARED the container', !!resolved.r?.streamFormat,
  `streamFormat = ${JSON.stringify(resolved.r?.streamFormat)}`);
check('declared format is hls (the only playable YouTube form)',
  String(resolved.r?.streamFormat).toLowerCase() === 'hls');

if (!resolved.r?.url) {
  console.log('\nFAIL  cannot test playback without a resolved url');
  await browser.close(); server.close(); process.exit(1);
}

// ── 3. looksLikeHls must be right BOTH ways round ──────────────────────────
const routing = await page.evaluate((u) => ({
  hlsWhenDeclared: looksLikeHls(u, 'hls'),
  // The regression guard that matters: a plain mp4 must NOT be sent to hls.js.
  mp4NotHls: looksLikeHls('https://example.com/a/file.mp4', ''),
  m3u8Sniffed: looksLikeHls('https://example.com/x/index.m3u8', ''),
}), resolved.r.url);
check('looksLikeHls() true for the declared stream', routing.hlsWhenDeclared === true);
check('looksLikeHls() FALSE for a plain .mp4 (no false positives)', routing.mp4NotHls === false);
check('looksLikeHls() still sniffs a bare .m3u8 path', routing.m3u8Sniffed === true);

// ── 4. Does it actually DECODE? ────────────────────────────────────────────
// The whole reason this file exists. A silent black box throws nothing, so the
// only honest evidence is real pixels and a clock that moves.
const playback = await page.evaluate(async (payload) => {
  const { url, format } = payload;
  const v = document.querySelector('#video');
  document.querySelector('#player').hidden = false;
  const err = attachSource(url, format);
  if (err) return { attachError: err };
  v.muted = true;
  // NOT awaited. play() returns a promise that neither resolves nor rejects while
  // nothing is buffering, so awaiting it hangs forever on exactly the failure this
  // test is here to catch. Fire it and let the polling below decide.
  try { const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {}
  // Watch for hls.js's own verdict as well as the video element's. A CORS refusal
  // shows up as a fatal networkError and NOTHING on the element, so polling
  // videoWidth alone just burns the whole deadline and reports "0x0" with no
  // reason attached.
  let fatal = '';
  if (hlsInstance) {
    hlsInstance.on(window.Hls.Events.ERROR, (_e, d) => {
      if (d && d.fatal && !fatal) fatal = `${d.type}/${d.details}`;
    });
  }
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (v.videoWidth > 0 && v.readyState >= 2) break;
    if (fatal) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (fatal) return { attachError: '', usedHlsJs: !!hlsInstance, fatal, videoWidth: 0, readyState: v.readyState, levels: hlsInstance ? (hlsInstance.levels||[]).length : 0 };
  const t0 = v.currentTime;
  await new Promise((r) => setTimeout(r, 2000));
  return {
    attachError: '',
    usedHlsJs: !!hlsInstance,
    videoWidth: v.videoWidth,
    videoHeight: v.videoHeight,
    readyState: v.readyState,
    duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
    advanced: +(v.currentTime - t0).toFixed(2),
    levels: hlsInstance ? (hlsInstance.levels || []).length : 0,
  };
}, { url: resolved.r.url, format: resolved.r.streamFormat });

check('attachSource() reported no error', playback.attachError === '', playback.attachError);
check('hls.js reported no FATAL error', !playback.fatal, playback.fatal || 'none');
check('it routed through hls.js (not a bare src=)', playback.usedHlsJs === true);
check('the manifest parsed into quality levels', (playback.levels || 0) > 0,
  `${playback.levels} levels`);
check('REAL VIDEO DECODED (videoWidth > 0)', (playback.videoWidth || 0) > 0,
  `${playback.videoWidth}x${playback.videoHeight}, readyState ${playback.readyState}`);
check('the clock moved (it is playing, not just loaded)', (playback.advanced || 0) > 0.3,
  `+${playback.advanced}s in 2.5s`);

check('no uncaught page errors', errs.length === 0, errs.slice(0, 3).join(' | '));

await page.screenshot({ path: process.env.SHOT || '/tmp/edu-play.png' });
await browser.close();
server.close();

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${eduName}  (${eduId})`);
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
