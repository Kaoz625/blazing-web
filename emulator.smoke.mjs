// Headless-Comet smoke test for the IN-BROWSER EMULATOR — emulator.js and the
// #emulator-overlay it drives.
//
// WHAT IS PROVED, and what is deliberately NOT.
//   This suite proves the parts that are ours and testable offline: the public
//   API (window.BlazingEmulator), the pure core-detection function coreFor(),
//   and the overlay's own behaviour — it opens on a known system, shows the
//   system picker on an unknown one, and tears the player down on close.
//
//   It does NOT boot a real core. EmulatorJS's loader.js and its wasm cores are
//   cross-origin on cdn.emulatorjs.org; here that host is STUBBED to an empty
//   200 so the test is hermetic and fast and never pulls a 40 MB core. Whether a
//   core actually runs a ROM is EmulatorJS's own concern and a live, networked
//   check, not this one. The one thing a networked ROM needs that this cannot
//   prove is a CORS header on the add-on's /games/resolve link; that is called
//   out in the report, not faked green here.
//
// The shapes any add-on interaction would use are the ones transcribed in
// games-hub.smoke.mjs from services/addon/lib/game-source-routes.js; this suite
// does not re-exercise that flow (games-hub.smoke.mjs owns it) and tests the
// emulator module in isolation instead.
import { prepareProfile, selectProfile } from './scripts/profile-fixture.mjs';
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

const browser = await launchBrowser();
const ctx = await browser.newContext();

// STUB the EmulatorJS CDN so nothing real is pulled: loader.js and any core or
// ROM fetch answer an empty 200. The overlay and the player iframe are built
// regardless; only the actual emulation is skipped.
await ctx.route('https://cdn.emulatorjs.org/**', (route) =>
  route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* stubbed in test */' }));

await prepareProfile(ctx);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
await selectProfile(page);

// ── 1: the module is present with its documented API ─────────────────────────
const api = await page.evaluate(() => {
  const e = window.BlazingEmulator || {};
  return {
    present: !!window.BlazingEmulator,
    open: typeof e.open,
    close: typeof e.close,
    coreFor: typeof e.coreFor,
    version: e.EJS_VERSION,
    data: e.EJS_DATA,
  };
});
check('window.BlazingEmulator exposes open/close/coreFor',
  api.present && api.open === 'function' && api.close === 'function' && api.coreFor === 'function',
  JSON.stringify(api));
check('EmulatorJS data path is pinned to a version, not stable/latest',
  typeof api.data === 'string' && /cdn\.emulatorjs\.org\/\d+\.\d+\.\d+\/data\//.test(api.data),
  api.data);

// ── 2: coreFor() maps the signals it is given, and only when sure ────────────
const cores = await page.evaluate(() => {
  const c = window.BlazingEmulator.coreFor;
  return {
    platformNes: c({ platform: 'nes' }),
    platformGenesis: c({ platform: 'genesis' }),
    formatSnes: c({ format: 'SNES' }),
    extSfc: c({ name: 'Chrono Trigger.sfc' }),
    extGba: c({ name: 'rom.gba' }),
    explicit: c({ core: 'n64' }),
    // "retro" is a BUCKET, not a system, and a bare .zip names no machine — both
    // must come back empty so the player asks instead of guessing wrong.
    retroBucket: c({ platform: 'retro' }),
    bareZip: c({ name: 'game.zip' }),
    nothing: c({}),
  };
});
check('coreFor maps platform/format/extension and an explicit core',
  cores.platformNes === 'nes' && cores.platformGenesis === 'segaMD'
  && cores.formatSnes === 'snes' && cores.extSfc === 'snes'
  && cores.extGba === 'gba' && cores.explicit === 'n64',
  JSON.stringify(cores));
check('coreFor refuses to guess for the "retro" bucket or a bare .zip',
  cores.retroBucket === '' && cores.bareZip === '' && cores.nothing === '',
  JSON.stringify(cores));

// ── 3: opening with a known system builds the player and shows the overlay ───
await page.evaluate(() => window.BlazingEmulator.open({
  romUrl: 'https://cdn.emulatorjs.org/stub/mario.nes', core: 'nes', title: 'Test Cartridge',
}));
await page.waitForSelector('#emulator-overlay', { state: 'visible', timeout: 8000 });
check('the overlay is visible after open()',
  await page.locator('#emulator-overlay').isVisible());
check('the player iframe is mounted on the stage',
  (await page.locator('#emulator-stage #emulator-frame').count()) === 1);
check('the overlay bar shows the game title',
  (await page.locator('#emulator-title').textContent())?.trim() === 'Test Cartridge');
check('the setup panel is hidden once a game launches',
  !(await page.locator('#emulator-setup').isVisible()));

// ── 4: close() tears the player down ─────────────────────────────────────────
await page.evaluate(() => window.BlazingEmulator.close());
check('the overlay is hidden after close()',
  !(await page.locator('#emulator-overlay').isVisible()));
check('the iframe is removed on close (frees the wasm heap and stops audio)',
  (await page.locator('#emulator-frame').count()) === 0);

// ── 5: an unknown system opens the picker instead of guessing ────────────────
await page.evaluate(() => window.BlazingEmulator.open({
  romUrl: 'https://cdn.emulatorjs.org/stub/mystery.zip', title: 'Mystery Disc',
}));
await page.waitForSelector('#emulator-setup', { state: 'visible', timeout: 8000 });
check('an undecidable ROM shows the system picker, not a player',
  (await page.locator('#emulator-picker').isVisible())
  && (await page.locator('#emulator-frame').count()) === 0);
check('the picker offers system choices and a local-file loader',
  (await page.locator('.emulator-system').count()) > 5
  && (await page.locator('#emulator-file-input').count()) === 1);
await page.evaluate(() => window.BlazingEmulator.close());

// EmulatorJS is stubbed, so ignore the network noise its absent loader produces;
// a real uncaught error in our own code still fails the suite.
const real = errors.filter((e) => !/Failed to fetch|NetworkError|CORS|load resource|EJS|emulatorjs/i.test(e));
check('no page errors', real.length === 0, real.join(' | '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
