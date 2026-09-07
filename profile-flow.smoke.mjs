// Render and exercise the actual first-run/profile UI. Every remote request is
// stubbed; account credentials and profile names below are test fixtures only.
// Run: node profile-flow.smoke.mjs
// Screenshots and measured geometry: /tmp/blazing-profile-review/
import { launchBrowser } from './comet.mjs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const OUTPUT = process.env.PROFILE_REVIEW_DIR || '/tmp/blazing-profile-review';
const NAVIGATION_TIMEOUT = Number(process.env.PROFILE_REVIEW_TIMEOUT_MS) || 10000;
const BROWSER_TIMEOUT = Number(process.env.PROFILE_REVIEW_BROWSER_TIMEOUT_MS) || 30000;
const DEVICE_KEY = 'blazing-web-profile-device-v1';
const SIGNED_OUT_KEY = 'blazing-signed-out-v1';
const CREDS = { id: 'fixture-browser', token: 'fixture-token-v1' };
const EMAIL = 'viewer@example.invalid';
const PASSWORD = randomUUID();
const PROFILES = [
  { id: 'alex', name: 'Alex', avatar: '🦊', maxRating: 'adult', allowAdult: true, effectiveMaxRating: 'teen', effectiveAllowAdult: false },
  { id: 'morgan', name: 'Morgan', avatar: '🐼', maxRating: 'teen', hasPin: true },
  { id: 'jordan', name: 'Jordan', avatar: '🚀', maxRating: 'teen' },
  { id: 'kids', name: 'Kids', avatar: '🐸', maxRating: 'kids', isKids: true },
  { id: 'grandma', name: 'Grandma', avatar: '🐧', maxRating: 'teen' },
  { id: 'guest', name: 'Guest', avatar: '🐻', maxRating: 'teen', disabled: true },
];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const checks = [];
const metrics = [];
const check = (condition, label, detail = '') => {
  checks.push({ pass: Boolean(condition), label, detail });
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
await mkdir(OUTPUT, { recursive: true });
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/fixture-empty') {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Fixture seed</title>');
    return;
  }
  const file = resolve(ROOT, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
  if (!file.startsWith(resolve(ROOT) + sep)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end('Not found'); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

async function fixture(browser, width, { seeded = false, empty = false, profiles = PROFILES, logoutMode = 'success', reducedMotion = 'no-preference', art = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion, serviceWorkers: 'block' });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
  const state = { approved: seeded, token: CREDS.token, profiles: empty ? [] : structuredClone(profiles), calls: [], faults: [], consoleErrors: [], localErrors: [] };
  await context.addInitScript(() => {
    window.__profileSelections = [];
    window.__profileResets = 0;
    document.addEventListener('blazing-profile-selected', (event) => window.__profileSelections.push(event.detail));
    document.addEventListener('blazing-profile-signed-out', () => window.__profileResets++);
  });
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === base) return route.continue();
    if (!/^https?:$/.test(url.protocol)) return route.continue();
    let body = null;
    try { body = JSON.parse(req.postData() || 'null'); } catch {}
    const call = { path: url.pathname, method: req.method(), body, token: req.headers()['x-device-token'] || '' };
    const send = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.hostname === 'fleet.lyreosai.com') {
      state.calls.push(call);
      if (call.path === '/agent/register') return send({ deviceId: CREDS.id, deviceToken: state.token });
      if (call.path === '/accounts/login') {
        if (body?.email !== EMAIL || body?.password !== PASSWORD || body?.deviceId !== CREDS.id || call.token !== state.token) {
          return send({ error: 'bad login fixture or device token' }, 401);
        }
        state.approved = true;
        return send({ ok: true, account: { id: 'fixture-account' } });
      }
      if (call.path === '/accounts/logout') {
        if (body?.deviceId !== CREDS.id || call.token !== state.token) return send({ error: 'invalid device credentials' }, 401);
        if (logoutMode === 'offline') return route.abort('internetdisconnected');
        if (logoutMode === 'unavailable') return send({ error: 'not found', path: call.path }, 404);
        state.approved = false;
        state.token = 'fixture-token-v2';
        return send({ ok: true, deviceId: CREDS.id, deviceToken: state.token });
      }
      if (call.path === '/profiles') {
        if (!state.approved) return send({ error: 'device enrollment is pending admin approval' }, 403);
        if (url.searchParams.get('deviceId') !== CREDS.id || call.token !== state.token) return send({ error: 'invalid device credentials' }, 401);
        if (call.method === 'POST') {
          const profile = { id: 'created', name: body?.name, isKids: body?.isKids === true, maxRating: body?.isKids ? 'kids' : 'teen' };
          state.profiles.push(profile);
          return send({ profile });
        }
        return send({ profiles: state.profiles });
      }
      if (/^\/profiles\/[^/]+\/progress$/.test(call.path)) return send({ progress: { items: art && call.path === '/profiles/jordan/progress'
        ? [{ id: 'fixture-art', name: 'Local artwork fixture', type: 'movie', background: 'https://fixture-art.invalid/profile-backdrop.jpg', updatedAt: '2026-09-05T10:00:00Z' }] : [] } });
      if (/^\/profiles\/[^/]+\/verify$/.test(call.path)) {
        if (call.method !== 'POST' || body?.pin !== '1111' || call.token !== state.token || url.searchParams.get('deviceId') !== CREDS.id) return send({ ok: false }, 401);
        return send({ ok: true, unlockToken: 'fixture-unlock', expiresAt: new Date(Date.now() + 60000).toISOString() });
      }
      return send({ ok: true, rows: [], shelves: [], items: [], profiles: [] });
    }
    // Local product files are real. No CDN, artwork host, telemetry endpoint,
    // add-on, font provider, or third-party API can receive this test traffic.
    if (req.resourceType() === 'script') return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    if (req.resourceType() === 'stylesheet') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (art && url.hostname === 'fixture-art.invalid') return route.fulfill({ status: 200, contentType: 'image/jpeg', body: art });
    if (req.resourceType() === 'image') return route.fulfill({ status: 200, contentType: 'image/png', body: await readFile(join(ROOT, 'icon-192.png')) });
    return send({ ok: true, metas: [], items: [], catalogs: [], rows: [], shelves: [], streams: [], addons: [], favorites: [] });
  });
  const observe = (p) => {
    p.on('pageerror', (e) => state.faults.push(e.message));
    p.on('console', (message) => { if (message.type() === 'error') state.consoleErrors.push(message.text()); });
    p.on('response', (response) => { if (response.url().startsWith(base) && response.status() >= 400) state.localErrors.push(`${response.status()} ${response.url()}`); });
  };
  context.on('page', observe);
  const page = await context.newPage();
  await page.goto(base + '/fixture-empty');
  if (seeded) await page.evaluate(({ key, credentials }) => localStorage.setItem(key, JSON.stringify(credentials)), { key: DEVICE_KEY, credentials: CREDS });
  await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator('.bp-layer').waitFor({ state: 'visible' });
  return { context, page, state };
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(120);
}

