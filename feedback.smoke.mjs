/**
 * Settings → Send feedback, driven for real (feedback.js, Markus 17 Oct 2026).
 *
 * Same rule as settings.smoke.mjs: nothing here asserts that a control EXISTS.
 * It breaks things on purpose, presses Send, and checks the request that left
 * the browser — that the note, the kind and the profile are in it, that the
 * error log carries the failures that really happened, and that no secret that
 * was inside those failures went with it.
 *
 *   node feedback.smoke.mjs
 */
import { launchBrowser } from './comet.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

let pass = 0, fail = 0;
const ok = (condition, label, detail = '') => {
  if (condition) { pass += 1; console.log('ok   ', label, detail); }
  else { fail += 1; console.log('FAIL ', label, detail); }
};

const profiles = [
  { id: 'p-alex', name: 'Alex', avatar: '🦊', maxRating: 'mature', allowAdult: false, isKids: false, hasPin: false },
];
const posts = [];
let nextAnswer = { status: 202, body: { ok: true, id: 'fb_test1' } };

let browser;
try {
  browser = await launchBrowser();
  // Tall enough that the whole form is on screen without scrolling. Against
  // Comet over CDP, Playwright's scroll-into-view step can hang until the 30 s
  // timeout — settings.smoke.mjs dies the same way on a clean checkout of main
  // on this Mac (17 Oct 2026) — and nothing here is about scrolling.
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 2200 } });
  // Top frame, and only when absent. An init script runs in EVERY same-origin
  // document, iframes included; re-writing the device key from inside a
  // trailer frame fires a `storage` event in the app, and profile.js answers a
  // changed device key with location.reload() — which is right for a real
  // second tab and wiped this page out mid-test (measured: a reload ~1 s after
  // the first Send, every run).
  await ctx.addInitScript(() => {
    if (window.top !== window) return;
    if (!localStorage.getItem('blazing-web-profile-device-v1')) {
      localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-fb', token: 'fixture-token' }));
    }
    localStorage.setItem('blazing-household-approved', '1');
  });
  await ctx.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === base) return route.continue();
    if (url.hostname === 'fleet.lyreosai.com') {
      if (url.pathname === '/profiles' && request.method() === 'GET') return json(route, { profiles });
      if (url.pathname === '/accounts/me') return json(route, { account: { id: 'acc', name: 'Fixture' }, device: { id: 'dev-fb', enrollmentStatus: 'approved' } });
      if (url.pathname === '/feedback' && request.method() === 'POST') {
        posts.push({
          deviceId: url.searchParams.get('deviceId'),
          token: request.headers()['x-device-token'],
          body: JSON.parse(request.postData() || '{}'),
          raw: request.postData() || '',
        });
        return json(route, nextAnswer.body, nextAnswer.status);
      }
      return json(route, {});
    }
    return json(route, {});
  });

  const page = await ctx.newPage();
  const faults = [];
  page.on('pageerror', (error) => faults.push(error.message));
  // Comet over CDP reloads a freshly opened page once, about a second in —
  // measured 17 Oct 2026 on a blank static page with no app code at all
  // (2 navigations for 1 goto). Landing mid-test, that reload detached the form
  // at a different step on every run. Wait it out before driving anything. CI's
  // Playwright chromium does not do it, so there this just runs out in 3 s.
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  for (let tick = 0; tick < 30 && navigations < 2; tick += 1) await page.waitForTimeout(100);
  await page.getByRole('button', { name: 'Choose Alex', exact: true }).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Choose Alex', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.bp-layer')?.hidden === true, null, { timeout: 8000 });

  /* ── Break things the ways a real evening breaks them ──────────────────── */
  await page.evaluate(() => {
    console.error('row load failed', 'https://fleet.lyreosai.com/emby/latest?deviceId=dev-fb&token=SECRET_IN_QUERY');
    console.error('debrid said no: apikey=SECRET_KEY_VALUE');
    setTimeout(() => { throw new Error('a deliberate uncaught error'); }, 0);
    Promise.reject(new Error('a deliberate rejected promise'));
    window.BlazingTelemetry.log('play_failed', { title: 'Dune', code: '4', message: 'html5 media error' });
    const img = new Image();
    img.src = '/missing-poster.jpg?sig=SECRET_SIGNATURE';
    document.body.append(img);
  });
  await page.waitForFunction(() => window.BlazingFeedback.log.entries().length >= 6, null, { timeout: 8000 })
    .catch(() => {});
  const recorded = await page.evaluate(() => window.BlazingFeedback.log.entries());
  const recordedText = JSON.stringify(recorded);
  ok(recorded.length >= 6, 'every kind of failure lands in the local log', `(${recorded.length} lines)`);
  ok(recordedText.includes('a deliberate uncaught error') && recordedText.includes('a deliberate rejected promise'),
    'uncaught errors and rejected promises are recorded');
  ok(recordedText.includes('play_failed: Dune') && recordedText.includes('img failed to load'),
    'play_failed handed to telemetry and a failed image are recorded');
  ok(!/SECRET/.test(recordedText), 'no secret from a URL, a key=value or a query string reaches storage',
    recordedText.match(/.{0,30}SECRET.{0,10}/)?.[0] || '');
  const stored = await page.evaluate(() => localStorage.getItem('blazing-web-error-log-v1') || '');
  ok(stored.includes('a deliberate uncaught error'), 'the log is kept in localStorage, so it survives a reload');

  /* ── Settings → Send feedback ──────────────────────────────────────────── */
  await page.evaluate(() => document.querySelector('[data-view="settings"]').click());
  await page.waitForSelector('#settings-view:not([hidden]) #settings-feedback', { timeout: 8000 });
  await page.locator('#settings-feedback').click();
  await page.waitForSelector('#feedback-message', { timeout: 8000 });
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'feedback-kind-broken'),
    'the form opens on the kind choice, not the text box (no TV keyboard popping up)');

  await page.locator('#feedback-send').click();
  ok(posts.length === 0 && (await page.locator('#feedback-status').innerText()).includes('Write a few words'),
    'an empty note is not sent, and the screen says why');

  const logRow = await page.locator('#feedback-include-log').innerText();
  ok(/Include the error log: On \(\d+ lines\)/.test(logRow), 'the log toggle says it is on and how much is in it', `(${logRow})`);
  await page.locator('#feedback-show-log').click();
  const previewText = await page.locator('#feedback-log-preview').innerText();
  ok(await page.locator('#feedback-log-preview').isVisible() && previewText.includes('play_failed: Dune'),
    'Show what the log will send shows the actual lines');

  await page.locator('#feedback-kind-dislike').click();
  await page.locator('#feedback-message').fill('The Live TV guide text is too small to read from the couch.');
  await page.locator('#feedback-contact').fill('text me');
  await page.locator('#feedback-send').click();
  await page.waitForFunction(() => (document.getElementById('feedback-status')?.textContent || '').startsWith('Sent'), null, { timeout: 8000 });
  const first = posts[0];
  ok(first && first.deviceId === 'dev-fb' && first.token === 'fixture-token',
    'Send posts to the fleet as this device, with its token in the header');
  ok(first && first.body.kind === 'dislike' && first.body.message.startsWith('The Live TV guide')
    && first.body.contact === 'text me' && first.body.profileId === 'p-alex' && first.body.platform === 'web',
  'the note carries the kind, the words, the contact and the profile', JSON.stringify(first && { ...first.body, log: undefined, device: undefined }));
  ok(first && first.body.log.length >= 6 && JSON.stringify(first.body.log).includes('a deliberate rejected promise'),
    'the error log goes with it', `(${first && first.body.log.length} lines)`);
  ok(first && typeof first.body.device.model === 'string' && first.body.device.model.length > 0,
    'and what kind of screen sent it', `(${first && first.body.device.model})`);
  ok(first && !/SECRET|fixture-token/.test(first.raw), 'no secret and not the device token are in the body');
  ok(await page.locator('#feedback-message').inputValue() === '', 'a sent note clears the box');

  /* ── The log can be left out ───────────────────────────────────────────── */
  await page.locator('#feedback-include-log').click();
  ok((await page.locator('#feedback-include-log').innerText()).includes(': Off'), 'the log toggle turns off');
  await page.locator('#feedback-kind-idea').click();
  await page.locator('#feedback-message').fill('A sleep timer would be nice.');
  await page.locator('#feedback-send').click();
  await page.waitForFunction(() => (document.getElementById('feedback-status')?.textContent || '') === 'Sent. Thank you. The team has it now.', null, { timeout: 8000 });
  ok(posts[1] && posts[1].body.kind === 'idea' && Array.isArray(posts[1].body.log) && posts[1].body.log.length === 0,
    'with the log off, nothing from it is sent');

  /* ── A refusal keeps the note ──────────────────────────────────────────── */
  nextAnswer = { status: 429, body: { error: 'Too many notes from this screen in the last hour. Try again later.' } };
  await page.locator('#feedback-message').fill('One more thing.');
  await page.locator('#feedback-send').click();
  await page.waitForFunction(() => (document.getElementById('feedback-status')?.textContent || '').startsWith('Too many'), null, { timeout: 8000 });
  ok(await page.locator('#feedback-message').inputValue() === 'One more thing.', 'a refused note stays in the box');

  /* ── Back, and back again ──────────────────────────────────────────────── */
  await page.locator('#feedback-back').click();
  await page.waitForSelector('#settings-min-height', { timeout: 8000 });
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'settings-feedback'),
    'Back returns to Settings with focus on Send feedback, where the remote left it');
  await page.locator('#settings-feedback').click();
  await page.waitForSelector('#feedback-message', { timeout: 8000 });
  ok(await page.locator('#feedback-message').inputValue() === 'One more thing.', 'and the unsent note is still there');

  const unexpected = faults.filter((message) => !message.includes('deliberate'));
  ok(unexpected.length === 0, 'no page errors other than the deliberate ones', unexpected.join(' | '));
} catch (error) {
  fail += 1;
  console.log('FAIL  harness', error && error.stack ? error.stack : error);
} finally {
  if (browser) await browser.close();
  server.close();
}

console.log(`\nfeedback: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
