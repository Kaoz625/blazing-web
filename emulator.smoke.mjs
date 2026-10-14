// Headless-Comet smoke test for the IN-BROWSER EMULATOR — emulator.js, the
// #emulator-overlay it drives, and the "Play in browser" button games.js draws.
//
// WHAT IS PROVED, and what is deliberately NOT.
//   This suite proves the parts that are ours and testable offline: the public
//   API (window.BlazingEmulator), which releases get a button and which system
//   each one boots (verdict / coreFor, fed the catalog's REAL row text), the
//   overlay's own behaviour, and the Games dialog end to end against a stubbed
//   add-on — including the /games/resolve `playPath` contract.
//
//   It does NOT boot a real core. EmulatorJS's loader.js and its wasm cores are
//   cross-origin on cdn.emulatorjs.org; here that host is STUBBED to an empty
//   200 so the test is hermetic and fast and never pulls a 40 MB core. Whether a
//   core actually runs a ROM is EmulatorJS's own concern and a live, networked
//   check, not this one. What the frame IS handed — the EJS_* globals — is read
//   back out of it, because that part is ours.
//
// THE ROW TEXT BELOW IS REAL. Every `platform` / `collection` / `format` triple
// in section 2 was read off the live add-on (GET /games/search) on 14 Oct 2026.
// The first version of this file tested only invented tokens ('nes',
// 'genesis'), passed, and the button then showed on NO real catalog row: the
// archive sends "Nintendo - Nintendo Entertainment System (Headered)", never
// "nes". A mock that disagrees with the server proves nothing — the same lesson
// written at the top of games-hub.smoke.mjs.
//
// The add-on shapes in section 6 follow games-hub.smoke.mjs (transcribed from
// services/addon/lib/game-source-routes.js) plus the one field this feature
// adds to the 200 answer of /games/resolve: `playPath`, a path ON THE ADD-ON
// that serves the same file with CORS headers (BLZ-0120).
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
const stubCdn = (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* stubbed in test */' });
await ctx.route('https://cdn.emulatorjs.org/**', stubCdn);

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
    verdict: typeof e.verdict,
    systems: Array.isArray(e.SYSTEMS) ? e.SYSTEMS.length : -1,
    version: e.EJS_VERSION,
    data: e.EJS_DATA,
  };
});
check('window.BlazingEmulator exposes open/close/coreFor/verdict',
  api.present && api.open === 'function' && api.close === 'function'
  && api.coreFor === 'function' && api.verdict === 'function',
  JSON.stringify(api));
check('all 27 EmulatorJS systems are offered', api.systems === 27, String(api.systems));
check('EmulatorJS data path is pinned to a version, not stable/latest',
  typeof api.data === 'string' && /cdn\.emulatorjs\.org\/\d+\.\d+\.\d+\/data\//.test(api.data),
  api.data);

