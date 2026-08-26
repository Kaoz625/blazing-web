/**
 * Web telemetry sender — TELEMETRY-CONTRACT.md, platform "web".
 *
 *   POST https://fleet.lyreosai.com/events?deviceId=<id>
 *   X-Device-Token: <token>
 *
 * The FLEET, not the addon. Bare path, no /api prefix. Confusing those two has
 * already caused four production bugs in this codebase.
 *
 * The fleet's CORS allow-list is `https://kaoz625.github.io` (server.js:98),
 * and it already permits POST and the X-Device-Token header, so this works from
 * the production origin with no server change. From a local file:// or
 * localhost page the preflight is refused — that is expected, and the sender
 * treats it like any other failure: one retry, then drop, and never a visible
 * error.
 *
 * Credentials are the ones profile.js already stores. This file only reads them.
 */
'use strict';

(() => {
  const FLEET_BASE = 'https://fleet.lyreosai.com';
  const DEVICE_KEY = 'blazing-web-profile-device-v1'; // owned by profile.js
  const APP_VERSION = '1.0.0-web';

  const MAX_BUFFER = 200;   // contract rule 4
  const FLUSH_AT = 25;      // contract rule 2
  const FLUSH_MS = 30000;   // contract rule 2
  const POST_TIMEOUT_MS = 8000;

  /**
   * Rule 6: send nothing secret. A DENY list, not an allow list, because the
   * next person adding an event should not have to register its props to get
   * them through — they should have to work to leak something.
   */
  const FORBIDDEN = /url|token|secret|pass|pin|auth|cookie|magnet|hash|key|href|link/i;

  const state = {
    buffer: [],
    counter: 0,
    sessionId: 's_' + Math.random().toString(36).slice(2, 8),
    timer: null,
    sending: false,
    dropped: 0,
  };

  function credentials() {
    try {
      const value = JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null');
      if (!value || typeof value !== 'object') return null;
      const id = String(value.id || '').trim();
      const token = String(value.token || '').trim();
      return id && token ? { id, token } : null;
    } catch { return null; }
  }

  function scrub(props) {
    const out = {};
    if (!props || typeof props !== 'object') return out;
    for (const [k, v] of Object.entries(props)) {
      if (FORBIDDEN.test(k)) {
        // Loud on purpose. A silently dropped prop is a metric that quietly
        // reads zero forever.
        console.warn('[telemetry] refused prop "' + k + '" — see rule 6');
        continue;
      }
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') continue;             // no nested shapes
      out[k] = typeof v === 'string' ? v.slice(0, 300) : v;
    }
    return out;
  }

  /** Queue one event. Never throws, never blocks, never awaited. */
  function log(name, props) {
    try {
      if (!name) return;
      state.counter += 1;
      state.buffer.push({
        key: 'web_' + Math.floor(Date.now() / 1000) + '_' + state.counter,
        ts: Math.floor(Date.now() / 1000),
        name: String(name),
        props: scrub(props),
      });
      if (state.buffer.length > MAX_BUFFER) {
        state.dropped += state.buffer.length - MAX_BUFFER;
        state.buffer.splice(0, state.buffer.length - MAX_BUFFER); // oldest first
      }
      if (state.buffer.length >= FLUSH_AT) flush();
    } catch (e) { /* rule 3 */ }
  }

  async function post(body, creds, keepalive) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${FLEET_BASE}/events?deviceId=${encodeURIComponent(creds.id)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Device-Token': creds.token },
          body: JSON.stringify(body),
          signal: controller.signal,
          keepalive: !!keepalive,
        },
      );
      return res.ok;
    } finally { clearTimeout(timer); }
  }

  /**
   * Send what is buffered.
   *
   * `keepalive` is what makes the page-hide flush actually leave the browser;
   * a normal fetch is cancelled when the document goes away. sendBeacon would
   * also survive, but it cannot set X-Device-Token, and putting the token in
   * the query string would write it into every proxy log we do not control.
   */
  async function flush(keepalive) {
    if (state.sending || !state.buffer.length) return;
    const creds = credentials();
    if (!creds) return;                       // not enrolled; nothing to do

    const batch = state.buffer.splice(0, MAX_BUFFER);
    state.sending = true;
    const body = {
      platform: 'web',
      appVersion: APP_VERSION,
      sessionId: state.sessionId,
      events: batch,
    };
    const profileId = (() => { try { return localStorage.getItem('profileId') || ''; } catch { return ''; } })();
    if (profileId) body.profileId = profileId;

    try {
      let ok = await post(body, creds, keepalive).catch(() => false);
      // Rule 5: retry once, then drop. The data is not worth a second
      // round-trip, and the idempotency key makes a duplicate harmless.
      if (!ok) ok = await post(body, creds, keepalive).catch(() => false);
      if (!ok) state.dropped += batch.length;
    } catch (e) {
      state.dropped += batch.length;
    } finally {
      state.sending = false;
    }
  }

  function start() {
    if (state.timer) return;
    state.timer = setInterval(() => flush(), FLUSH_MS);
    // Rule 2: flush when the app backgrounds. visibilitychange is the only
    // event that reliably fires on mobile Safari; 'unload' does not.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush(true);
    });
    window.addEventListener('pagehide', () => flush(true));
  }

  start();
  log('app_open', { cold: true });

  window.BlazingTelemetry = {
    log,
    flush,
    /** Exposed for the console and for tests; carries no secret. */
    debug: () => ({
      pending: state.buffer.length,
      dropped: state.dropped,
      sessionId: state.sessionId,
      enrolled: !!credentials(),
    }),
  };
})();
