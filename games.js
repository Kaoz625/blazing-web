/* Blazing web Games — a poster wall of the fleet's RAWG-backed catalogue.
 *
 * DISCOVERY ONLY, matching Roku's GamesScreen/Games.brs and Fire TV's
 * GameStore-adjacent catalogue: a poster, a description, screenshots and
 * (sometimes) a promo trailer clip — never playable game content. This file
 * was built directly against roku channels/source/lib/Games.brs and
 * components/screens/{GamesScreen,GameDetailScreen}.brs — read those for the
 * on-device behavior this mirrors.
 *
 * WIRE CONTRACT (fleet.lyreosai.com, blazing-fleet repo):
 *   GET /games/catalog?page=<n>&pageSize=40[&search=<q>]
 *       -> { configured: bool, count, page, hasNext, games: [{id,name,poster}] }
 *       configured !== true means the RAWG key is not set up server-side —
 *       NOT the same as an empty result, and shown as its own message.
 *   GET /games/catalog/<id>
 *       -> { found: bool, id, name, description, released, rating,
 *            metacritic, poster, genres[], platforms[], screenshots[],
 *            trailer, error? }
 *
 * No profile/rating gate here on purpose: grepping the whole Roku channel for
 * a gamesAllowedNow() finds nothing — unlike Manga (see manga.js), Games has
 * no age gate on any client in this fleet.
 */
'use strict';

(() => {
  const FLEET_BASE = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  const FETCH_TIMEOUT_MS = 20000;
  const PAGE_SIZE = 40;

  const state = {
    mounted: false,
    items: [],
    page: 0,
    hasNext: false,
    mode: 'catalog', // 'catalog' | 'search'
    query: '',
    loading: false,
  };

  function element(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function plainText(value, fallback = '') {
    const out = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return out ? out.slice(0, 600) : fallback;
  }

  // Same rule app.js's safeHttpsUrl uses everywhere a catalog value reaches an
  // <img src>, a background-image or a <video src>: https only, so a bad
  // upstream value can never become a javascript: or data: URI in the DOM.
  function safeHttpsUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  // Same shape as app.js's setBackground(): a left-to-right darkening so the
  // title text over the art stays readable, poster on the right.
  function setBackground(node, value) {
    const image = safeHttpsUrl(value);
    node.style.backgroundImage = image
      ? `linear-gradient(90deg, rgba(10,10,11,.98) 0%, rgba(10,10,11,.7) 42%, rgba(10,10,11,.15) 100%), url("${image.replace(/"/g, '%22')}")`
      : '';
  }

  async function fetchJSON(url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function refs() {
    return {
      form: document.getElementById('games-search-form'),
      input: document.getElementById('games-search-input'),
      status: document.getElementById('games-status'),
      results: document.getElementById('games-results'),
      loadMore: document.getElementById('games-load-more'),
      dialog: document.getElementById('game-detail-dialog'),
      close: document.getElementById('game-detail-close'),
      title: document.getElementById('game-detail-title'),
      meta: document.getElementById('game-detail-meta'),
      desc: document.getElementById('game-detail-desc'),
      platforms: document.getElementById('game-detail-platforms'),
      shots: document.getElementById('game-detail-shots'),
      art: document.getElementById('game-detail-art'),
      trailerHost: document.getElementById('game-detail-trailer'),
      trailerBtn: document.getElementById('game-detail-trailer-btn'),
      dstatus: document.getElementById('game-detail-status'),
    };
  }

  function card(game) {
    const id = plainText(game.id);
    const name = plainText(game.name, 'Untitled');
    const button = element('button', 'card');
    button.type = 'button';
    button.setAttribute('aria-label', `View ${name}`);
    const poster = safeHttpsUrl(game.poster);
    const image = element('img', 'card-image');
    image.loading = 'lazy';
    image.decoding = 'async';
    image.alt = '';
    if (poster) image.src = poster;
    else button.classList.add('no-image');
    const label = element('span', 'card-label');
    label.textContent = name;
    button.append(image, label);
    button.addEventListener('click', () => openDetail(id));
    return button;
  }

  function renderNewCards() {
    const { results } = refs();
    if (!results) return;
    const already = results.children.length;
    const fresh = state.items.slice(already);
    results.append(...fresh.map(card));
  }

  async function loadPage(page, { append }) {
    if (state.loading) return;
    state.loading = true;
    const { status, results, loadMore } = refs();
    if (!append) {
      status.textContent = 'Loading…';
      results.replaceChildren();
    }
    loadMore.hidden = true;

    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (state.mode === 'search' && state.query) params.set('search', state.query);
    const data = await fetchJSON(`${FLEET_BASE}/games/catalog?${params.toString()}`);
    state.loading = false;

    if (!data) {
      if (!append) {
        state.items = [];
        results.replaceChildren();
        status.textContent = 'Could not reach the games catalogue.';
      } else {
        loadMore.hidden = !state.hasNext;
      }
      return;
    }

    // The raw server payload, not something this file computed — see the
    // contract note above. A missing/false `configured` means the fleet has
    // no RAWG key wired up, which is a server config gap, not "no results".
    if (data.configured !== true) {
      state.items = [];
      state.hasNext = false;
      results.replaceChildren();
      status.textContent = data.error || 'The games catalogue is not configured on the server.';
      return;
    }

    const incoming = Array.isArray(data.games) ? data.games : [];
    state.page = Number(data.page) || page;
    state.hasNext = data.hasNext === true;
    state.items = append ? state.items.concat(incoming) : incoming;

    if (!state.items.length) {
      results.replaceChildren();
      status.textContent = state.mode === 'search'
        ? `No games matched "${state.query}".`
        : 'No games are available right now. Come back later.';
      loadMore.hidden = true;
      return;
    }

    renderNewCards();
    status.textContent = `${state.items.length} game${state.items.length === 1 ? '' : 's'}${state.hasNext ? '+' : ''}`;
    loadMore.hidden = !state.hasNext;
  }

  function closeTrailer() {
    const { trailerHost } = refs();
    if (!trailerHost) return;
    trailerHost.classList.remove('loaded');
    trailerHost.replaceChildren();
  }

  async function openDetail(id) {
    const { dialog, title, meta, desc, platforms, shots, art, trailerBtn, dstatus } = refs();
    if (!dialog || !id) return;
    title.textContent = 'Loading…';
    meta.textContent = '';
    desc.textContent = '';
    platforms.textContent = '';
    shots.replaceChildren();
    art.style.backgroundImage = '';
    trailerBtn.hidden = true;
    trailerBtn.dataset.trailer = '';
    dstatus.textContent = '';
    closeTrailer();
    if (typeof dialog.showModal === 'function') dialog.showModal();

    const data = await fetchJSON(`${FLEET_BASE}/games/catalog/${encodeURIComponent(id)}`);
    if (!data || data.found !== true) {
      title.textContent = plainText(data && data.name, 'This game could not be loaded.');
      dstatus.textContent = (data && data.error) || 'This game could not be loaded.';
      return;
    }

    title.textContent = plainText(data.name, 'Untitled');
    setBackground(art, data.poster);

    const bits = [];
    if (data.released) bits.push(plainText(data.released));
    if (data.rating) bits.push(`★ ${plainText(data.rating)}`);
    if (data.metacritic) bits.push(`Metacritic ${plainText(data.metacritic)}`);
    const genres = Array.isArray(data.genres) ? data.genres.map((g) => plainText(g)).filter(Boolean).join(', ') : '';
    if (genres) bits.push(genres);
    meta.textContent = bits.join('   ·   ');
    desc.textContent = plainText(data.description);

    const platformList = Array.isArray(data.platforms) ? data.platforms.map((p) => plainText(p)).filter(Boolean).join(', ') : '';
    platforms.textContent = platformList ? `Platforms: ${platformList}` : '';

    const shotUrls = (Array.isArray(data.screenshots) ? data.screenshots : []).map(safeHttpsUrl).filter(Boolean);
    shots.replaceChildren(...shotUrls.map((url) => {
      const img = element('img', '');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = url;
      return img;
    }));

    const trailerUrl = safeHttpsUrl(data.trailer);
    trailerBtn.hidden = !trailerUrl;
    trailerBtn.dataset.trailer = trailerUrl;
  }

  function playTrailer() {
    const { trailerHost, trailerBtn } = refs();
    const url = trailerBtn && trailerBtn.dataset.trailer;
    if (!trailerHost || !url) return;
    const video = element('video', '');
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    trailerHost.replaceChildren(video);
    trailerHost.classList.add('loaded');
  }

  function closeDialog() {
    const { dialog } = refs();
    closeTrailer();
    if (dialog && dialog.open) dialog.close();
  }

  function bindOnce() {
    const { form, input, loadMore, dialog, close, trailerBtn } = refs();
    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const q = (input.value || '').trim();
        state.mode = q ? 'search' : 'catalog';
        state.query = q;
        loadPage(1, { append: false });
      });
    }
    if (loadMore) loadMore.addEventListener('click', () => loadPage(state.page + 1, { append: true }));
    if (close) close.addEventListener('click', closeDialog);
    if (dialog) dialog.addEventListener('close', closeTrailer);
    if (trailerBtn) trailerBtn.addEventListener('click', playTrailer);
  }

  // RENAMED FROM mount(), AND IT NO LONGER RUNS ON OPEN.
  //
  // The catalogue is one of four tabs now and it is not the default one. Left
  // as-is this would spend a RAWG page-1 request on a screen nobody is
  // looking at, every single time Games is opened. The hub below calls this
  // the first time the Catalogue tab is actually activated.
  //
  // `mount` is still exported under its old name so nothing that calls
  // window.BlazingGames.mount() breaks while it is being re-pointed; the hub
  // IIFE overwrites that one key and leaves mountCatalogue alone.
  function mountCatalogue() {
    if (state.mounted) return;
    state.mounted = true;
    bindOnce();
    loadPage(1, { append: false });
  }

  window.BlazingGames = { mount: mountCatalogue, mountCatalogue };
})();

