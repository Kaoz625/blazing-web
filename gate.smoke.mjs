// Does the GATE work, end to end, in a real browser?
//
// WHY. profile.js carried the gate's LOGIC — showGate, startPairing,
// pollPairStatus, showEmail, submitEmailLogin, showSignup, submitSignup,
// maybeShowApprover, approvePairedDevice — for a whole build before buildUi()
// created a single element they address. `node --check` passed the entire
// time: every `ui.pairCode.textContent = code` is valid syntax, and it is a
// TypeError only when it runs. So this drives each of the four ways in with a
// stubbed fleet and reads what the screen and the wire actually did.
//
// The fleet is stubbed, never called: pairing codes are single use, logins
// are 5-per-hour-per-IP, and a signup would make a real account.
//
// The stub is as strict as the contract where the contract bit us. /pair/peek
// answered 200 to ANY query here, so the app shipped asking it with only
// ?code= — and the real route makes ?deviceId= required (400 'need deviceId'),
// which meant a phone could never reach Approve. A stub that is looser than
// the server is a test that passes on a broken client.
//
// Scenarios (h)–(m) pin the review findings of 2 Sep 2026: the OLD fleet's 404
// to /pair/start, the credential repair that must reclaim before it clears,
// the empty ?pair= the help line's address arrives with, Back from the owner
// pad, the stale code on a re-entered QR sheet, and the invite button that was
// live while /profiles was in flight.
//
//   node gate.smoke.mjs
import { chromium } from '/Users/markususche/.hermes/hermes-agent/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.env.BW_DIR || '/Users/markususche/Desktop/blazing-web';
const CHROME = '/Users/markususche/Library/Caches/ms-playwright/chromium-1208/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  let p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  // /pair/<CODE> is the address the QR encodes. The site serves the app there;
  // this fixture does the same. The app's relative './x.js' then resolves under
  // /pair/, so that prefix is stripped from everything else.
  if (/^\/pair\/[A-Z2-9]{6}$/i.test(p)) p = '/index.html';
  else if (p.startsWith('/pair/')) p = p.slice('/pair'.length);
  try {
    const body = await readFile(join(ROOT, p === '/' ? 'index.html' : p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (n, pass, d = '') => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

// A 1x1 PNG, so the QR <img> the gate asks the fleet for actually loads.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// The field names are deviceId / deviceToken, flat — pinpad.smoke.mjs learned
// that the hard way.
const REGISTERED = { status: 200, body: { deviceId: 'dev-new', deviceToken: 'tok-new' } };
const ONE_PROFILE = (name) => ({ status: 200, body: { profiles: [{ id: 'p1', name, maxRating: 'adult', hasPin: false }] } });
// A fleet that does not serve /pair/* at all. Note the BODY — that is what
// separates it from STALE_DEVICE below, and the two share a status code.
const OLD_SERVER = { status: 404, body: { error: 'not found', path: '/pair/start' } };
// The OTHER 404, and it means the opposite: the route RAN and rejected this
// browser's identity. Answering it like OLD_SERVER parked an approved browser on
// the pending wall for ever while repairCredentials sat unreached in the file.
const STALE_DEVICE = { status: 404, body: { error: 'unknown device; register first' } };
const PENDING = { status: 403, body: { error: 'device enrollment is pending admin approval' } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: CHROME });

/**
 * One browser context per way in. Every https request is answered here — the
 * fleet by the scenario's `fleet(call)` table, everything else with `{}` — so
 * the run touches no live host. On localhost profile.js reads FLEET_BASE as
 * https://fleet.lyreosai.com (index.html only sets the /fleet proxy path on
 * blazingstream itself), which is why that is the host matched.
 *
 * A reply may carry `delay` (ms) to hold the answer — that is how "while the
 * request is in flight" is observed — and `fleet` may be async.
 */
async function scenario({ seed = null, path = '/index.html', fleet }) {
  const ctx = await browser.newContext();
  if (seed) {
    await ctx.addInitScript((value) => {
      localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify(value));
    }, seed);
  }
  const seen = [];
  await ctx.route(/^https:\/\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname !== 'fleet.lyreosai.com') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    let body = null;
    try { body = JSON.parse(req.postData() || 'null'); } catch { body = null; }
    const call = {
      method: req.method(), path: url.pathname, search: url.search, body,
      token: req.headers()['x-device-token'] || '',
    };
    seen.push(call);
    if (url.pathname.startsWith('/pair/qr/')) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    // The contract's rule, for every scenario: the approver must say WHICH
    // device it is (CONTRACT.md §5, /pair/peek: "?deviceId= required (400
    // 'need deviceId')"). The client shipped without it and this stub let it.
    if (url.pathname === '/pair/peek' && !url.searchParams.get('deviceId')) {
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'need deviceId' }) });
    }
    const reply = (await fleet(call)) || { status: 200, body: {} };
    if (reply.delay) await sleep(reply.delay);
    return route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  const calls = (method, p) => seen.filter((c) => c.method === method && c.path === p);
  const trail = () => seen.map((c) => `${c.method} ${c.path}`).join(', ') || 'no fleet calls';
  // The class of bug this file exists for. 404s for icons are console noise,
  // not a broken gate, so only the runtime faults count.
  const faults = () => errs.filter((e) => /is not defined|ReferenceError|TypeError/.test(e));
  return { ctx, page, seen, errs, calls, trail, faults };
}

const shown = (page, selector) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return !!el && !el.hidden && !el.closest('[hidden]');
}, selector);
const view = (page) => page.evaluate(() => (document.querySelector('.bp-layer') || {}).dataset?.view);
const status = (page) => page.evaluate(() => (document.querySelector('.bp-status') || {}).textContent || '');
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('blazing-web-profile-device-v1') || 'null'));
// A click that gives up after eight seconds instead of Playwright's thirty, and
// says so instead of throwing. On code where the step before failed, the
// target is hidden — and one thrown click would end the run before the other
// scenarios got to report. Returns false when nothing could be clicked.
// Eight, not two: at two, a run sharing the CPU with a second Chromium missed
// clicks on elements that were plainly there.
const TAP_MS = 8000;
const tap = (page, selector) => page.click(selector, { timeout: TAP_MS }).then(() => true, () => false);
const type = (page, selector, keys) => page.locator(selector).pressSequentially(keys, { timeout: TAP_MS }).then(() => true, () => false);
// The pending screen as the viewer sees it: the rail with the sentence and the
// two hatches, and no QR sheet. One reader, so (h), (h2) and (i2) agree on
// what "pending copy" means.
const pendingScreen = (page) => page.evaluate(() => {
  const vis = (el) => !!el && !el.hidden && !el.closest('[hidden]');
  const secondary = [...document.querySelectorAll('.bp-footer .bp-secondary')];
  return {
    view: document.querySelector('.bp-layer')?.dataset.view,
    rail: vis(document.querySelector('.bp-profiles')),
    qrHidden: document.getElementById('bp-qr')?.hidden,
    status: document.querySelector('.bp-status')?.textContent || '',
    owner: vis(secondary.find((b) => b.textContent === 'I am the owner')),
    invite: vis(secondary.find((b) => b.textContent === 'Enter Invite Code')),
  };
});

