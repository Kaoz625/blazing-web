// Does the browser beat, and does a rejected beat leave the credential alone?
//
// WHY THIS FILE EXISTS. POST /agent/:deviceId/heartbeat is the ONLY writer of
// `lastSeen` on the fleet (blazing-fleet server.js:523). Registration stamps it
// once at mint (server.js:463), so a client that never beats keeps
// firstSeen === lastSeen for ever. On 2026-09-03, 31 of the 47 records on
// GET /admin/fleet were in exactly that state, and all 19 Blazing Web records
// were among them, because nothing in this repo had ever sent a beat.
//
// WHY IT IS MOSTLY ABOUT 404. The Roku's first heartbeat deleted both credential
// keys on any 401 or any 404 (roku channels source/lib/Fleet.brs, the note at
// ~170-190), and that was two bugs in three lines:
//
//   1. TWO DIFFERENT 404 BODIES SHARE THE STATUS CODE and mean opposite things.
//        {"error":"not found","path":...}            a route is missing, we are FINE
//        {"error":"unknown device; register first"}  the id really is dead
//   2. Even on a REAL "unknown device", the held id+token pair is the only thing
//      a reclaim can be made of — /agent/register matches on BOTH and keeps the
//      previous enrollmentStatus, so an approved client comes back approved.
//      Wiping first made the forced register mint a new PENDING record and the
//      client lost its approval, its profile and its adult unlock in one tick.
//
// So the four cases below are the whole point, and every one of them asserts the
// stored credential is BYTE-IDENTICAL afterwards. The network is stubbed; this
// never touches the real fleet — a live 404 test would need a real dead id, and
// a live 401 burns the register rate limit for nothing.
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

const results = [];
const check = (n, pass, d = '') => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

const KEY = 'blazing-web-profile-device-v1';
const DEVICE = { id: 'dev-web-beat', token: 'tok-web-beat' };
// The exact string localStorage will hold. Every case below compares against
// THIS, not against a re-parsed object: a wipe-then-rewrite would pass an
// object comparison and this catches it.
const STORED = JSON.stringify(DEVICE);

const browser = await chromium.launch();
const ctx = await browser.newContext();

// An identity, seeded before the first byte of profile.js runs. boot() only
// calls connectProfiles() when storedCredentials() returns something
// (profile.js, "A browser that has never registered gets the welcome screen"),
// and connectProfiles() is one of the two places the beat is started from.
await ctx.addInitScript(([key, value]) => {
  localStorage.setItem(key, value);
}, [KEY, STORED]);

// The fleet, stubbed. `beatAnswer` is swapped between cases.
let beatAnswer = { status: 200, body: { ok: true } };
const beats = [];          // every heartbeat request, in order
const fleetSeen = [];      // every fleet call at all
await ctx.route('https://fleet.lyreosai.com/**', async (route) => {
  const req = route.request();
  const path = req.url().replace('https://fleet.lyreosai.com', '');
  fleetSeen.push(`${req.method()} ${path}`);

  if (/\/agent\/[^/]+\/heartbeat/.test(path)) {
    let body = null;
    try { body = JSON.parse(req.postData() || 'null'); } catch { body = null; }
    beats.push({ method: req.method(), path, token: req.headers()['x-device-token'] || '', body });
    return route.fulfill({
      status: beatAnswer.status,
      contentType: 'application/json',
      body: JSON.stringify(beatAnswer.body),
    });
  }
  if (path.includes('/agent/register')) {
    // The reclaim shape: same id back, NO token. If the app ever registered
    // during this run, the stored string would change and every byte-identical
    // assertion below would go red — which is the point.
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ deviceId: DEVICE.id }) });
  }
  if (path.startsWith('/profiles')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profiles: [] }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
