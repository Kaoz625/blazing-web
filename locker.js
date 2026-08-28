/* Blazing web "My Locker": Markus's private Streamtape files, shown as one more
 * shelf on Home. It reuses the app's own shelf/card markup (.row / .row-track /
 * .card) and the app's own player (openPlayer from app.js), so there is no new
 * design system and no second video path here.
 *
 * WIRE CONTRACT (fleet.lyreosai.com, blazing-fleet repo):
 *   GET /streamtape/list?deviceId=<id>
 *       -> [{ id, name, size, embed, folder, createdAt, downloads, converted }]
 *   GET /streamtape/resolve/<fileId>?deviceId=<id>
 *       -> { id, name, size, url }   url is a direct, range-serving mp4
 *   Both need the device to be registered AND admin-approved:
 *     deviceId query param + X-Device-Token header.
 *     400 = unregistered/bad request, 403 = not approved, 503 = Streamtape off.
 *
 * AUTH: the credentials are the ones profile.js already registered and stored.
 * This file only READS that storage key — it never registers a device of its
 * own, because a second registration path would mean a second device waiting
 * for admin approval. No credentials, or any refusal from the server, and the
 * whole shelf simply never appears: this is one person's feature, and almost
 * nobody opening the site is meant to see an error about it.
 */
'use strict';