// ── (a) the gate, and (b) Scan QR ─────────────────────────────────────────────
{
  let statusPolls = 0;
  const s = await scenario({
    fleet: (c) => {
      if (c.path === '/agent/register') return REGISTERED;
      if (c.path === '/pair/start') return { status: 200, body: { code: 'K7M2PX', expiresAt: new Date(Date.now() + 600000).toISOString() } };
      if (c.path === '/pair/status') {
        statusPolls += 1;
        // First poll: somebody is still reaching for their phone. Second: done.
        return statusPolls === 1
          ? { status: 200, body: { state: 'waiting', code: 'K7M2PX' } }
          : { status: 200, body: { state: 'approved', accountId: 'acc_owner' } };
      }
      if (c.path === '/profiles') return ONE_PROFILE('Mark');
      return null;
    },
  });
  await s.page.waitForTimeout(1500);
  const gate = await s.page.evaluate(() => ({
    view: document.querySelector('.bp-layer')?.dataset.view,
    welcome: !document.querySelector('.bp-welcome')?.hidden,
    pills: [...document.querySelectorAll('.bp-pill')].map((b) => ({
      id: b.id, label: b.querySelector('.bp-pill-label')?.textContent, sub: b.querySelector('.bp-pill-sub')?.textContent, disabled: b.disabled,
    })),
    title: document.querySelector('.bp-gate-title')?.textContent,
    sub: document.querySelector('.bp-gate-sub')?.textContent,
    mark: !!document.querySelector('.bp-gate-mark'),
    key: !!document.querySelector('.bp-gate-key'),
    links: [...document.querySelectorAll('.bp-gate-link')].map((b) => `${b.id}${b.hidden ? '(hidden)' : ''}`),
    recheckHidden: document.getElementById('bp-gate-recheck')?.hidden,
  }));
  check('(a) the gate is the first screen, in gate view', gate.view === 'gate' && gate.welcome, `view=${gate.view} welcome=${gate.welcome}`);
  check('(a) three pills, in order Google / Scan QR / Type code',
    gate.pills.map((p) => p.id).join(',') === 'bp-pill-google,bp-pill-qr,bp-pill-code'
      && gate.pills[0].label === 'Login with Google' && gate.pills[1].label === 'Scan QR to login' && gate.pills[2].label === 'Type code to open',
    JSON.stringify(gate.pills.map((p) => p.label)));
  check('(a) Google is disabled ("Coming soon"); the other two are live',
    gate.pills[0]?.disabled === true && gate.pills[0]?.sub === 'Coming soon' && gate.pills[1]?.disabled === false && gate.pills[2]?.disabled === false);
  check('(a) door mark, key, PRIVATE CLUB and the invite-only line',
    gate.mark && gate.key && gate.title === 'Private Club' && gate.sub === 'Blazing Stream is invite only.', `${gate.title} / ${gate.sub}`);
  check('(a) links: email sign-in, I am the owner, and Check again (hidden with no credentials)',
    gate.links.join(',') === 'bp-gate-email,bp-gate-owner,bp-gate-recheck(hidden)', gate.links.join(','));
  check('(a) nothing was registered before a click', s.calls('POST', '/agent/register').length === 0, s.trail());

  await s.page.click('#bp-pill-qr');
  await s.page.waitForTimeout(1500);
  const order = s.seen.map((c) => `${c.method} ${c.path}`);
  const iReg = order.indexOf('POST /agent/register');
  const iStart = order.indexOf('POST /pair/start');
  check('(b) Scan QR registers the browser first, THEN asks for a code', iReg >= 0 && iStart > iReg, order.join(', '));
  const start = s.calls('POST', '/pair/start')[0];
  check('(b) /pair/start carries the new deviceId and its token',
    !!start && start.body?.deviceId === 'dev-new' && start.token === 'tok-new', JSON.stringify(start && { body: start.body, token: start.token }));
  const qr = await s.page.evaluate(() => ({
    sheet: !document.getElementById('bp-qr')?.hidden,
    code: document.getElementById('bp-pair-code')?.textContent, codeHidden: document.getElementById('bp-pair-code')?.hidden,
    src: document.getElementById('bp-pair-image')?.src, imgHidden: document.getElementById('bp-pair-image')?.hidden,
    imgLoaded: (document.getElementById('bp-pair-image') || {}).naturalWidth > 0,
    helpHidden: document.getElementById('bp-pair-help')?.hidden, retryHidden: document.getElementById('bp-qr-retry')?.hidden,
    view: document.querySelector('.bp-layer')?.dataset.view,
  }));
  check('(b) the code is on screen, big', qr.sheet && qr.code === 'K7M2PX' && qr.codeHidden === false && qr.view === 'gate', `code="${qr.code}"`);
  check('(b) the QR <img> is the fleet render of that code, and it loaded',
    typeof qr.src === 'string' && qr.src.endsWith('/pair/qr/K7M2PX.png') && qr.imgHidden === false && qr.imgLoaded, qr.src);
  check('(b) help line shown, Try again hidden', qr.helpHidden === false && qr.retryHidden === true);
  check('(b) status says it is waiting', /waiting/i.test(await status(s.page)), await status(s.page));

  // Two polls at 3 s each, plus the profile load that follows the second.
  await s.page.waitForTimeout(7500);
  const polls = s.calls('GET', '/pair/status');
  check('(b) /pair/status polled with the device token, every 3 s',
    polls.length >= 2 && polls.every((c) => c.token === 'tok-new' && c.search.includes('deviceId=dev-new')), `${polls.length} polls`);
  const rail = await s.page.evaluate(() => ({
    view: document.querySelector('.bp-layer')?.dataset.view,
    tile: document.querySelector('.bp-profile')?.textContent || '',
    qrHidden: document.getElementById('bp-qr')?.hidden,
    profilesShown: !document.querySelector('.bp-profiles')?.hidden,
  }));
  check('(b) approved → GET /profiles → the normal profile rail',
    s.calls('GET', '/profiles').length >= 1 && rail.view === '' && rail.profilesShown && rail.qrHidden === true && /Mark/.test(rail.tile),
    JSON.stringify(rail));
  // The poll must STOP once approved: a late poll from the rail would be a
  // request nobody asked for.
  const pollsBefore = s.calls('GET', '/pair/status').length;
  await s.page.waitForTimeout(3500);
  check('(b) polling stopped after approval', s.calls('GET', '/pair/status').length === pollsBefore);
  check('(a,b) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.page.screenshot({ path: process.env.SHOT || '/tmp/gate-b.png' });
  await s.ctx.close();
}

// ── (c) Type code → not a household invite → an ACCOUNT invite → sign up ─────
{
  const s = await scenario({
    fleet: (c) => {
      if (c.path === '/agent/register') return REGISTERED;
      if (c.path === '/devices/join') return { status: 404, body: { error: 'unknown code' } };
      if (c.path === '/accounts/invite/check') {
        const code = new URLSearchParams(c.search).get('code');
        if (code === 'HJK234') return { status: 200, body: { valid: true, name: 'Ana', email: null } };
        if (code === 'USED22') return { status: 410, body: { error: 'code used' } };
        return { status: 404, body: { error: 'unknown code' } };
      }
      if (c.path === '/accounts/register') return { status: 200, body: { ok: true, account: { id: 'acc_1', email: 'ana@example.test', name: 'Ana' } } };
      if (c.path === '/profiles') return { status: 200, body: { profiles: [] } };
      return null;
    },
  });
  await s.page.waitForTimeout(1200);
  await s.page.click('#bp-pill-code');
  await s.page.waitForTimeout(400);
  check('(c) Type code opens the invite box, still in gate view', (await shown(s.page, '.bp-invite')) && (await view(s.page)) === 'gate');

  const tryCode = async (code) => {
    await s.page.fill('.bp-invite-input', code);
    await s.page.click('.bp-invite .bp-verify');
    await s.page.waitForTimeout(1200);
    return status(s.page);
  };
  const used = await tryCode('USED22');
  check('(c) a used/expired account invite says so', /expired or has already been used/.test(used), used);
  const unknown = await tryCode('ZZZZZZ');
  check('(c) a code neither side knows is "not recognized"', /not recognized/.test(unknown) && !(await shown(s.page, '#bp-signup')), unknown);

  await tryCode('HJK234');
  const join = s.calls('POST', '/devices/join').find((c) => c.body?.code === 'HJK234');
  const invite = s.calls('GET', '/accounts/invite/check').find((c) => c.search.includes('code=HJK234'));
  check('(c) /devices/join 404 → GET /accounts/invite/check?code=HJK234',
    !!join && join.body?.deviceId === 'dev-new' && !!invite, s.trail());
  const signup = await s.page.evaluate(() => ({
    shown: !document.getElementById('bp-signup')?.hidden,
    name: document.getElementById('bp-signup-name')?.value,
    inviteHidden: document.querySelector('.bp-invite')?.hidden,
    view: document.querySelector('.bp-layer')?.dataset.view,
  }));
  check('(c) the signup sheet opens with the invite\'s name filled in', signup.shown && signup.name === 'Ana' && signup.inviteHidden === true && signup.view === 'gate', JSON.stringify(signup));

  await s.page.fill('#bp-signup-email', 'Ana@Example.test');
  await s.page.fill('#bp-signup-password', 'short');
  await s.page.click('#bp-signup-submit');
  await s.page.waitForTimeout(300);
  check('(c) a short password is refused before any request', /at least 8/.test(await status(s.page)) && s.calls('POST', '/accounts/register').length === 0, await status(s.page));

  await s.page.fill('#bp-signup-password', 'longenough1');
  await s.page.press('#bp-signup-password', 'Enter');
  await s.page.waitForTimeout(1500);
  const reg = s.calls('POST', '/accounts/register')[0];
  const want = { code: 'HJK234', email: 'ana@example.test', password: 'longenough1', name: 'Ana', deviceId: 'dev-new' };
  check('(c) Enter → POST /accounts/register {code, email (lower-cased), password, name, deviceId}',
    !!reg && JSON.stringify(reg.body) === JSON.stringify(want), JSON.stringify(reg && reg.body));
  check('(c) then GET /profiles and the rail (empty, ready for Add profile)',
    s.calls('GET', '/profiles').length >= 1 && (await view(s.page)) === '' && (await shown(s.page, '.bp-profiles')) && !(await shown(s.page, '#bp-signup')));
  check('(c) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.ctx.close();
}

// ── (d) Have an email login? Sign in ─────────────────────────────────────────
{
  const s = await scenario({
    fleet: (c) => {
      if (c.path === '/agent/register') return REGISTERED;
      if (c.path === '/accounts/login') {
        return c.body?.password === 'right-one'
          ? { status: 200, body: { ok: true, account: { id: 'acc_1', email: 'ana@example.test', name: 'Ana' } } }
          : { status: 401, body: { error: 'invalid email or password' } };
      }
      if (c.path === '/profiles') return ONE_PROFILE('Ana');
      return null;
    },
  });
  await s.page.waitForTimeout(1200);
  await s.page.click('#bp-gate-email');
  await s.page.waitForTimeout(400);
  check('(d) the email sheet opens, in gate view', (await shown(s.page, '#bp-email')) && (await view(s.page)) === 'gate');
  const inputs = await s.page.evaluate(() => ({
    address: [document.getElementById('bp-email-address')?.type, document.getElementById('bp-email-address')?.autocomplete].join('/'),
    password: [document.getElementById('bp-email-password')?.type, document.getElementById('bp-email-password')?.autocomplete].join('/'),
  }));
  check('(d) inputs are email/username and password/current-password', inputs.address === 'email/username' && inputs.password === 'password/current-password', JSON.stringify(inputs));

  await s.page.fill('#bp-email-address', 'Ana@Example.test');
  await s.page.fill('#bp-email-password', 'wrong-one');
  await s.page.click('#bp-email-submit');
  await s.page.waitForTimeout(1200);
  const first = s.calls('POST', '/accounts/login')[0];
  check('(d) POST /accounts/login {email lower-cased, password, deviceId} — after registering',
    !!first && first.body?.email === 'ana@example.test' && first.body?.password === 'wrong-one' && first.body?.deviceId === 'dev-new'
      && s.calls('POST', '/agent/register').length === 1, JSON.stringify(first && first.body));
  const refused = await status(s.page);
  check('(d) 401 says "not right" and stays on the sheet', /not right/.test(refused) && (await shown(s.page, '#bp-email')), refused);

  await s.page.fill('#bp-email-password', 'right-one');
  await s.page.press('#bp-email-password', 'Enter');
  await s.page.waitForTimeout(1500);
  const rail = await s.page.evaluate(() => ({
    view: document.querySelector('.bp-layer')?.dataset.view,
    tile: document.querySelector('.bp-profile')?.textContent || '',
    emailHidden: document.getElementById('bp-email')?.hidden,
    passwordCleared: document.getElementById('bp-email-password')?.value === '',
  }));
  check('(d) Enter in the password submits; 200 → GET /profiles → the rail',
    s.calls('POST', '/accounts/login').length === 2 && s.calls('GET', '/profiles').length >= 1 && rail.view === '' && /Ana/.test(rail.tile) && rail.emailHidden === true,
    JSON.stringify(rail));
  check('(d) the password field is emptied after a successful sign-in', rail.passwordCleared);
  check('(d) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.ctx.close();
}

// ── (e) the APPROVER: ?pair=CODE on a browser that is already in ─────────────
{
  const s = await scenario({
    seed: { id: 'dev-1', token: 'tok' },
    path: '/index.html?pair=K7M2PX',
    fleet: (c) => {
      if (c.path === '/profiles') return ONE_PROFILE('Mark');
      if (c.path === '/pair/peek') return { status: 200, body: { model: 'Blazing Web', label: 'Blazing Web', requestedAt: new Date().toISOString() } };
      if (c.path === '/pair/approve') return { status: 200, body: { ok: true, pairedDeviceId: 'dev-9' } };
      return null;
    },
  });
  await s.page.waitForTimeout(1500);
  check('(e) a browser with credentials lands on the rail — the approver waits for a profile',
    (await view(s.page)) === '' && (await shown(s.page, '.bp-profile')) && !(await shown(s.page, '#bp-approve')) && s.calls('GET', '/pair/peek').length === 0, s.trail());

  await s.page.click('.bp-profile');
  await s.page.waitForTimeout(1200);
  const peek = s.calls('GET', '/pair/peek')[0];
  check('(e) picking a profile asks GET /pair/peek?code=K7M2PX with this browser\'s token',
    !!peek && peek.search.includes('code=K7M2PX') && peek.token === 'tok', JSON.stringify(peek && { search: peek.search, token: peek.token }));
  // The BLOCKER of 2 Sep: without this the real route answers 400 and the
  // approver never renders Approve. The stub now answers the same.
  check('(e) the peek says WHICH device is approving: ?deviceId=dev-1',
    !!peek && new URLSearchParams(peek.search).get('deviceId') === 'dev-1', peek && peek.search);
  const sheet = await s.page.evaluate(() => ({
    layerHidden: document.querySelector('.bp-layer')?.hidden,
    shown: !document.getElementById('bp-approve')?.hidden,
    question: document.getElementById('bp-approve-question')?.textContent,
    actionsHidden: document.getElementById('bp-approve-actions')?.hidden,
    view: document.querySelector('.bp-layer')?.dataset.view,
  }));
  check('(e) the sheet asks "Approve Blazing Web as a device on your account?" with Approve / Not now',
    sheet.layerHidden === false && sheet.shown && sheet.question === 'Approve Blazing Web as a device on your account?' && sheet.actionsHidden === false && sheet.view === 'gate',
    JSON.stringify(sheet));

  await tap(s.page, '#bp-approve-yes');
  await s.page.waitForTimeout(800);
  const approve = s.calls('POST', '/pair/approve')[0];
  check('(e) Approve → POST /pair/approve {code:"K7M2PX", deviceId:"dev-1"} with the token',
    !!approve && approve.body?.code === 'K7M2PX' && approve.body?.deviceId === 'dev-1' && approve.token === 'tok', JSON.stringify(approve && approve.body));
  const after = await s.page.evaluate(() => ({
    question: document.getElementById('bp-approve-question')?.textContent,
    actionsHidden: document.getElementById('bp-approve-actions')?.hidden,
    url: location.search,
  }));
  check('(e) confirmation shown, buttons gone, ?pair= dropped from the address',
    /now on your account/.test(after.question || '') && after.actionsHidden === true && !after.url.includes('pair='), JSON.stringify(after));

  await s.page.click('#bp-approve-back');
  await s.page.waitForTimeout(300);
  check('(e) Back closes the sheet and returns to the app (a profile is active)',
    (await s.page.evaluate(() => document.querySelector('.bp-layer')?.hidden)) === true);
  check('(e) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.ctx.close();
}

// ── (g) Back from the QR sheet: the poll stops, and Check again appears ──────
{
  const s = await scenario({
    fleet: (c) => {
      if (c.path === '/agent/register') return REGISTERED;
      if (c.path === '/pair/start') return { status: 200, body: { code: 'K7M2PX', expiresAt: new Date(Date.now() + 600000).toISOString() } };
      if (c.path === '/pair/status') return { status: 200, body: { state: 'waiting', code: 'K7M2PX' } };
      return null;
    },
  });
  await s.page.waitForTimeout(1200);
  await s.page.click('#bp-pill-qr');
  await s.page.waitForTimeout(1000);
  await s.page.click('#bp-qr-back');
  await s.page.waitForTimeout(300);
  const back = await s.page.evaluate(() => ({
    welcome: !document.querySelector('.bp-welcome')?.hidden,
    qrHidden: document.getElementById('bp-qr')?.hidden,
    recheckHidden: document.getElementById('bp-gate-recheck')?.hidden,
  }));
  check('(g) Back returns to the gate, and "Check again" is now offered (credentials exist)',
    back.welcome && back.qrHidden === true && back.recheckHidden === false, JSON.stringify(back));
  const pollsAtBack = s.calls('GET', '/pair/status').length;
  await s.page.waitForTimeout(3500);
  check('(g) leaving the QR sheet stopped the poll', s.calls('GET', '/pair/status').length === pollsAtBack, `${pollsAtBack} → ${s.calls('GET', '/pair/status').length}`);
  check('(g) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.ctx.close();
}

// ── (h) the OLD SERVER: /pair/start is a 404 on fleet.lyreosai.com today ──────
// CONTRACT-TV §2 step 5. Roku and Fire TV fall back to their pending screen;
// the web showed "Could not get a pairing code" and a Try again that could
// only ask the same absent route.
{
  const s = await scenario({
    fleet: (c) => {
      if (c.path === '/agent/register') return { status: 200, body: { deviceId: '0f3a9c2e-7b1d-4e88-9a1f-abcdef012345', deviceToken: 'tok-old' } };
      if (c.path === '/pair/start') return OLD_SERVER;
      if (c.path === '/profiles') return PENDING;
      return null;
    },
  });
  await s.page.waitForTimeout(1200);
  await tap(s.page, '#bp-pill-qr');
  await s.page.waitForTimeout(1200);
  const pend = await pendingScreen(s.page);
  check('(h) 404 on /pair/start → the EXISTING pending copy: rail, "waiting for approval", QR sheet gone',
    pend.view === '' && pend.rail && pend.qrHidden === true && /waiting for approval/i.test(pend.status), JSON.stringify(pend));
  check('(h) the sentence carries the first 8 characters of the deviceId', pend.status.includes('0f3a9c2e') && !pend.status.includes('0f3a9c2e-'), pend.status);
  check('(h) the owner and invite hatches are offered', pend.owner && pend.invite, JSON.stringify({ owner: pend.owner, invite: pend.invite }));
  const codeHidden = await s.page.evaluate(() => document.getElementById('bp-pair-code')?.hidden && document.getElementById('bp-pair-image')?.hidden);
  check('(h) no code and no QR are shown', codeHidden === true);
  await s.page.waitForTimeout(3500);
  check('(h) and NO polling: zero GET /pair/status', s.calls('GET', '/pair/status').length === 0, s.trail());
  // The hatches are live, not decoration.
  await tap(s.page, '.bp-footer .bp-secondary:has-text("Enter Invite Code")');
  await s.page.waitForTimeout(300);
  check('(h) Enter Invite Code from there opens the invite box', await shown(s.page, '.bp-invite'));
  check('(h) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.ctx.close();
}

// ── (h2) a fleet that has /pair/start but answers 404 to /pair/status ─────────
{
  const s = await scenario({
    fleet: (c) => {
      if (c.path === '/agent/register') return REGISTERED;
      if (c.path === '/pair/start') return { status: 200, body: { code: 'K7M2PX', expiresAt: new Date(Date.now() + 600000).toISOString() } };
      if (c.path === '/pair/status') return OLD_SERVER;
      return null;
    },
  });
  await s.page.waitForTimeout(1200);
  await tap(s.page, '#bp-pill-qr');
  await s.page.waitForTimeout(1000);
  check('(h2) the code came up first', (await s.page.evaluate(() => document.getElementById('bp-pair-code')?.textContent)) === 'K7M2PX');
  await s.page.waitForTimeout(3200);
  const pend = await pendingScreen(s.page);
  check('(h2) 404 on /pair/status → the pending copy, QR sheet gone',
    s.calls('GET', '/pair/status').length === 1 && pend.view === '' && pend.rail && pend.qrHidden === true && /waiting for approval/i.test(pend.status) && pend.owner && pend.invite,
    JSON.stringify(pend));
  await s.page.waitForTimeout(3500);
  check('(h2) and the poll stopped', s.calls('GET', '/pair/status').length === 1, `${s.calls('GET', '/pair/status').length} polls`);
  check('(h2) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.ctx.close();
}

// ── (h3) 404 'unknown device' from /pair/start is a STALE IDENTITY, not an old fleet ──
// The two 404s share a status code and mean the opposite. oldServer() used to read
// only the status, so this landed on the pending wall — on a fleet that pairs
// perfectly, with the blame on the server, while repairCredentials() (which reclaims
// the id + token before it will clear anything) was never called.
//
// No seed and no /profiles handler, exactly like (h2): a seeded identity plus a 403
// from /profiles puts the pending wall up before the QR pill exists, and then the
// tap does nothing and /pair/start is never reached at all.
{
  let starts = 0;
  let regs = 0;
  const s = await scenario({
    fleet: (c) => {
      if (c.path === '/agent/register') {
        regs += 1;
        // First: the enrolment. Second: the reclaim, which echoes the id back and
        // sends NO deviceToken — exactly what the real server does (see (i)).
        return regs === 1 ? REGISTERED : { status: 200, body: { deviceId: 'dev-new' } };
      }
      if (c.path === '/pair/start') {
        starts += 1;
        return starts === 1
          ? STALE_DEVICE
          : { status: 200, body: { code: 'K7M2PX', expiresAt: new Date(Date.now() + 600000).toISOString() } };
      }
      if (c.path === '/pair/status') return { status: 200, body: { state: 'waiting', code: 'K7M2PX' } };
      return null;
    },
  });
  await s.page.waitForTimeout(1200);
  await tap(s.page, '#bp-pill-qr');
  await s.page.waitForTimeout(3000);
  const calls = s.calls('POST', '/agent/register');
  check('(h3) it RECLAIMED — a second register carrying deviceId dev-new and its token',
    calls.length === 2 && calls[1].body?.deviceId === 'dev-new' && calls[1].token === 'tok-new',
    JSON.stringify(calls.map((r) => ({ deviceId: r.body?.deviceId, token: r.token }))));
  const kept3 = await stored(s.page);
  check('(h3) the identity was KEPT, not replaced', kept3?.id === 'dev-new' && kept3?.token === 'tok-new', JSON.stringify(kept3));
  const code3 = await s.page.evaluate(() => document.getElementById('bp-pair-code')?.textContent);
  check('(h3) /pair/start was asked twice and the SECOND answer produced a real code',
    s.calls('POST', '/pair/start').length === 2 && code3 === 'K7M2PX',
    `${s.calls('POST', '/pair/start').length} starts, code=${code3}`);
  const pend = await pendingScreen(s.page);
  check('(h3) and NOT the pending wall — the QR sheet is up', pend.qrHidden === false, JSON.stringify(pend));
  check('(h3) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.ctx.close();
}

// ── (h4) the same 404 mid-poll restarts pairing ONCE, then stops ──────────────
// The poll runs on a 3 s interval holding the old credentials in its closure, so a
// repaired identity could never reach it — it restarts the flow instead. And it does
// that exactly once: state.pairRepaired, the same doctrine as pairRestarted, because
// a repair that does not stick must not become a page minting codes on a timer.
{
  let starts = 0;
  let regs = 0;
  const s = await scenario({
    fleet: (c) => {
      if (c.path === '/agent/register') {
        regs += 1;
        return regs === 1 ? REGISTERED : { status: 200, body: { deviceId: 'dev-new' } };
      }
      if (c.path === '/pair/start') {
        starts += 1;
        return { status: 200, body: { code: starts === 1 ? 'AAA222' : 'BBB333', expiresAt: new Date(Date.now() + 600000).toISOString() } };
      }
      if (c.path === '/pair/status') return STALE_DEVICE;   // stale, every time
      return null;
    },
  });
  await s.page.waitForTimeout(1200);
  await tap(s.page, '#bp-pill-qr');
  await s.page.waitForTimeout(1200);
  check('(h4) the first code came up',
    (await s.page.evaluate(() => document.getElementById('bp-pair-code')?.textContent)) === 'AAA222',
    `code=${await s.page.evaluate(() => document.getElementById('bp-pair-code')?.textContent)} starts=${s.calls('POST', '/pair/start').length}`);
  await s.page.waitForTimeout(5000);
  const code4 = await s.page.evaluate(() => document.getElementById('bp-pair-code')?.textContent);
  check('(h4) the stale poll restarted pairing — a SECOND code, not the pending wall',
    s.calls('POST', '/pair/start').length === 2 && code4 === 'BBB333',
    `${s.calls('POST', '/pair/start').length} starts, code=${code4}`);
  await s.page.waitForTimeout(6000);
  check('(h4) and it restarted ONCE — the second stale answer gives up instead of looping',
    s.calls('POST', '/pair/start').length === 2,
    `${s.calls('POST', '/pair/start').length} starts, ${s.calls('GET', '/pair/status').length} polls`);
  check('(h4) the retry hatch is offered',
    await s.page.evaluate(() => document.getElementById('bp-qr-retry')?.hidden === false),
    await s.page.evaluate(() => document.querySelector('.bp-status')?.textContent));
  check('(h4) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.ctx.close();
}

// ── (i) credential repair RECLAIMS before it clears ───────────────────────────
// A 401 on /profiles used to clear the stored identity and register a brand-new
// pending one — the tvOS 7142fd5 orphan bug. The reclaim carries the existing
// deviceId in the body and the token in X-Device-Token; a 2xx echoing the id
// (and, as the server does, NO deviceToken) keeps the identity.
{
  let profileCalls = 0;
  const s = await scenario({
    seed: { id: 'dev-1', token: 'tok' },
    fleet: (c) => {
      if (c.path === '/agent/register') {
        if (c.body?.deviceId === 'dev-1' && c.token === 'tok') return { status: 200, body: { ok: true, deviceId: 'dev-1', tokenProtected: true, approved: true } };
        return REGISTERED;
      }
      if (c.path === '/profiles') {
        profileCalls += 1;
        if (profileCalls === 1) return { status: 401, body: { error: 'device token required' } };
        return c.search.includes('deviceId=dev-1') && c.token === 'tok' ? ONE_PROFILE('Mark') : { status: 401, body: { error: 'wrong device' } };
      }
      return null;
    },
  });
  await s.page.waitForTimeout(2000);
  const regs = s.calls('POST', '/agent/register');
  check('(i) 401 on /profiles → ONE POST /agent/register, carrying deviceId dev-1 in the body and tok in X-Device-Token',
    regs.length === 1 && regs[0].body?.deviceId === 'dev-1' && regs[0].token === 'tok', JSON.stringify(regs.map((r) => ({ body: r.body, token: r.token }))));
  const lists = s.calls('GET', '/profiles');
  check('(i) the 200 echoing the id KEEPS the identity: /profiles retried as dev-1 with the same token',
    lists.length === 2 && lists[1].search.includes('deviceId=dev-1') && lists[1].token === 'tok', lists.map((l) => `${l.search} ${l.token}`).join(' | '));
  const kept = await stored(s.page);
  check('(i) localStorage still holds dev-1 / tok', kept?.id === 'dev-1' && kept?.token === 'tok', JSON.stringify(kept));
  check('(i) and the rail is up', (await view(s.page)) === '' && /Mark/.test(await s.page.evaluate(() => document.querySelector('.bp-profile')?.textContent || '')));
  check('(i) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.ctx.close();
}

// ── (i2) …and clears ONLY when the fleet refuses the reclaim ──────────────────
{
  const s = await scenario({
    seed: { id: 'dev-1', token: 'tok' },
    fleet: (c) => {
      if (c.path === '/agent/register') {
        if (c.body?.deviceId) return { status: 401, body: { error: 'existing device requires X-Device-Token' } };
        return REGISTERED;
      }
      if (c.path === '/profiles') return c.search.includes('deviceId=dev-new') ? PENDING : { status: 401, body: { error: 'device token required' } };
      return null;
    },
  });
  await s.page.waitForTimeout(2000);
  const regs = s.calls('POST', '/agent/register');
  check('(i2) refused reclaim (401) → a second, FRESH registration with no deviceId and no token',
    regs.length === 2 && regs[0].body?.deviceId === 'dev-1' && regs[0].token === 'tok' && regs[1].body?.deviceId === undefined && regs[1].token === '',
    JSON.stringify(regs.map((r) => ({ body: r.body, token: r.token }))));
  const kept = await stored(s.page);
  check('(i2) localStorage now holds the fresh identity', kept?.id === 'dev-new' && kept?.token === 'tok-new', JSON.stringify(kept));
  const pend = await pendingScreen(s.page);
  check('(i2) the fresh identity is pending, and the screen says so with its first 8 characters',
    /waiting for approval/i.test(pend.status) && pend.status.includes('dev-new') && pend.owner && pend.invite, pend.status);
  check('(i2) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.ctx.close();
}

// ── (j) the help line's address: /pair → /app/?pair= with an EMPTY value ──────
// The approver read only a non-empty ?pair=, so the address the QR sheet
// tells a phone to open asked nothing. Now it offers a six-character box.
{
  const s = await scenario({
    seed: { id: 'dev-1', token: 'tok' },
    path: '/index.html?pair=',
    fleet: (c) => {
      if (c.path === '/profiles') return ONE_PROFILE('Mark');
      if (c.path === '/pair/peek') {
        const code = new URLSearchParams(c.search).get('code');
        return code === 'K7M2PX'
          ? { status: 200, body: { model: 'Roku Ultra', label: 'Living room', requestedAt: new Date().toISOString() } }
          : { status: 404, body: { error: 'unknown code' } };
      }
      if (c.path === '/pair/approve') return { status: 200, body: { ok: true, pairedDeviceId: 'dev-9' } };
      return null;
    },
  });
  await s.page.waitForTimeout(1500);
  await tap(s.page, '.bp-profile');
  await s.page.waitForTimeout(600);
  const box = await s.page.evaluate(() => ({
    sheet: !document.getElementById('bp-approve')?.hidden,
    input: !document.getElementById('bp-approve-input')?.hidden,
    actionsHidden: document.getElementById('bp-approve-actions')?.hidden,
    focused: document.activeElement?.id,
    view: document.querySelector('.bp-layer')?.dataset.view,
  }));
  check('(j) an empty ?pair= opens the approver with the code box, no question yet, nothing peeked',
    box.sheet && box.input && box.actionsHidden === true && box.view === 'gate' && s.calls('GET', '/pair/peek').length === 0, JSON.stringify(box) + ' ' + s.trail());
  check('(j) the box has focus', box.focused === 'bp-approve-input', box.focused);

  // A typo first. The box stays, emptied, so it can be fixed.
  await type(s.page, '#bp-approve-input', 'zzzzzz');
  await s.page.waitForTimeout(800);
  const typo = await s.page.evaluate(() => ({ input: !document.getElementById('bp-approve-input')?.hidden, value: document.getElementById('bp-approve-input')?.value }));
  check('(j) six characters peek at once (no button); a 404 says so and keeps the box, emptied',
    s.calls('GET', '/pair/peek').length === 1 && /No device is waiting/.test(await status(s.page)) && typo.input && typo.value === '', JSON.stringify(typo));

  // Lower case and a character outside A-Z 2-9 ("1"): the box fixes both.
  await type(s.page, '#bp-approve-input', 'k7m2p1x');
  await s.page.waitForTimeout(800);
  const peek = s.calls('GET', '/pair/peek')[1];
  check('(j) typed k7m2p1x → GET /pair/peek?code=K7M2PX&deviceId=dev-1 (upper-cased, "1" dropped)',
    !!peek && new URLSearchParams(peek.search).get('code') === 'K7M2PX' && new URLSearchParams(peek.search).get('deviceId') === 'dev-1' && peek.token === 'tok',
    peek && peek.search);
  const asked = await s.page.evaluate(() => ({
    question: document.getElementById('bp-approve-question')?.textContent,
    actionsHidden: document.getElementById('bp-approve-actions')?.hidden,
    inputHidden: document.getElementById('bp-approve-input')?.hidden,
  }));
  check('(j) the sheet asks about the device the fleet named, box gone',
    asked.question === 'Approve Roku Ultra as a device on your account?' && asked.actionsHidden === false && asked.inputHidden === true, JSON.stringify(asked));
  await tap(s.page, '#bp-approve-yes');
  await s.page.waitForTimeout(800);
  const approve = s.calls('POST', '/pair/approve')[0];
  check('(j) Approve → POST /pair/approve {code:"K7M2PX", deviceId:"dev-1"}',
    !!approve && approve.body?.code === 'K7M2PX' && approve.body?.deviceId === 'dev-1' && approve.token === 'tok', JSON.stringify(approve && approve.body));
  check('(j) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.ctx.close();
}

// ── (j2) belt and braces: the code in the PATH, /pair/K7M2PX ──────────────────
{
  const s = await scenario({
    seed: { id: 'dev-1', token: 'tok' },
    path: '/pair/K7M2PX',
    fleet: (c) => {
      if (c.path === '/profiles') return ONE_PROFILE('Mark');
      if (c.path === '/pair/peek') return { status: 200, body: { model: 'Blazing Web', label: 'Blazing Web', requestedAt: new Date().toISOString() } };
      return null;
    },
  });
  await s.page.waitForTimeout(1500);
  check('(j2) the app came up at /pair/K7M2PX (the fixture serves it there, as the site does)', (await shown(s.page, '.bp-profile')), s.trail());
  await tap(s.page, '.bp-profile');
  await s.page.waitForTimeout(1000);
  const peek = s.calls('GET', '/pair/peek')[0];
  check('(j2) the code is read from the path → GET /pair/peek?code=K7M2PX&deviceId=dev-1',
    !!peek && new URLSearchParams(peek.search).get('code') === 'K7M2PX' && new URLSearchParams(peek.search).get('deviceId') === 'dev-1', peek && peek.search);
  check('(j2) and the question is asked', (await s.page.evaluate(() => document.getElementById('bp-approve-question')?.textContent)) === 'Approve Blazing Web as a device on your account?');
  check('(j2) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.ctx.close();
}

// ── (k) Gate → "I am the owner" → Back returns to the GATE ────────────────────
// It called showProfiles(): an empty rail, no owner or invite hatch (those are
// unhidden only by a 403 from /profiles), and the gate gone. Stranded.
{
  const s = await scenario({
    fleet: (c) => {
      if (c.path === '/agent/register') return REGISTERED;
      return null;
    },
  });
  await s.page.waitForTimeout(1200);
  await tap(s.page, '#bp-gate-owner');
  await s.page.waitForTimeout(1000);
  const pad = await s.page.evaluate(() => ({
    pin: !document.querySelector('.bp-pin')?.hidden,
    // Scoped to .bp-pin: the invite sheet's top row wears .bp-pin-top too.
    title: document.querySelector('.bp-pin .bp-pin-top strong')?.textContent,
    back: document.querySelector('.bp-pin .bp-back')?.textContent,
    view: document.querySelector('.bp-layer')?.dataset.view,
    dots: document.querySelectorAll('.bp-dot').length,
  }));
  check('(k) the owner pad opens from the gate, in gate view, seven slots', pad.pin && pad.title === 'Owner PIN' && pad.view === 'gate' && pad.dots === 7, JSON.stringify(pad));
  check('(k) its Back says "Back", not "Choose another profile" — there are none to choose', pad.back === 'Back', pad.back);
  await tap(s.page, '.bp-pin .bp-back');
  await s.page.waitForTimeout(300);
  const back = await s.page.evaluate(() => ({
    welcome: !document.querySelector('.bp-welcome')?.hidden,
    pinHidden: document.querySelector('.bp-pin')?.hidden,
    profilesHidden: document.querySelector('.bp-profiles')?.hidden,
    view: document.querySelector('.bp-layer')?.dataset.view,
    pills: [...document.querySelectorAll('.bp-pill')].filter((b) => !b.closest('[hidden]')).length,
  }));
  check('(k) Back from the owner pad returns to the GATE — three pills, no empty rail',
    back.welcome && back.pinHidden === true && back.profilesHidden === true && back.view === 'gate' && back.pills === 3, JSON.stringify(back));
  // And the pad can be opened again — the mode was really left.
  await tap(s.page, '#bp-gate-owner');
  await s.page.waitForTimeout(600);
  check('(k) I am the owner works a second time, without registering again',
    (await shown(s.page, '.bp-pin')) && s.calls('POST', '/agent/register').length === 1, s.trail());
  check('(k) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.ctx.close();
}

// ── (l) a re-entered QR sheet shows no stale code ─────────────────────────────
// Verified in a browser before the fix: AAA111 stayed on screen until BBB222
// arrived. A phone that scanned in that window scanned a retired code.
{
  let starts = 0;
  const s = await scenario({
    fleet: (c) => {
      if (c.path === '/agent/register') return REGISTERED;
      if (c.path === '/pair/start') {
        starts += 1;
        return starts === 1
          ? { status: 200, body: { code: 'AAA222', expiresAt: new Date(Date.now() + 600000).toISOString() } }
          : { status: 200, delay: 1500, body: { code: 'BBB333', expiresAt: new Date(Date.now() + 600000).toISOString() } };
      }
      if (c.path === '/pair/status') return { status: 200, body: { state: 'waiting' } };
      return null;
    },
  });
  await s.page.waitForTimeout(1200);
  await tap(s.page, '#bp-pill-qr');
  await s.page.waitForTimeout(1000);
  check('(l) first entry shows AAA222', (await s.page.evaluate(() => document.getElementById('bp-pair-code')?.textContent)) === 'AAA222');
  await tap(s.page, '#bp-qr-back');
  await s.page.waitForTimeout(300);
  await tap(s.page, '#bp-pill-qr');
  await s.page.waitForTimeout(200);
  const during = await s.page.evaluate(() => ({
    codeHidden: document.getElementById('bp-pair-code')?.hidden, code: document.getElementById('bp-pair-code')?.textContent,
    imgHidden: document.getElementById('bp-pair-image')?.hidden, src: document.getElementById('bp-pair-image')?.getAttribute('src'),
    helpHidden: document.getElementById('bp-pair-help')?.hidden, retryHidden: document.getElementById('bp-qr-retry')?.hidden,
    status: document.querySelector('.bp-status')?.textContent,
  }));
  check('(l) while the new code is fetched: no code, no QR, no help, no retry — "Getting a code…"',
    during.codeHidden === true && during.code === '' && during.imgHidden === true && !during.src && during.helpHidden === true && during.retryHidden === true && /Getting a code/.test(during.status || ''),
    JSON.stringify(during));
  await s.page.waitForTimeout(2200);
  const after = await s.page.evaluate(() => ({ code: document.getElementById('bp-pair-code')?.textContent, src: document.getElementById('bp-pair-image')?.src, hidden: document.getElementById('bp-pair-code')?.hidden }));
  check('(l) then BBB333 and its QR', after.code === 'BBB333' && after.hidden === false && /\/pair\/qr\/BBB333\.png$/.test(after.src || ''), JSON.stringify(after));
  check('(l) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.ctx.close();
}

// ── (m) "Enter Invite Code" is not live while /profiles is in flight ──────────
// It fell out of BUSY_CONTROLS in the gate rewrite, and showInvite() had no
// busy guard: the box it opened was torn down when the request answered.
{
  let lists = 0;
  const s = await scenario({
    seed: { id: 'dev-1', token: 'tok' },
    fleet: (c) => {
      if (c.path === '/profiles') {
        lists += 1;
        // First: the pending screen, which is where the button lives. Second
        // (Refresh): held for two seconds so "in flight" can be looked at.
        return lists === 1 ? PENDING : { ...PENDING, delay: 2000 };
      }
      return null;
    },
  });
  await s.page.waitForTimeout(1500);
  check('(m) the pending screen offers Enter Invite Code, enabled',
    await s.page.evaluate(() => { const b = [...document.querySelectorAll('.bp-footer .bp-secondary')].find((x) => x.textContent === 'Enter Invite Code'); return !!b && !b.hidden && !b.disabled; }));
  await tap(s.page, '.bp-footer .bp-refresh');
  await s.page.waitForTimeout(400);
  const busy = await s.page.evaluate(() => {
    const b = [...document.querySelectorAll('.bp-footer .bp-secondary')].find((x) => x.textContent === 'Enter Invite Code');
    // A synthetic click is what a listener sees from a button that was not
    // disabled. If the guard holds, the invite box stays shut either way.
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { disabled: b.disabled, inviteShown: !document.querySelector('.bp-invite')?.hidden, refreshDisabled: document.querySelector('.bp-footer .bp-refresh')?.disabled };
  });
  check('(m) while /profiles is in flight the button is disabled, like Refresh beside it', busy.disabled === true && busy.refreshDisabled === true, JSON.stringify(busy));
  check('(m) and a click that gets through anyway opens nothing', busy.inviteShown === false, JSON.stringify(busy));
  await s.page.waitForTimeout(2200);
  check('(m) once the answer lands the button is live again', await s.page.evaluate(() => {
    const b = [...document.querySelectorAll('.bp-footer .bp-secondary')].find((x) => x.textContent === 'Enter Invite Code'); return !!b && !b.hidden && !b.disabled;
  }));
  check('(m) no ReferenceError/TypeError', s.faults().length === 0, s.faults().slice(0, 2).join(' | '));
  await s.ctx.close();
}

await browser.close(); server.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
