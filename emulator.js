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
 * THE ONE EXTERNAL DEPENDENCY THAT CAN FAIL. A remote ROM is fetched by the
 * emulator cross-origin, so it needs CORS on the host that finally serves it.
 * /games/resolve can answer `playPath`, the add-on's own CORS-enabled copy of the
 * file, and games.js hands that over when it is there (resolveForPlay). A plain
 * debrid link may not allow it; the watchdog below then says so and offers the
 * always-present "load a ROM from this device" path.
 *
 * WHICH ROWS GET A BUTTON — see verdict(). Every row on one of the 27 systems
 * below does. A row that names no machine at all but is plainly retro gets one
 * too, and the on-screen picker asks which machine it is. A row that names a
 * machine EmulatorJS cannot run gets none. And a system that cannot start ON
 * THIS PAGE (a BIOS we cannot ship, a browser feature the host cannot turn on)
 * keeps its button but disabled, with one plain sentence saying why, instead of
 * a black screen after a long download.
 * =========================================================================== */
(() => {
  'use strict';

  // EmulatorJS 4.2.3, PINNED. 'stable'/'latest' would move under us; a number
  // does not. Read off data.jsdelivr.com (@emulatorjs/emulatorjs latest) and
  // the CDN docs on 2026-10-13; data/version.json on the CDN answers "4.2.3".
  const EJS_VERSION = '4.2.3';
  const EJS_DATA = `https://cdn.emulatorjs.org/${EJS_VERSION}/data/`;

  // ── THE 27 SYSTEMS ─────────────────────────────────────────────────────────
  //
  // EJS_core takes a SYSTEM id and EmulatorJS picks that system's default core
  // (getCores() in data/src/emulator.js, 4.2.3). `ext` holds only the file
  // extensions that name ONE system on their own, taken from each core's own
  // list in data/cores/cores.json: .zip, .7z and bare disc images
  // (.iso/.cue/.bin/.chd/.pbp) are left out on purpose, because they do not, and
  // guessing a core for them is how a player boots the wrong machine.
  //
  // `needs` is what stops a system starting on this page, checked 14 Oct 2026:
  //   'bios'     the default core will not boot without a BIOS file, and a
  //              public repo cannot ship one. Sega CD and ColecoVision say
  //              "Required" on emulatorjs.org/docs/systems; 3DO's core (Opera)
  //              logs "no BIOS ROM found" and runs nothing (opera_lr_opts.c).
  //   'threads'  PSP: requiresThreads() is ["ppsspp", "dosbox_pure"] in 4.2.3, and
  //              the docs page says it needs EJS_threads = true. Threads need
  //              SharedArrayBuffer, which only a cross-origin-isolated page
  //              (COOP + COEP headers) has. GitHub Pages cannot send headers, so
  //              the check is made at run time — see isolated().
  // `disc` marks the CD systems. Their images are hundreds of MB and reach the
  // browser through the add-on's play relay — the house's own upload link — so
  // one takes minutes to arrive, and the player says so while it loads.
  // NOT listed as needing one, though a docs page says "Required": DS (the
  // EmulatorJS melonDS fork logs "Using FreeBIOS" and carries on), Lynx (Handy
  // falls back to its internal boot ROM), PlayStation (pcsx_rearmed's HLE BIOS),
  // Saturn (Yabause's HLE BIOS) and Amiga (PUAE's built-in AROS). Each was read
  // in the EmulatorJS fork of that core, not assumed.
  const SYSTEMS = [
    { core: 'nes',        label: 'NES / Famicom',             ext: ['nes', 'unf', 'unif'] },
    { core: 'snes',       label: 'SNES / Super Famicom',      ext: ['sfc', 'smc', 'swc', 'fig'] },
    { core: 'gb',         label: 'Game Boy / Color',          ext: ['gb', 'gbc', 'dmg'] },
    { core: 'gba',        label: 'Game Boy Advance',          ext: ['gba'] },
    { core: 'n64',        label: 'Nintendo 64',               ext: ['n64', 'z64', 'v64'] },
    { core: 'nds',        label: 'Nintendo DS',               ext: ['nds'] },
    { core: 'vb',         label: 'Virtual Boy',               ext: ['vb', 'vboy'] },
    { core: 'segaMD',     label: 'Sega Genesis / Mega Drive', ext: ['md', 'gen', 'smd'] },
    { core: 'segaMS',     label: 'Sega Master System',        ext: ['sms'] },
    { core: 'segaGG',     label: 'Sega Game Gear',            ext: ['gg'] },
    { core: 'sega32x',    label: 'Sega 32X',                  ext: ['32x'] },
    { core: 'segaCD',     label: 'Sega CD',                   ext: [], needs: 'bios', disc: true },
    { core: 'segaSaturn', label: 'Sega Saturn',               ext: [], disc: true },
    { core: 'psx',        label: 'PlayStation',               ext: [], disc: true },
    { core: 'psp',        label: 'PSP',                       ext: [], needs: 'threads', disc: true },
    { core: 'atari2600',  label: 'Atari 2600',                ext: ['a26'] },
    { core: 'atari7800',  label: 'Atari 7800',                ext: ['a78'] },
    { core: 'lynx',       label: 'Atari Lynx',                ext: ['lnx'] },
    { core: 'jaguar',     label: 'Atari Jaguar',              ext: ['j64', 'jag'] },
    { core: 'pce',        label: 'PC Engine / TurboGrafx-16', ext: ['pce'] },
    { core: 'ngp',        label: 'Neo Geo Pocket',            ext: ['ngp', 'ngc'] },
    { core: 'ws',         label: 'WonderSwan',                ext: ['ws', 'wsc'] },
    { core: 'coleco',     label: 'ColecoVision',              ext: ['col', 'cv'], needs: 'bios' },
    { core: 'c64',        label: 'Commodore 64',              ext: ['d64', 't64', 'g64'] },
    { core: 'amiga',      label: 'Amiga',                     ext: ['adf', 'adz', 'dms', 'ipf'] },
    { core: '3do',        label: '3DO',                       ext: [], needs: 'bios', disc: true },
    { core: 'arcade',     label: 'Arcade',                    ext: [] },
  ];

  const CORE_SET = new Set(SYSTEMS.map((s) => s.core));
  const SYSTEM_BY_CORE = new Map(SYSTEMS.map((s) => [s.core, s]));

  // What detect() answers. `none` is a machine no EmulatorJS 4.2.3 core runs, so
  // no button at all. `bucket` is the add-on's `retro` token: the archive, not a
  // machine. `variant` is a machine that runs under one of the 27 systems only
  // with a BIOS file of its own (the Famicom Disk System under NES).
  const NONE = Object.freeze({ none: true });
  const BUCKET = Object.freeze({ bucket: true });
  const hit = (core, variant = '') => Object.freeze({ core, variant });

  /** ASCII, lower case, nothing but letters and digits: "Sega Genesis" -> "segagenesis". */
  const norm = (v) => String(v == null ? '' : v).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  /** The same, with each run of punctuation kept as ONE space, so \b can see words. */
  const words = (v) => String(v == null ? '' : v).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // ── ONE-WORD TOKENS: what a `platform`, `system` or `format` field holds ──
  //
  // The add-on's own vocabulary, read off the live add-on on 14 Oct 2026:
  // PLATFORMS (GET /games/sources: ps5 … nds … retro, arcade), the retro system
  // ids (GET /games/systems: nes, fds, snes, n64, gb, gbc, gba, genesis,
  // mastersystem, gamegear, psx, arcade, atari2600, virtualboy, pokemonmini),
  // and the row tokens its sources send (`ps1` from NoPayStation, `psp` from the
  // PSP Game Browser, `nds`/`arcade`/`retro` from NYC Games). Plus every
  // EmulatorJS system id, and the common spellings of each machine.
  const TOKENS = (() => {
    const t = {};
    SYSTEMS.forEach((s) => { t[norm(s.core)] = hit(s.core); });
    const alias = {
      nes: ['famicom', 'nintendoentertainmentsystem'],
      snes: ['superfamicom', 'supernintendo', 'supernes', 'sfc'],
      gb: ['gameboy', 'gbc', 'gameboycolor', 'gameboycolour'],
      gba: ['gameboyadvance'],
      n64: ['nintendo64'],
      nds: ['nintendods', 'ds'],
      vb: ['virtualboy'],
      segaMD: ['genesis', 'megadrive', 'segagenesis', 'segamegadrive', 'md'],
      segaMS: ['mastersystem', 'segamastersystem', 'sms'],
      segaGG: ['gamegear', 'segagamegear', 'gg'],
      segaCD: ['megacd', 'segamegacd'],
      segaSaturn: ['saturn'],
      psx: ['ps1', 'psone', 'playstation', 'playstation1'],
      psp: ['playstationportable'],
      atari2600: ['2600', 'vcs'],
      atari7800: ['7800'],
      lynx: ['atarilynx'],
      jaguar: ['atarijaguar'],
      pce: ['pcengine', 'turbografx', 'turbografx16', 'tg16'],
      ngp: ['neogeopocket', 'neogeopocketcolor', 'ngpc'],
      ws: ['wonderswan', 'wonderswancolor', 'wsc'],
      coleco: ['colecovision'],
      c64: ['commodore64'],
      amiga: ['commodoreamiga'],
      arcade: ['mame', 'fbneo', 'finalburnneo'],
    };
    Object.entries(alias).forEach(([core, list]) => list.forEach((w) => { t[w] = hit(core); }));
    t.fds = hit('nes', 'fds');
    t.famicomdisksystem = hit('nes', 'fds');
    t.neogeo = hit('arcade', 'neogeo');
    // The add-on's tokens for machines no EmulatorJS 4.2.3 core runs.
    ['ps5', 'ps4', 'ps3', 'ps2', 'psvita', 'switch', 'wiiu', 'wii', 'gamecube', '3ds', 'xboxone',
      'xbox360', 'xbox', 'dreamcast', 'triforce', 'pc', 'mac', 'linux', 'android', 'pokemonmini',
    ].forEach((w) => { t[w] = NONE; });
    t.retro = BUCKET;
    return t;
  })();

  // Extension -> system, built from SYSTEMS above, plus the one variant a file
  // extension names by itself.
  const EXT = (() => {
    const map = {};
    SYSTEMS.forEach((s) => s.ext.forEach((e) => { if (!map[e]) map[e] = hit(s.core); }));
    map.fds = hit('nes', 'fds');
    return map;
  })();

  // ── FREE TEXT: the machine an ARCHIVE row names ───────────────────────────
  //
  // The add-on passes a release's own platform text through untouched, and it is
  // never a token: "Nintendo - Nintendo Entertainment System (Headered)"
  // (No-Intro), "Nintendo Game Boy" (TOSEC), "RA - Super Nintendo Entertainment
  // System" (RetroAchievements), "Sega Mark III & Master System" — all measured on
  // the live /games/search, 14 Oct 2026. NYC Games keeps platform at `retro` and
  // names the machine in its collection instead ("NYC Games · Super Nintendo ·
  // ZIP · archive.org"). An exact-token lookup matched NONE of those, so the
  // Play button never showed on a real catalog row. These rules read text the
  // way the add-on's own RETRO_RULES do (lib/game-sources.js): ASCII, lower case,
  // punctuation to spaces, most specific first ("game boy advance" before "game
  // boy", "super nintendo" before "nintendo entertainment system", "mega cd"
  // and "32x" before "mega drive") — extended to all 27 systems.
  //
  // A TEXT THAT NAMES A MACHINE THESE RULES DO NOT KNOW GETS NO BUTTON — see
  // detect(). Measured: the same retro search returns "IBM PC Compatibles",
  // "Sharp X68000", "Tiger Electronics Game.com" and, under platform=arcade,
  // TeknoParrot PC loaders ("!EXTRAS Loaders JConfig …") and Naomi GD-ROMs. A
  // picker cannot help any of those; it would be a dead-end press. The NONE rules
  // first name the ones a looser rule below would otherwise claim.
  const RULES = [
    // Not a game at all: "SPC Music … SNES" (sound files), "PlayStation Portable
    // (UMD Video)" (films on a disc) — both measured under a retro search.
    [/\bmusic\b|\bumd video\b/, NONE],
    [/\bplaystation ?(2|3|4|5|vita)\b|\bps ?[2-5]\b|\bps ?vita\b/, NONE],
    [/\bgame ?cube\b|\bwii\b|\bswitch\b|\b3ds\b|\bnintendo dsi\b|\b64 ?dd\b|\bpokemon mini\b/, NONE],
    [/\bdreamcast\b|\bnaomi\b|\batomiswave\b|\bchihiro\b|\blindbergh\b|\btriforce\b|\bxbox\b/, NONE],
    [/\bjaguar ?cd\b|\bcd ?32\b|\bcdtv\b|\bneo ?geo ?cd\b|\bpc ?fx\b/, NONE],
    [/\bdisk system\b|\bfds\b/, hit('nes', 'fds')],
    [/\bpc ?engine ?cd\b|\bturbo ?grafx ?cd\b|\bpce ?cd\b|\bsuper ?cd ?rom\b/, hit('pce', 'pcecd')],
    [/\b(sega|mega|genesis) ?cd\b/, hit('segaCD')],
    [/\b32x\b/, hit('sega32x')],
    [/\bplaystation portable\b|\bpsp\b/, hit('psp')],
    [/\bgame ?boy advance\b|\bgba\b/, hit('gba')],
    [/\bgame ?boy\b|\bgbc\b/, hit('gb')],
    [/\bvirtual ?boy\b/, hit('vb')],
    [/\bsuper (famicom|nintendo)\b|\bsnes\b/, hit('snes')],
    [/\bnintendo 64\b|\bn64\b/, hit('n64')],
    [/\bnintendo ds\b|\bnds\b/, hit('nds')],
    [/\bfamicom\b|\bnintendo entertainment system\b|\bnes\b/, hit('nes')],
    [/\bmega ?drive\b|\bgenesis\b/, hit('segaMD')],
    [/\bmaster system\b|\bmark iii\b/, hit('segaMS')],
    [/\bgame ?gear\b/, hit('segaGG')],
    [/\bsaturn\b/, hit('segaSaturn')],
    [/\batari ?2600\b|\bvcs\b/, hit('atari2600')],
    [/\batari ?7800\b/, hit('atari7800')],
    [/\blynx\b/, hit('lynx')],
    [/\bjaguar\b/, hit('jaguar')],
    [/\bpc ?engine\b|\bturbo ?grafx\b|\bsuper ?grafx\b|\btg ?16\b/, hit('pce')],
    [/\bneo ?geo ?pocket\b|\bngpc?\b/, hit('ngp')],
    [/\bwonder ?swan\b|\bwswan\b/, hit('ws')],
    [/\bcoleco ?vision\b/, hit('coleco')],
    [/\bcommodore 64\b|\bc64\b/, hit('c64')],
    [/\bamiga\b/, hit('amiga')],
    [/\b3do\b/, hit('3do')],
    [/\bplaystation\b|\bpsx\b|\bps ?1\b|\bps ?one\b/, hit('psx')],
    // Neo Geo MVS/AES carts are arcade sets that FBNeo runs only beside the Neo
    // Geo BIOS set (neogeo.zip). Same reason as the BIOS systems above.
    [/\bneo ?geo\b/, hit('arcade', 'neogeo')],
    // The arcade core is FBNeo. NOT the bare word "arcade": "Eggman's Arcade
    // Repository" is TeknoParrot PC loaders, not a single FBNeo set.
    [/\bfinal ?burn\b|\bfbneo\b|\bhb ?mame\b|\bmame\b|\bcp ?system\b|\bcps ?[123]\b/, hit('arcade')],
    // A MAME SOFTWARE LIST names its machine by MAME's short name ("Software List
    // ROMs (merged) wswan"). One the rules above did not catch is NOT an arcade
    // set, so it must not fall through to the collection ("MAME") below.
    [/\bsoftware list\b/, NONE],
  ];

  // Formats that are never a game: MAME's artwork packs ("all_non-zipped_content
  // gameover", format PNG) and a host's page (NYC Games, format HTML).
  const NOT_GAME = new Set(['png', 'jpg', 'jpeg', 'gif', 'ico', 'bmp', 'webp', 'txt', 'nfo', 'pdf',
    'html', 'htm', 'xml', 'dat', 'json', 'mp3', 'ogg', 'wav', 'flac', 'mp4', 'mkv', 'avi']);

  function ruleHit(text) {
    const w = words(text);
    if (!w) return null;
    for (const [re, out] of RULES) if (re.test(w)) return out;
    return null;
  }

  /** A collection minus the parts that are host names ("archive.org", "1fichier.com"). */
  function machineText(collection) {
    return String(collection == null ? '' : collection).split(/[·|]/)
      .map((s) => s.trim())
      .filter((s) => s && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s))
      .join(' ');
  }

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
   * Which system a release is for, from the strongest signal to the weakest:
   * an explicit core, an explicit system id, the platform, then — only when the
   * platform names no machine (the `retro` bucket, or nothing) — the collection,
   * the format, and the ROM's own file extension.
   *
   * A platform that is FREE TEXT is a machine name, and the rules decide it,
   * with one fallback: the archive's collection. Minerva files MAME sets as
   * platform "ROMs (merged)" in collection "MAME", so the collection is the only
   * place that one names its machine. A text neither of them knows is a machine
   * we cannot run (NONE) — not a reason to guess from the format.
   */
  function detect(opts) {
    const o = opts || {};
    if (o.core && CORE_SET.has(o.core)) return hit(o.core);
    if (NOT_GAME.has(norm(o.format))) return NONE;
    const bySystem = TOKENS[norm(o.system)];
    if (bySystem && !bySystem.bucket) return bySystem;
    const platform = String(o.platform == null ? '' : o.platform).trim();
    const byToken = TOKENS[norm(platform)];
    if (byToken && !byToken.bucket) return byToken;
    if (platform && !byToken) return ruleHit(platform) || ruleHit(machineText(o.collection)) || NONE;
    const byCollection = ruleHit(machineText(o.collection));
    if (byCollection) return byCollection;
    const f = norm(o.format);
    const byFormat = (TOKENS[f] && TOKENS[f].core ? TOKENS[f] : null) || EXT[f];
    if (byFormat) return byFormat;
    const byExt = EXT[extOf(o.name || o.fileName || o.romUrl)];
    if (byExt) return byExt;
    return byToken || {};
  }

  /**
   * The EmulatorJS system to boot, or '' when nothing names one system for
   * certain — which is the case the on-screen system picker exists to cover.
   */
  function coreFor(opts) {
    const d = detect(opts);
    return d.none ? '' : (d.core || '');
  }

  // ── WHY A KNOWN SYSTEM CANNOT START HERE ──────────────────────────────────
  // One plain sentence each, saying what is missing. Shown under a disabled
  // "Play in browser" in the dialog, or in the player if it gets that far.
  const VARIANT_WHY = {
    fds: 'Famicom Disk System games need the Disk System BIOS file to start, and this page does not have one.',
    pcecd: 'PC Engine CD games need a CD BIOS file to start, and this page does not have one.',
    neogeo: 'Neo Geo games need the Neo Geo BIOS file to start, and this page does not have one.',
  };
  const PKG_WHY = 'This is a PlayStation Store package (.pkg). The in-browser player cannot open those, '
    + 'so pick a copy in another format.';
  const THREADS_WHY = 'PSP games need a browser feature this website cannot switch on, so they cannot play here yet.';
  const DISC_HINT = 'Disc games are big, so this one can take a few minutes to load before it starts.';

  /**
   * SharedArrayBuffer, which threaded cores need, exists only on a page served
   * with COOP + COEP headers. GitHub Pages cannot send headers at all, so on
   * kaoz625.github.io this is false; it is read at run time so a host that does
   * send them gets PSP with no code change.
   */
  function isolated() {
    return window.crossOriginIsolated === true && typeof window.SharedArrayBuffer === 'function';
  }

  function blockedReason(core, variant, format) {
    if (variant && VARIANT_WHY[variant]) return VARIANT_WHY[variant];
    if (norm(format) === 'pkg') return PKG_WHY;
    const sys = SYSTEM_BY_CORE.get(core);
    if (!sys) return '';
    if (sys.needs === 'bios') return `${sys.label} games need a ${sys.label} BIOS file to start, and this page does not have one.`;
    if (sys.needs === 'threads' && !isolated()) return THREADS_WHY;
    return '';
  }

  /**
   * What the Games dialog does with a release:
   *   { core, ask: false, blocked: '' }   a Play button that boots `core`
   *   { core, ask: false, blocked: why }  a DISABLED Play button and `why` under it
   *   { core: '', ask: true }             a Play button; the player asks the system
   *   { core: '', ask: false }            no Play button: not a machine we run
   * opts: platform, collection, format (the row), and `retro` — true when the
   * caller knows the row came from a retro archive, so that a row naming no
   * machine at all is still plainly a retro game.
   */
  function verdict(opts) {
    const o = opts || {};
    const d = detect(o);
    if (d.none) return { core: '', ask: false, blocked: '' };
    if (d.core) return { core: d.core, ask: false, blocked: blockedReason(d.core, d.variant, o.format) };
    return { core: '', ask: Boolean(d.bucket || o.retro), blocked: '' };
  }

  // A live colour token, handed to EmulatorJS so its menu and its ground match
  // the house look under whichever theme is active (red by default, gold under
  // kids_warm).
  function tokenHex(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return v;
    } catch { /* ignore */ }
    return fallback;
  }

  /** A file name we can hand on: the last path piece, with an extension, or ''. */
  function safeName(value) {
    const base = String(value == null ? '' : value).split(/[\\/]/).pop().trim();
    return /\.[a-z0-9]{1,6}$/i.test(base) ? base.slice(-180) : '';
  }

  /**
   * THE ROM'S REAL NAME, ON THE END OF ITS URL AS A FRAGMENT: `<url>#/<name>`.
   *
   * EmulatorJS 4.2.3 names the file it hands the core after the LAST PATH PIECE
   * of EJS_gameUrl. Read in its own data/src/emulator.js (14 Oct 2026):
   * getBaseFileName(true) is `gameUrl.split("/").pop().split("#")[0]
   * .split("?")[0]`, and nothing on that path calls decodeURIComponent. The
   * add-on's CORS copy is /games/play?t=<token>, so the core would be handed a
   * file called "play" with no extension: genesis_plus_gx tells a Master System
   * cart from a Mega Drive one by it, and FBNeo finds an arcade game by its set
   * name ("sf2.zip") and nothing else. (A .zip of one ROM is fine either way —
   * EmulatorJS unzips it and uses the names inside.)
   *
   * WHY A FRAGMENT, not `&f=/<name>` on the query. Both give the same last
   * piece, but a fragment is never sent — XHR drops it, so the request the
   * add-on sees is byte-for-byte the one it signed, and a `url` fallback (a
   * signed CDN link that may check its whole query) is untouched too. The same
   * piece keys EmulatorJS's IndexedDB ROM cache ("rom" store, by
   * `gameUrl.split("/").pop()`), so the cache is keyed by the real name, not by
   * "play" for every game.
   *
   * THE NAME GOES IN RAW, because EmulatorJS does not decode it: encoded, a
   * file would reach the core as "Super%20Mario%20Bros..zip". The only
   * characters that would break the split above are cut first — safeName()
   * keeps the last path piece, and "#" and "?" become "_".
   */
  function namedUrl(src, fileName) {
    const s = String(src || '');
    const name = safeName(fileName).replace(/[#?]/g, '_');
    if (!name || !/^https?:/i.test(s)) return s;
    return `${s.split('#')[0]}#/${name}`;
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
    hintEl: null,
    frame: null,
    blobUrl: '',
    watchdog: 0,
    booted: false,
    pending: null, // { src, title, core, variant, format, fileName }
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
    // One quiet line under the bar, shown only while a slow game loads.
    let hint = overlay.querySelector('#emulator-hint');
    if (!hint) {
      hint = h('p', 'emulator-hint');
      hint.id = 'emulator-hint';
      hint.setAttribute('role', 'status');
      hint.hidden = true;
      overlay.insertBefore(hint, state.stage);
    }
    state.hintEl = hint;
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
    state.picker = null;

    if (needSystem) {
      const label = h('p', 'emulator-setup-label', 'Choose the system');
      const grid = h('div', 'emulator-picker');
      grid.id = 'emulator-picker';
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-label', 'Choose the system');
      SYSTEMS.forEach((sys) => {
        const b = h('button', 'secondary-button emulator-system', sys.label);
        b.type = 'button';
        b.dataset.core = sys.core;
        b.addEventListener('click', () => pickSystem(sys.core));
        grid.append(b);
      });
      state.picker = grid;
      // Said once, in plain words: the list IS the set this page can play.
      const unlisted = h('p', 'emulator-status detail-copy', 'If its system is not in this list, this page cannot play it.');
      setup.append(label, grid, unlisted);
    }

    // Always present: load a ROM from this device.
    const fileRow = h('div', 'emulator-file');
    const fileLabel = h('label', 'emulator-file-label', 'Or load a ROM from this device');
    fileLabel.setAttribute('for', 'emulator-file-input');
    const input = h('input');
    input.id = 'emulator-file-input';
    input.type = 'file';
    const exts = new Set(SYSTEMS.flatMap((s) => s.ext));
    ['fds', 'zip', '7z', 'rar', 'chd', 'cue', 'bin', 'iso', 'img', 'ccd', 'm3u', 'pbp', 'cso'].forEach((e) => exts.add(e));
    input.accept = [...exts].map((e) => `.${e}`).join(',');
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (f) chooseFile(f);
    });
    state.fileInput = input;
    fileRow.append(fileLabel, input);
    setup.append(fileRow);

    setup.hidden = false;
  }

  function hideSetup() { if (state.setup) state.setup.hidden = true; }

  function setHint(text) {
    if (!state.hintEl) return;
    state.hintEl.textContent = text || '';
    state.hintEl.hidden = !text;
  }

  function pickSystem(core) {
    if (!state.pending) state.pending = {};
    state.pending.core = core;
    // A system picked by hand is that system: a variant read off the row (the
    // Disk System) no longer applies. A .pkg is still a .pkg.
    state.pending.variant = '';
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
    const s = SYSTEM_BY_CORE.get(core);
    return s ? s.label : core;
  }

  function chooseFile(file) {
    revokeBlob();
    state.blobUrl = URL.createObjectURL(file);
    if (!state.pending) state.pending = {};
    const p = state.pending;
    p.src = state.blobUrl;
    p.fileName = safeName(file.name);
    p.format = extOf(file.name);
    p.title = p.title || file.name.replace(/\.[^.]+$/, '');
    // The file's own extension, when it names one system, beats whatever the
    // player was opened on: a .gba loaded after a catalog NES row did not start
    // is a Game Boy Advance game. A bare .zip keeps the system already picked.
    const d = detect({ name: file.name });
    if (d.core) {
      p.core = d.core;
      p.variant = d.variant || '';
    }
    if (p.core) {
      launch(p);
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
  function frameDoc({ src, core, gameName, threads }) {
    const ground = tokenHex('--bg', '#0A0A0B');
    const j = (v) => JSON.stringify(String(v));
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
  html,body{margin:0;padding:0;height:100%;background:${ground};overflow:hidden;}
  #game{width:100%;height:100%;}
</style></head><body>
<div id="game"></div>
<script>
  window.EJS_player = '#game';
  window.EJS_core = ${j(core)};
  window.EJS_gameUrl = ${j(src)};
  window.EJS_gameName = ${j(gameName || 'Game')};
  window.EJS_pathtodata = ${j(EJS_DATA)};
  window.EJS_color = ${j(tokenHex('--accent', '#FF3D47'))};
  // EmulatorJS paints rgb(51,51,51) behind the game by default: the grey the
  // house banned. The page black instead.
  window.EJS_backgroundColor = ${j(ground)};
  ${threads ? 'window.EJS_threads = true;' : ''}
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
    teardownFrame();

    // A system that cannot start on this page says so, in the player, instead of
    // downloading a ROM into a black screen.
    const reason = blockedReason(core, pending.variant, pending.format);
    if (reason) {
      renderSetup(reason);
      return;
    }
    hideSetup();

    const blob = src.startsWith('blob:');
    const frame = document.createElement('iframe');
    frame.className = 'emulator-frame';
    frame.id = 'emulator-frame';
    frame.title = title || 'Game';
    // The emulator's own fullscreen button and gamepad mapping need these; the
    // launch click is the user gesture that lets audio start.
    frame.setAttribute('allow', 'fullscreen; gamepad; autoplay');
    frame.setAttribute('allowfullscreen', 'true');
    frame.srcdoc = frameDoc({
      src: blob ? src : namedUrl(src, pending.fileName),
      core,
      // For a blob: URL EmulatorJS names the file after EJS_gameName instead of
      // the URL (getBaseFileName), so a local ROM keeps its extension that way.
      gameName: blob ? (safeName(pending.fileName) || title) : title,
      threads: (SYSTEM_BY_CORE.get(core) || {}).needs === 'threads' && isolated(),
    });
    state.stage.append(frame);
    state.frame = frame;
    state.booted = false;

    if (state.titleEl) state.titleEl.textContent = title || 'Game';
    // A CD image is hundreds of MB through the house's upload link: minutes, not
    // seconds. EmulatorJS's own text only counts a percentage, so say why.
    setHint((SYSTEM_BY_CORE.get(core) || {}).disc && !blob ? DISC_HINT : '');

    // Watchdog: if the emulator never comes up, the likeliest cause for a remote
    // ROM is a link that does not allow in-browser play. Say so and leave the
    // local-file path available rather than a frozen black rectangle.
    clearWatchdog();
    state.watchdog = window.setTimeout(() => {
      if (state.booted) return;
      renderSetup(
        'This game is taking a long time to start. The link it came from may not allow '
        + 'playing in the browser. You can load a copy of the ROM from this device below.',
        { needSystem: !core }
      );
    }, 30000);
  }

  function clearWatchdog() {
    if (state.watchdog) { window.clearTimeout(state.watchdog); state.watchdog = 0; }
  }

  function teardownFrame() {
    setHint('');
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
   *   opts.fileName the ROM's real file name, when the URL does not carry it
   *   opts.core     an explicit EmulatorJS core/system id (optional)
   *   opts.system / opts.platform / opts.collection / opts.format  hints for detect()
   * With no src at all it opens on the picker + local-file chooser.
   */
  function open(opts) {
    const o = opts || {};
    ensureOverlay();
    bindGlobalHandlers();

    state.lastFocus = document.activeElement;
    teardownFrame();
    revokeBlob();

    let src = '';
    let fileName = safeName(o.fileName);
    if (o.file instanceof File || (o.file && typeof o.file === 'object' && 'name' in o.file)) {
      state.blobUrl = URL.createObjectURL(o.file);
      src = state.blobUrl;
      fileName = safeName(o.file.name) || fileName;
    } else if (o.romUrl) {
      src = String(o.romUrl);
    }

    const title = (o.title && String(o.title)) || (fileName ? fileName.replace(/\.[^.]+$/, '') : 'Game');
    const d = detect({
      core: o.core, system: o.system, platform: o.platform, collection: o.collection,
      format: o.format, name: fileName, romUrl: o.romUrl,
    });

    state.pending = {
      src, title, fileName,
      core: d.none ? '' : (d.core || ''),
      variant: d.variant || '',
      format: o.format || extOf(fileName),
    };
    if (state.titleEl) state.titleEl.textContent = title;

    state.overlay.hidden = false;
    document.documentElement.classList.add('emulator-open');

    if (src && state.pending.core) {
      launch(state.pending);
    } else if (src) {
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
        // 'ready' is EmulatorJS's own UI coming up, before the ROM is fetched;
        // only 'start' means the game is running and the wait is over.
        if (d && d.__blz_emu === 'start') setHint('');
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
    open, close, isOpen, coreFor, verdict,
    // Exposed for the smoke harness and for anyone wiring another entry point.
    SYSTEMS, EJS_VERSION, EJS_DATA,
  });
})();
