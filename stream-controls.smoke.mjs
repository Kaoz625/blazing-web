// Actual page controls with isolated profile, source-evidence and Hls fixtures.
// This checks UI and request identity, not remote media playback.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';
import { launchBrowser } from './comet.mjs';
import { prepareProfile, selectProfile } from './scripts/profile-fixture.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const OUT = process.env.STREAM_CONTROLS_REVIEW_DIR || '/tmp/blazing-stream-controls-review';
await mkdir(OUT, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = pathname === '/' ? 'index.html' : pathname;
  try { const body = await readFile(join(ROOT, file)); res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }).end(body); }
  catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const profiles = ['A', 'B'].map(letter => ({ id: `preferences-${letter}`, name: `Profile ${letter}`, maxRating: 'mature', hasPin: false }));
const description = 'A long description used to check the real detail controls. '.repeat(20);
const titles = [
  { id: 'tt905001', type: 'movie', name: 'Track controls fixture', description, contentRating: 'general', releaseInfo: '2026' },
  { id: 'tt905002', type: 'movie', name: 'Short description fixture', description: 'A short description.', contentRating: 'general', releaseInfo: '2026' },
];
const checks = [], requests = [], errors = [], cardMotion = [];
let browser, page, releaseOld;
let holdOld = false;
const check = (name, pass) => { checks.push({ name, pass: Boolean(pass) }); assert.ok(pass, name); console.log(`PASS ${name}`); };
const response = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
function sourceReply(audio, sub, marker = 'CURRENT') {
  const checkedAt = Date.now();
  const verification = { mode: 'media-v1', status: 'inspected', checkedAt, prefs: { wantEnglishAudio: audio === 'en', wantEnglishSub: sub === 'en' }, coverage: { '1080p': { inspected: 1 } } };
  const sample = {
    name: '✅ 4K HEVC', title: `${marker}.Mislabelled.2160p.HEVC.AAC`, url: 'https://media.example.test/measured.m3u8',
    _verified: { mode: 'media-v1', checkedAt, quality: '1080p' },
    _mediaEvidence: { kind: 'ffprobe-sample-v1', inspectedAt: checkedAt, bytes: 4096,
      video: { width: 1920, height: 1080, codec: 'h264', tier: '1080p', packets: 20 },
      audio: [{ language: 'eng', codec: 'aac', packets: 5 }], subtitles: [{ language: 'en', packets: 3, forced: false }] },
  };
  return { verification, streams: [sample, { name: '✔ 720p', title: `${marker}.Marker.only.720p.H264.AAC.mp4`, url: 'https://media.example.test/marker.mp4', _verified: { mode: 'media-v1', checkedAt, quality: '720p' } }] };
}
const waitUntil = async predicate => {
  const end = Date.now() + 30000;
  while (!predicate()) { if (Date.now() >= end) assert.fail('Expected fixture request did not start'); await new Promise(resolve => setTimeout(resolve, 25)); }
};
const hlsFixture = `(() => {
  class TrackFixture {
    static isSupported() { return true; }
    static Events = { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed', AUDIO_TRACKS_UPDATED: 'hlsAudioTracksUpdated', SUBTITLE_TRACKS_UPDATED: 'hlsSubtitleTracksUpdated', AUDIO_TRACK_SWITCHED: 'hlsAudioTrackSwitched', SUBTITLE_TRACK_SWITCH: 'hlsSubtitleTrackSwitch' };
    constructor() { this.callbacks = new Map(); this.audioTracks = [{ lang: 'ja', name: 'Japanese' }, { lang: 'en', name: 'English dub' }]; this.subtitleTracks = [{ lang: 'en', name: 'English captions' }]; this.audioTrack = 0; this.subtitleTrack = -1; this.subtitleDisplay = false; window.__trackFixture = this; }
    on(name, callback) { if (!this.callbacks.has(name)) this.callbacks.set(name, new Set()); this.callbacks.get(name).add(callback); }
    off(name, callback) { this.callbacks.get(name)?.delete(callback); }
    emit(name) { this.callbacks.get(name)?.forEach(callback => callback(name, {})); }
    loadSource(url) { this.source = url; }
    attachMedia(video) { this.video = video; }
    destroy() { this.destroyed = true; this.callbacks.clear(); }
  }
  window.Hls = TrackFixture;
})();`;
async function openTitle(name = titles[0].name) {
  await page.getByRole('button', { name: `View ${name}`, exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.locator('#detail-streams .stream-row').first().waitFor();
}
async function pointerOpenTitle(name = titles[0].name) {
  const target = page.getByRole('button', { name: `View ${name}`, exact: true });
  const box = await target.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let index = 0; index < 4; index++) {
    await page.waitForTimeout(250);
    cardMotion.push(await target.evaluate(node => {
      const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
      return { time: performance.now(), x: rect.x, y: rect.y, width: rect.width, height: rect.height, transform: css.transform, transition: css.transition, animation: css.animationName };
    }));
  }
  const [before, after] = cardMotion.slice(-2);
  check('Pointer hover settles without a repeating card movement', ['x','y','width','height'].every(key => Math.abs(before[key] - after[key]) <= 1));
  const point = { x: after.x + after.width / 2, y: after.y + after.height / 2 };
  check('Settled pointer target remains the intended card', await target.evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), point));
  await page.mouse.click(point.x, point.y);
  await page.locator('#detail-streams .stream-row').first().waitFor();
  check('Real pointer click opens the settled card', await page.locator('#detail-title').innerText() === name);
}
async function switchProfile(from, to) {
  await page.locator('.topbar').getByRole('button', { name: new RegExp(`Profile ${from}`) }).click();
  await selectProfile(page, `Profile ${to}`);
}
try {
  const served = await fetch(base);
  assert.match(served.headers.get('content-type'), /^text\/html/);
  assert.match(await served.text(), /<html/);
  browser = await launchBrowser({ timeoutMs: 120000 });
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === base) {
      if (url.pathname === '/hls.min.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: hlsFixture });
      return route.continue();
    }
    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/manifest.json') return response(route, { catalogs: [{ id: 'controls', type: 'movie', name: 'Control fixtures' }] });
      if (url.pathname === '/catalog/movie/controls.json') return response(route, { metas: titles });
      if (url.pathname.startsWith('/meta/')) return response(route, { meta: titles.find(title => url.pathname.includes(title.id)) });
      if (url.pathname.startsWith('/stream/')) {
        const audio = url.searchParams.get('audio'), sub = url.searchParams.get('sub');
        requests.push({ audio, sub, profileId: req.headers()['x-profile-id'] || null });
        if (holdOld && audio === 'any' && sub === 'en') {
          await new Promise(resolve => { releaseOld = resolve; });
          return response(route, sourceReply(audio, sub, 'STALE'));
        }
        return response(route, sourceReply(audio, sub));
      }
    }
    if (url.pathname === '/party/active') return route.fulfill({ status: 204 });
    if (req.resourceType() === 'image') return route.fulfill({ status: 200, contentType: 'image/png', body: await readFile(join(ROOT, 'icon-192.png')) });
    return response(route, { catalogs: [], metas: [], items: [], events: [] });
  });
  await prepareProfile(context, profiles[0]);
  await context.route('https://fleet.lyreosai.com/profiles?*', route => response(route, { profiles }));
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await selectProfile(page, 'Profile A'); await openTitle();
  check('Initial source request uses this profile and English preferences', requests.at(-1).audio === 'en' && requests.at(-1).sub === 'en' && (await page.evaluate(() => window.BlazingStreamPreferences.current().profileId)) === 'preferences-A');
  const sampled = page.locator('#detail-streams .stream-row').filter({ hasText: 'Mislabelled' });
  check('Measured1080 H264 survives misleading4K HEVC filename and shows1080 badge', await sampled.count() === 1 && await sampled.locator('.badge').textContent() === '1080p');
  check('Only a measured source gets the sample description', await page.locator('.stream-sample-proof').count() === 1 && (await sampled.innerText()).includes('1920 × 1080'));
  check('Marker-only source gets no proof or check mark', !(await page.locator('#detail-streams .stream-row').filter({ hasText: 'Marker.only' }).innerText()).match(/[✓✔✅]|Sample checked/));
  check('Coverage states short samples without full-playback claim', (await page.locator('#detail-verification').innerText()).includes('1/3') && (await page.locator('#detail-verification').innerText()).includes('Full playback is not confirmed'));
  const inconsistent = sourceReply('en', 'en'); inconsistent.streams[0]._mediaEvidence.video.width = 640; inconsistent.streams[0]._mediaEvidence.video.height = 360;
  check('Contradictory360 dimensions cannot qualify as measured1080', await page.evaluate(({ item, verification }) => !window.BlazingStreamEvidence.inspected(item, verification, window.BlazingStreamPreferences.current()), { item: inconsistent.streams[0], verification: inconsistent.verification }));
  await page.locator('#detail-play').click(); await page.locator('.stream-subtitle-track').waitFor();
  check('Default English preferences select the actual English Hls tracks', await page.evaluate(() => window.__trackFixture.audioTrack === 1 && window.__trackFixture.subtitleTrack === 0 && window.__trackFixture.subtitleDisplay));
  await page.locator('#player-close').click(); await openTitle();
  await page.screenshot({ path: join(OUT, 'sources-1440.png'), animations: 'disabled', timeout: 60000 });
  await page.setViewportSize({ width: 375, height: 1000 });
  const copy = page.locator('#detail-copy'), more = page.locator('#detail-copy-toggle');
  const collapsedHeight = await copy.evaluate(node => node.getBoundingClientRect().height);
  check('Long synopsis is collapsed with an accessible expansion control', await more.getAttribute('aria-expanded') === 'false' && collapsedHeight < 100);
  await more.click();
  check('Show more expands the actual synopsis', await more.getAttribute('aria-expanded') === 'true' && await copy.evaluate(node => node.getBoundingClientRect().height) > collapsedHeight * 2);
  await more.click();
  await page.locator('#detail-close').click(); await openTitle(titles[1].name);
  check('Next short title resets and hides synopsis expansion', await more.isHidden() && !(await copy.getAttribute('class')).includes('is-collapsed'));
  await page.locator('#detail-close').click(); await pointerOpenTitle();
  const targetMetrics = await page.locator('#detail-dialog').evaluate(dialog => ({ overflow: dialog.scrollWidth > dialog.clientWidth + 1, targets: [...dialog.querySelectorAll('#detail-stream-preferences select,#detail-copy-toggle')].filter(node => node.getClientRects().length).map(node => ({ label: node.getAttribute('aria-label') || node.textContent, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })) }));
  check('375px language and synopsis controls are at least44px with no dialog overflow', !targetMetrics.overflow && targetMetrics.targets.every(target => target.width >= 44 && target.height >= 44));
  await page.screenshot({ path: join(OUT, 'sources-375.png'), animations: 'disabled', timeout: 60000 });
  holdOld = true;
  await page.getByLabel('Preferred audio', { exact: true }).selectOption('any'); await waitUntil(() => releaseOld);
  await page.getByLabel('Preferred subtitles', { exact: true }).selectOption('off');
  await page.locator('#detail-streams .stream-row').first().waitFor();
  const oldDone = page.waitForResponse(reply => reply.url().includes('/stream/') && new URL(reply.url()).searchParams.get('sub') === 'en');
  releaseOld(); await oldDone; holdOld = false; await page.waitForTimeout(100);
  check('Language change requests Any/Off and ignores the older response', requests.at(-1).audio === 'any' && requests.at(-1).sub === 'off' && !(await page.locator('#detail-streams').innerText()).includes('STALE'));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }); await selectProfile(page, 'Profile A'); await openTitle();
  check('Reload restores the actual profile preferences and source query', await page.getByLabel('Preferred audio', { exact: true }).inputValue() === 'any' && await page.getByLabel('Preferred subtitles', { exact: true }).inputValue() === 'off' && requests.at(-1).audio === 'any' && requests.at(-1).sub === 'off');
  await page.locator('#detail-close').click(); await switchProfile('A', 'B'); await openTitle();
  check('Other profile starts with its own English defaults', requests.at(-1).audio === 'en' && requests.at(-1).sub === 'en' && (await page.evaluate(() => window.BlazingStreamPreferences.current().profileId)) === 'preferences-B');
  await page.locator('#detail-close').click(); await switchProfile('B', 'A'); await openTitle();
  check('Returning to the first profile restores Any/Off', await page.getByLabel('Preferred subtitles', { exact: true }).inputValue() === 'off');
  await page.locator('#detail-play').click(); await page.locator('#player').waitFor({ state: 'visible' }); await page.locator('.stream-subtitle-track').waitFor();
  check('Play uses the same measured first source as the list', await page.evaluate(() => window.__trackFixture.source.endsWith('/measured.m3u8')));
  check('Hls player lists only the two actual audio tracks and one subtitle track plus Off', await page.locator('.stream-audio-track option').count() === 2 && await page.locator('.stream-subtitle-track option').count() === 2);
  check('Saved Off disables Hls captions on attach', await page.evaluate(() => window.__trackFixture.subtitleTrack === -1 && window.__trackFixture.subtitleDisplay === false));
  await page.locator('.stream-audio-track').selectOption('1'); await page.locator('.stream-subtitle-track').selectOption('0');
  check('Real track menu events switch the exposed Hls indices', await page.evaluate(() => window.__trackFixture.audioTrack === 1 && window.__trackFixture.subtitleTrack === 0 && window.__trackFixture.subtitleDisplay));
  await page.locator('.stream-subtitle-track').selectOption('-1');
  check('Player Off disables captions again', await page.evaluate(() => window.__trackFixture.subtitleTrack === -1 && !window.__trackFixture.subtitleDisplay));
  const playerMetrics = await page.locator('#player').evaluate(player => ({ overflow: player.scrollWidth > player.clientWidth + 1, controls: [...player.querySelectorAll('.stream-track-controls select')].map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })) }));
  check('375px player track controls fit and retain44px targets', !playerMetrics.overflow && playerMetrics.controls.every(control => control.width >= 44 && control.height >= 44));
  await page.screenshot({ path: join(OUT, 'player-tracks-375.png'), animations: 'disabled', timeout: 60000 });
  const native = await page.evaluate(() => {
    const video = document.querySelector('video.video');
    window.BlazingStreamPreferences.resetPlayer();
    const captions = video.addTextTrack('captions', 'Native English captions', 'en'); captions.mode = 'showing';
    const chapters = video.addTextTrack('metadata', 'Chapter data', 'en'); chapters.mode = 'hidden';
    window.BlazingStreamPreferences.bindPlayer(video);
    return { captionMode: captions.mode, chapterMode: chapters.mode, choices: [...document.querySelectorAll('.stream-subtitle-track option')].map(option => option.textContent) };
  });
  check('Native TextTrack captions honor Off and omit metadata tracks', native.captionMode === 'disabled' && native.chapterMode === 'hidden' && native.choices.join('|') === 'Off|Native English captions');
  await page.locator('.stream-subtitle-track').selectOption('0');
  check('Native caption menu enables the real browser TextTrack', await page.evaluate(() => [...document.querySelector('video.video').textTracks].find(track => track.kind === 'captions').mode === 'showing'));
  await page.locator('#player-close').click();
  check('Closing the player clears all track controls', await page.locator('.stream-track-controls').count() === 0);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('blazing-profile-signed-out')));
  check('Signout clears active language identity and mounted controls', await page.evaluate(() => window.BlazingStreamPreferences.query() === '' && window.BlazingStreamPreferences.current().profileId === null && document.querySelector('#detail-stream-preferences').childElementCount === 0));
  check('No browser runtime errors', errors.length === 0);
} catch (error) {
  errors.push(String(error)); console.error(error);
  if (page) await page.screenshot({ path: join(OUT, 'failure.png'), animations: 'disabled', timeout: 60000 }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (releaseOld) releaseOld();
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(OUT, 'report.json'), JSON.stringify({ pass: checks.length > 0 && checks.every(check => check.pass) && errors.length === 0, checks, requests, errors, cardMotion, coverage: 'Local actual page, isolated profiles and source evidence; Hls track model and real native TextTrack controls. No remote playback proof.' }, null, 2) + '\n');
}
