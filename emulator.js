/* =============================================================================
 * emulator.js — play a retro ROM in the browser, no install.
 *
 * WHAT THIS IS. A full-screen player that boots EmulatorJS (a web RetroArch
 * frontend) for one ROM, on a phone, a PC or a television browser. It is opened
 * from the Games screen's download dialog — the "Play in browser" button beside
 * "Download" (games.js openDialog) — and it can also be opened on its own with a
 * locally chosen ROM file.
 *
 * WHY EmulatorJS, AND WHY FROM A CDN. This app has no bundler and no build step
 * (see package.json): index.html loads plain <script> tags off the disk. Nostalgist
 * is an ESM/npm library you wire a UI around; EmulatorJS is a drop-in that reads a
 * handful of window.EJS_* globals and ships its own touch pad, gamepad mapping,
 * save states, fullscreen and in-browser unzip — the whole frontend. So it is the
 * one that fits a no-build vanilla PWA. Its loader.js and its cores (wasm) come
 * from https://cdn.emulatorjs.org/<version>/data/ and are fetched ONLY when a ROM
 * is actually launched, so nothing here touches the main bundle until the player
 * opens. The service worker never sees these requests: sw.js returns early on any
 * cross-origin URL.
 *
 * WHY AN IFRAME. EmulatorJS is built to run once per page load — it is awkward to
 * tear down and re-initialise in place. Running it inside a srcdoc iframe makes
 * close() a one-liner (remove the iframe: the wasm heap, the audio and the rAF
 * loop all go with it) and keeps every EJS_* global out of the app's own window.
 * A srcdoc iframe inherits this document's origin, so a blob: URL minted here for
 * a local file is readable inside it.
 *
 * THE ONE EXTERNAL DEPENDENCY THAT CAN FAIL. A remote ROM URL is fetched by the
 * emulator cross-origin, so it needs CORS on the host that finally serves it.
 * The add-on's /games/resolve link is that host; if it does not send
 * Access-Control-Allow-Origin, the fetch fails and the watchdog below shows a
 * hint and the always-present "load a local ROM" fallback. See REPORT/TODO.
 * =========================================================================== */