await ctx.route('https://addon.lyreosai.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });

await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

check('no pageerror from the gate', errs.length === 0, errs.slice(0, 2).join(' | '));

// ── 1. It beats at all, unasked, on a browser that already has an identity ──
check('the browser sends a heartbeat on its own at boot', beats.length >= 1,
  `beats=${beats.length} fleet=${fleetSeen.join(', ')}`);
const first = beats[0] || {};
check('  POST /agent/<deviceId>/heartbeat', first.method === 'POST' && first.path === `/agent/${DEVICE.id}/heartbeat`,
  `${first.method} ${first.path}`);
check('  carries X-Device-Token', first.token === DEVICE.token, `token=${JSON.stringify(first.token)}`);
check('  body is {"appVersions":{"web":<n>}}',
  !!first.body && !!first.body.appVersions && Number.isInteger(first.body.appVersions.web),
  JSON.stringify(first.body));
check('  and the version matches the one register sends (73)',
  !!first.body && first.body.appVersions && first.body.appVersions.web === 73,
  JSON.stringify(first.body && first.body.appVersions));

const api = await page.evaluate(() => !!(window.BlazingFleetBeat && typeof window.BlazingFleetBeat.beat === 'function'));
check('window.BlazingFleetBeat is exposed, so a beat can be driven and read', api);

// One beat with a chosen answer. Reads the RAW stored string on both sides and
// the status line too — a failed beat must never speak to the viewer.
async function beatWith(status, body) {
  beatAnswer = { status, body };
  return page.evaluate(async () => {
    const KEY_ = 'blazing-web-profile-device-v1';
    const before = localStorage.getItem(KEY_);
    const statusBefore = (document.querySelector('.bp-status') || {}).textContent || '';
    const out = await window.BlazingFleetBeat.beat();
    return {
      before,
      after: localStorage.getItem(KEY_),
      statusBefore,
      statusAfter: (document.querySelector('.bp-status') || {}).textContent || '',
      out,
      flag: window.BlazingFleetBeat.identityRejected(),
    };
  });
}

// ── (a) 200 {"ok":true} ────────────────────────────────────────────────────
{
  const r = await beatWith(200, { ok: true });
  check('(a) 200 — the credential is byte-identical', r.after === STORED && r.after === r.before,
    `before=${r.before} after=${r.after}`);
  check('(a) 200 — not an identity rejection', r.out.identityRejected === false && r.flag === false);
  check('(a) 200 — reported ok', r.out.ok === true && r.out.status === 200);
}

// ── (b) 401 invalid or missing X-Device-Token ──────────────────────────────
{
  const r = await beatWith(401, { error: 'invalid or missing X-Device-Token' });
  check('(b) 401 — THE CREDENTIAL IS BYTE-IDENTICAL', r.after === STORED && r.after === r.before,
    `before=${r.before} after=${r.after}`);
  check('(b) 401 — it is an identity rejection, and that sets a FLAG and nothing else',
    r.out.identityRejected === true && r.flag === true);
  check('(b) 401 — the viewer is told nothing', r.statusAfter === r.statusBefore,
    `"${r.statusBefore}" -> "${r.statusAfter}"`);
}

// ── (c) 404 {"error":"not found","path":...} — A MISSING ROUTE ─────────────
// THE CASE THIS FILE IS FOR. The fleet has no such route; our identity is
// perfect. Reading the status code alone calls this a dead device and throws an
// approved browser away for a deploy that has not shipped a route yet.
{
  // Cleared first, by a good beat, so the assertion below is about THIS answer
  // and not about the 401 two cases up.
  await beatWith(200, { ok: true });
  const r = await beatWith(404, { error: 'not found', path: '/agent/dev-web-beat/heartbeat' });
  check('(c) 404 "not found" — the credential is byte-identical', r.after === STORED && r.after === r.before,
    `before=${r.before} after=${r.after}`);
  check('(c) 404 "not found" — IS NOT AN IDENTITY REJECTION', r.out.identityRejected === false,
    `identityRejected=${r.out.identityRejected}`);
  check('(c) 404 "not found" — and it does not raise the flag either', r.flag === false,
    `flag=${r.flag}`);
  check('(c) 404 "not found" — the viewer is told nothing', r.statusAfter === r.statusBefore,
    `"${r.statusBefore}" -> "${r.statusAfter}"`);
}

// ── (d) 404 {"error":"unknown device; register first"} — A DEAD ID ─────────
// A real rejection. It STILL deletes nothing: the held pair is the only thing a
// reclaim can be made of, and repair belongs to the register path.
{
  const r = await beatWith(404, { error: 'unknown device; register first' });
  check('(d) 404 "unknown device" — IS an identity rejection', r.out.identityRejected === true,
    `identityRejected=${r.out.identityRejected}`);
  check('(d) 404 "unknown device" — AND STILL DELETES NOTHING', r.after === STORED && r.after === r.before,
    `before=${r.before} after=${r.after}`);
  check('(d) 404 "unknown device" — the flag is raised and that is all', r.flag === true);
  check('(d) 404 "unknown device" — the viewer is told nothing', r.statusAfter === r.statusBefore,
    `"${r.statusBefore}" -> "${r.statusAfter}"`);
  check('(d) 404 "unknown device" — it did NOT re-register',
    !fleetSeen.slice(-4).some((c) => c.includes('/agent/register')), fleetSeen.slice(-4).join(', '));
}

// ── the flag is cleared by proof, not by hope ──────────────────────────────
{
  const r = await beatWith(200, { ok: true });
  check('a later 200 clears the rejection flag', r.flag === false);
}

// ── a dead network is not evidence about anything ──────────────────────────
{
  await ctx.route('https://fleet.lyreosai.com/agent/*/heartbeat', (route) => route.abort());
  const r = await page.evaluate(async () => {
    const out = await window.BlazingFleetBeat.beat();
    return { after: localStorage.getItem('blazing-web-profile-device-v1'), out, flag: window.BlazingFleetBeat.identityRejected() };
  });
  await ctx.unroute('https://fleet.lyreosai.com/agent/*/heartbeat');
  check('a dead socket keeps the credential and is not a rejection',
    r.after === STORED && r.out.identityRejected === false && r.flag === false,
    `status=${r.out.status} after=${r.after}`);
}

// ── never stack timers ─────────────────────────────────────────────────────
{
  const before = beats.length;
  const started = await page.evaluate(() => window.BlazingFleetBeat.start());
  await page.waitForTimeout(300);
  check('start() is idempotent — a second call starts nothing',
    started === false && beats.length === before, `returned ${started}, beats ${before}->${beats.length}`);
  check('the interval is the Roku cadence, 300s',
    await page.evaluate(() => window.BlazingFleetBeat.intervalMs) === 300000);
}

// ── a hidden tab does not beat, and a returning one beats at once ──────────
{
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(200);
  const runningHidden = await page.evaluate(() => window.BlazingFleetBeat.running());
  check('a hidden tab stops beating', runningHidden === false);

  const before = beats.length;
  beatAnswer = { status: 200, body: { ok: true } };
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(600);
  const runningVisible = await page.evaluate(() => window.BlazingFleetBeat.running());
  check('coming back to the tab beats immediately and restarts the tick',
    runningVisible === true && beats.length > before, `running=${runningVisible} beats ${before}->${beats.length}`);
}

// ── the credential survived the whole run ──────────────────────────────────
{
  const finalStored = await page.evaluate(() => localStorage.getItem('blazing-web-profile-device-v1'));
  check('after every answer the fleet can give, the stored credential is UNCHANGED',
    finalStored === STORED, `${finalStored}`);
}

await page.evaluate(() => window.BlazingFleetBeat.stop());
await browser.close(); server.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
