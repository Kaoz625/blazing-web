import { prepareProfile, selectProfile } from './scripts/profile-fixture.mjs';
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
  window.__seen = { rtcConfigs: [], sent: [], mediaRequests: [] };
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const attempt = { constraints, state: 'pending' };
    window.__seen.mediaRequests.push(attempt);
    try {
      const stream = await getUserMedia(constraints);
      attempt.state = 'resolved';
      return stream;
    } catch (error) {
      attempt.state = error.name;
      throw error;
    }
  };
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
  // The browser's fake devices still need permission in each isolated context.
  await ctx.grantPermissions(['camera', 'microphone'], { origin: base });
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
  await prepareProfile(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  // Select the viewer through the real profile gate.
  await selectProfile(page);
  await page.waitForSelector('#watch-party-launch-button');
  await page.click('#watch-party-launch-button');
  await page.fill('#watch-party-join-input', 'ABC123');
  await page.click('.wp-join-submit');
  await page.waitForFunction(() => window.__ws && window.__ws.readyState === 1, null, { timeout: 8000 });
  // Wait for the call to actually go active (own tile on screen). offerTo() is a
  // no-op before that by design, so feeding peers earlier is just a race.
  await page.waitForSelector('.wp-tile-self', { timeout: 15000 }).catch(async (error) => {
    console.log('Call did not start:', await page.locator('.wp-panel').innerText());
    console.log('Media diagnostic:', await page.evaluate(async () => ({
      secureContext: window.isSecureContext,
      mediaDevices: Boolean(navigator.mediaDevices),
      cameraPermission: (await navigator.permissions.query({ name: 'camera' })).state,
      microphonePermission: (await navigator.permissions.query({ name: 'microphone' })).state,
      mediaRequests: window.__seen.mediaRequests,
      fleet: window.BLAZING_FLEET_BASE,
    })));
    throw error;
  });
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

// --- scenario 4: B30. the party actually DRIVES this browser's playback ------
//
// The gap this closes: a browser guest used to see the chat and the reactions
// and nothing else — their video stayed wherever they left it, which is to say
// the watch party had no effect on what they were watching. The Roku
// (MainScene.brs onPartyPollState) and the Apple TV (PartySession.reconcile)
// have corrected their own playhead against the host's for months.
//
// The fixture is a real 30-minute WebM, because a seek is the thing under test
// and an element with no timeline cannot be seeked. VP8 rather than H264 on
// purpose: CI runs Playwright's chromium, which ships without the proprietary
// codecs, and a fixture that decodes on this Mac and nowhere else would turn a
// green lane into a lie.
{
  const room = {
    code: 'SYNC01',
    contentId: 'tt900',
    streamUrl: 'https://cdn.example.test/party.webm',
    state: 'playing',
    position: 0,
    updatedAt: new Date().toISOString(),
  };
  const fixture = await readFile(join(ROOT, 'scripts', 'fixture-30min.webm'));

  const ctx = await browser.newContext();
  await ctx.grantPermissions(['camera', 'microphone'], { origin: base });
  await ctx.addInitScript(STUBS);
  await ctx.route('https://fleet.lyreosai.com/**', (route) => {
    const url = route.request().url();
    if (url.includes('/party/ice')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(WITH_TURN) });
    }
    if (url.includes('/party/active')) return route.fulfill({ status: 204, body: '' });
    if (url.includes('/party/SYNC01/state')) {
      room.updatedAt = new Date().toISOString();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(room) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  // RANGE REQUESTS ARE NOT OPTIONAL HERE. A plain 200 with the whole body makes
  // the element unseekable in Chromium — `currentTime = 600` is accepted, does
  // nothing, and the test then reports a broken seek that is really a broken
  // fixture. Measured: without this, the guest stayed at 0.2s.
  await ctx.route('https://cdn.example.test/**', (route) => {
    const range = route.request().headers().range || '';
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match) {
      return route.fulfill({
        status: 200,
        contentType: 'video/webm',
        headers: { 'accept-ranges': 'bytes', 'content-length': String(fixture.length) },
        body: fixture,
      });
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), fixture.length - 1) : fixture.length - 1;
    const slice = fixture.subarray(start, end + 1);
    return route.fulfill({
      status: 206,
      contentType: 'video/webm',
      headers: {
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${fixture.length}`,
        'content-length': String(slice.length),
      },
      body: slice,
    });
  });
  await prepareProfile(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await selectProfile(page);

  await page.waitForSelector('#watch-party-launch-button');
  await page.click('#watch-party-launch-button');
  await page.fill('#watch-party-join-input', 'SYNC01');
  await page.click('.wp-join-submit');

  // 1. Joining starts what the room is watching. The join IS the gesture a
  //    browser demands before it will play sound, which is why it happens here
  //    and not on a timer.
  await page.waitForFunction(
    () => !document.querySelector('#player').hidden
      && document.querySelector('#video').getAttribute('src') === 'https://cdn.example.test/party.webm',
    null, { timeout: 20000 },
  ).catch(() => {});
  const opened = await page.evaluate(() => ({
    hidden: document.querySelector('#player').hidden,
    src: document.querySelector('#video').getAttribute('src'),
  }));
  check('joining a party starts what the party is watching',
    opened.hidden === false && opened.src === 'https://cdn.example.test/party.webm',
    JSON.stringify(opened));

  // The element needs a timeline before anything can be corrected.
  await page.waitForFunction(() => document.querySelector('#video').readyState >= 1,
    null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#video').currentTime > 0,
    null, { timeout: 20000 });

  // 2. The host is ten minutes in. The guest is at the start. One relative step
  //    closes the whole gap — there is no separate start-at path.
  room.position = 600;
  await page.waitForFunction(() => Math.abs(document.querySelector('#video').currentTime - 600) < 15,
    null, { timeout: 20000 }).catch(() => {});
  const at = await page.evaluate(() => document.querySelector('#video').currentTime);
  check('a guest behind the host is stepped up to the host', Math.abs(at - 600) < 15, `at ${at.toFixed(1)}s`);
  check('the sync line says what it is doing',
    /host/i.test(await page.locator('.wp-sync-text').textContent()),
    await page.locator('.wp-sync-text').textContent());

  // 3. The host pauses. So does this browser.
  room.state = 'paused';
  await page.waitForFunction(() => document.querySelector('#video').paused === true,
    null, { timeout: 20000 }).catch(() => {});
  check('the host pausing pauses the guest',
    (await page.evaluate(() => document.querySelector('#video').paused)) === true);
  check('and the panel says so',
    (await page.locator('.wp-sync-text').textContent()) === 'The host paused.',
    await page.locator('.wp-sync-text').textContent());

  // 4. And resumes. Never a blind toggle: two ticks of the same state in a row
  //    must not invert it.
  room.state = 'playing';
  await page.waitForFunction(() => document.querySelector('#video').paused === false,
    null, { timeout: 20000 }).catch(() => {});
  check('the host resuming resumes the guest',
    (await page.evaluate(() => document.querySelector('#video').paused)) === false);
  await page.waitForTimeout(5000);
  check('two ticks of the same state do not toggle it back',
    (await page.evaluate(() => document.querySelector('#video').paused)) === false);

  // 5. THE PARTY DRIVES ITS OWN FILM AND NOTHING ELSE. #video is app.js's one
  //    player and the sync clock deliberately outlives a close (step 6 asserts
  //    exactly that), so a guest who goes and opens something else while still
  //    in the room used to have THAT film seeked and paused to a stranger's
  //    playhead inside two seconds. The unrelated film is opened through
  //    window.BlazingPlayer.open, which is the same public surface a detail
  //    sheet, youtube.js and livetv.js all open the player through.
  room.position = 600;
  room.state = 'playing';
  await page.evaluate(() => window.BlazingPlayer.open('Some Other Film', 'https://cdn.example.test/other.webm'));
  await page.waitForFunction(() => {
    const v = document.querySelector('#video');
    return v.getAttribute('src') === 'https://cdn.example.test/other.webm'
      && v.readyState >= 1 && v.currentTime > 0 && v.paused === false;
  }, null, { timeout: 20000 });
  // Three ticks of the two-second clock, plus slack for the fetch.
  await page.waitForTimeout(7000);
  const unrelated = await page.evaluate(() => ({
    src: document.querySelector('#video').getAttribute('src'),
    at: document.querySelector('#video').currentTime,
  }));
  check('a film the party is not watching is never seeked to the host',
    unrelated.at < 60, `at ${unrelated.at.toFixed(1)}s with the host at 600s`);
  check('and it is still the film the viewer opened',
    unrelated.src === 'https://cdn.example.test/other.webm', unrelated.src);
  // The pause half of the same hole: the host's play state must not be applied
  // to it either.
  room.state = 'paused';
  await page.waitForTimeout(5000);
  check('and the host pausing does not pause it',
    (await page.evaluate(() => document.querySelector('#video').paused)) === false);
  check('the panel says which film it is not driving',
    /not syncing/i.test(await page.locator('.wp-sync-text').textContent()),
    await page.locator('.wp-sync-text').textContent());
  room.state = 'playing';

  // 6. Close the film while still in the party. The panel must OFFER it back —
  //    a control that is drawn and does nothing is the exact defect this item
  //    is about, so the button is asserted by pressing it, not by existing.
  await page.click('#player-close');
  await page.waitForFunction(() => document.querySelector('#player').hidden === true,
    null, { timeout: 10000 });
  await page.waitForSelector('.wp-sync-play:not([hidden])', { timeout: 20000 });
  check('closing the film offers it back instead of leaving a dead panel',
    (await page.locator('.wp-sync-play').textContent()) === 'Play what the party is watching');
  await page.click('.wp-sync-play');
  await page.waitForFunction(
    () => !document.querySelector('#player').hidden
      && document.querySelector('#video').getAttribute('src') === 'https://cdn.example.test/party.webm',
    null, { timeout: 20000 },
  ).catch(() => {});
  check('and the button actually starts it',
    (await page.evaluate(() => !document.querySelector('#player').hidden
      && document.querySelector('#video').getAttribute('src'))) === 'https://cdn.example.test/party.webm');

  // 7. Leaving stops the corrections and NOTHING else. Roku says the same thing
  //    out loud on the same action: "Left the watch party - carry on watching."
  await page.click('.wp-head-leave');
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => ({
    hidden: document.querySelector('#player').hidden,
    src: document.querySelector('#video').getAttribute('src'),
  }));
  check('leaving the party leaves the film playing',
    after.hidden === false && after.src === 'https://cdn.example.test/party.webm',
    JSON.stringify(after));

  await ctx.close();
}

const real = errors.filter((e) => !/Failed to fetch|NetworkError|CORS|load resource/i.test(e));
check('no page errors', real.length === 0, real.join(' | '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