(() => {
  const FLEET_BASE = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  const DEVICE_KEY = 'blazing-web-profile-device-v1'; // owned by profile.js; read-only here
  const LIST_TIMEOUT_MS = 15000;
  const RESOLVE_TIMEOUT_MS = 45000; // Streamtape enforces a ~6s wait before it hands over a link.
  const REFRESH_MIN_GAP_MS = 20000; // A tab flicked back and forth must not hammer the fleet.
  const MAX_FILES = 200;

  const state = {
    credentials: null,
    section: null,
    track: null,
    status: null,
    files: [],
    lastFetch: 0,
    fetching: false,
    resolving: false,
    hidden: false, // set once the server says no; nothing is retried after that.
    // Nobody is watching yet until profile.js says so, and "nobody" must not
    // default to "safe to show" — see isKidsProfile() below for why unknown
    // starts closed rather than open.
    isKids: true,
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function plainText(value, fallback = '') {
    const out = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return out ? out.slice(0, 200) : fallback;
  }

  function readCredentials() {
    try {
      const value = JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null');
      if (!value || typeof value !== 'object') return null;
      const id = plainText(value.id);
      const token = plainText(value.token);
      return id && token ? { id, token } : null;
    } catch {
      return null;
    }
  }

  function humanSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`;
    if (value >= 1e6) return `${Math.round(value / 1e6)} MB`;
    return `${Math.max(1, Math.round(value / 1e3))} KB`;
  }

  function safeFile(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = plainText(raw.id);
    if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    return {
      id,
      name: plainText(raw.name, 'Untitled file'),
      size: Number(raw.size) || 0,
      converted: raw.converted !== false,
    };
  }

  function httpsUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  async function requestJSON(path, timeoutMs) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${FLEET_BASE}${path}`, {
        headers: { 'X-Device-Token': state.credentials.token },
        signal: controller.signal,
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
      });
      const raw = await response.text();
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      return { status: response.status, ok: response.ok, body };
    } catch {
      return { status: 0, ok: false, body: null };
    } finally {
      window.clearTimeout(timer);
    }
  }

  function addStyle() {
    const style = element('style');
    style.textContent = `
      .locker-card .card-label { padding-top: 40px; }
      .locker-meta { position: absolute; top: 8px; right: 8px; border-radius: 999px; padding: 4px 7px; color: #fff; background: rgba(0,0,0,.72); font-size: 10px; font-weight: 800; letter-spacing: .03em; }
      .locker-card[aria-busy="true"] { cursor: wait; opacity: .62; }
      .locker-card[aria-busy="true"]::after { content: ""; position: absolute; top: 50%; left: 50%; width: 26px; height: 26px; margin: -13px 0 0 -13px; border: 3px solid rgba(255,255,255,.18); border-top-color: var(--accent, #ff3d47); border-radius: 50%; animation: spin .8s linear infinite; }
      .locker-status { margin: 0 0 11px 18px; color: var(--muted, #a3a3aa); font-size: 13px; min-height: 18px; }
      .locker-status[data-state="error"] { color: #ff9aa1; }
      @media (min-width: 900px) { .locker-status { margin-left: 26px; } }
    `;
    document.head.appendChild(style);
  }

  function currentRoute() {
    const active = document.querySelector('.topnav button.active, .drawer-nav button.active');
    return (active && active.dataset.view) || 'home';
  }

  // The locker shelf lives in #rows next to the catalog shelves, so it must obey
  // the same Home-only rule app.js applies to a row with no media type.
  function syncVisibility() {
    if (!state.section) return;
    state.section.hidden = currentRoute() !== 'home';
  }

  function ensureSection() {
    if (state.section) return state.section;
    const rows = document.getElementById('rows');
    if (!rows) return null;
    const section = element('section', 'row locker-row');
    section.dataset.name = 'My Locker';
    section.dataset.type = '';
    section.appendChild(element('h2', 'row-title', 'My Locker'));
    state.status = element('p', 'locker-status');
    state.status.setAttribute('role', 'status');
    section.appendChild(state.status);
    state.track = element('div', 'row-track');
    section.appendChild(state.track);
    // After the fresh Home shelves, before the slower add-on catalog rows.
    const fresh = rows.querySelectorAll('[data-fresh-shelf="true"]');
    const anchor = fresh.length ? fresh[fresh.length - 1].nextSibling : rows.firstChild;
    rows.insertBefore(section, anchor);
    state.section = section;
    syncVisibility();
    return section;
  }

  function removeSection() {
    if (state.section) state.section.remove();
    state.section = null;
    state.track = null;
    state.status = null;
  }

  function setStatus(message, kind = 'info') {
    if (!state.status) return;
    state.status.textContent = message || '';
    state.status.dataset.state = kind;
  }

  function buildCard(file) {
    const card = element('button', 'card no-image locker-card');
    card.type = 'button';
    card.dataset.fileId = file.id;
    card.setAttribute('aria-label', `Play ${file.name}`);
    const size = humanSize(file.size);
    if (size) card.appendChild(element('span', 'locker-meta', size));
    card.appendChild(element('span', 'card-label', file.name));
    card.addEventListener('click', () => playFile(file, card));
    return card;
  }

  function render() {
    if (!ensureSection()) return;
    if (!state.files.length) {
      state.track.replaceChildren();
      setStatus('Nothing in your locker yet. Upload a file and it shows up here.');
      return;
    }
    setStatus('');
    state.track.replaceChildren(...state.files.map(buildCard));
  }

  async function playFile(file, card) {
    if (state.resolving) return;
    if (typeof window.openPlayer !== 'function') {
      setStatus('The player is not ready yet. Try again.', 'error');
      return;
    }
    state.resolving = true;
    card.setAttribute('aria-busy', 'true');
    setStatus(`Getting a link for ${file.name}… this takes a few seconds.`);
    try {
      const result = await requestJSON(
        `/streamtape/resolve/${encodeURIComponent(file.id)}?deviceId=${encodeURIComponent(state.credentials.id)}`,
        RESOLVE_TIMEOUT_MS
      );
      const url = result.ok ? httpsUrl(result.body && result.body.url) : '';
      if (!url) {
        setStatus(result.status === 503
          ? 'The locker service is off right now.'
          : `Could not get a link for ${file.name}. Try again.`, 'error');
        return;
      }
      setStatus('');
      window.openPlayer(plainText(result.body.name, file.name), url);
    } finally {
      card.removeAttribute('aria-busy');
      state.resolving = false;
    }
  }

  async function refresh(force = false) {
    if (state.hidden || state.isKids || state.fetching || !state.credentials) return;
    const now = Date.now();
    if (!force && now - state.lastFetch < REFRESH_MIN_GAP_MS) return;
    state.fetching = true;
    state.lastFetch = now;
    try {
      const result = await requestJSON(
        `/streamtape/list?deviceId=${encodeURIComponent(state.credentials.id)}`,
        LIST_TIMEOUT_MS
      );
      // 400 unregistered, 401/403 not approved, 503 Streamtape unconfigured, 404
      // route absent: none of these are this viewer's problem. The shelf goes
      // away for good rather than showing an error nobody can act on.
      if (!result.ok) {
        if (result.status >= 400) {
          state.hidden = true;
          removeSection();
        }
        return;
      }
      const list = Array.isArray(result.body)
        ? result.body
        : (result.body && Array.isArray(result.body.files) ? result.body.files : null);
      if (!list) {
        state.hidden = true;
        removeSection();
        return;
      }
      // The server already sorts newest first; this keeps that order as given.
      state.files = list.map(safeFile).filter(Boolean).slice(0, MAX_FILES);
      render();
    } finally {
      state.fetching = false;
    }
  }

  // This is Markus's own personal locker — his uploads, no content rating on
  // any of them — surfaced as a shelf next to everyone else's catalog rows.
  // It had NO profile awareness at all: gated on "is this device approved",
  // never on "which profile is watching," so anything he'd uploaded (a movie
  // rip, whatever) was one profile-switch away from a Kids profile. profile.js
  // already fires 'blazing-profile-selected' with isKids on every switch —
  // app.js's Emby rows already react to it; this shelf never had a listener.
  function onProfileSelected(event) {
    const detail = (event && event.detail) || {};
    state.isKids = detail.isKids === true;
    if (state.isKids) {
      removeSection();
    } else {
      refresh(true);
    }
  }

  function start() {
    state.credentials = readCredentials();
    if (!state.credentials) return; // No approved browser here: no locker, no trace of one.
    addStyle();
    // Nothing is fetched here. state.isKids starts true (see state above), so
    // the first real fetch waits for profile.js to say who is actually
    // watching — a profile picked before this listener attaches still fires
    // the event synchronously from selectProfile()/verifyPin(), so there is
    // no missed-event window.
    document.addEventListener('blazing-profile-selected', onProfileSelected);
    // Self-refreshing without a polling loop: a file uploaded elsewhere appears
    // the next time this tab is looked at again.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh(false);
    });
    window.addEventListener('focus', () => refresh(false));
    // app.js swaps routes on these; re-apply the Home-only rule after it runs.
    document.addEventListener('click', (event) => {
      const target = event.target && event.target.closest ? event.target.closest('[data-view]') : null;
      if (target) window.setTimeout(syncVisibility, 0);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