// ── 2: which rows get a button, and which system each one boots ──────────────
//
// [platform, collection, format, expected]. expected is a system id (a button
// that boots it), 'BLOCKED:<id>' (a disabled button and a reason), 'ASK' (a
// button, and the player asks the system) or 'NONE' (no button).
const REAL = [
  // One live row per system the catalog holds, 14 Oct 2026.
  ['Nintendo - Nintendo Entertainment System (Headered)', 'No-Intro', 'ZIP', 'nes'],
  ['RA - Nintendo Entertainment System', 'RetroAchievements', 'ZIP', 'nes'],
  ['RA - Super Nintendo Entertainment System', 'RetroAchievements', 'ZIP', 'snes'],
  ['Nintendo - Super Famicom - Speed Hacks', 'T-En Collection', 'ZIP', 'snes'],
  ['Nintendo Game Boy', 'TOSEC', 'ZIP', 'gb'],
  ['Nintendo - Game Boy Color', 'No-Intro', 'ZIP', 'gb'],
  ['RA - Nintendo Game Boy Advance', 'RetroAchievements', 'ZIP', 'gba'],
  ['Nintendo 64', 'TOSEC', 'ZIP', 'n64'],
  ['Nintendo - Nintendo DS (Decrypted)', 'No-Intro', 'ZIP', 'nds'],
  ['Nintendo - Virtual Boy', 'No-Intro', 'ZIP', 'vb'],
  ['Sega - Mega Drive - Genesis', 'No-Intro', 'ZIP', 'segaMD'],
  ['Sega Mega Drive & Genesis', 'TOSEC', 'ZIP', 'segaMD'],
  ['Sega - Master System - Mark III', 'No-Intro', 'ZIP', 'segaMS'],
  ['Sega Mark III & Master System', 'TOSEC', 'ZIP', 'segaMS'],
  ['Sega - Game Gear', 'No-Intro', 'ZIP', 'segaGG'],
  ['Sega - Saturn', 'Redump', 'ZIP', 'segaSaturn'],
  ['Sony - PlayStation', 'Redump', 'ZIP', 'psx'],
  ['Sony - PlayStation (PS one Classics) (PSN)', 'No-Intro', 'ZIP', 'psx'],
  ['Atari - Atari 2600', 'No-Intro', 'ZIP', 'atari2600'],
  ['Atari - Atari Lynx (LNX)', 'No-Intro', 'ZIP', 'lynx'],
  ['Atari - Atari Jaguar (J64)', 'No-Intro', 'ZIP', 'jaguar'],
  ['RA - SNK Neo Geo Pocket', 'RetroAchievements', 'ZIP', 'ngp'],
  ['SNK Neo-Geo Pocket Color', 'TOSEC', 'ZIP', 'ngp'],
  ['Bandai - WonderSwan Color', 'No-Intro', 'ZIP', 'ws'],
  ['Commodore Amiga', 'TOSEC', 'ZIP', 'amiga'],
  ['ROMs (merged)', 'MAME', 'ZIP', 'arcade'],
  // The add-on's own tokens.
  ['ps1', 'NoPayStation', 'BIN', 'psx'],
  ['nds', 'NYC Games · 1fichier.com', '', 'nds'],
  ['arcade', 'NYC Games · ZIP · archive.org', 'ZIP', 'arcade'],
  ['retro', 'NYC Games · Super Nintendo · ZIP · archive.org', 'ZIP', 'snes'],
  // On the 27, but cannot start on this page: a disabled button and a reason.
  ['Sega - Mega CD & Sega CD', 'Redump', 'ZIP', 'BLOCKED:segaCD'],
  ['Coleco ColecoVision', 'TOSEC', 'ZIP', 'BLOCKED:coleco'],
  ['Panasonic - 3DO Interactive Multiplayer', 'Redump', 'ZIP', 'BLOCKED:3do'],
  ['Nintendo - Family Computer Disk System (FDS)', 'No-Intro', 'ZIP', 'BLOCKED:nes'],
  ['Sony - PlayStation Portable', 'Redump', 'ZIP', 'BLOCKED:psp'],
  ['ps1', 'NoPayStation', 'PKG', 'BLOCKED:psx'],
  // Plainly retro, no machine named: the player asks.
  ['retro', 'NYC Games · archive.org', 'ZIP', 'ASK'],
  // A machine nothing here runs, or not a game at all: no button.
  ['Sony - PlayStation 2', 'Redump', 'ZIP', 'NONE'],
  ['IBM PC Compatibles', 'TOSEC', 'ZIP', 'NONE'],
  ['!EXTRAS Loaders JConfig Jconfig Game Specific', "Eggman's Arcade Repository", 'ZIP', 'NONE'],
  ['Arcade Arcade - Sega - Naomi', 'Redump', 'ZIP', 'NONE'],
  ['Nintendo Pokemon Mini', 'TOSEC', 'ZIP', 'NONE'],
  ['SPC Music SPC1 1 SNES 0-C', 'Hardware Target Game Database', 'ZIP', 'NONE'],
  ['all_non-zipped_content gameover', 'MAME', 'PNG', 'NONE'],
  ['wii', 'NYC Games · 1fichier.com', '', 'NONE'],
  ['PC', '', 'zip', 'NONE'],
];
const verdicts = await page.evaluate((rows) => rows.map(([platform, collection, format]) => {
  // Minerva and NYC Games' retro rows are "plainly retro" (games.js isRetroRow).
  const retro = /^(retro|arcade)$/i.test(platform) || !/^(ps1|nds|wii|pc)$/i.test(platform);
  const v = window.BlazingEmulator.verdict({ platform, collection, format, retro });
  if (v.core && v.blocked) return `BLOCKED:${v.core}`;
  if (v.core) return v.core;
  return v.ask ? 'ASK' : 'NONE';
}), REAL);
const wrong = REAL.map((r, i) => (verdicts[i] === r[3] ? '' : `${r[0]} -> ${verdicts[i]} (want ${r[3]})`)).filter(Boolean);
check(`every real catalog row maps the way it should (${REAL.length} rows)`, wrong.length === 0, wrong.join(' | '));