(() => {
  'use strict';

  // EmulatorJS 4.2.3, PINNED. 'stable'/'latest' would move under us; a number
  // does not. Read off data.jsdelivr.com (@emulatorjs/emulatorjs latest) and
  // the CDN docs on 2026-10-13.
  const EJS_VERSION = '4.2.3';
  const EJS_DATA = `https://cdn.emulatorjs.org/${EJS_VERSION}/data/`;

  // EJS_core takes a SYSTEM id and EmulatorJS picks that system's default core.
  // The system ids and the cores behind them are off emulatorjs.org/docs4devs/cores
  // (read 2026-10-13). `ext` holds only the file extensions that name ONE system
  // on their own: .zip, .7z and bare disc images (.iso/.cue/.bin/.chd) are left
  // out on purpose, because they do not, and guessing a core for them is how a
  // player boots the wrong machine and shows a black screen.
  const SYSTEMS = [
    { core: 'nes',        label: 'NES / Famicom',            ext: ['nes', 'fds', 'unf', 'unif'] },
    { core: 'snes',       label: 'SNES / Super Famicom',     ext: ['sfc', 'smc'] },
    { core: 'gb',         label: 'Game Boy / Color',         ext: ['gb', 'gbc', 'dmg'] },
    { core: 'gba',        label: 'Game Boy Advance',         ext: ['gba'] },
    { core: 'n64',        label: 'Nintendo 64',              ext: ['n64', 'z64', 'v64'] },
    { core: 'nds',        label: 'Nintendo DS',              ext: ['nds'] },
    { core: 'vb',         label: 'Virtual Boy',              ext: ['vb', 'vboy'] },
    { core: 'segaMD',     label: 'Sega Genesis / Mega Drive', ext: ['md', 'gen', 'smd'] },
    { core: 'segaMS',     label: 'Sega Master System',       ext: ['sms'] },
    { core: 'segaGG',     label: 'Sega Game Gear',           ext: ['gg'] },
    { core: 'sega32x',    label: 'Sega 32X',                 ext: ['32x'] },
    { core: 'segaCD',     label: 'Sega CD',                  ext: [] },
    { core: 'segaSaturn', label: 'Sega Saturn',              ext: [] },
    { core: 'psx',        label: 'PlayStation',              ext: ['pbp'] },
    { core: 'psp',        label: 'PSP',                      ext: [] },
    { core: 'atari2600',  label: 'Atari 2600',               ext: ['a26'] },
    { core: 'atari7800',  label: 'Atari 7800',               ext: ['a78'] },
    { core: 'lynx',       label: 'Atari Lynx',               ext: ['lnx'] },
    { core: 'jaguar',     label: 'Atari Jaguar',             ext: ['j64', 'jag'] },
    { core: 'pce',        label: 'PC Engine / TurboGrafx-16', ext: ['pce'] },
    { core: 'ngp',        label: 'Neo Geo Pocket',           ext: ['ngp', 'ngc'] },
    { core: 'ws',         label: 'WonderSwan',               ext: ['ws', 'wsc'] },
    { core: 'coleco',     label: 'ColecoVision',             ext: ['col'] },
    { core: 'c64',        label: 'Commodore 64',             ext: ['d64', 't64'] },
    { core: 'amiga',      label: 'Amiga',                    ext: ['adf', 'adz'] },
    { core: '3do',        label: '3DO',                      ext: [] },
    { core: 'arcade',     label: 'Arcade',                   ext: [] },
  ];

  const CORE_SET = new Set(SYSTEMS.map((s) => s.core));

  // Extension -> core, built from SYSTEMS above (first system that claims it).
  const EXT_CORE = (() => {
    const map = {};
    SYSTEMS.forEach((s) => s.ext.forEach((e) => { if (!map[e]) map[e] = s.core; }));
    return map;
  })();

  // Loose platform/format words -> core. The catalog's `platform` is often the
  // bucket "retro"; a specific source may still tag a row "nes", "genesis", etc,
  // and the `format` field can name the system too. Everything is lower-cased and
  // stripped of spaces/punctuation before lookup.
  const TOKEN_CORE = {
    nes: 'nes', famicom: 'nes', nintendoentertainmentsystem: 'nes',
    snes: 'snes', superfamicom: 'snes', supernintendo: 'snes', supernes: 'snes',
    gb: 'gb', gameboy: 'gb', gbc: 'gb', gameboycolor: 'gb',
    gba: 'gba', gameboyadvance: 'gba',
    n64: 'n64', nintendo64: 'n64',
    nds: 'nds', nintendods: 'nds', ds: 'nds',
    vb: 'vb', virtualboy: 'vb',
    segamd: 'segaMD', genesis: 'segaMD', megadrive: 'segaMD', segagenesis: 'segaMD', md: 'segaMD',
    sms: 'segaMS', mastersystem: 'segaMS', segamastersystem: 'segaMS',
    gg: 'segaGG', gamegear: 'segaGG', segagamegear: 'segaGG',
    sega32x: 'sega32x', '32x': 'sega32x',
    segacd: 'segaCD', megacd: 'segaCD',
    saturn: 'segaSaturn', segasaturn: 'segaSaturn',
    psx: 'psx', ps1: 'psx', psone: 'psx', playstation: 'psx', playstation1: 'psx',
    psp: 'psp', playstationportable: 'psp',
    atari2600: 'atari2600', '2600': 'atari2600', vcs: 'atari2600',
    atari7800: 'atari7800', '7800': 'atari7800',
    lynx: 'lynx', atarilynx: 'lynx',
    jaguar: 'jaguar', atarijaguar: 'jaguar',
    pce: 'pce', pcengine: 'pce', turbografx: 'pce', turbografx16: 'pce', tg16: 'pce',
    ngp: 'ngp', neogeopocket: 'ngp', ngpc: 'ngp',
    ws: 'ws', wonderswan: 'ws', wonderswancolor: 'ws',
    coleco: 'coleco', colecovision: 'coleco',
    c64: 'c64', commodore64: 'c64',
    amiga: 'amiga',
    '3do': '3do',
    arcade: 'arcade', mame: 'arcade', neogeo: 'arcade',
  };

  const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');

  /** The extension of a filename or URL, lower-cased, no dot. '' if none. */
  function extOf(nameOrUrl) {
    const s = String(nameOrUrl || '');
    let path = s;
    try { path = new URL(s).pathname; } catch { /* not a URL: treat as a name */ }
    const base = path.split('/').filter(Boolean).pop() || '';
    const m = base.toLowerCase().match(/\.([a-z0-9]{1,6})$/);
    return m ? m[1] : '';
  }

  /**
   * Decide which EmulatorJS core to boot, from strongest signal to weakest:
   *   an explicit core, then an explicit system id, then the platform word,
   *   then the format word, then the ROM's own file extension.
   * Returns a core string, or '' when nothing names one system for certain —
   * which is the case the on-screen system picker exists to cover.
   */
  function coreFor(opts) {
    const o = opts || {};
    if (o.core && CORE_SET.has(o.core)) return o.core;
    const bySystem = TOKEN_CORE[norm(o.system)];
    if (bySystem) return bySystem;
    const byPlatform = TOKEN_CORE[norm(o.platform)];
    if (byPlatform) return byPlatform;
    const byFormat = TOKEN_CORE[norm(o.format)] || EXT_CORE[norm(o.format)];
    if (byFormat) return byFormat;
    const byExt = EXT_CORE[extOf(o.name || o.fileName || o.romUrl)];
    if (byExt) return byExt;
    return '';
  }

  // The app's live accent, handed to EmulatorJS so its menu matches the house
  // look under whichever theme is active (red by default, gold under kids_warm).
  function accentHex() {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      const m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (m) return v;
    } catch { /* ignore */ }
    return '#FF3D47';
  }

  // ── overlay DOM (built once, lazily) ───────────────────────────────────────
  const state = {
    overlay: null,
    stage: null,
    setup: null,
    status: null,
    picker: null,
    fileInput: null,
    titleEl: null,
    frame: null,
    blobUrl: '',
    watchdog: 0,
    booted: false,
    pending: null, // { src, title, core }
    lastFocus: null,
    onKeydown: null,
    onMessage: null,
  };

  function h(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function ensureOverlay() {
    if (state.overlay) return state.overlay;

    // Prefer markup already in index.html (stable ids for the smoke harness and
    // for the service worker's shell), fall back to building it.
    let overlay = document.getElementById('emulator-overlay');
    const built = !overlay;
    if (!overlay) {
      overlay = h('div', 'emulator-overlay');
      overlay.id = 'emulator-overlay';
    }
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Game player');

    if (built) {
      const bar = h('header', 'emulator-bar');
      const title = h('span', 'emulator-title');
      title.id = 'emulator-title';
      const close = h('button', 'emulator-close');
      close.id = 'emulator-close';
      close.type = 'button';
      close.textContent = 'Close';
      close.setAttribute('aria-label', 'Close the game player');
      bar.append(title, close);

      const stage = h('div', 'emulator-stage');
      stage.id = 'emulator-stage';

      const setup = h('div', 'emulator-setup');
      setup.id = 'emulator-setup';
      setup.hidden = true;
      stage.append(setup);
      overlay.append(bar, stage);
      document.body.append(overlay);
    }

    state.overlay = overlay;
    state.stage = overlay.querySelector('#emulator-stage') || overlay.querySelector('.emulator-stage');
    state.setup = overlay.querySelector('#emulator-setup') || overlay.querySelector('.emulator-setup');
    state.titleEl = overlay.querySelector('#emulator-title') || overlay.querySelector('.emulator-title');
    const closeBtn = overlay.querySelector('#emulator-close') || overlay.querySelector('.emulator-close');
    if (closeBtn && !closeBtn.dataset.bound) {
      closeBtn.dataset.bound = '1';
      closeBtn.addEventListener('click', () => close());
    }
    return overlay;
  }

  // Build the setup panel: a one-line status, a system picker, and a local-file
  // chooser that is always offered — it is the path that needs no network and no
  // CORS, so it is how a family member plays when a remote link will not load.
  function renderSetup(message, { needSystem = false } = {}) {
    const setup = state.setup;
    setup.replaceChildren();

    const status = h('p', 'emulator-status detail-copy', message || '');
    status.id = 'emulator-status';
    status.setAttribute('role', 'status');
    state.status = status;
    setup.append(status);

    if (needSystem) {
      const label = h('p', 'emulator-setup-label', 'Choose the system');
      const grid = h('div', 'emulator-picker');
      grid.id = 'emulator-picker';
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-label', 'Choose the system');
      // One button per DISTINCT core, labelled by its system.
      const seen = new Set();
      SYSTEMS.forEach((sys) => {
        if (seen.has(sys.core)) return;
        seen.add(sys.core);
        const b = h('button', 'secondary-button emulator-system', sys.label);
        b.type = 'button';
        b.dataset.core = sys.core;
        b.addEventListener('click', () => pickSystem(sys.core));
        grid.append(b);
      });
      state.picker = grid;
      setup.append(label, grid);
    }

    // Always present: load a ROM from this device.
    const fileRow = h('div', 'emulator-file');
    const fileLabel = h('label', 'emulator-file-label', 'Or load a ROM from this device');
    fileLabel.setAttribute('for', 'emulator-file-input');
    const input = h('input');
    input.id = 'emulator-file-input';
    input.type = 'file';
    input.accept = '.nes,.fds,.sfc,.smc,.gb,.gbc,.gba,.n64,.z64,.v64,.nds,.md,.gen,.smd,.sms,.gg,.32x,.pce,.ngp,.ws,.wsc,.vb,.a26,.a78,.lnx,.col,.d64,.t64,.adf,.zip,.7z,.chd,.cue,.bin,.iso,.pbp';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (f) chooseFile(f);
    });
    state.fileInput = input;
    fileRow.append(fileLabel, input);
    setup.append(fileRow);

    setup.hidden = false;
  }

  function showSetup() { if (state.setup) state.setup.hidden = false; }
  function hideSetup() { if (state.setup) state.setup.hidden = true; }

  function pickSystem(core) {
    if (!state.pending) state.pending = {};
    state.pending.core = core;
    if (state.pending.src) {
      launch(state.pending);
    } else {
      renderSetup('Now choose a ROM file to play on ' + labelForCore(core) + '.', { needSystem: true });
      // keep the picked system visually marked
      markPicked(core);
    }
  }

  function markPicked(core) {
    if (!state.picker) return;
    state.picker.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', b.dataset.core === core ? 'true' : 'false');
    });
  }

  function labelForCore(core) {
    const s = SYSTEMS.find((x) => x.core === core);
    return s ? s.label : core;
  }

  function chooseFile(file) {
    revokeBlob();
    state.blobUrl = URL.createObjectURL(file);
    if (!state.pending) state.pending = {};
    state.pending.src = state.blobUrl;
    state.pending.title = state.pending.title || file.name.replace(/\.[^.]+$/, '');
    const core = state.pending.core || coreFor({ name: file.name });
    if (core) {
      state.pending.core = core;
      launch(state.pending);
    } else {
      renderSetup('Could not tell which system "' + file.name + '" is for. Pick it below.', { needSystem: true });
    }
  }

  function revokeBlob() {
    if (state.blobUrl) {
      try { URL.revokeObjectURL(state.blobUrl); } catch { /* ignore */ }
      state.blobUrl = '';
    }
  }

  // Build the srcdoc that boots EmulatorJS for ONE ROM. Everything is inlined so
  // the iframe needs no file of its own; the only network it does is the CDN
  // loader.js and, from inside it, the cores and the ROM.
  function frameDoc({ src, core, title }) {
    const cfg = {
      core,
      gameUrl: src,
      gameName: title || 'Game',
      pathtodata: EJS_DATA,
      color: accentHex(),
    };
    const j = (v) => JSON.stringify(String(v));
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
  html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden;}
  #game{width:100%;height:100%;}