/* ===========================================================================
 * THE GAMES HUB — one browser in place of eight.
 *
 * Markus, verbatim: "can we have an agent take all my 7 game browser apps i
 * have on mac1 and merge them into one so i dont have so many apps to go
 * through. there should be a way to add more sources and this should also be
 * accessible on the ps5. there should also be a way to use my debrid and
 * torbox account. as well as the normal ways."
 *
 * There are EIGHT, not seven: com.nookie.* FitGirl, GOG, PS3, PS4, PS5, PSP,
 * Switch and Xbox 360 "Game Browser", all still in /Applications. They are
 * closed Rust/Tauri binaries, so nothing in them can be merged — this is a
 * rebuild against one wire contract, and the eight stay where they are until
 * Markus removes them himself.
 *
 * ── THE CONTRACT, READ OUT OF THE SERVER, NOT INVENTED ─────────────────────
 *
 * READ OFF THE SERVER SOURCE, 23 Sep 2026, and re-read rather than remembered:
 * services/addon/lib/game-sources.js (normaliseRow, list, LANE_LABELS,
 * PLATFORMS) and services/addon/lib/game-source-routes.js (every route below).
 * An earlier draft of this file was coded against a GUESSED contract and was
 * wrong in six places — `name` for `label`, `origin` for `kind`, a `direct`
 * lane that is really called `http`, a `page` parameter that is really `limit`,
 * a per-lane resolve that is really server-chosen, and browser-held debrid keys
 * that the server actually owns. Every one of those would have looked fine in a
 * mock and failed on contact, which is exactly what happened: the first
 * games-hub.smoke.mjs mocked field names no route has ever sent.
 *
 *   GET  /games/sources
 *     -> { count,
 *          sources: [{ id, label, platforms[], delivery, kind, backend,
 *                      indexer, enabled, builtin, lane, minQueryLength,
 *                      error }],
 *          platforms[], backends[],
 *          lanes: { http, realdebrid, torbox },
 *          laneLabels, debridEnabled, configFile }
 *     `kind` is 'module' (a file in lib/game-sources/) or 'indexer' (one entry
 *     inside a backend that manages many — a Prowlarr indexer behind Questarr
 *     on mac2). ONE LIST for both, which is the server's own stated rule:
 *     Markus should not have to know which of the two a source is.
 *     THERE IS NO `origin` FIELD, and `error` is an OBJECT `{ reason, message }`
 *     rather than a string — printing it raw draws "[object Object]".
 *     `lane` is the ONE lane a row from this source would take today, and it is
 *     null when nothing configured can fetch one.
 *
 *   GET  /games/search?q=&platform=&source=&limit=
 *     -> { query, platform, source, count, results[], asked[], errors[],
 *          lanes, debridEnabled, unavailable }
 *     A RESULT ROW IS EXACTLY: { source, provider, title, platform, collection,
 *     region, format, size, url, ref, direct, playable, info, cover, tier,
 *     lane, delivery, kind } — `provider` is the friendly name ("SteamRIP") and
 *     `source` is the lower-case id ("steamrip"); there is no `sourceLabel` and
 *     no `sourceName`. `lane` is ONE STRING out of http|realdebrid|torbox, or
 *     null; there is no `lanes` array on a row and no lane called 'direct'.
 *     `size` is a NUMBER OF BYTES and 0 means "the archive stated no size",
 *     which normaliseRow calls an honest answer — so 0 prints nothing at all.
 *     IGDB enrichment MAY add summary, genres[], released, rating,
 *     screenshots[] and a cover, and may not: a box with no IGDB credentials
 *     answers this same shape minus those fields, so both must render.
 *
 *   GET  /games/resolve?ref=[&redirect=1]
 *     -> { ok, lane, provider, url, source, tried[] }
 *     -> 202 { preparing: true } when a debrid lane has started the fetch.
 *     THE SERVER PICKS THE LANE, not this file. So there is ONE Download
 *     button, and the answer says which lane won and what else was tried.
 *
 *   GET  /games/browse?platform=&limit=
 *     -> { platform, count, source: 'igdb', results: [{ title, cover, summary,
 *          released, rating, genres[] }] }, or 503 { error:
 *          'igdb-not-configured' } on a box with no IGDB credentials.
 *     TITLES, NOT RELEASES: no row carries a `ref` and nothing there is
 *     downloadable. It exists for the console, which has no keyboard.
 *
 *   POST  /games/sources  { source: { id, label, platforms[], delivery, … } }
 *     LAN only, and it upserts into a private file with no restart.
 *
 *   PATCH /games/sources/<id>  { enabled: true|false }
 *     -> { ok, id, enabled, count, sources[] }
 *     LAN only, same file, same no-restart reload. THE REPLY IS THE TRUTH: its
 *     `enabled` is read back off the registry, so a source carrying an error
 *     reports disabled however the switch was set, and a client that trusted
 *     its own echo would draw the switch in the wrong position. A non-boolean
 *     `enabled` is refused with 400 `bad-enabled` on purpose — "false" is a
 *     truthy string and coercing it would switch a source ON.
 *
 * ── THE NORMAL WAY ─────────────────────────────────────────────────────────
 *
 * The `http` lane needs no account. `lanes.http` is true whatever the debrid
 * state is, and a source whose `lane` is `http` resolves with both debrid
 * accounts absent. That is the case games-hub.smoke.mjs names and tests,
 * because it is the one most likely to be shipped broken.
 *
 * ── WHY THERE IS NO KEY BOX ON THE ACCOUNTS TAB ────────────────────────────
 *
 * An earlier draft kept the Real-Debrid and TorBox keys in localStorage and
 * sent them as request headers. THE SERVER OWNS THEM: /games/sources answers
 * `lanes` and `debridEnabled` off its own `debrid.hasRd` / `debrid.hasTorbox`,
 * and /games/resolve uses those. A second copy in the browser would let this
 * screen draw a lane as ready while the server refuses it — two sources of
 * truth for one credential, which is worse than none. So Accounts shows the
 * server's real state and says where a key is actually set.
 *
 * ── PS5 ─────────────────────────────────────────────────────────────────────
 *
 * The console DOES run this app now. Its "Blazing Games" tile (PPSA99190,
 * ps5-linux tools/blazing-games-tile) opens https://blazingstream.lyreosai.com/
 * app/#games in the PS5's own system browser (NPXS40036, a WebKit that sends
 * "PlayStation 5/10.20"). isConsole() below is what keeps the Download button
 * off that screen. The PS5 hand-off button is still for driving the console
 * FROM the Mac.
 * =========================================================================== */