const cores = await page.evaluate(() => {
  const c = window.BlazingEmulator.coreFor;
  return {
    platformNes: c({ platform: 'nes' }),
    platformGenesis: c({ platform: 'genesis' }),
    formatSnes: c({ format: 'SNES' }),
    extSfc: c({ name: 'Chrono Trigger.sfc' }),
    extGba: c({ name: 'rom.gba' }),
    explicit: c({ core: 'n64' }),
    // "retro" is a BUCKET, not a system, and a bare .zip or a disc image names
    // no machine — all must come back empty so the player asks instead of
    // guessing wrong. .pbp is PS1 AND PSP, so it names none either.
    retroBucket: c({ platform: 'retro' }),
    bareZip: c({ name: 'game.zip' }),
    discImage: c({ name: 'game.cue' }),
    pbp: c({ name: 'EBOOT.PBP' }),
    nothing: c({}),
  };
});
check('coreFor maps platform/format/extension and an explicit core',
  cores.platformNes === 'nes' && cores.platformGenesis === 'segaMD'
  && cores.formatSnes === 'snes' && cores.extSfc === 'snes'
  && cores.extGba === 'gba' && cores.explicit === 'n64',
  JSON.stringify(cores));
check('coreFor refuses to guess for the "retro" bucket, a bare .zip, a disc image or a .pbp',
  cores.retroBucket === '' && cores.bareZip === '' && cores.discImage === ''
  && cores.pbp === '' && cores.nothing === '',
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
check('the picker offers all 27 systems and a local-file loader',
  (await page.locator('.emulator-system').count()) === 27
  && (await page.locator('#emulator-file-input').count()) === 1,
  String(await page.locator('.emulator-system').count()));
check('the picker says plainly that an unlisted system cannot play here',
  /not in this list.*cannot play it/i.test(await page.locator('#emulator-setup').innerText()));
await page.evaluate(() => window.BlazingEmulator.close());

// ── 5b: a system that cannot start HERE says why, instead of a black screen ──
await page.evaluate(() => window.BlazingEmulator.open({
  romUrl: 'https://cdn.emulatorjs.org/stub/sonic-cd.zip', title: 'Sonic CD',
  platform: 'Sega - Mega CD & Sega CD', collection: 'Redump', format: 'ZIP',
}));
await page.waitForSelector('#emulator-setup', { state: 'visible', timeout: 8000 });
check('a Sega CD game says it needs a BIOS file and boots nothing',
  /Sega CD games need a Sega CD BIOS file/.test(await page.locator('#emulator-status').innerText())
  && (await page.locator('#emulator-frame').count()) === 0,
  await page.locator('#emulator-status').innerText());
await page.evaluate(() => window.BlazingEmulator.close());

// ── 5c: what the frame is handed ─────────────────────────────────────────────
//
// The add-on's CORS copy ends in "/games/play?t=…", and EmulatorJS 4.2.3 names
// the file it gives the core after the URL's last path piece — "play", no
// extension. The real name rides on the end as a fragment, which no request
// ever sends.
async function frameGlobals(p) {
  await p.waitForFunction(() => {
    const f = document.getElementById('emulator-frame');
    return !!(f && f.contentWindow && f.contentWindow.EJS_gameUrl);
  }, null, { timeout: 8000 });
  return p.evaluate(() => {
    const w = document.getElementById('emulator-frame').contentWindow;
    return {
      gameUrl: w.EJS_gameUrl, core: w.EJS_core, gameName: w.EJS_gameName,
      background: w.EJS_backgroundColor, threads: w.EJS_threads === true,
    };
  });
}
await page.evaluate(() => window.BlazingEmulator.open({
  romUrl: 'https://addon.example.test/games/play?t=tok-1',
  fileName: 'Sonic The Hedgehog (USA, Europe).md',
  title: 'Sonic The Hedgehog',
  platform: 'Sega - Mega Drive - Genesis',
}));
const g = await frameGlobals(page);
check('the ROM URL carries the real file name as a fragment',
  g.gameUrl === `https://addon.example.test/games/play?t=tok-1#/${encodeURIComponent('Sonic The Hedgehog (USA, Europe).md')}`,
  g.gameUrl);
check('the core is the one the row named', g.core === 'segaMD', g.core);
check('the frame is painted the page black, not EmulatorJS\'s grey',
  /^#0a0a0b$/i.test(String(g.background)), String(g.background));
check('threads stay off on a page that is not cross-origin isolated', g.threads === false);
await page.evaluate(() => window.BlazingEmulator.close());

// A ROM from this device is a blob: URL, and for one of those EmulatorJS names
// the file after EJS_gameName instead of the URL — so the name it gets must
// still end in the extension the core reads.
await page.evaluate(() => window.BlazingEmulator.open({}));
await page.waitForSelector('#emulator-file-input', { state: 'attached', timeout: 8000 });
await page.setInputFiles('#emulator-file-input', {
  name: 'Tetris (World).gb', mimeType: 'application/octet-stream', buffer: Buffer.from('not a real rom'),
});
const local = await frameGlobals(page);
check('a local .gb boots the Game Boy core from a blob: URL',
  local.core === 'gb' && String(local.gameUrl).startsWith('blob:'), `${local.core} ${local.gameUrl}`);
check('...and EmulatorJS is handed a name that keeps the extension',
  local.gameName === 'Tetris (World).gb', local.gameName);
await page.evaluate(() => window.BlazingEmulator.close());

// EmulatorJS is stubbed, so ignore the network noise its absent loader produces;
// a real uncaught error in our own code still fails the suite.
const real = errors.filter((e) => !/Failed to fetch|NetworkError|CORS|load resource|EJS|emulatorjs/i.test(e));
check('no page errors (player)', real.length === 0, real.join(' | '));
await ctx.close();

// ── 6: the Games dialog, against a stubbed add-on ────────────────────────────
//
// THE ADD-ON SITS BEHIND A PATH PREFIX HERE, ON PURPOSE. api() builds every URL
// as `${ADDON_BASE}${path}`, and a host serving the add-on under a prefix (a
// same-origin proxy, the way blazingstream serves the fleet under /fleet) is
// exactly where a root-relative `playPath` resolved with new URL() would land
// on the host root and miss. So the base is …/via-proxy, and the assertion is
// that the play URL keeps it.
const PREFIX = '/via-proxy';
const ADDON = `https://addon.lyreosai.com${PREFIX}`;
const LANES = { http: true, realdebrid: true, torbox: true, usenet: false };
const LANE_LABELS = { http: 'Direct download', realdebrid: 'Real-Debrid', torbox: 'TorBox', usenet: 'Usenet (TorBox)' };
const row = (ref, title, platform, collection, format, source, lane) => ({
  source, provider: source, title, platform, collection, region: '', format, size: 0,
  url: ref, ref, direct: true, playable: true, info: '', cover: '', risk: '', part: 0, tier: 1,
  lane, delivery: lane === 'http' ? 'direct' : 'magnet', kind: 'module',
});
const ROWS = [
  row('ref-nes', 'Super Mario Bros. (World)', 'Nintendo - Nintendo Entertainment System (Headered)', 'No-Intro', 'ZIP', 'minerva', 'realdebrid'),
  row('ref-gg', 'Sonic Chaos (USA, Europe)', 'Sega - Game Gear', 'No-Intro', 'ZIP', 'minerva', 'realdebrid'),
  row('ref-bad', 'Columns (World)', 'Sega - Game Gear', 'No-Intro', 'ZIP', 'minerva', 'realdebrid'),
  row('ref-scd', 'Sonic CD (USA)', 'Sega - Mega CD & Sega CD', 'Redump', 'ZIP', 'minerva', 'realdebrid'),
  row('ref-ps2', 'Metal Slug 3 (USA)', 'Sony - PlayStation 2', 'Redump', 'ZIP', 'minerva', 'realdebrid'),
  row('ref-pkg', 'Crash Bandicoot', 'ps1', 'NoPayStation', 'PKG', 'nps-ps1', 'http'),
  row('ref-ask', 'Mystery Cart', 'retro', 'NYC Games · archive.org', 'ZIP', 'nyc-games', 'http'),
];
// GET /games/resolve, per ref. `playPath` is the new field; `url` is the
// lane's own link, which the Download button keeps using.
const RESOLVE = {
  'ref-nes': { url: 'https://dl.example.test/d/ABC/Super%20Mario%20Bros.%20(World).zip', playPath: '/games/play?t=tok-nes' },
  'ref-gg': { url: 'https://cdn.example.test/roms/Sonic%20Chaos%20(USA%2C%20Europe).zip' },
  // A play path that is not one absolute path on the add-on is refused, and the
  // plain link is used instead. Protocol-relative would point at another host.
  'ref-bad': { url: 'https://cdn.example.test/roms/Columns%20(World).zip', playPath: '//evil.example.test/x.zip' },
  'ref-ask': { url: 'https://cdn.example.test/roms/mystery.zip', playPath: '/games/play?t=tok-ask' },
};

const ctx2 = await browser.newContext();
const resolved = [];
await ctx2.route('https://cdn.emulatorjs.org/**', stubCdn);
await ctx2.route('https://addon.lyreosai.com/**', (route) => {
  const u = new URL(route.request().url());
  const path = u.pathname.startsWith(PREFIX) ? u.pathname.slice(PREFIX.length) : u.pathname;
  const json = (status, payload) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
  if (path === '/games/sources') {
    return json(200, {
      count: 2,
      sources: [
        { id: 'minerva', label: 'Minerva Archive', platforms: ['retro', 'arcade'], delivery: 'magnet', kind: 'module', enabled: true, lane: 'realdebrid', error: null },
        { id: 'nps-ps1', label: 'NoPayStation PS1', platforms: ['ps1'], delivery: 'direct', kind: 'module', enabled: true, lane: 'http', error: null },
        { id: 'nyc-games', label: 'NYC Games', platforms: ['ps5', 'ps1', 'nds', 'arcade', 'retro'], delivery: 'direct', kind: 'module', enabled: true, lane: 'http', error: null },
      ],
      platforms: ['ps5', 'ps4', 'ps3', 'ps2', 'ps1', 'psp', 'nds', 'pc', 'retro', 'arcade'],
      backends: [], lanes: LANES, laneLabels: LANE_LABELS, debridEnabled: true, configFile: 'sources.local.json',
    });
  }
  if (path === '/games/search') {
    return json(200, {
      query: u.searchParams.get('q') || '', platform: '', source: '', count: ROWS.length, results: ROWS,
      asked: ['minerva', 'nps-ps1', 'nyc-games'], errors: [], lanes: LANES, debridEnabled: true, unavailable: null,
    });
  }
  if (path === '/games/resolve') {
    const ref = u.searchParams.get('ref') || '';
    resolved.push({ ref, path: u.pathname });
    const answer = RESOLVE[ref];
    if (!answer) return json(404, { error: 'invalid-reference', reason: 'invalid-reference', message: 'That reference is expired or was not issued here.' });
    return json(200, { ok: true, lane: 'realdebrid', provider: 'Real-Debrid', source: 'minerva', tried: ['realdebrid'], ...answer });
  }
  return json(200, { catalogs: [], metas: [] });
});
await ctx2.route('https://fleet.lyreosai.com/**', (route) => {
  if (route.request().url().includes('/party/active')) return route.fulfill({ status: 204, body: '' });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
});
await ctx2.route(/^https:\/\/(cdn|dl|media|evil)\.example\.test\//, (route) =>
  route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'ok' }));
