// Headless smoke test for the two watch-party changes:
//   1. the ICE server list comes from GET /party/ice and is what the peer
//      connections are actually built with (that is how a TURN relay reaches
//      the client at all), with a safe fallback when the fetch fails;
//   2. every remote tile has a per-person mute that is LOCAL — it silences one
//      caller for me and signals nothing to anyone.
//
// The signaling socket is stubbed (no server needed) and /party/* is
// intercepted, so nothing real is contacted. The camera/mic are Chrome's own
// fake devices, so RTCPeerConnection gets genuine MediaStreamTracks and the
// real WebRTC stack runs.
import { launchBrowser } from './comet.mjs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const errors = [];
let failures = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const STUBS = () => {
  window.__seen = { rtcConfigs: [], sent: [] };
  class FakeWS extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      window.__ws = this;
      setTimeout(() => this.dispatchEvent(new Event('open')), 0);
    }
    send(data) { window.__seen.sent.push(data); }
    close() { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code: 1000 })); }
    set onopen(fn) { this.addEventListener('open', fn); }
    set onmessage(fn) { this.addEventListener('message', fn); }
    set onclose(fn) { this.addEventListener('close', fn); }
    set onerror(fn) { this.addEventListener('error', fn); }
  }
  FakeWS.OPEN = 1;
  window.WebSocket = FakeWS;
  window.__feed = (obj) => window.__ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(obj) }));

  const Real = window.RTCPeerConnection;
  window.RTCPeerConnection = function (cfg) {
    window.__seen.rtcConfigs.push(JSON.parse(JSON.stringify(cfg || {})));
    return new Real(cfg);
  };
  window.RTCPeerConnection.prototype = Real.prototype;
};

// These three are BROWSER flags, so they go to the Comet spawn as extraArgs
// rather than to a launch() this repo no longer makes. Same flags, same
// effect: a fake camera/mic so getUserMedia resolves with nobody present,
// and autoplay allowed so the party video element actually starts.
const browser = await launchBrowser({
  extraArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

// A FRESH context per scenario: watch-party.js remembers the joined code in
// localStorage, so reusing one would reopen the panel instead of the dialog.
async function joinedPage({ ice, killIce = false, peer }) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(STUBS);
  await ctx.route('https://fleet.lyreosai.com/**', (route) => {
    const url = route.request().url();
    if (url.includes('/party/ice')) {
      if (killIce) return route.abort();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ice) });
    }
    if (url.includes('/party/active')) return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  // profile.js's own gate overlay (.bp-layer[data-gate="required"]) sits over
  // the whole page until a profile is picked, and Playwright correctly refuses
  // to click through it — same root cause as the locker/upscale fixes above.
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('blazing-profile-selected', {
      detail: { id: 'p1', name: 'Mark', maxRating: 'adult', isKids: false },
    }));
    document.querySelectorAll('.bp-layer').forEach((n) => n.remove());
  });
  await page.waitForSelector('#watch-party-launch-button');
  await page.click('#watch-party-launch-button');
  await page.fill('#watch-party-join-input', 'ABC123');
  await page.click('.wp-join-submit');
  await page.waitForFunction(() => window.__ws && window.__ws.readyState === 1, null, { timeout: 8000 });
  // Wait for the call to actually go active (own tile on screen). offerTo() is a
  // no-op before that by design, so feeding peers earlier is just a race.
  await page.waitForSelector('.wp-tile-self', { timeout: 15000 });
  // peer-list is what makes this client offer, which is what builds the tile.
  await page.evaluate((id) => window.__feed({ type: 'peer-list', peers: [id] }), peer);
  await page.waitForSelector('.wp-tile:not(.wp-tile-self)', { timeout: 8000 });
  return { ctx, page };
}

const WITH_TURN = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }, { urls: ['turn:t.example:3478'], username: '123:me', credential: 'abc' }],
  relay: true,
  ttl: 3600,
};

// --- scenario 1: a relay is configured, and per-person mute -----------------
{
  const { ctx, page } = await joinedPage({ ice: WITH_TURN, peer: 'peer-aaaa1111' });

  const cfg = await page.evaluate(() => window.__seen.rtcConfigs[0]);
  check('the peer connection is built from the fetched list, TURN included',
    JSON.stringify(cfg).includes('turn:t.example:3478'), JSON.stringify(cfg));

  const tile = page.locator('.wp-tile:not(.wp-tile-self)').first();
  const btn = tile.locator('.wp-tile-toggle');
  check('remote tile has one mute button', (await btn.count()) === 1);
  check('a caller starts audible', (await tile.locator('video').evaluate((v) => v.muted)) === false);
  check('button reads unmuted', (await btn.textContent()) === '🔊');

  await btn.click();
  check('clicking mutes that caller', (await tile.locator('video').evaluate((v) => v.muted)) === true);
  check('button flips to muted', (await btn.textContent()) === '🔇');
  check('aria-pressed reflects it', (await btn.getAttribute('aria-pressed')) === 'true');
  check('tile is marked muted', (await tile.getAttribute('data-muted')) === 'true');
  const sent = await page.evaluate(() => window.__seen.sent.join(''));
  check('mute is local — nothing is sent to the party', !sent.includes('mute'));

  // A second caller must be unaffected: this is per person, not a master mute.
  await page.evaluate(() => window.__feed({ type: 'peer-list', peers: ['peer-bbbb2222'] }));
  await page.waitForFunction(() => document.querySelectorAll('.wp-tile:not(.wp-tile-self)').length === 2, null, { timeout: 8000 });
  const second = page.locator('.wp-tile:not(.wp-tile-self)').nth(1);
  check('the other caller stays audible', (await second.locator('video').evaluate((v) => v.muted)) === false);
  check('the muted caller is still muted', (await tile.locator('video').evaluate((v) => v.muted)) === true);

  await btn.click();
  check('unmuting restores audio', (await tile.locator('video').evaluate((v) => v.muted)) === false);
  await ctx.close();
}

// --- scenario 2: no relay configured (today's live server) ------------------
{
  const { ctx, page } = await joinedPage({
    ice: { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], relay: false, ttl: null },
    peer: 'peer-cccc3333',
  });
  const cfg = await page.evaluate(() => window.__seen.rtcConfigs[0]);
  check('a STUN-only answer still builds the mesh',
    JSON.stringify(cfg).includes('stun:') && !JSON.stringify(cfg).includes('turn:'), JSON.stringify(cfg));
  await ctx.close();
}

// --- scenario 3: /party/ice unreachable -------------------------------------
{
  const { ctx, page } = await joinedPage({ ice: WITH_TURN, killIce: true, peer: 'peer-dddd4444' });
  const cfg = await page.evaluate(() => window.__seen.rtcConfigs[0]);
  check('a dead /party/ice falls back to the built-in STUN instead of blocking',
    JSON.stringify(cfg).includes('stun:stun.l.google.com'), JSON.stringify(cfg));
  await ctx.close();
}

const real = errors.filter((e) => !/Failed to fetch|NetworkError|CORS|load resource/i.test(e));
check('no page errors', real.length === 0, real.join(' | '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