async function capture(page, width, view) {
  await settle(page);
  const data = await page.evaluate(() => {
    const layer = document.querySelector('.bp-layer');
    const panel = document.querySelector('.bp-panel');
    const controls = [...layer.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]')]
      .filter((el) => !el.classList.contains('bp-backdrop') && el.getClientRects().length);
    return {
      width: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth + 1 || layer.scrollWidth > layer.clientWidth + 1 || panel.scrollWidth > panel.clientWidth + 1,
      widths: { document: document.documentElement.scrollWidth, layer: layer.scrollWidth, layerClient: layer.clientWidth, panel: panel.scrollWidth, panelClient: panel.clientWidth },
      overflowing: [...panel.querySelectorAll('*')].filter((el) => {
        const r = el.getBoundingClientRect();
        return el.getClientRects().length && r.right > panel.getBoundingClientRect().right + 1;
      }).map((el) => ({ tag: el.tagName, id: el.id, class: el.className, right: Math.round(el.getBoundingClientRect().right) })).slice(0, 12),
      panelHeight: panel.clientHeight, panelScrollHeight: panel.scrollHeight,
      targets: controls.map((el) => {
        const r = el.getBoundingClientRect();
        return { label: el.id || el.getAttribute('aria-label') || el.textContent.trim(), width: Math.round(r.width), height: Math.round(r.height) };
      }),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  });
  data.view = view;
  metrics.push(data);
  check(data.width === width && !data.overflow, `${width} ${view}: exact viewport and no horizontal overflow`, data.overflow ? JSON.stringify({ widths: data.widths, overflowing: data.overflowing }) : '');
  const small = data.targets.filter((target) => target.width < 44 || target.height < 44);
  check(small.length === 0, `${width} ${view}: controls are at least 44×44`, JSON.stringify(small));
  await page.screenshot({ path: join(OUTPUT, `${view}-${width}.png`), fullPage: true });
}

async function focusCheck(page, label) {
  const candidates = await page.evaluate(() => [...document.querySelectorAll('.bp-layer button:not(:disabled), .bp-layer input:not(:disabled), .bp-layer a[href]')]
    .filter((el) => !el.classList.contains('bp-backdrop') && el.getClientRects().length).map((el) => ({ id: el.id, label: el.getAttribute('aria-label') })));
  check(candidates.length > 0, `${label}: focus targets exist`);
  await page.evaluate(() => [...document.querySelectorAll('.bp-layer button:not(:disabled), .bp-layer input:not(:disabled), .bp-layer a[href]')]
    .filter((el) => !el.classList.contains('bp-backdrop') && el.getClientRects().length).at(-1)?.focus());
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => {
    const list = [...document.querySelectorAll('.bp-layer button:not(:disabled), .bp-layer input:not(:disabled), .bp-layer a[href]')]
      .filter((el) => !el.classList.contains('bp-backdrop') && el.getClientRects().length);
    return document.activeElement === list[0];
  });
  await page.keyboard.press('Shift+Tab');
  const last = await page.evaluate(() => {
    const list = [...document.querySelectorAll('.bp-layer button:not(:disabled), .bp-layer input:not(:disabled), .bp-layer a[href]')]
      .filter((el) => !el.classList.contains('bp-backdrop') && el.getClientRects().length);
    return document.activeElement === list.at(-1);
  });
  check(first && last, `${label}: Tab and Shift+Tab stay in the open gate`);
  await page.keyboard.press('Escape');
  check(await page.locator('.bp-layer').isVisible(), `${label}: Escape cannot bypass profile selection`);
  await page.evaluate(() => { document.querySelector('.bp-panel').scrollTop = 0; });
}