await ctx2.addInitScript((addon) => { window.BLAZING_API_BASE = addon; }, ADDON);
await prepareProfile(ctx2);

const p2 = await ctx2.newPage();
const errors2 = [];
p2.on('pageerror', (e) => errors2.push(String(e)));
await p2.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
await selectProfile(p2);
// "Games" lives in the drawer-only "More" nav at a desktop viewport; the
// button is bound the same either way (the reason games-hub.smoke.mjs does this).
await p2.evaluate(() => document.querySelector('[data-view="games"]').click());
await p2.waitForSelector('#games-tab-browse', { state: 'visible', timeout: 10000 });
// Spy on the player: record what games.js hands it, then let it run.
await p2.evaluate(() => {
  window.__emuOpens = [];
  const emu = window.BlazingEmulator;
  const real = emu.open;
  emu.open = (opts) => { window.__emuOpens.push(opts); return real(opts); };
});
await p2.fill('#games-hub-input', 'sonic');
await p2.click('#games-hub-form button[type="submit"]');
await p2.waitForSelector(`#games-hub-results .games-row[data-ref="ref-nes"]`, { timeout: 10000 });

async function openRow(ref) {
  await p2.evaluate(() => { if (window.BlazingEmulator.isOpen()) window.BlazingEmulator.close(); });
  await p2.click(`#games-hub-results .games-row[data-ref="${ref}"]`);
  await p2.waitForSelector('#game-source-dialog[open]', { timeout: 8000 });
}
async function play(ref) {
  await openRow(ref);
  const before = await p2.evaluate(() => window.__emuOpens.length);
  await p2.click('#game-source-play');
  await p2.waitForFunction((n) => window.__emuOpens.length > n, before, { timeout: 8000 });
  return p2.evaluate(() => window.__emuOpens[window.__emuOpens.length - 1]);
}

