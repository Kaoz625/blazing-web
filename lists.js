/* Watchlist / Collection / Watched — the household's saved titles, kept per
   PROFILE on the FLEET, not in this browser.

   AUDIT B27 / B31 / B22. Until this file existed the web had ONE saved list and
   it lived in localStorage under `blazing-my-list-v2:<profile>`. Three things
   were wrong with that and only the first one is obvious:

     1. Clearing site data deleted it.
     2. A title saved in the browser never reached the Roku or the Fire Stick,
        and a title saved on a TV never reached the browser. Markus's standing
        rule is "roku, web, and firestick should all feel like im using the same
        app no matter what", and a saved list is the one surface where the
        household actually notices the difference.
     3. There was ONE list where the TVs have THREE. The Roku
        (DetailsScreen.brs:1422) and Fire TV (ListsClient.kt) have had
        watchlist / collection / watched since the lists work; the browser had
        "My list".

   This module is the clause-for-clause port of Fire TV's ListsClient.kt, which
   is the reference implementation: same three names, same routes, same
   X-Device-Token header, same "POST is an upsert so add() never has to ask
   first", same cache-owner guard so a profile switch mid-request cannot graft
   one household member's title onto another's list.

   LOCALSTORAGE IS NOW A CACHE, NEVER THE STORE. It draws the three buttons and
   the Library screen on the first frame and it is the whole answer when the
   browser is offline — but every write goes to the fleet first and a write that
   fails changes nothing locally. That is the difference between a cache and a
   store, and it is the whole of B27.

   THE OLD LIST IS MIGRATED, NOT DROPPED. See migrate() at the foot of the file. */