async function login(page) {
  await page.locator('#bp-gate-email').click();
  await page.locator('#bp-email-address').fill(EMAIL);
  await page.locator('#bp-email-password').fill(PASSWORD);
  await page.locator('#bp-email-submit').click();
  await page.locator('.bp-profile-add').waitFor({ state: 'visible' });
}

let liveBrowser;
try {
  liveBrowser = await launchBrowser({ timeoutMs: BROWSER_TIMEOUT });
  // A server-side access change must invalidate a profile already selected in
  // this browser, even when its id is unchanged. Exercise the actual refresh,
  // close controls, and PIN buttons rather than mutating runtime state.
  for (const change of ['account-cap', 'new-pin']) {
    const active = { id: 'active', name: 'Active Viewer', avatar: '🦊', maxRating: change === 'account-cap' ? 'adult' : 'teen', allowAdult: change === 'account-cap' };
    const refreshed = await fixture(liveBrowser, 1440, { seeded: true, profiles: [active] });
    const page = refreshed.page;
    await page.locator('.bp-profile:not(.bp-profile-add)').first().click();
    await page.waitForFunction(() => window.__profileSelections.length === 1);
    check(await page.locator('.bp-layer').isHidden(), `${change}: original profile opens the app`);
    await page.locator('.bp-connect').click();
    await page.locator('.bp-refresh').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.bp-refresh').disabled);
    if (change === 'account-cap') {
      refreshed.state.profiles[0].effectiveMaxRating = 'teen';
      refreshed.state.profiles[0].effectiveAllowAdult = false;
    } else refreshed.state.profiles[0].hasPin = true;
    await page.locator('.bp-refresh').click();
    await page.waitForFunction(() => !document.querySelector('.bp-refresh').disabled);
    const reset = await page.evaluate(({ deviceKey }) => ({
      resetEvents: window.__profileResets,
      selectionCount: window.__profileSelections.length,
      profileId: localStorage.getItem('profileId'),
      credentials: JSON.parse(localStorage.getItem(deviceKey) || 'null'),
      connected: document.querySelector('.bp-connect').dataset.connected,
      gate: document.querySelector('.bp-layer').dataset.gate,
    }), { deviceKey: DEVICE_KEY });
    check(reset.resetEvents === 1 && reset.profileId === null && reset.connected !== 'true', `${change}: refresh clears active content and saved profile identity`, JSON.stringify(reset));
    check(reset.credentials?.id === CREDS.id && reset.credentials?.token === CREDS.token, `${change}: access refresh keeps browser device credentials`);
    check(reset.gate === 'required' && await page.locator('.bp-close').isHidden(), `${change}: close control cannot bypass a fresh profile choice`);
    await page.keyboard.press('Escape');
    await page.locator('.bp-backdrop').click({ position: { x: 1400, y: 850 } });
    check(await page.locator('.bp-layer').isVisible() && await page.evaluate(() => window.__profileSelections.length) === 1, `${change}: Escape and backdrop cannot restore old access`);
    await page.locator('.bp-profile:not(.bp-profile-add)').first().click();
    if (change === 'new-pin') {
      await page.locator('.bp-pin').waitFor({ state: 'visible' });
      check(await page.evaluate(() => window.__profileSelections.length) === 1, 'new-pin: reselecting the profile requires PIN before dispatch');
      await page.locator('.bp-pin .bp-back').click();
      await page.keyboard.press('Escape');
      check(await page.locator('.bp-layer').isVisible() && await page.locator('.bp-close').isHidden(), 'new-pin: Back from PIN cannot reopen the old session');
      await page.locator('.bp-profile:not(.bp-profile-add)').first().click();
      for (let digit = 0; digit < 4; digit++) await page.locator('.bp-digit[data-digit="1"]').click();
      await page.locator('.bp-pin .bp-verify').click();
    }
    await page.waitForFunction(() => window.__profileSelections.length === 2);
    const selection = await page.evaluate(() => window.__profileSelections.at(-1));
    check(selection.id === 'active' && selection.maxRating === 'teen' && selection.allowAdult === false && (change !== 'new-pin' || selection.unlocked === true), `${change}: fresh selection applies current cap and PIN state`, JSON.stringify(selection));
    check(await page.locator('.bp-layer').isHidden(), `${change}: app opens only after a valid fresh selection`);
    check(refreshed.state.faults.length === 0, `${change}: no runtime faults`, refreshed.state.faults.join('; '));
    await refreshed.context.close();
  }

  for (const width of [375, 768, 1440]) {
    if (!liveBrowser) liveBrowser = await launchBrowser({ timeoutMs: BROWSER_TIMEOUT });
    const s = await fixture(liveBrowser, width);
    await s.page.locator('#bp-gate-email').waitFor({ state: 'visible' });
    await capture(s.page, width, 'welcome');
    check(!s.state.calls.some((c) => c.path === '/agent/register'), `${width}: looking at welcome does not register a device`);
    await focusCheck(s.page, `${width} welcome`);
    await s.page.locator('#bp-gate-email').click();
    await capture(s.page, width, 'login');
    await focusCheck(s.page, `${width} login`);
    await s.page.locator('#bp-email-address').fill(EMAIL);
    await s.page.locator('#bp-email-password').fill(PASSWORD);
    await s.page.locator('#bp-email-submit').click();
    await s.page.locator('.bp-profile-add').waitFor({ state: 'visible' });
    check(s.state.calls.some((c) => c.path === '/accounts/login' && c.method === 'POST'), `${width}: real sign-in click sends a login request`);
    const tiles = s.page.locator('.bp-profile:not(.bp-profile-add)');
    check(await tiles.count() === 6, `${width}: all six account profiles render`);
    check(await tiles.nth(5).isDisabled(), `${width}: disabled profile cannot be selected`);
    check(await s.page.locator('.bp-profile-slot').nth(5).locator('.bp-pencil').isDisabled(), `${width}: disabled profile cannot be edited`);
    await capture(s.page, width, 'profiles');
    check(!s.state.calls.some((c) => /^\/profiles\/(alex|guest)\/progress$/.test(c.path)), `${width}: raw-adult and disabled profiles never request history artwork`);
    await focusCheck(s.page, `${width} profiles`);
    await s.page.locator('#bp-sign-out').scrollIntoViewIfNeeded();
    await s.page.screenshot({ path: join(OUTPUT, `profiles-bottom-${width}.png`), fullPage: true });
    check(await s.page.locator('#bp-sign-out').isVisible(), `${width}: sign-out is reachable below six profiles`);
    await tiles.nth(0).click();
    await s.page.waitForFunction(() => window.__profileSelections.length > 0);
    const selected = await s.page.evaluate(() => window.__profileSelections.at(-1));
    check(selected.id === 'alex' && selected.maxRating === 'teen' && selected.allowAdult === false, `${width}: account limits override raw profile permissions`);
    check(await s.page.locator('.bp-layer').isHidden(), `${width}: selecting a profile opens the app`);
    check(s.state.faults.length === 0, `${width}: no browser runtime faults`, s.state.faults.join('; '));
    check(s.state.consoleErrors.length === 0 && s.state.localErrors.length === 0, `${width}: clean console and no missing local assets`, [...s.state.consoleErrors, ...s.state.localErrors].join('; '));
    await s.context.close();
    await liveBrowser.close();
    liveBrowser = null;
  }

  liveBrowser = await launchBrowser({ timeoutMs: BROWSER_TIMEOUT });
  // An existing Blazing artwork file exercises the real history-to-backdrop
  // path. This is fixture history, never presented as a live user's progress.
  const artPath = process.env.BW_PROFILE_ART || '/Users/markususche/Desktop/roku channels/images/profiles/kids-backdrop.jpg';
  const art = await readFile(artPath).catch(() => null);
  if (art) {
    const preview = await fixture(liveBrowser, 1440, { seeded: true, art });
    await preview.page.locator('.bp-profile:not(.bp-profile-add)').nth(2).focus();
    await preview.page.waitForFunction(() => document.querySelector('.bp-art')?.dataset.shown === 'true');
    await preview.page.waitForTimeout(500);
    check(await preview.page.locator('.bp-art').evaluate((el) => el.style.backgroundImage.includes('fixture-art.invalid')), 'safe history artwork: real image paints behind the profile rail');
    await capture(preview.page, 1440, 'profiles-art-fixture');
    metrics.at(-1).fixtureArtSource = artPath;
    await preview.context.close();
  } else console.log('NOTE safe history art preview skipped: optional local Blazing artwork unavailable.');

  const empty = await fixture(liveBrowser, 375, { seeded: true, empty: true });
  await empty.page.locator('.bp-profile-add').waitFor({ state: 'visible' });
  await capture(empty.page, 375, 'no-profiles');
  await empty.page.locator('.bp-profile-add').click();
  await empty.page.locator('.bp-create-input').fill('New Viewer');
  await empty.page.locator('.bp-create .bp-verify').click();
  await empty.page.waitForTimeout(300);
  check(empty.state.calls.some((c) => c.path === '/profiles' && c.method === 'POST' && c.body?.name === 'New Viewer'), 'empty account: visible create action creates a profile');
  check(await empty.page.locator('.bp-layer').isHidden(), 'empty account: created profile is selected and app opens');
  await empty.context.close();

  const reduced = await fixture(liveBrowser, 375, { seeded: true, reducedMotion: 'reduce' });
  await reduced.page.locator('.bp-profile-add').waitFor({ state: 'visible' });
  await capture(reduced.page, 375, 'profiles-reduced-motion');
  const motion = await reduced.page.evaluate(() => ({
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    maxTransition: Math.max(...[...document.querySelectorAll('.bp-profile, .bp-avatar, .bp-art')].flatMap((el) => getComputedStyle(el).transitionDuration.split(',').map(parseFloat))),
  }));
  check(motion.reduced && motion.maxTransition <= 0.02, 'reduced motion: profile controls stay visible without long transitions', JSON.stringify(motion));
  await focusCheck(reduced.page, 'reduced-motion profiles');
  await reduced.context.close();

  const session = await fixture(liveBrowser, 1440, { seeded: true });
  await session.page.locator('.bp-profile:not(.bp-profile-add)').first().click();
  const other = await session.context.newPage();
  await other.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  // The first tab already chose somebody, and a second tab in the SAME context
  // shares that storage — so this one restores that viewer and closes its gate
  // on its own. The tile stays in the DOM but is not visible, so an
  // unconditional click waits for an element that will never be clickable.
  // What this scenario needs is only that both tabs are signed in before the
  // sign-out below; how each got there does not matter.
  const otherTile = other.locator('.bp-profile:not(.bp-profile-add)').first();
  if (await otherTile.isVisible().catch(() => false)) await otherTile.click();
  await session.page.evaluate(() => { localStorage.setItem('profileId', 'alex'); localStorage.setItem('profileName', 'Alex'); });
  // The viewer changes back to the first tab before opening its profile menu.
  // Comet can leave the background tab's actionability checks waiting even
  // when its DOM is ready; make this tab change an explicit user-flow step.
  await session.page.bringToFront();
  await session.page.locator('.bp-connect').click();
  await session.page.locator('#bp-sign-out').click();
  await session.page.locator('#bp-gate-email').waitFor({ state: 'visible', timeout: 10000 });
  await other.locator('#bp-gate-email').waitFor({ state: 'visible', timeout: 10000 });
  const afterLogout = await session.page.evaluate(({ deviceKey, markerKey }) => ({
    device: JSON.parse(localStorage.getItem(deviceKey) || 'null'), marker: localStorage.getItem(markerKey), profile: localStorage.getItem('profileId'), name: localStorage.getItem('profileName'),
  }), { deviceKey: DEVICE_KEY, markerKey: SIGNED_OUT_KEY });
  check(session.state.calls.filter((c) => c.path === '/accounts/logout').length === 1, 'logout: one authenticated server logout request');
  check(afterLogout.device?.id === CREDS.id && afterLogout.device?.token === 'fixture-token-v2' && afterLogout.marker === '1', 'logout: pending identity retained with rotated token and signed-out marker');
  check(!afterLogout.profile && !afterLogout.name, 'logout: profile identity cleared from browser storage');
  check(await other.locator('.bp-connect').getAttribute('data-connected') !== 'true', 'logout: other tab clears its selected profile');
  const registrations = session.state.calls.filter((c) => c.path === '/agent/register').length;
  await login(session.page);
  check(session.state.calls.filter((c) => c.path === '/agent/register').length === registrations, 'relogin: reuses browser identity without a new device');
  check(await session.page.evaluate((key) => localStorage.getItem(key), SIGNED_OUT_KEY) === null, 'relogin: successful sign-in clears signed-out marker');
  check(session.state.faults.length === 0, 'two-tab logout and relogin: no runtime faults', session.state.faults.join('; '));
  await session.context.close();

  for (const logoutMode of ['unavailable', 'offline']) {
    const fallback = await fixture(liveBrowser, 375, { seeded: true, logoutMode });
    await fallback.page.locator('#bp-sign-out').waitFor({ state: 'visible' });
    await fallback.page.locator('#bp-sign-out').click();
    await fallback.page.locator('#bp-gate-email').waitFor({ state: 'visible', timeout: 10000 });
    const note = await fallback.page.locator('.bp-status').innerText();
    const hasCreds = await fallback.page.evaluate((key) => localStorage.getItem(key), DEVICE_KEY);
    check(!hasCreds && /browser/i.test(note) && /server|device|account|connection|offline|could not|unable/i.test(note), `${logoutMode} logout: local credentials cleared and browser-only sign-out explained`, note);
    await capture(fallback.page, 375, `signout-${logoutMode}`);
    await fallback.context.close();
  }
} catch (error) {
  check(false, 'profile flow harness completed all scenarios', error.stack || String(error));
  for (const [index, page] of (liveBrowser?.contexts().flatMap((context) => context.pages()) || []).entries()) {
    if (!page.url().startsWith(base)) continue;
    await page.screenshot({ path: join(OUTPUT, `failure-tab-${index}.png`), timeout: 5000 }).catch(() => {});
  }
} finally {
  if (liveBrowser) await liveBrowser.close();
  await new Promise((done) => server.close(done));
  await writeFile(join(OUTPUT, 'report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, metrics }, null, 2));
}
const failed = checks.filter((item) => !item.pass);
console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed. Evidence: ${OUTPUT}`);
process.exitCode = failed.length ? 1 : 0;