// 6a — a playable row: the button is there, enabled, and names its system.
await openRow('ref-nes');
const nesBtn = p2.locator('#game-source-play');
check('an NES row from the archive gets "Play in browser"',
  (await nesBtn.count()) === 1 && (await nesBtn.isEnabled()) && (await nesBtn.getAttribute('data-core')) === 'nes',
  `count=${await nesBtn.count()} core=${await nesBtn.getAttribute('data-core').catch(() => '?')}`);
await p2.evaluate(() => document.getElementById('game-source-dialog').close());

// 6b — playPath is preferred, joined to the SAME base api() uses.
const nes = await play('ref-nes');
check('Play asks /games/resolve on the prefixed add-on base',
  resolved.some((r) => r.ref === 'ref-nes' && r.path === `${PREFIX}/games/resolve`),
  JSON.stringify(resolved));
check('playPath wins over url, and keeps the add-on base\'s path prefix',
  nes.romUrl === `${ADDON}/games/play?t=tok-nes`, nes.romUrl);
check('the play URL is NOT the root-relative one new URL() would have built',
  nes.romUrl !== 'https://addon.lyreosai.com/games/play?t=tok-nes');
check('the ROM keeps its real name, taken from url (the play path names nothing)',
  nes.fileName === 'Super Mario Bros. (World).zip', nes.fileName);