(() => {
  const ADDON_BASE = window.BLAZING_API_BASE || 'https://addon.lyreosai.com';
  // THE CLIENT MUST OUTWAIT THE SERVER. /games/search holds a question for up
  // to 25 s (DEFAULT_WAIT_MS in services/addon/lib/game-source-routes.js)
  // before it answers 202 "still looking", and a real answer then has IGDB
  // fields laid over it. This was 20 s. Measured 24 Sep 2026 against the live
  // add-on: a cold "tekken" answered in 21.7 s and "god of war" in 21.9 s, so
  // the browser cut the socket first and printed "Could not reach the add-on."
  // about an add-on that was answering. On the PS5 browser that line was the
  // only thing Markus ever saw. 45 s covers the 25 s hold and the enrichment.
  const TIMEOUT_MS = 45000;
  const LIMIT = 60;

  // `http`, not `direct`. The server calls this lane `http` in lanesFor(), in
  // signRef() and in the `lane` field of every source row; a client that says
  // `direct` agrees with nothing. These strings are LANE_LABELS out of
  // lib/game-sources.js verbatim, and /games/sources sends the same table as
  // `laneLabels` — so the server's copy wins at runtime (see loadSources) and
  // this one is only the answer before it has replied.
  const LANE_LABEL = { http: 'Direct download', realdebrid: 'Real-Debrid', torbox: 'TorBox' };
  const LANE_ORDER = ['http', 'realdebrid', 'torbox'];

  // A fallback only. The real list is `platforms[]` off /games/sources, which
  // is PLATFORMS in lib/game-sources.js. These are the systems the eight apps
  // covered, used when the registry has not answered yet.
  const FALLBACK_PLATFORMS = ['ps5', 'ps4', 'ps3', 'psp', 'switch', 'xbox360', 'pc', 'retro'];
  const PLATFORM_LABEL = {
    ps5: 'PS5', ps4: 'PS4', ps3: 'PS3', psp: 'PSP', switch: 'Switch',
    xbox360: 'Xbox 360', pc: 'PC', retro: 'Retro',
  };

  const hub = {
    bound: false,
    tab: 'browse',
    catalogueMounted: false,
    sources: [],
    platforms: FALLBACK_PLATFORMS.slice(),
    lanes: { http: true, realdebrid: false, torbox: false },
    laneLabels: Object.assign({}, LANE_LABEL),
    debridEnabled: false,
    sourcesLoaded: false,
    results: [],
    platform: '',
    source: '',
    query: '',
    loading: false,
    pendingTimer: 0,
    current: null,
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function clean(value, fallback = '') {
    const out = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return out ? out.slice(0, 400) : fallback;
  }

  function platformLabel(token) {
    return PLATFORM_LABEL[token] || clean(token).toUpperCase();
  }

  /** The server's own word for a lane, falling back to ours, then to the id. */
  function laneLabel(lane) {
    const token = clean(lane);
    if (!token) return '';
    return clean(hub.laneLabels[token]) || LANE_LABEL[token] || token;
  }

  /**
   * `size` IS A NUMBER OF BYTES, and 0 is an ANSWER rather than a gap.
   *
   * lib/game-sources.js normaliseRow(): "0 IS AN HONEST ANSWER, not a missing
   * one. Minerva's search API states no size at all and a guess on a card is a
   * claim we cannot back." So 0 prints nothing — writing "0 B" on a card would
   * invent the claim the server refused to make. Anything that is not a finite
   * positive number is treated the same way.
   */
  function sizeText(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${i === 0 || n >= 100 ? Math.round(n) : Number(n.toFixed(1))} ${units[i]}`;
  }

  /**
   * The word that says WHERE a broken source gets fixed.
   *
   * A module is a file in lib/game-sources/ on the add-on; an indexer is one
   * entry inside a backend that manages many, so it is switched on inside
   * Prowlarr/Questarr on mac2 and named by its backend. The backend arrives
   * lower-cased (validateSource does `text(mod.backend).toLowerCase()`), so it
   * is capitalised here rather than printed as "questarr indexer".
   *
   * THEY STILL SHARE ONE LIST. The server's own rule, and the reason the label
   * carries the difference instead of a second list doing it: Markus must not
   * have to know which of the two a source is in order to switch it on.
   */
  function kindText(source) {
    const kind = clean(source && source.kind) || 'module';
    if (kind !== 'indexer') return 'Built-in scraper';
    const backend = clean(source && source.backend);
    if (!backend) return 'Indexer';
    return `${backend.charAt(0).toUpperCase()}${backend.slice(1)} indexer`;
  }

  /**
   * Is this the PlayStation's own browser?
   *
   * IT DECIDES WHETHER A DOWNLOAD BUTTON IS DRAWN AT ALL. The console holds a
   * whole response body in RAM and dies with "not enough free system memory"
   * on anything large — written down in blazing-ps5/README.md, in
   * tools/games-handoff.py and again in the add-on's own queue header. A
   * Download button there is a button guaranteed to fail on exactly the files
   * it exists for, so the console gets the Mac hand-off and nothing else.
   *
   * Read at call time, not once at load: window.BLAZING_FORCE_PS5 is how a
   * harness proves this branch on a Mac with no console in the loop.
   */
  function isConsole() {
    if (window.BLAZING_FORCE_PS5 === true) return true;
    return /PlayStation\s*[45]/i.test(String(navigator.userAgent || ''));
  }

  /** The last path segment of a resolved link, which is the only filename the
   *  wire ever carries — /games/resolve answers a url and no `filename`. */
  function fileNameFrom(url) {
    try {
      const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
      return /\.[a-z0-9]{2,5}$/i.test(name) ? clean(name) : '';
    } catch { return ''; }
  }

  // https only, same rule as the catalogue half of this file and as app.js's
  // safeHttpsUrl: a value straight off a third-party scraper must never be
  // able to become a javascript: or data: URI once it is in the DOM.
  function safeImage(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '';
    } catch { return ''; }
  }

  // A DOWNLOAD url may be http:. A direct source on the LAN, or one of our own
  // /dl/<token> links off an add-on that is not behind TLS, is a real case, and
  // refusing it would break the one lane that has to work without an account.
  // What is refused is every scheme that is not http/https.
  function safeDownloadUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : '';
    } catch { return ''; }
  }

  // AbortSignal.timeout() is Safari 16+. The console's WebKit claims 17, but a
  // missing one would throw before the try below and leave the screen saying
  // "Searching…" for ever, so the old-browser path costs one line.
  function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
    const controller = new AbortController();
    window.setTimeout(() => controller.abort(), ms);
    return controller.signal;
  }

  async function api(path, { method = 'GET', body = null } = {}) {
    const init = { method, signal: timeoutSignal(TIMEOUT_MS), headers: {} };
    if (body != null) {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
    try {
      const res = await fetch(`${ADDON_BASE}${path}`, init);
      let json = null;
      try { json = await res.json(); } catch { json = null; }
      return { status: res.status, ok: res.ok, json };
    } catch (error) {
      // Nothing here aborts a request except the timer, so an abort IS a
      // timeout: TimeoutError from AbortSignal.timeout, AbortError from the
      // fallback controller.
      const name = error && error.name;
      return { status: 0, ok: false, json: null, timeout: name === 'TimeoutError' || name === 'AbortError' };
    }
  }

  /**
   * The sentence for a call that did not come back with an answer.
   *
   * THREE DIFFERENT FAILURES, and they used to share one line. "Could not reach
   * the add-on" is only true of the last one: a SLOW add-on is reachable and
   * still working (and caches what it finds, so asking again is quick), and an
   * add-on that answered 503 said in its own words what went wrong.
   */
  function failureText(res) {
    if (res.timeout) return 'The add-on is slow to answer right now. Try again in a minute — it keeps searching and remembers what it finds.';
    const told = res.json && res.json.unavailable && clean(res.json.unavailable.message);
    if (told) return told;
    if (res.status === 0) return 'Could not reach the add-on. Check the network connection.';
    return `The add-on answered with an error (${res.status}). Try again in a minute.`;
  }

  function refs() {
    return {
      tabs: document.getElementById('games-tabs'),
      panels: {
        browse: document.getElementById('games-tab-browse'),
        sources: document.getElementById('games-tab-sources'),
        accounts: document.getElementById('games-tab-accounts'),
        catalogue: document.getElementById('games-tab-catalogue'),
      },
      form: document.getElementById('games-hub-form'),
      input: document.getElementById('games-hub-input'),
      chips: document.getElementById('games-platform-chips'),
      sourceFilter: document.getElementById('games-source-filter'),
      status: document.getElementById('games-hub-status'),
      results: document.getElementById('games-hub-results'),
      warnings: document.getElementById('games-hub-warnings'),
      srcStatus: document.getElementById('games-sources-status'),
      srcList: document.getElementById('games-sources-list'),
      srcGap: document.getElementById('games-sources-gap'),
      srcAdd: document.getElementById('games-source-add'),
      srcAddStatus: document.getElementById('games-source-add-status'),
      srcId: document.getElementById('games-source-id'),
      srcName: document.getElementById('games-source-name'),
      srcUrl: document.getElementById('games-source-url'),
      srcDelivery: document.getElementById('games-source-kind'),
      srcPlatforms: document.getElementById('games-source-platforms'),
      laneState: document.getElementById('games-lane-state'),
      accStatus: document.getElementById('games-accounts-status'),
      dialog: document.getElementById('game-source-dialog'),
      dClose: document.getElementById('game-source-close'),
      dArt: document.getElementById('game-source-art'),
      dTitle: document.getElementById('game-source-title'),
      dMeta: document.getElementById('game-source-meta'),
      dFile: document.getElementById('game-source-file'),
      dSummary: document.getElementById('game-source-summary'),
      dShots: document.getElementById('game-source-shots'),
      dLanes: document.getElementById('game-source-lanes'),
      dPs5: document.getElementById('game-source-ps5'),
      dStatus: document.getElementById('game-source-status'),
    };
  }

  // ── tabs ──────────────────────────────────────────────────────────────────
  function showTab(name) {
    const r = refs();
    if (!r.panels[name]) return;
    hub.tab = name;
    Object.keys(r.panels).forEach((key) => {
      if (r.panels[key]) r.panels[key].hidden = key !== name;
    });
    if (r.tabs) {
      Array.from(r.tabs.querySelectorAll('[data-games-tab]')).forEach((btn) => {
        const on = btn.dataset.gamesTab === name;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    if (name === 'accounts') paintLanes();
    // Lazy, for the reason written at mountCatalogue(): a RAWG page-1 request
    // is not spent until somebody actually opens that tab.
    if (name === 'catalogue' && !hub.catalogueMounted) {
      hub.catalogueMounted = true;
      if (window.BlazingGames && window.BlazingGames.mountCatalogue) {
        window.BlazingGames.mountCatalogue();
      }
    }
  }

  // ── the registry ──────────────────────────────────────────────────────────
  async function loadSources() {
    const r = refs();
    if (r.srcStatus) r.srcStatus.textContent = 'Loading sources…';
    const res = await api('/games/sources');
    if (res.status === 404) {
      hub.sourcesLoaded = true;
      hub.sources = [];
      if (r.srcStatus) {
        r.srcStatus.textContent = 'This add-on has no /games/sources route, so there is no registry to show.';
      }
      if (r.srcList) r.srcList.replaceChildren();
      paintPlatforms();
      paintSourceFilter();
      paintLanes();
      return;
    }
    if (!res.ok || !res.json) {
      if (r.srcStatus) r.srcStatus.textContent = failureText(res);
      return;
    }
    const d = res.json;
    hub.sources = Array.isArray(d.sources) ? d.sources : [];
    hub.platforms = Array.isArray(d.platforms) && d.platforms.length
      ? d.platforms.map((p) => clean(p).toLowerCase()).filter(Boolean)
      : FALLBACK_PLATFORMS.slice();
    // `http` is true whatever the server says about debrid — it is the lane
    // that needs no account, and defaulting it to false here would draw the
    // one always-available lane as dead.
    const lanes = (d.lanes && typeof d.lanes === 'object') ? d.lanes : {};
    hub.lanes = {
      http: lanes.http !== false,
      realdebrid: lanes.realdebrid === true,
      torbox: lanes.torbox === true,
    };
    // THE SERVER NAMES ITS OWN LANES. /games/sources sends `laneLabels`, which
    // is LANE_LABELS out of lib/game-sources.js, so the screen and the add-on
    // cannot drift into two different words for one lane.
    if (d.laneLabels && typeof d.laneLabels === 'object') {
      hub.laneLabels = Object.assign({}, LANE_LABEL, d.laneLabels);
    }
    hub.debridEnabled = d.debridEnabled === true;
    hub.sourcesLoaded = true;
    paintSources();
    paintPlatforms();
    paintSourceFilter();
    paintLanes();
  }

  function sourceItem(source) {
    const li = el('li', 'games-source-item');
    const enabled = source.enabled !== false;
    li.dataset.enabled = enabled ? 'true' : 'false';
    li.dataset.sourceId = clean(source.id);
    const kind = clean(source.kind) || 'module';
    li.dataset.kind = kind;

    const left = el('div', '');
    left.append(el('div', 'games-source-name', clean(source.label, source.id)));

    const sub = [];
    // The kind first, because it is the word that decides where a broken
    // source gets fixed: a module is a file on the add-on, an indexer lives
    // inside Prowlarr/Questarr on mac2.
    sub.push(kindText(source));
    if (source.delivery) sub.push(clean(source.delivery));
    if (source.lane) sub.push(laneLabel(source.lane));
    const platforms = Array.isArray(source.platforms)
      ? source.platforms.map((p) => platformLabel(p)).filter(Boolean) : [];
    if (platforms.length) sub.push(platforms.join(', '));
    left.append(el('div', 'games-source-sub', sub.join('  ·  ')));

    // A source can carry its own error — a module that failed to load, an
    // indexer whose backend is down. Showing it here is the difference between
    // "why is my SkidrowRepack search empty" and an answer.
    //
    // IT IS AN OBJECT, `{ reason, message }`, not a string. createGameSourceRegistry's
    // load() builds it that way for every overlay it could not compile. Printing
    // the object draws "[object Object]", which is the exact shape of bug this
    // whole pass exists to remove; `message` is the sentence a person can act on
    // and `reason` is the machine token behind it.
    if (source.error) {
      const why = typeof source.error === 'object'
        ? clean(source.error.message || source.error.reason)
        : clean(source.error);
      if (why) left.append(el('div', 'games-source-error', why));
    }
    li.append(left);

    // A REAL SWITCH, and the comment that used to stand here is gone with the
    // gap it described.
    //
    // It said a switch could not work, because the registry's only write was
    // POST /games/sources and that upserts a WHOLE declaration — id, label,
    // platforms, delivery and a live search() function — which a browser
    // cannot round-trip. That was true, and it named the endpoint it needed.
    // PATCH /games/sources/<id> { enabled } now exists and is exactly it: it
    // writes a two-key OVERLAY, so switching a built-in off never forks its
    // definition into a config file where it would rot.
    const toggle = el('button', 'games-source-toggle secondary-button', enabled ? 'On' : 'Off');
    toggle.type = 'button';
    toggle.dataset.enabled = enabled ? 'true' : 'false';
    toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    toggle.setAttribute('aria-label',
      `${enabled ? 'Switch off' : 'Switch on'} ${clean(source.label, source.id)}`);
    toggle.addEventListener('click', () => switchSource(li, toggle, source));
    li.append(toggle);
    return li;
  }

  /**
   * Press the switch: PATCH the add-on, then believe the ANSWER.
   *
   * THE REPLY IS THE TRUTH, NOT THE ECHO. The route reads `enabled` back off
   * the reloaded registry rather than repeating what was sent, and it says why
   * in its own comment: a source carrying an error is reported disabled
   * however the switch was set. A screen that painted its own optimistic guess
   * would show On over a source that is not running — which is the same class
   * of lie as a lane drawn ready over a key the server does not have.
   *
   * A FAILURE PUTS THE ROW BACK. Anything other than a 200 with ok:true leaves
   * the registry exactly as it was on the add-on, so leaving the row flipped
   * here would be the screen and the server disagreeing silently.
   */
  async function switchSource(li, button, source) {
    const id = clean(source && source.id);
    const r = refs();
    if (!id || button.disabled) return;
    const was = li.dataset.enabled === 'true';
    const wasText = button.textContent;
    const want = !was;
    button.disabled = true;
    button.textContent = '…';
    if (r.srcGap) r.srcGap.textContent = '';

    // A BOOLEAN, never a string. The route refuses a non-boolean with 400
    // `bad-enabled` on purpose — "false" is a truthy string and coercing it
    // would switch a source ON when the press asked for OFF.
    const res = await api(`/games/sources/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { enabled: want },
    });

    const putBack = (why) => {
      li.dataset.enabled = was ? 'true' : 'false';
      button.dataset.enabled = was ? 'true' : 'false';
      button.setAttribute('aria-pressed', was ? 'true' : 'false');
      button.textContent = wasText;
      button.disabled = false;
      if (r.srcGap) r.srcGap.textContent = why;
    };

    if (res.status === 404 || res.status === 405) {
      putBack(`This add-on does not serve PATCH /games/sources/${id} yet, so ${clean(source.label, id)} was not changed.`);
      return;
    }
    // LAN-only for the same reason POST is: it writes the private file that
    // holds the debrid keys. Say that, rather than "it refused".
    if (res.status === 403) {
      putBack('Switching a source only works on the home network — it writes a file that holds credentials.');
      return;
    }
    if (!res.ok || !res.json || res.json.ok !== true) {
      putBack(clean(res.json && (res.json.message || res.json.error),
        `The add-on refused it (HTTP ${res.status}).`));
      return;
    }

    button.disabled = false;
    // The route hands back the WHOLE registry, so the whole list is repainted
    // from it and nothing on screen is left holding a stale copy.
    if (Array.isArray(res.json.sources)) {
      hub.sources = res.json.sources;
      paintSources();
      paintSourceFilter();
      return;
    }
    const now = res.json.enabled === true;
    li.dataset.enabled = now ? 'true' : 'false';
    button.dataset.enabled = now ? 'true' : 'false';
    button.setAttribute('aria-pressed', now ? 'true' : 'false');
    button.textContent = now ? 'On' : 'Off';
  }

  function paintSources() {
    const r = refs();
    if (!r.srcList) return;
    r.srcList.replaceChildren(...hub.sources.map(sourceItem));
    const on = hub.sources.filter((s) => s.enabled !== false).length;
    const indexers = hub.sources.filter((s) => clean(s.kind) === 'indexer').length;
    const modules = hub.sources.length - indexers;
    r.srcStatus.textContent = hub.sources.length
      ? `${hub.sources.length} source${hub.sources.length === 1 ? '' : 's'}, ${on} on — `
        + `${modules} built-in, ${indexers} from an indexer backend.`
      : 'No sources registered yet.';
    // This line is where a SWITCH says what happened when it could not. It is
    // cleared on every repaint on purpose: a stale "it refused" under a list
    // that has since been re-read is worse than no line at all.
    if (r.srcGap) r.srcGap.textContent = '';
  }

  function paintPlatforms() {
    const r = refs();
    if (!r.chips) return;
    const list = [''].concat(hub.platforms);
    r.chips.replaceChildren(...list.map((token) => {
      const b = el('button', 'games-chip', token ? platformLabel(token) : 'All');
      b.type = 'button';
      b.dataset.platform = token;
      b.setAttribute('aria-pressed', hub.platform === token ? 'true' : 'false');
      b.addEventListener('click', () => {
        hub.platform = token;
        paintPlatforms();
        runSearch();
      });
      return b;
    }));
  }

  function paintSourceFilter() {
    const r = refs();
    if (!r.sourceFilter) return;
    const keep = hub.source;
    const all = el('option', '', 'All sources');
    all.value = '';
    const opts = [all];
    hub.sources.filter((s) => s.enabled !== false).forEach((s) => {
      const o = el('option', '', clean(s.label, s.id));
      o.value = s.id;
      opts.push(o);
    });
    r.sourceFilter.replaceChildren(...opts);
    r.sourceFilter.value = hub.sources.some((s) => s.id === keep) ? keep : '';
    hub.source = r.sourceFilter.value;
  }

  // ── browse ────────────────────────────────────────────────────────────────
  function laneBadges(row) {
    const box = el('div', 'games-row-lanes');
    // ONE LANE PER ROW, AS A STRING. normaliseRow() sets `lane` from laneFor(),
    // which returns a single id or null — there has never been a `lanes` array
    // on a row. It is a preview of what /games/resolve will use, not a menu:
    // resolve builds its own lane list and chooses for itself.
    const lane = clean(row.lane);

    // DIM AND DISABLED, NEVER HIDDEN. A row whose lane is null is a magnet or
    // torrent release on a box with no debrid account: laneFor() has nothing
    // to hand it. Dropping the badge would read as "this source is broken",
    // when the true answer is "paste a key into the add-on". So the badge is
    // still drawn, disarmed, and it says which thing is missing.
    const badge = el('span', 'games-lane-badge', lane ? laneLabel(lane) : 'Needs an account');
    badge.dataset.lane = lane;
    const armed = Boolean(lane) && hub.lanes[lane] === true;
    badge.dataset.armed = armed ? 'true' : 'false';
    if (!armed) {
      badge.setAttribute('aria-disabled', 'true');
      badge.title = lane
        ? `The add-on has no ${laneLabel(lane)} account, so this lane cannot fetch yet.`
        : 'This release needs a Real-Debrid or TorBox account on the add-on.';
    }
    box.append(badge);
    return box;
  }

  function resultRow(row) {
    const button = el('button', 'games-row');
    button.type = 'button';
    const title = clean(row.title || row.name, 'Untitled');
    button.dataset.ref = clean(row.ref);
    button.setAttribute('aria-label', `Download options for ${title}`);

    const cover = safeImage(row.cover || row.poster);
    if (cover) {
      const img = el('img', 'games-row-art');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = cover;
      button.append(img);
    } else {
      // Not an <img> with no src — that draws a broken-image glyph on some
      // engines. IGDB art is coming, so this is the genuinely-missing case.
      const blank = el('div', 'games-row-art is-blank',
        (clean(row.platform, '?')[0] || '?').toUpperCase());
      button.append(blank);
    }

    const main = el('div', 'games-row-main');
    main.append(el('span', 'games-row-title', title));
    const bits = [];
    if (row.platform) bits.push(platformLabel(row.platform));
    // `provider` IS THE FRIENDLY NAME and `source` is the lower-case id.
    // normaliseRow() sets provider from the source's own `label`, so this is
    // "SteamRIP"; there is no `sourceLabel` field and never was, and reading
    // one printed the id on every row while looking like it worked.
    if (row.provider || row.source) bits.push(clean(row.provider || row.source));
    if (row.released) bits.push(clean(row.released));
    const size = sizeText(row.size);
    if (size) bits.push(size);
    main.append(el('span', 'games-row-meta', bits.join('  ·  ')));
    button.append(main);
    button.append(laneBadges(row));

    button.addEventListener('click', () => openDialog(row));
    return button;
  }

  /**
   * ONE TITLE ROW on a system's list. It is a GAME, not a release: pressing it
   * asks what the add-on can deliver for it. `row.source` set means the row came
   * off /games/library (a catalog that holds links for it); unset means it came
   * off /games/browse (IGDB, which only knows the game exists).
   */
  function titleRow(row) {
    const button = el('button', 'games-row games-title-row');
    button.type = 'button';
    const title = clean(row.title, 'Untitled');
    button.setAttribute('aria-label', `Ways to get ${title}`);
    const cover = safeImage(row.cover);
    if (cover) {
      const img = el('img', 'games-row-art');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = cover;
      button.append(img);
    } else {
      button.append(el('div', 'games-row-art is-blank', (title[0] || '?').toUpperCase()));
    }
    const main = el('div', 'games-row-main');
    main.append(el('span', 'games-row-title', title));
    // One caption line; a second value joins the first with a middle dot
    // (DESIGN-V2 §2.8, "Caption is ONE line").
    const bits = [];
    if (row.provider) bits.push(clean(row.provider));
    const year = clean(row.released).slice(0, 4);
    if (/^\d{4}$/.test(year)) bits.push(year);
    const size = sizeText(row.size);
    if (size) bits.push(size);
    if (Number(row.hosts) > 0) bits.push(`${Number(row.hosts)} link${Number(row.hosts) === 1 ? '' : 's'}`);
    if (clean(row.risk)) bits.push('Warning');
    main.append(el('span', 'games-row-meta', bits.join('  ·  ')));
    button.append(main);
    button.addEventListener('click', () => {
      if (row.source) {
        openTitle(row);
        return;
      }
      // IGDB title: the route's own documented flow is an ordinary search for
      // that exact name, with the chosen system still set.
      const r = refs();
      hub.query = title;
      if (r.input) r.input.value = title;
      runSearch();
    });
    return button;
  }

  /**
   * A SYSTEM WITH NO NAME TYPED: that system's list of games.
   *
   * THIS IS WHAT A CONTROLLER DOES FIRST, and it was the "can't reach the
   * add-on" Markus saw on the PS5. A chip is one press and a name is the
   * on-screen keyboard, so "pick a system" is the natural first move — and it
   * sent /games/search?q= with nothing in it. The add-on refuses that with 400
   * missing-query (its sources are archives you search, not lists), and this
   * screen printed "Could not reach the add-on." Measured 24 Sep 2026: 400 in
   * 0.23 s, on a healthy add-on.
   *
   * WHICH LIST. /games/library first: every game a catalog HOLDS A LINK FOR
   * (1,056 for ps5 and 8,292 for pc, 0.5 s, measured 24 Sep), so every row
   * opens into something. /games/browse (IGDB) only when no catalog covers the
   * system (404 no-catalog-source): IGDB knows what EXISTS, and its rows can
   * open into nothing, so it is the fallback and not the default.
   */
  async function runBrowse() {
    const r = refs();
    const asked = hub.platform;
    const label = platformLabel(asked);
    hub.loading = true;
    r.results.replaceChildren();
    if (r.warnings) r.warnings.replaceChildren();
    r.status.textContent = `Loading ${label} games…`;

    let res = await api(`/games/library?platform=${encodeURIComponent(asked)}&pageSize=${LIMIT}`);
    let fromIgdb = false;
    if (res.status === 404) {
      fromIgdb = true;
      res = await api(`/games/browse?platform=${encodeURIComponent(asked)}&limit=${LIMIT}`);
    }
    hub.loading = false;
    // A chip pressed, or a name typed, while this was loading wins.
    if (hub.platform !== asked || hub.query) {
      runSearch();
      return;
    }

    if (fromIgdb && (res.status === 503 || res.status === 404)) {
      r.status.textContent = `No list of ${label} games yet. Type a game name instead.`;
      return;
    }
    if (!res.ok || !res.json) {
      r.status.textContent = failureText(res);
      return;
    }
    const rows = (Array.isArray(res.json.results) ? res.json.results : []).filter((row) => clean(row && row.title));
    if (!rows.length) {
      r.status.textContent = `No ${label} games to list. Type a game name instead.`;
      return;
    }
    r.results.append(...rows.map(titleRow));
    const total = Number(res.json.total) || rows.length;
    r.status.textContent = total > rows.length
      ? `${rows.length} of ${total} ${label} games. Pick one, or type a name to find the rest.`
      : `${rows.length} ${label} games. Pick one.`;
  }

  /**
   * ONE GAME off the library: every way to get it. /games/library/title signs
   * each row, so what comes back is the same shape /games/search returns and
   * opens the same download dialog.
   *
   * `risk` IS SHOWN, NEVER DROPPED. The route marks a risky title and asks the
   * client to warn; Markus chose "show everything, warn clearly".
   */
  async function openTitle(row) {
    const r = refs();
    if (hub.loading) return;
    const title = clean(row.title, 'Untitled');
    hub.loading = true;
    r.results.replaceChildren();
    if (r.warnings) r.warnings.replaceChildren();
    r.status.textContent = `Finding ways to get ${title}…`;
    const params = new URLSearchParams();
    params.set('title', clean(row.title));
    if (row.platform || hub.platform) params.set('platform', clean(row.platform || hub.platform));
    if (row.source) params.set('source', clean(row.source));
    const asked = hub.platform;
    const res = await api(`/games/library/title?${params.toString()}`);
    hub.loading = false;
    // A chip pressed, or a name typed, while this was loading wins.
    if (hub.platform !== asked || hub.query) {
      runSearch();
      return;
    }

    if (res.status === 404) {
      r.status.textContent = `The catalog no longer lists ${title}. Pick another game.`;
      return;
    }
    if (!res.ok || !res.json) {
      r.status.textContent = failureText(res);
      return;
    }
    const d = res.json;
    const risk = clean(d.risk);
    if (r.warnings && risk) r.warnings.replaceChildren(el('p', 'games-warning', `Warning: ${risk}`));
    if (Number(d.parts) > 1 && r.warnings) {
      r.warnings.append(el('p', 'games-warning',
        `This game comes in ${Number(d.parts)} parts. Get every part — one part alone will not open.`));
    }
    hub.results = Array.isArray(d.rows) ? d.rows : [];
    if (!hub.results.length) {
      r.status.textContent = `No working link for ${title} right now.`;
      return;
    }
    r.results.append(...hub.results.map(resultRow));
    r.status.textContent = `${hub.results.length} way${hub.results.length === 1 ? '' : 's'} to get ${title}`;
  }

  function clearPending() {
    if (hub.pendingTimer) {
      window.clearTimeout(hub.pendingTimer);
      hub.pendingTimer = 0;
    }
  }

  /**
   * `retried` is the ONE automatic second ask after a timeout. The add-on does
   * not stop when the browser gives up — the search runs on and fills its cache
   * — so the second ask usually answers at once. One, not a loop: a page that
   * re-asks for ever with nobody watching is the thing every retry in this app
   * refuses to be.
   */
  async function runSearch(retried = false) {
    const r = refs();
    if (!r.results || hub.loading) return;
    clearPending();
    // /games/search refuses an empty q (400 missing-query). A system with no
    // name is a browse; neither is a prompt, and neither ever reaches the wire.
    if (!hub.query) {
      if (hub.platform) {
        await runBrowse();
        return;
      }
      r.results.replaceChildren();
      if (r.warnings) r.warnings.replaceChildren();
      r.status.textContent = 'Type a game name, or pick a system.';
      return;
    }
    hub.loading = true;
    r.results.replaceChildren();
    if (r.warnings) r.warnings.replaceChildren();
    r.status.textContent = 'Searching every source…';

    const params = new URLSearchParams();
    params.set('q', hub.query);
    if (hub.platform) params.set('platform', hub.platform);
    if (hub.source) params.set('source', hub.source);
    params.set('limit', String(LIMIT));

    const res = await api(`/games/search?${params.toString()}`);
    hub.loading = false;

    if (res.timeout && !retried) {
      r.status.textContent = 'The add-on is slow to answer. Still searching…';
      hub.pendingTimer = window.setTimeout(() => runSearch(true), 1000);
      return;
    }

    if (res.status === 404) {
      r.status.textContent = 'This add-on has no /games/search route yet.';
      return;
    }

    // 202 IS NOT AN EMPTY RESULT, AND MERGING THEM IS THE BUG THE SERVER'S OWN
    // COMMENT WARNS ABOUT. An archive is still answering; say so, and come
    // back on the server's own clock rather than making him press again.
    if (res.status === 202 && res.json && res.json.pending) {
      const wait = Number(res.json.retryAfterSeconds) || 10;
      r.status.textContent = `Still searching. An archive is slow to answer — checking again in ${wait}s.`;
      hub.pendingTimer = window.setTimeout(() => runSearch(), wait * 1000);
      return;
    }

    if (!res.ok || !res.json) {
      r.status.textContent = failureText(res);
      return;
    }

    const d = res.json;
    hub.results = Array.isArray(d.results) ? d.results : [];

    // A SOURCE THAT FAILED IS NAMED, not quietly dropped. Without this, one
    // dead indexer looks exactly like a thin catalogue and nobody ever finds
    // out which source stopped working.
    const errors = Array.isArray(d.errors) ? d.errors : [];
    if (r.warnings && errors.length) {
      r.warnings.replaceChildren(...errors.map((e) => {
        const who = clean(e && (e.source || e.id), 'a source');
        const why = clean(e && (e.message || e.error), 'it did not answer');
        return el('p', 'games-warning', `${who}: ${why}`);
      }));
    }

    if (!hub.results.length) {
      r.status.textContent = hub.query
        ? `Nothing matched "${hub.query}".`
        : 'Type a game name, or pick a system.';
      return;
    }

    r.results.append(...hub.results.map(resultRow));
    const asked = Array.isArray(d.asked) ? d.asked.length : 0;
    r.status.textContent = `${hub.results.length} release${hub.results.length === 1 ? '' : 's'}`
      + (asked ? ` from ${asked} source${asked === 1 ? '' : 's'}` : '');
  }

  // ── the download dialog ───────────────────────────────────────────────────
  //
  // ONE button, because /games/resolve chooses the lane itself. An earlier
  // draft drew one button per lane and passed &lane=, which the route does not
  // read — it would have looked like a choice and been none.
  function openDialog(row) {
    const r = refs();
    if (!r.dialog) return;
    hub.current = row;
    r.dTitle.textContent = clean(row.title || row.name, 'Untitled');

    const bits = [];
    if (row.platform) bits.push(platformLabel(row.platform));
    if (row.provider || row.source) bits.push(clean(row.provider || row.source));
    if (row.released) bits.push(clean(row.released));
    if (row.rating) bits.push(`★ ${clean(row.rating)}`);
    const genres = Array.isArray(row.genres) ? row.genres.map((g) => clean(g)).filter(Boolean) : [];
    if (genres.length) bits.push(genres.join(', '));
    const size = sizeText(row.size);
    if (size) bits.push(size);
    r.dMeta.textContent = bits.join('  ·  ');

    // THE ROW CARRIES NO FILENAME. normaliseRow() strips the extension off the
    // title on purpose ("a television shows this string and '.zip' on the end
    // says nothing a viewer can act on") and emits no `file` field at all — an
    // earlier draft printed `row.file`, which is undefined on every real row.
    // What it does carry is `format`, `region` and `collection`, and those are
    // the three facts that tell one release apart from the next.
    const fileBits = [];
    if (row.format) fileBits.push(clean(row.format));
    if (row.region) fileBits.push(clean(row.region));
    if (row.collection) fileBits.push(`in ${clean(row.collection)}`);
    r.dFile.textContent = fileBits.join('  ·  ');

    // IGDB fills these server-side. Each is drawn only when it is really
    // there: an empty element left in the flow reads as a broken card, and a
    // hard-coded placeholder would hide the day the art stops arriving.
    const summary = clean(row.summary || row.description, '');
    r.dSummary.textContent = summary;
    r.dSummary.hidden = !summary;

    const shots = (Array.isArray(row.screenshots) ? row.screenshots : [])
      .map(safeImage).filter(Boolean).slice(0, 8);
    r.dShots.replaceChildren(...shots.map((url) => {
      const img = el('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = url;
      return img;
    }));
    r.dShots.hidden = shots.length === 0;

    const cover = safeImage(row.cover || row.poster);
    r.dArt.style.backgroundImage = cover
      ? `linear-gradient(90deg, rgba(10,10,11,.98) 0%, rgba(10,10,11,.7) 42%, rgba(10,10,11,.15) 100%), url("${cover.replace(/"/g, '%22')}")`
      : '';

    const lane = clean(row.lane);
    const armed = Boolean(lane) && hub.lanes[lane] === true;

    // ── THE CONSOLE GETS NO DOWNLOAD BUTTON AT ALL ──────────────────────────
    //
    // Not a disabled one and not a smaller one. The PS5 browser holds a whole
    // response body in RAM and dies with "not enough free system memory" on
    // anything large; that is written down in blazing-ps5/README.md, in
    // tools/games-handoff.py and in the add-on's own queue header. A Download
    // button there is a button guaranteed to fail on exactly the files it
    // exists for, which teaches him the app is broken rather than that the
    // console cannot do this. It chooses, and the Mac fetches.
    if (isConsole()) {
      r.dLanes.replaceChildren(el('p', 'detail-copy',
        'This console cannot fetch its own games: its browser keeps the whole '
        + 'file in memory and runs out on anything large. Send it to the Mac '
        + 'instead — the Mac pulls it onto the 5TB and Blazing Mount installs it here.'));
    } else {
      const go = el('button', 'primary-button');
      go.type = 'button';
      go.id = 'game-source-go';
      go.dataset.lane = lane;
      go.textContent = 'Download';
      // DIM AND DISABLED, NOT REMOVED — the same rule as the lane badge. A
      // missing button says "this release is broken"; a disabled one beside
      // the sentence below says which account is missing.
      go.disabled = !armed;
      go.addEventListener('click', () => resolveAndFetch(row));

      let why;
      if (armed) {
        why = `This release comes down the ${laneLabel(lane)} lane.`;
      } else if (lane) {
        why = `This release needs the ${laneLabel(lane)} lane, and the add-on has no account for it. `
          + 'A source on the Direct download lane still works with no account at all.';
      } else {
        // lane === null: laneFor() found nothing that can fetch this row, which
        // on a box with no debrid keys is every magnet and torrent release.
        why = 'This release is a torrent, and the add-on has neither a Real-Debrid nor a '
          + 'TorBox account to fetch it with. A source on the Direct download lane still '
          + 'works with no account at all.';
      }
      r.dLanes.replaceChildren(go, el('p', 'detail-copy', why));
    }

    r.dStatus.textContent = '';
    r.dStatus.dataset.lane = '';
    r.dPs5.hidden = false;
    if (typeof r.dialog.showModal === 'function') r.dialog.showModal();
  }

  async function resolveAndFetch(row) {
    const r = refs();
    r.dStatus.textContent = 'Resolving…';
    const res = await api(`/games/resolve?ref=${encodeURIComponent(String(row.ref || ''))}`);

    if (res.status === 404) {
      r.dStatus.textContent = 'This add-on has no /games/resolve route yet.';
      return;
    }
    // A debrid lane has STARTED the fetch upstream. That is not a failure and
    // it is not a link yet; saying either would be a lie.
    if (res.status === 202 && res.json && res.json.preparing) {
      const wait = Number(res.json.retryAfterSeconds) || 20;
      r.dStatus.textContent = `The debrid service is preparing this file. Try again in about ${wait}s.`;
      return;
    }
    if (!res.ok || !res.json) {
      r.dStatus.textContent = failureText(res);
      return;
    }
    if (res.json.ok !== true) {
      const tried = Array.isArray(res.json.tried) ? res.json.tried : [];
      const why = clean(res.json.message || res.json.reason, 'No lane could resolve this release.');
      r.dStatus.textContent = tried.length
        ? `${why} Tried: ${tried.map((t) => clean(t && (t.lane || t))).filter(Boolean).join(', ')}.`
        : why;
      return;
    }
    const url = safeDownloadUrl(res.json.url);
    if (!url) {
      r.dStatus.textContent = 'The add-on answered with no usable link.';
      return;
    }

    // An <a download> rather than location.assign: it keeps this page alive so
    // the dialog can report what happened, and it names the file.
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    a.target = '_blank';
    a.id = 'game-source-link';
    a.hidden = true;
    document.body.append(a);
    a.click();
    window.setTimeout(() => a.remove(), 4000);

    // `lane` is the lane that ANSWERED, decided by the server. `provider` is
    // its label — outcome.label, which for the http lane is LANE_LABELS.http,
    // "Direct download". So when the two say the same thing, say it once.
    const lane = clean(res.json.lane, 'http');
    const provider = clean(res.json.provider, '') || laneLabel(lane) || lane;
    // The reply carries NO `filename`. The only name on the wire is the last
    // segment of the resolved url, so that is where it comes from.
    const name = fileNameFrom(url);
    r.dStatus.dataset.lane = lane;
    r.dStatus.textContent = `Started on ${provider}${name ? ` — ${name}` : ''}.`;
  }

  async function handToPs5() {
    const r = refs();
    const row = hub.current;
    if (!row) return;
    r.dStatus.textContent = 'Handing off…';
    // A GET, and that is not a style choice. The console side of this is the
    // JTPlay plugin, whose QuickJS sandbox exposes exactly one network call,
    // `http.get` — there is no http.post to call. The add-on serves it as
    // `app.get('/games/ps5/queue')` for that reason and writes down the three
    // things that make a state-changing GET safe here: LAN only, idempotent on
    // a ref already queued, and the ref itself is signed. One shape for both
    // callers.
    const params = new URLSearchParams({ ref: String(row.ref || '') });
    const title = clean(row.title || row.name);
    if (title) params.set('title', title);
    if (row.platform) params.set('platform', clean(row.platform).toLowerCase());
    const res = await api(`/games/ps5/queue?${params.toString()}`);
    if (res.status === 404) {
      r.dStatus.textContent = clean(res.json && res.json.message,
        'No hand-off queue on the add-on yet (GET /games/ps5/queue?ref=). Nothing was sent.');
      return;
    }
    if (res.status === 403) {
      r.dStatus.textContent = 'The hand-off queue only works on the home network. Nothing was sent.';
      return;
    }
    if (!res.ok || !res.json || res.json.ok !== true) {
      r.dStatus.textContent = clean(res.json && (res.json.message || res.json.error),
        `The hand-off queue refused it (HTTP ${res.status}).`);
      return;
    }
    // The route answers `duplicate: true` rather than queueing a second copy,
    // and it names the folder it will land in. Both are worth repeating: a
    // second press that silently did nothing reads as a press that failed.
    r.dStatus.textContent = res.json.duplicate === true
      ? 'That one is already waiting for the Mac.'
      : clean(res.json.message,
        'Queued. The Mac fetches it onto the 5TB, then Blazing Mount installs it on the console.');
  }

  // ── accounts: the SERVER's state, never a second copy ─────────────────────
  function paintLanes() {
    const r = refs();
    if (!r.laneState) return;
    r.laneState.replaceChildren(...LANE_ORDER.map((lane) => {
      const on = hub.lanes[lane] === true;
      const row = el('div', 'games-lane-state-row');
      const badge = el('span', 'games-lane-badge', laneLabel(lane));
      badge.dataset.lane = lane;
      badge.dataset.armed = on ? 'true' : 'false';
      if (!on) badge.setAttribute('aria-disabled', 'true');
      row.append(badge);
      row.append(el('span', '', lane === 'http'
        // lanesAvailable() in the add-on returns http:true unconditionally, and
        // says why in its own comment: a direct source needs nothing configured.
        ? 'Always ready. It needs no account at all.'
        : (on ? 'The add-on has a key for this.' : 'The add-on has no key for this.')));
      return row;
    }));
    if (r.accStatus) {
      r.accStatus.textContent = hub.sourcesLoaded
        ? (hub.debridEnabled
          ? 'Debrid is on. The add-on holds the keys; nothing is stored in this browser.'
          : 'No debrid account is configured on the add-on. Direct sources still work.')
        : 'Asking the add-on…';
    }
  }

  // ── add a source ──────────────────────────────────────────────────────────
  async function addSource(event) {
    event.preventDefault();
    const r = refs();
    const id = clean(r.srcId.value).toLowerCase();
    const label = clean(r.srcName.value);
    const url = clean(r.srcUrl.value);
    const platforms = clean(r.srcPlatforms.value)
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!id || !label || !platforms.length) {
      r.srcAddStatus.textContent = 'An id, a name and at least one system are all needed.';
      return;
    }
    r.srcAddStatus.textContent = 'Adding…';
    // NESTED UNDER `source`, which is the shape the route states in its 400:
    // Send { "source": { "id": …, "label": …, "platforms": […], "delivery": …,
    // "search": {…} }. A flat body is accepted as a fallback but the documented
    // shape is the one to send.
    const res = await api('/games/sources', {
      method: 'POST',
      body: { source: { id, label, url, platforms, delivery: r.srcDelivery.value } },
    });
    if (res.status === 404 || res.status === 405) {
      r.srcAddStatus.textContent = 'This add-on has no POST /games/sources yet, so this was not saved.';
      return;
    }
    // The route is LAN-only on purpose: it writes a file that holds
    // credentials. Say that, rather than "it refused".
    if (res.status === 403) {
      r.srcAddStatus.textContent = 'Adding a source only works on the home network — it writes a file that holds credentials.';
      return;
    }
    if (!res.ok || !res.json || res.json.ok !== true) {
      r.srcAddStatus.textContent = clean(res.json && (res.json.message || res.json.error),
        `The add-on refused it (HTTP ${res.status}).`);
      return;
    }
    r.srcAddStatus.textContent = `Added ${label}.`;
    r.srcId.value = '';
    r.srcName.value = '';
    r.srcUrl.value = '';
    r.srcPlatforms.value = '';
    // The route hands the whole new registry back, so there is no second GET.
    if (Array.isArray(res.json.sources)) {
      hub.sources = res.json.sources;
      paintSources();
      paintSourceFilter();
    } else {
      await loadSources();
    }
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  function bind() {
    if (hub.bound) return;
    hub.bound = true;
    const r = refs();
    if (r.tabs) {
      r.tabs.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-games-tab]');
        if (btn) showTab(btn.dataset.gamesTab);
      });
    }
    if (r.form) {
      r.form.addEventListener('submit', (event) => {
        event.preventDefault();
        hub.query = String(r.input.value || '').trim();
        runSearch();
      });
    }
    if (r.sourceFilter) {
      r.sourceFilter.addEventListener('change', () => {
        hub.source = r.sourceFilter.value;
        runSearch();
      });
    }
    if (r.srcAdd) r.srcAdd.addEventListener('submit', addSource);
    if (r.dClose) r.dClose.addEventListener('click', () => r.dialog && r.dialog.open && r.dialog.close());
    if (r.dialog) r.dialog.addEventListener('close', () => { hub.current = null; });
    if (r.dPs5) r.dPs5.addEventListener('click', handToPs5);
  }

  function mountHub() {
    bind();
    paintPlatforms();
    paintLanes();
    const r = refs();
    if (r.status && !r.results.children.length) {
      r.status.textContent = 'Type a game name, or pick a system.';
    }
    // The registry is loaded on mount, not on the Sources tab, because the
    // Browse tab's chips, its source dropdown and every lane badge are built
    // from it.
    if (!hub.sourcesLoaded) loadSources();
    showTab(hub.tab);
  }

  // Overwrite the one key app.js calls. mountCatalogue stays reachable so the
  // Catalogue tab can still start the RAWG half.
  window.BlazingGames = Object.assign(window.BlazingGames || {}, { mount: mountHub, mountHub });
})();