</style></head><body>
<div id="game"></div>
<script>
  window.EJS_player = '#game';
  window.EJS_core = ${j(cfg.core)};
  window.EJS_gameUrl = ${j(cfg.gameUrl)};
  window.EJS_gameName = ${j(cfg.gameName)};
  window.EJS_pathtodata = ${j(cfg.pathtodata)};
  window.EJS_color = ${j(cfg.color)};
  window.EJS_startOnLoaded = true;
  window.EJS_ready = function(){ try { parent.postMessage({ __blz_emu: 'ready' }, '*'); } catch(e){} };
  window.EJS_onGameStart = function(){ try { parent.postMessage({ __blz_emu: 'start' }, '*'); } catch(e){} };
<\/script>
<script src=${j(EJS_DATA + 'loader.js')}><\/script>
</body></html>`;
  }

  function launch(pending) {
    const { src, core, title } = pending;
    if (!src || !core) return;
    hideSetup();
    teardownFrame();

    const frame = document.createElement('iframe');
    frame.className = 'emulator-frame';
    frame.id = 'emulator-frame';
    frame.title = title || 'Game';
    // The emulator's own fullscreen button and gamepad mapping need these; the
    // launch click is the user gesture that lets audio start.
    frame.setAttribute('allow', 'fullscreen; gamepad; autoplay');
    frame.setAttribute('allowfullscreen', 'true');
    frame.srcdoc = frameDoc({ src, core, title });
    state.stage.append(frame);
    state.frame = frame;
    state.booted = false;

    if (state.titleEl) state.titleEl.textContent = title || 'Game';

    // Watchdog: if nothing starts, the likeliest cause for a remote ROM is a
    // missing CORS header on the resolve link. Say so and leave the local-file
    // path available rather than a frozen black rectangle.
    clearWatchdog();
    state.watchdog = window.setTimeout(() => {
      if (state.booted) return;
      renderSetup(
        'This game is taking a while to start. If it was opened from the catalog, the '
        + 'download link may not allow in-browser play (a CORS header on the add-on). '
        + 'You can load a local copy of the ROM below.',
        { needSystem: !core }
      );
    }, 30000);
  }

  function clearWatchdog() {
    if (state.watchdog) { window.clearTimeout(state.watchdog); state.watchdog = 0; }
  }

  function teardownFrame() {
    if (state.frame) {
      try { state.frame.srcdoc = 'about:blank'; } catch { /* ignore */ }
      state.frame.remove();
      state.frame = null;
    }
    clearWatchdog();
    state.booted = false;
  }

  /**
   * open(opts) — show the player.
   *   opts.romUrl   a resolved, CORS-enabled ROM/zip URL (from /games/resolve)
   *   opts.file     a File the viewer chose (alternative to romUrl)
   *   opts.title    the game's name
   *   opts.core     an explicit EmulatorJS core/system id (optional)
   *   opts.system / opts.platform / opts.format / opts.fileName  hints for coreFor()
   * With no src at all it opens on the picker + local-file chooser.
   */
  function open(opts) {
    const o = opts || {};
    ensureOverlay();
    bindGlobalHandlers();

    state.lastFocus = document.activeElement;
    revokeBlob();

    let src = '';
    if (o.file instanceof File || (o.file && typeof o.file === 'object' && 'name' in o.file)) {
      state.blobUrl = URL.createObjectURL(o.file);
      src = state.blobUrl;
    } else if (o.romUrl) {
      src = String(o.romUrl);
    }

    const title = (o.title && String(o.title)) || (o.fileName ? String(o.fileName).replace(/\.[^.]+$/, '') : 'Game');
    const core = coreFor({
      core: o.core, system: o.system, platform: o.platform,
      format: o.format, name: o.fileName || o.file && o.file.name, romUrl: o.romUrl,
    });

    state.pending = { src, title, core };
    if (state.titleEl) state.titleEl.textContent = title;

    state.overlay.hidden = false;
    document.documentElement.classList.add('emulator-open');

    if (src && core) {
      launch(state.pending);
    } else if (src && !core) {
      renderSetup('Choose the system this game is for.', { needSystem: true });
    } else {
      renderSetup('Load a ROM to play, or choose a system first.', { needSystem: true });
    }
    // Move focus into the player for keyboard and screen-reader users.
    const closeBtn = state.overlay.querySelector('.emulator-close');
    if (closeBtn) { try { closeBtn.focus(); } catch { /* ignore */ } }
    return true;
  }

  function close() {
    teardownFrame();
    revokeBlob();
    state.pending = null;
    if (state.overlay) state.overlay.hidden = true;
    document.documentElement.classList.remove('emulator-open');
    unbindGlobalHandlers();
    if (state.lastFocus && typeof state.lastFocus.focus === 'function') {
      try { state.lastFocus.focus(); } catch { /* ignore */ }
    }
    state.lastFocus = null;
  }

  function isOpen() { return !!(state.overlay && !state.overlay.hidden); }

  function bindGlobalHandlers() {
    if (!state.onKeydown) {
      state.onKeydown = (e) => {
        if (e.key === 'Escape' && isOpen() && !isFrameFullscreen()) { e.preventDefault(); close(); }
      };
      document.addEventListener('keydown', state.onKeydown);
    }
    if (!state.onMessage) {
      state.onMessage = (e) => {
        if (!state.frame || e.source !== state.frame.contentWindow) return;
        const d = e.data;
        if (d && (d.__blz_emu === 'start' || d.__blz_emu === 'ready')) {
          state.booted = true;
          clearWatchdog();
          hideSetup();
        }
      };
      window.addEventListener('message', state.onMessage);
    }
  }

  function unbindGlobalHandlers() {
    if (state.onKeydown) { document.removeEventListener('keydown', state.onKeydown); state.onKeydown = null; }
    if (state.onMessage) { window.removeEventListener('message', state.onMessage); state.onMessage = null; }
  }

  function isFrameFullscreen() {
    // When the emulator is fullscreen, Escape belongs to it (it exits fullscreen),
    // not to our overlay.
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  window.BlazingEmulator = Object.assign(window.BlazingEmulator || {}, {
    open, close, isOpen, coreFor,
    // Exposed for the smoke harness and for anyone wiring another entry point.
    SYSTEMS, EJS_VERSION, EJS_DATA,
  });
})();