check('the dialog closes and the player takes the screen',
  !(await p2.locator('#game-source-dialog[open]').count()) && (await p2.locator('#emulator-overlay').isVisible()));
const g2 = await frameGlobals(p2);
check('the frame gets the play URL, named', g2.gameUrl
  === `${ADDON}/games/play?t=tok-nes#/${encodeURIComponent('Super Mario Bros. (World).zip')}` && g2.core === 'nes',
  `${g2.gameUrl} ${g2.core}`);

// 6c — no playPath: the plain url is what plays.
const gg = await play('ref-gg');
check('with no playPath the plain url plays', gg.romUrl === RESOLVE['ref-gg'].url, gg.romUrl);

// 6d — a playPath that is not a path on the add-on is refused.
const bad = await play('ref-bad');
check('a protocol-relative playPath is refused and url is used', bad.romUrl === RESOLVE['ref-bad'].url, bad.romUrl);

// 6e — plainly retro, no machine named: a button, and the player asks.
const ask = await play('ref-ask');
check('a retro row naming no machine still gets the button, and plays from playPath',
  ask.romUrl === `${ADDON}/games/play?t=tok-ask`, ask.romUrl);
await p2.waitForSelector('#emulator-picker', { state: 'visible', timeout: 8000 });
check('...and the player asks which system instead of guessing',
  (await p2.locator('#emulator-frame').count()) === 0);

// 6f — a system that cannot start here: disabled, with the reason, no resolve.
const askedBefore = resolved.length;
await openRow('ref-scd');
const scd = p2.locator('#game-source-play');
check('a Sega CD row shows Play in browser DISABLED',
  (await scd.count()) === 1 && (await scd.isDisabled()));
check('...with the reason in plain words beside it',
  /Sega CD games need a Sega CD BIOS file/.test(await p2.locator('#game-source-play-why').innerText()));
await p2.evaluate(() => document.getElementById('game-source-dialog').close());
await openRow('ref-pkg');
check('a NoPayStation .pkg row is disabled and says why',
  (await p2.locator('#game-source-play').isDisabled())
  && /PlayStation Store package/.test(await p2.locator('#game-source-play-why').innerText()));
await p2.evaluate(() => document.getElementById('game-source-dialog').close());
check('a disabled Play never calls /games/resolve', resolved.length === askedBefore);

// 6g — a machine nothing here runs: no button at all.
await openRow('ref-ps2');
check('a PS2 row gets no Play button', (await p2.locator('#game-source-play').count()) === 0);
check('...and its Download button is untouched',
  (await p2.locator('#game-source-lanes button').count()) === 1
  && (await p2.locator('#game-source-go').count()) === 1);
await p2.evaluate(() => document.getElementById('game-source-dialog').close());

const real2 = errors2.filter((e) => !/Failed to fetch|NetworkError|CORS|load resource|EJS|emulatorjs/i.test(e));
check('no page errors (Games dialog)', real2.length === 0, real2.join(' | '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
