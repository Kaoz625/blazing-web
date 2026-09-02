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
//   node gate.smoke.mjs
import { chromium } from '/Users/markususche/.hermes/hermes-agent/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.env.BW_DIR || '/Users/markususche/Desktop/blazing-web';
const CHROME = '/Users/markususche/Library/Caches/ms-playwright/chromium-1208/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
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

const results = [];
const check = (n, pass, d = '') => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

// A 1x1 PNG, so the QR <img> the gate asks the fleet for actually loads.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// The field names are deviceId / deviceToken, flat — pinpad.smoke.mjs learned
// that the hard way.
const REGISTERED = { status: 200, body: { deviceId: 'dev-new', deviceToken: 'tok-new' } };
const ONE_PROFILE = (name) => ({ status: 200, body: { profiles: [{ id: 'p1', name, maxRating: 'adult', hasPin: false }] } });

const browser = await chromium.launch({ executablePath: CHROME });

/**
 * One browser context per way in. Every https request is answered here — the
 * fleet by the scenario's `fleet(call)` table, everything else with `{}` — so
 * the run touches no live host. On localhost profile.js reads FLEET_BASE as
 * https://fleet.lyreosai.com (index.html only sets the /fleet proxy path on
 * blazingstream itself), which is why that is the host matched.
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
    const reply = fleet(call) || { status: 200, body: {} };
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

  await s.page.click('#bp-approve-yes');
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

await browser.close(); server.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
