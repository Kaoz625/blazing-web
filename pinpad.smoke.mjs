// Does the OWNER PIN pad accept SEVEN digits, in a real browser?
//
// WHY. profile.js used OWNER_PIN_LENGTH in two places and declared it in none.
// The file is 'use strict' inside an IIFE, so the first reference threw
// ReferenceError and the pad stopped dead — it was not "rejecting the wrong
// length", it was broken. `node --check` passes on that file: syntax is fine and
// the fault is at runtime. Only a browser can catch it, so this is a browser.
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

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext();

// The fleet, stubbed. The PIN VALUE is never sent to a real server from a test:
// it is verified server-side against a scrypt hash, and burning the live route
// costs 1 of only 5 attempts per hour per IP AND per device.
let sentPinLength = -1;
const fleetSeen = [];
await ctx.route('https://fleet.lyreosai.com/**', async (route) => {
  const u = route.request().url();
  fleetSeen.push(route.request().method() + ' ' + u.replace('https://fleet.lyreosai.com', ''));
  // POST /agent/register — NOT /devices/register. The wrong path fell through to
  // the catch-all "{}" and the app correctly said it had no browser connection.
  if (u.includes('/agent/register')) {
    // The field names are deviceId / deviceToken, flat. The app said so itself:
    // with a {device:{id},token} shape it reported "The profile server did not
    // return a browser connection" and refused to open the pad.
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ deviceId: 'dev-1', deviceToken: 'tok' }) });
  }
  if (u.includes('/profiles')) {
    // 403 IS the pending state. applyProfileList() reveals "I am the owner" only
    // on a 403 — that is the situation the owner PIN exists to escape, so a 200
    // here would hide the very control under test.
    return route.fulfill({ status: 403, contentType: 'application/json',
      body: JSON.stringify({ error: 'device pending approval' }) });
  }
  if (u.includes('unlock') || u.includes('owner') || u.includes('pin')) {
    try {
      const body = JSON.parse(route.request().postData() || '{}');
      const pin = String(body.pin ?? body.ownerPin ?? '');
      if (pin) sentPinLength = pin.length;
    } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, token: 't', expiresAt: Date.now() + 60000 }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
await ctx.route('https://addon.lyreosai.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });

await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

// The bug this file exists for: a ReferenceError anywhere in the gate.
const refErr = errs.filter((e) => /is not defined|ReferenceError/.test(e));
check('no ReferenceError from the profile gate', refErr.length === 0, refErr.slice(0, 2).join(' | '));

// Find the owner entry point and open the pad.
// The gate lives behind the topbar's "Connect profile" button. Nothing in the
// panel — including the owner control — is visible until that is opened.
const connect = await page.$('.bp-connect');
check('the Connect profile button is in the topbar', !!connect);
if (connect) { await connect.click().catch(() => {}); await page.waitForTimeout(1800); }

const ownerBtn = await page.$('.bp-secondary:has-text("I am the owner")');
check('the "I am the owner" control is offered while pending', !!ownerBtn);
if (ownerBtn) {
  await ownerBtn.click().catch(() => {});
  await page.waitForTimeout(900);
}
// Say WHY, not just "false". openOwnerPin() refuses without device credentials
// and puts the reason in the status line; reading it turns a mystery into a fact.
const diag = await page.evaluate(() => ({
  status: (document.querySelector('.bp-status') || {}).textContent || '',
  pinHidden: (document.querySelector('.bp-pin') || {}).hidden,
  dotsCount: document.querySelectorAll('.bp-dot').length,
  layerHidden: (document.querySelector('.bp-layer') || {}).hidden,
  panelText: (document.body.innerText || '').slice(0, 300).replace(/\n+/g, ' | '),
}));
console.log('   diag:', JSON.stringify(diag));
console.log('   fleet calls:', JSON.stringify(fleetSeen));

const padOpen = await page.evaluate(() => {
  const dots = document.querySelector('.bp-dots');
  const panel = dots && dots.closest('[hidden]');
  return { visible: !!dots && !panel, name: (document.body.innerText.match(/Owner PIN/) || [''])[0] };
});
check('the pad opened in OWNER mode', padOpen.visible && padOpen.name === 'Owner PIN',
  `visible=${padOpen.visible} title="${padOpen.name}"`);

// Type EIGHT digits at a 7-digit pad and see how many it takes.
const typed = await page.evaluate(async () => {
  const keys = [...document.querySelectorAll('.bp-pad button, [data-digit], .pin-key, .keypad button')];
  const dots = () => document.querySelectorAll('.bp-dot[data-filled="true"]').length;
  const before = dots();
  for (const d of '69625699') {
    const k = keys.find((b) => (b.dataset?.digit === d) || b.textContent.trim() === d);
    if (k) { k.click(); await new Promise((r) => setTimeout(r, 60)); }
  }
  return { keysFound: keys.length, dotsBefore: before, dotsAfter: dots(),
           totalDots: document.querySelectorAll('.bp-dot').length,
           label: (document.querySelector('.bp-dots') || {}).ariaLabel || '',
           padTitle: (document.querySelector('.bp-pin-name, #bp-pin-name') || {}).textContent || '' };
});
check('the keypad rendered', typed.keysFound >= 10, `${typed.keysFound} keys`);
check('the pad draws SEVEN slots, not six', typed.totalDots === 7,
  `slots=${typed.totalDots}`);
check('it accepted exactly 7 of the 8 digits typed', typed.dotsAfter === 7,
  `filled=${typed.dotsAfter}, aria says "${typed.label}"`);

await page.screenshot({ path: process.env.SHOT || '/tmp/pinpad.png' });
await browser.close(); server.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