'use strict';
(() => {
  const FLEET_BASE = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  /* Written by profile.js on registration and read straight out of storage, the
     same way app.js's storedDeviceCredentials() reads it for /progress. The
     fleet checks X-Device-Token on EVERY /profiles route; without it the answer
     is 401 and the button correctly but uselessly reports "Couldn't save". */
  const DEVICE_KEY = 'blazing-web-profile-device-v1';
  const CACHE_KEY = 'blazing-lists-cache-v1:';
  /* The single browser-local list this replaced. Still read once per profile,
     by migrate(). */
  const LEGACY_KEY = 'blazing-my-list-v2:';
  const MIGRATED_KEY = 'blazing-lists-migrated-v1:';
  const CHANGED = 'blazing-lists-changed';
  const TIMEOUT_MS = 12000;
  /* One title's worth of fields is small; a runaway list is not. The old
     readList() capped at 100 for the same reason. */
  const MAX_ITEMS = 200;

  const WATCHLIST = 'watchlist';
  const COLLECTION = 'collection';
  const WATCHED = 'watched';
  const LIST_NAMES = Object.freeze([WATCHLIST, COLLECTION, WATCHED]);

  /** The active profile's id, or null when nobody is connected. */
  let profileId = null;
  /** Bumped on every setProfile so a late answer for the previous viewer is dropped. */
  let generation = 0;
  let snapshot = empty();
  /** 'idle' | 'loading' | 'ok' | 'error' — what the Library screen draws. */
  let phase = 'idle';
  let refreshing = null;

  function empty() {
    return { watchlist: [], collection: [], watched: [] };
  }

  /* `null` and the STRING "null" are both absent: the fleet's rows can carry
     either, which is why Fire TV's parseSnapshot and the Roku's FleetEntries
     both test for the literal. */
  function text(value, fallback = '') {
    const cleaned = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return !cleaned || cleaned === 'null' ? fallback : cleaned;
  }

  /* Posters are drawn into the page, so only https (and the data: URIs the
     fixtures use) may reach an <img src>. Same rule as app.js's safeHttpsUrl. */
  function httpsUrl(value) {
    const raw = text(value);
    if (!raw) return '';
    if (/^data:image\//i.test(raw)) return raw.slice(0, 4096);
    try {
      const url = new URL(raw, window.location.href);
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function credentials() {
    try {
      const value = JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null');
      if (!value || typeof value !== 'object') return null;
      const id = text(value.id);
      const token = text(value.token);
      return id && token ? { id, token } : null;
    } catch {
      return null;
    }
  }

  /**
   * One authenticated fleet call. Never throws: every caller wants "did it
   * work", and a thrown error inside a click handler is a button that silently
   * does nothing — which is the exact defect this audit found elsewhere.
   */
  async function call(method, path, body) {
    const creds = credentials();
    if (!creds) return { ok: false, data: null };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const url = `${FLEET_BASE}${path}${path.includes('?') ? '&' : '?'}deviceId=${encodeURIComponent(creds.id)}`;
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        mode: 'cors',
        // The device token is a HEADER, never a cookie. Same decision as
        // app.js's fetchJSON.
        credentials: 'omit',
        headers: {
          Accept: 'application/json',
          'X-Device-Token': creds.token,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) return { ok: false, data: null };
      return { ok: true, data: await response.json().catch(() => null) };
    } catch {
      return { ok: false, data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /** One wire row -> one drawable item, or null when it cannot be opened. */
  function parseItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = text(raw.id);
    if (!id) return null;
    return {
      id,
      type: text(raw.type, 'movie').toLowerCase(),
      // Falling back to the id rather than "Untitled" is the Roku's rule
      // (FleetEntries): an id at least identifies the row.
      name: text(raw.name, id),
      poster: httpsUrl(raw.poster),
      background: httpsUrl(raw.background),
      // NOT on the fleet's own POST body, and deliberately carried anyway — see
      // the note on toWireItem().
      contentRating: text(raw.contentRating).slice(0, 12),
      addedAt: text(raw.addedAt),
    };
  }

  /** Newest first, deduplicated by id. The Roku sorts here too (FleetNewestFirst);
   *  the fleet stores insertion order and does not sort. */
  function parseList(rawArray) {
    if (!Array.isArray(rawArray)) return [];
    const seen = new Set();
    const items = [];
    for (const raw of rawArray) {
      const item = parseItem(raw);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
      if (items.length >= MAX_ITEMS) break;
    }
    return items.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  }

  /**
   * The server answers either the bare lists object or one wrapped in `lists`,
   * depending on the route. Accept both rather than depend on which — the same
   * call the Roku makes at Fleet.brs:265.
   */
  function parseSnapshot(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw.lists && typeof raw.lists === 'object' ? raw.lists : raw;
    const out = empty();
    for (const name of LIST_NAMES) out[name] = parseList(source[name]);
    return out;
  }

  /**
   * What a POST actually sends. id / type / name / poster are the four fields
   * Fire TV sends (ListsClient.kt:160) and the four the server stores.
   *
   * contentRating rides along as a FIFTH because this client — and only this
   * client — filters the saved list with ratingAllowed(meta.contentRating);
   * there is no /rating lookup in the browser the way Fire TV has RatingClient.
   * If the fleet keeps the field, a title saved here stays correctly gated
   * everywhere. If it drops it, an unrated row is refused under a 'general' cap
   * and admitted above it, which is exactly what ratingAllowed('') already does
   * for every other unrated row in the app — fail closed for a kids profile,
   * never fail open.
   */
  function toWireItem(meta) {
    return {
      id: text(meta && meta.id),
      type: text(meta && meta.type, 'movie').toLowerCase(),
      name: text(meta && meta.name, text(meta && meta.id)),
      poster: httpsUrl(meta && meta.poster),
      contentRating: text(meta && meta.contentRating).slice(0, 12),
    };
  }

  function readCache(id) {
    try {
      return parseSnapshot(JSON.parse(localStorage.getItem(CACHE_KEY + encodeURIComponent(id)) || 'null'));
    } catch {
      return null;
    }
  }

  function writeCache(id, value) {
    if (!id) return;
    try {
      localStorage.setItem(CACHE_KEY + encodeURIComponent(id), JSON.stringify(value));
    } catch {
      // A browser that cannot cache still works; it just redraws from the fleet.
    }
  }

  function emit() {
    document.dispatchEvent(new CustomEvent(CHANGED, {
      detail: { profileId, phase, snapshot: snapshotOf() },
    }));
  }

  function snapshotOf() {
    return {
      watchlist: snapshot.watchlist.slice(),
      collection: snapshot.collection.slice(),
      watched: snapshot.watched.slice(),
      total: snapshot.watchlist.length + snapshot.collection.length + snapshot.watched.length,
    };
  }

  function items(list) {
    return LIST_NAMES.includes(list) ? snapshot[list].slice() : [];
  }

  function contains(list, id) {
    const wanted = text(id);
    return Boolean(profileId) && LIST_NAMES.includes(list) && !!wanted
      && snapshot[list].some((item) => item.id === wanted);
  }

  /** Replaces one list and publishes it, cache included. */
  function put(list, next) {
    snapshot = { ...snapshot, [list]: next };
    writeCache(profileId, snapshot);
    emit();
  }

  /** Loads all three lists in one call. Safe to call on every detail open. */
  function refresh() {
    if (!profileId) return Promise.resolve(null);
    if (refreshing) return refreshing;
    const mine = generation;
    const owner = profileId;
    phase = 'loading';
    emit();
    refreshing = (async () => {
      const { ok, data } = await call('GET', `/profiles/${encodeURIComponent(owner)}/lists`);
      // A profile switch while the request was in the air: this answer belongs
      // to somebody else now. Same guard as Fire TV's cacheProfileId test.
      if (generation !== mine || profileId !== owner) return null;
      const parsed = ok ? parseSnapshot(data) : null;
      if (!parsed) {
        // The cached copy stays on screen. An unreachable fleet must not read as
        // an empty list — that is the one wrong answer here, because the viewer
        // would add the title again.
        phase = 'error';
        emit();
        return null;
      }
      snapshot = parsed;
      phase = 'ok';
      writeCache(owner, snapshot);
      emit();
      return snapshotOf();
    })();
    const started = refreshing;
    // Cleared only when it is still OURS. setProfile() drops the handle on a
    // profile change, and a late `finally` from the previous viewer's request
    // must not null out the new one's — that would let a second GET start while
    // the first is still in the air.
    started.finally(() => { if (refreshing === started) refreshing = null; });
    return started;
  }

  /**
   * Adds one item, and NEVER removes it.
   *
   * The server's POST is an upsert, so sending it twice is safe and asking
   * first is not worth a round trip — Fire TV's add() carries the same note.
   */
  async function add(list, meta) {
    const item = toWireItem(meta);
    if (!LIST_NAMES.includes(list) || !item.id || !profileId) return false;
    const owner = profileId;
    const mine = generation;
    const { ok } = await call('POST', `/profiles/${encodeURIComponent(owner)}/lists/${encodeURIComponent(list)}`, item);
    if (!ok) return false;
    // Only touch the cache while it still describes THIS profile.
    if (generation === mine && profileId === owner) {
      // addedAt is stamped locally so the new row sorts first straight away;
      // the next refresh replaces it with the fleet's own value.
      put(list, [
        { ...parseItem(item), addedAt: new Date().toISOString() },
        ...snapshot[list].filter((existing) => existing.id !== item.id),
      ]);
    }
    return true;
  }

  /** Removes one item without consulting toggle state, so a stale screen cannot
   *  add it back by mistake. */
  async function remove(list, id) {
    const wanted = text(id);
    if (!LIST_NAMES.includes(list) || !wanted || !profileId) return false;
    const owner = profileId;
    const mine = generation;
    const { ok } = await call(
      'DELETE',
      `/profiles/${encodeURIComponent(owner)}/lists/${encodeURIComponent(list)}/${encodeURIComponent(wanted)}`,
    );
    if (!ok) return false;
    if (generation === mine && profileId === owner) {
      put(list, snapshot[list].filter((item) => item.id !== wanted));
    }
    return true;
  }

  /**
   * Adds or removes, and returns the NEW membership state — or null when the
   * call failed, so the button can say "Couldn't save" instead of flipping its
   * label and pretending it saved. Fire TV returns exactly this tri-state.
   */
  async function toggle(list, meta) {
    const item = toWireItem(meta);
    if (!LIST_NAMES.includes(list) || !item.id || !profileId) return null;
    if (contains(list, item.id)) return (await remove(list, item.id)) ? false : null;
    return (await add(list, item)) ? true : null;
  }

  /**
   * THE OLD BROWSER-LOCAL LIST IS MOVED UP, NOT DROPPED.
   *
   * `blazing-my-list-v2:<profile>` was one list, so it becomes the WATCHLIST —
   * the list the single "My list" button on the TVs maps to, and the one whose
   * description ("Titles you plan to watch") matches what a saved title meant
   * here.
   *
   * Runs once per profile, AFTER the first refresh so the upserts land on top
   * of whatever the TVs already put there. Nothing is deleted locally until
   * every item has been accepted by the fleet: a half-migrated list that has
   * lost its origin is unrecoverable, and one extra idempotent POST next
   * session is not.
   */
  async function migrate(id) {
    const flag = MIGRATED_KEY + encodeURIComponent(id);
    let legacy = [];
    try {
      if (localStorage.getItem(flag) === '1') return false;
      legacy = JSON.parse(localStorage.getItem(LEGACY_KEY + encodeURIComponent(id)) || '[]');
    } catch {
      return false;
    }
    const pending = (Array.isArray(legacy) ? legacy : [])
      .map(toWireItem)
      .filter((item) => item.id)
      .slice(0, MAX_ITEMS);
    let moved = false;
    let complete = true;
    for (const item of pending) {
      if (contains(WATCHLIST, item.id)) continue;
      // Serial, not Promise.all: this is a one-off on a profile's first run and
      // a hundred parallel POSTs to the fleet is not worth the milliseconds.
      // eslint-disable-next-line no-await-in-loop
      if (await add(WATCHLIST, item)) moved = true;
      else complete = false;
    }
    if (!complete) return moved;
    try {
      localStorage.setItem(flag, '1');
      localStorage.removeItem(LEGACY_KEY + encodeURIComponent(id));
    } catch {
      // The flag is an optimisation. Without it the upserts simply run again.
    }
    return moved;
  }

  /**
   * The one entry point for a profile change. app.js owns the profile
   * lifecycle — it has three paths into it (the picker, a restored session and
   * sign-out) and only it knows which one is running — so this module listens
   * for no events of its own.
   */
  function setProfile(id) {
    const next = text(id) || null;
    const mine = ++generation;
    profileId = next;
    snapshot = empty();
    phase = next ? 'loading' : 'idle';
    refreshing = null;
    if (!next) {
      emit();
      return Promise.resolve(null);
    }
    // The cached copy draws the screen and the three buttons on the first frame
    // and is the whole answer offline.
    const cached = readCache(next);
    if (cached) snapshot = cached;
    emit();
    return refresh().then(async (loaded) => {
      if (generation !== mine) return null;
      const moved = await migrate(next);
      if (generation !== mine) return null;
      return moved ? snapshotOf() : loaded;
    });
  }

  window.BlazingLists = Object.freeze({
    WATCHLIST,
    COLLECTION,
    WATCHED,
    CHANGED,
    names: () => LIST_NAMES.slice(),
    profile: () => profileId,
    phase: () => phase,
    snapshot: snapshotOf,
    items,
    contains,
    refresh,
    add,
    remove,
    toggle,
    setProfile,
    core: Object.freeze({ parseSnapshot, parseList, parseItem, toWireItem, httpsUrl }),
  });
})();
