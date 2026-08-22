/* Blazing web watch party: chat, quick reactions, and a small mesh voice/video
 * call layered next to (never inside of) the existing player. This module
 * never touches #video or any /party/:code/state WRITE — it only reads party
 * liveness and talks to the separate realtime signaling channel.
 *
 * WIRE CONTRACT this codes against (fleet.lyreosai.com, blazing-fleet repo):
 *   GET  /party/active?householdId=<id>   -> {code,...} | 204 (no device auth)
 *   GET  /party/:code/state               -> {code,...} | 404 | 410 (no auth)
 *   WS   wss://fleet.lyreosai.com/party/<CODE>/signal?peerId=<id>
 *     recv: {type:'peer-list',peers:[...]} | {type:'peer-joined',from} |
 *           {type:'peer-left',from} | {type:'offer'|'answer'|'ice-candidate',
 *           from,payload} | {type:'chat',from,text} | {type:'reaction',from,emoji}
 *     send: {type:'offer'|'answer'|'ice-candidate',to,payload} |
 *           {type:'chat',text} | {type:'reaction',emoji}
 *     close codes: 4404 no such party, 4410 party ended, 4409 replaced by a
 *     newer connection for this peerId, 4400 bad handshake.
 *   The server never carries a display name on chat/reaction messages ("from"
 *   is always a peerId) — this module labels people by a short peerId tag.
 *
 * Nothing here requires a registered device. /party/active is a bonus signal
 * used only when this browser already has device credentials from profile.js
 * (read-only — this file never writes that storage key); the real, always-
 * available path is a person typing in the code shown on the TV, since "the
 * code is the only credential" per the server's own trust model.
 */
'use strict';

(() => {
  const FLEET_BASE = 'https://fleet.lyreosai.com';
  const FLEET_WS_BASE = 'wss://fleet.lyreosai.com';
  const REQUEST_TIMEOUT_MS = 15000;
  const ACTIVE_POLL_MS = 25000;
  const STATE_POLL_MS = 12000;
  const RECONNECT_BASE_MS = 3000;
  const MAX_RECONNECT_ATTEMPTS = 6;
  const REACTIONS = ['👍', '😂', '😮', '❤️', '🎉'];
  const TOAST_LIFETIME_MS = 1700;
  const MAX_CHAT_ROWS = 200;

  const CODE_KEY = 'blazing-web-party-code-v1';
  const PEER_KEY = 'blazing-web-party-peer-v1';
  const DEVICE_KEY = 'blazing-web-profile-device-v1'; // owned by profile.js; read-only here

  // Fallback only. The real list comes from GET /party/ice (see ice.js on the
  // fleet), because a TURN relay's credential must not live in a client bundle
  // and because switching one on should not need a redeploy of this file. STUN
  // alone cannot connect two people whose networks refuse a direct path.
  const DEFAULT_RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  const CLOSE_REASONS = {
    4400: 'The watch party server rejected this connection.',
    4404: 'That watch party code was not found.',
    4409: 'This tab was replaced by another connection for the same session.',
    4410: 'This watch party has ended.',
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function plainText(value, fallback = '') {
    const out = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return out || fallback;
  }

  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function removeStorage(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // A blocked storage area has nothing useful to clear.
    }
  }

  function randomId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch {
      // Fall through to the manual id below.
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  function shortLabel(peerId) {
    const tail = String(peerId || '').replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase();
    return `Guest-${tail || '0000'}`;
  }

  function getOrCreatePeerId() {
    let id = readStorage(PEER_KEY);
    if (!id) {
      id = randomId();
      writeStorage(PEER_KEY, id);
    }
    return id;
  }

  function storedDeviceId() {
    try {
      const value = JSON.parse(readStorage(DEVICE_KEY) || 'null');
      return value && typeof value === 'object' ? plainText(value.id) || null : null;
    } catch {
      return null;
    }
  }

  function normalizeCode(raw) {
    return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  async function requestJSON(path) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${FLEET_BASE}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
      });
      if (response.status === 204) return { status: 204, ok: true, body: null };
      const raw = await response.text();
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      return { status: response.status, ok: response.ok, body };
    } catch (error) {
      return { status: 0, ok: false, timeout: error && error.name === 'AbortError', body: null };
    } finally {
      window.clearTimeout(timeout);
    }
  }

  // --- module state -----------------------------------------------------

  const state = {
    myPeerId: getOrCreatePeerId(),
    code: null,
    ws: null,
    wsAttempt: 0,
    reconnectTimer: 0,
    intentionalClose: false,
    activePollTimer: 0,
    statePollTimer: 0,
    discoveredCode: null,
    panelOpen: false,
    minimized: false,
    unreadChat: 0,
    localStream: null,
    callState: 'idle', // idle | requesting | active | unavailable
    rtcConfig: DEFAULT_RTC_CONFIG,
    relayAvailable: false,
    peers: new Map(), // peerId -> { pc, tile, videoEl, pending: [], muted }
  };

  const ui = {};

  // --- style --------------------------------------------------------------

  function addStyle() {
    const style = element('style');
    style.textContent = `
      .wp-launch { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; min-height: 42px; border: 1px solid rgba(255,255,255,.12); border-radius: 13px; padding: 8px 11px; color: var(--text, #fff); background: rgba(28,28,31,.85); font-size: 13px; font-weight: 800; white-space: nowrap; }
      .wp-launch:hover { background: var(--surface-focus, #1c1c1f); }
      .wp-launch-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255,255,255,.3); flex: 0 0 auto; }
      .wp-launch[data-hint="true"] .wp-launch-dot { background: #34d97a; animation: wp-pulse-dot 1.6s ease-in-out infinite; }
      .wp-launch[data-joined="true"] { border-color: rgba(255,61,71,.42); }
      .wp-launch[data-joined="true"] .wp-launch-dot { background: var(--accent, #ff3d47); animation: none; }

      .wp-join-layer { position: fixed; inset: 0; z-index: 85; display: grid; place-items: center; padding: 16px; }
      .wp-join-backdrop { position: absolute; inset: 0; width: 100%; border: 0; background: rgba(0,0,0,.72); backdrop-filter: blur(5px); }
      .wp-join-panel { position: relative; width: min(420px, 100%); border: 1px solid rgba(255,255,255,.12); border-radius: 24px; padding: 24px; color: var(--text, #f7f7f8); background: var(--surface, #141416); box-shadow: 0 30px 100px rgba(0,0,0,.7); }
      .wp-join-close { position: absolute; top: 13px; right: 13px; min-width: 42px; min-height: 42px; border: 0; border-radius: 13px; color: inherit; background: rgba(255,255,255,.06); font-weight: 800; }
      .wp-join-close:hover { background: rgba(255,255,255,.12); }
      .wp-join-kicker { margin: 0 48px 7px 0; color: var(--accent, #ff3d47); font-size: 12px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
      .wp-join-heading { margin: 0; font-size: clamp(24px, 6vw, 32px); line-height: 1.05; letter-spacing: -.04em; }
      .wp-join-copy { margin: 10px 0 0; color: var(--muted, #a3a3aa); font-size: 14px; line-height: 1.5; }
      .wp-join-form { display: flex; gap: 8px; margin-top: 18px; }
      .wp-join-input { flex: 1; min-width: 0; min-height: 46px; border: 1px solid rgba(255,255,255,.14); border-radius: 14px; padding: 0 15px; color: var(--text, #fff); background: rgba(255,255,255,.04); font-size: 18px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; text-align: center; }
      .wp-join-input:focus { outline: none; border-color: var(--accent, #ff3d47); box-shadow: 0 0 0 3px rgba(255,61,71,.16); }
      .wp-join-submit { flex: 0 0 auto; min-height: 46px; border: 1px solid var(--accent, #ff3d47); border-radius: 14px; padding: 0 18px; color: #fff; background: linear-gradient(140deg, var(--accent, #ff3d47), var(--accent-strong, #e11d2b)); font-size: 14px; font-weight: 850; }
      .wp-join-submit:disabled { cursor: wait; opacity: .55; }
      .wp-join-status { min-height: 22px; margin: 14px 0 0; color: var(--muted, #a3a3aa); font-size: 13px; line-height: 1.4; }
      .wp-join-status[data-state="error"] { color: #ff9aa1; }

      .wp-panel { position: fixed; z-index: 70; right: 12px; bottom: calc(12px + var(--safe-bottom, 0px)); width: min(360px, calc(100vw - 24px)); max-height: min(78vh, 640px); display: flex; flex-direction: column; overflow: hidden; border: 1px solid rgba(255,255,255,.12); border-radius: 22px; color: var(--text, #f7f7f8); background: var(--surface, #141416); box-shadow: 0 26px 80px rgba(0,0,0,.6); }
      .wp-head { display: flex; align-items: center; gap: 9px; flex: 0 0 auto; padding: 13px 10px 13px 16px; border-bottom: 1px solid rgba(255,255,255,.08); }
      .wp-head-dot { width: 9px; height: 9px; border-radius: 50%; background: #34d97a; flex: 0 0 auto; animation: wp-pulse-dot 1.6s ease-in-out infinite; }
      .wp-head-dot[data-state="lost"] { background: #ffb020; animation: none; }
      .wp-head-title { min-width: 0; flex: 1; overflow: hidden; font-size: 13px; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
      .wp-head-code { color: var(--muted, #a3a3aa); font-weight: 700; letter-spacing: .06em; }
      .wp-head-btn { flex: 0 0 auto; min-width: 34px; min-height: 34px; border: 0; border-radius: 11px; color: inherit; background: rgba(255,255,255,.06); font-size: 12px; font-weight: 800; }
      .wp-head-btn:hover { background: rgba(255,255,255,.12); }
      .wp-head-leave { color: #fff; background: rgba(225,29,43,.24); }
      .wp-head-leave:hover { background: rgba(225,29,43,.4); }

      .wp-body { min-height: 0; overflow-y: auto; padding: 12px 14px 0; }
      .wp-call { position: relative; margin-bottom: 12px; }
      .wp-call-note { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border: 1px dashed rgba(255,255,255,.16); border-radius: 14px; color: var(--muted, #a3a3aa); font-size: 12px; line-height: 1.4; }
      .wp-call-retry { flex: 0 0 auto; border: 1px solid rgba(255,255,255,.15); border-radius: 999px; padding: 6px 10px; color: inherit; background: rgba(255,255,255,.06); font-size: 11px; font-weight: 800; }
      .wp-call-retry:hover { background: rgba(255,255,255,.12); }
      .wp-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
      .wp-tile { position: relative; aspect-ratio: 4 / 3; overflow: hidden; border-radius: 13px; background: #0d0d0f; }
      .wp-tile video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .wp-tile-avatar { position: absolute; inset: 0; display: grid; place-items: center; color: rgba(255,255,255,.55); font-size: 11px; font-weight: 800; background: linear-gradient(150deg, #222226, #101012); }
      .wp-tile-label { position: absolute; left: 6px; bottom: 5px; padding: 2px 6px; border-radius: 999px; color: #fff; background: rgba(0,0,0,.55); font-size: 10px; font-weight: 800; }
      .wp-tile-self { grid-column: span 1; }
      .wp-tile-self video { transform: scaleX(-1); }
      .wp-tile-controls { position: absolute; right: 5px; bottom: 5px; display: flex; gap: 4px; }
      .wp-tile-toggle { width: 24px; height: 24px; border: 0; border-radius: 8px; color: #fff; background: rgba(0,0,0,.55); font-size: 12px; line-height: 1; }
      .wp-tile-toggle[data-off="true"] { background: rgba(225,29,43,.75); }
      .wp-tile[data-muted="true"] video { opacity: .55; }

      .wp-reactions { display: flex; gap: 6px; margin: 12px 0; }
      .wp-reaction-btn { flex: 1; min-height: 40px; border: 1px solid rgba(255,255,255,.1); border-radius: 12px; color: inherit; background: rgba(255,255,255,.04); font-size: 18px; }
      .wp-reaction-btn:hover { background: rgba(255,255,255,.1); border-color: rgba(255,61,71,.5); }

      .wp-toast-layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 5; }
      .wp-toast { position: absolute; bottom: 8px; display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 26px; animation: wp-float-fade 1.7s ease-out forwards; }
      .wp-toast-tag { font-size: 10px; font-weight: 800; color: #fff; background: rgba(0,0,0,.55); border-radius: 999px; padding: 1px 6px; }

      .wp-chat-list { display: flex; flex-direction: column; gap: 7px; min-height: 90px; max-height: 220px; overflow-y: auto; padding-bottom: 8px; }
      .wp-chat-row { max-width: 88%; }
      .wp-chat-row[data-mine="true"] { align-self: flex-end; text-align: right; }
      .wp-chat-tag { display: block; margin-bottom: 2px; color: var(--quiet, #6d6d75); font-size: 10px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
      .wp-chat-bubble { display: inline-block; padding: 7px 10px; border-radius: 13px; background: rgba(255,255,255,.06); font-size: 13px; line-height: 1.4; word-break: break-word; }
      .wp-chat-row[data-mine="true"] .wp-chat-bubble { background: linear-gradient(140deg, var(--accent, #ff3d47), var(--accent-strong, #e11d2b)); }
      .wp-chat-empty { margin: 8px 0; color: var(--quiet, #6d6d75); font-size: 12px; }

      .wp-chat-form { display: flex; gap: 7px; flex: 0 0 auto; padding: 10px 14px calc(12px + var(--safe-bottom, 0px)); border-top: 1px solid rgba(255,255,255,.08); }
      .wp-chat-input { flex: 1; min-width: 0; min-height: 38px; border: 1px solid rgba(255,255,255,.12); border-radius: 999px; padding: 0 13px; color: var(--text, #fff); background: rgba(255,255,255,.04); font-size: 13px; }
      .wp-chat-input:focus { outline: none; border-color: var(--accent, #ff3d47); }
      .wp-chat-send { flex: 0 0 auto; min-width: 38px; min-height: 38px; border: 0; border-radius: 999px; color: #fff; background: linear-gradient(140deg, var(--accent, #ff3d47), var(--accent-strong, #e11d2b)); font-size: 13px; font-weight: 800; }
      .wp-chat-send:disabled { opacity: .5; }

      .wp-chip { position: fixed; z-index: 70; right: 12px; bottom: calc(12px + var(--safe-bottom, 0px)); display: inline-flex; align-items: center; gap: 8px; min-height: 46px; border: 1px solid rgba(255,61,71,.4); border-radius: 999px; padding: 0 15px; color: #fff; background: rgba(20,20,22,.94); box-shadow: 0 16px 46px rgba(0,0,0,.5); font-size: 13px; font-weight: 800; }
      .wp-chip-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent, #ff3d47); animation: wp-pulse-dot 1.6s ease-in-out infinite; }
      .wp-chip-badge { min-width: 17px; height: 17px; padding: 0 4px; border-radius: 999px; color: #fff; background: var(--accent, #ff3d47); font-size: 10px; line-height: 17px; text-align: center; }

      @keyframes wp-pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
      @keyframes wp-float-fade { 0% { transform: translateY(0); opacity: 0; } 15% { opacity: 1; } 100% { transform: translateY(-90px); opacity: 0; } }

      @media (max-width: 420px) {
        .wp-launch { padding: 0; width: 42px; font-size: 0; justify-content: center; }
        .wp-launch-dot { width: 9px; height: 9px; }
        .wp-panel, .wp-chip { right: 8px; left: 8px; width: auto; }
      }
      @media (prefers-reduced-motion: reduce) {
        .wp-launch-dot, .wp-head-dot, .wp-chip-dot, .wp-toast { animation: none; }
      }
    `;
    document.head.appendChild(style);
  }

  // --- topbar entry point ---------------------------------------------------

  function updateLaunchButton() {
    if (!ui.launch) return;
    const joined = Boolean(state.code);
    ui.launch.dataset.joined = joined ? 'true' : 'false';
    ui.launch.dataset.hint = (!joined && state.discoveredCode) ? 'true' : 'false';
    ui.launchLabel.textContent = joined ? `Party · ${state.code}` : 'Party';
    ui.launch.setAttribute('aria-label', joined ? `Watch party ${state.code}, open panel` : 'Watch party');
  }

  // --- join dialog -----------------------------------------------------------

  function openJoinDialog(prefillCode) {
    ui.joinInput.value = prefillCode || '';
    ui.joinStatus.textContent = prefillCode
      ? 'A watch party looks live for this browser. Select Join to connect.'
      : 'Type the code shown on the TV.';
    ui.joinStatus.dataset.state = 'info';
    ui.joinLayer.hidden = false;
    ui.joinLayer.setAttribute('aria-hidden', 'false');
    window.setTimeout(() => ui.joinInput.focus(), 0);
  }

  function closeJoinDialog() {
    ui.joinLayer.hidden = true;
    ui.joinLayer.setAttribute('aria-hidden', 'true');
  }

  function setJoinBusy(busy) {
    ui.joinInput.disabled = busy;
    ui.joinSubmit.disabled = busy;
  }

  async function submitJoin(event) {
    event.preventDefault();
    const code = normalizeCode(ui.joinInput.value);
    if (!code) {
      ui.joinStatus.textContent = 'Enter a code first.';
      ui.joinStatus.dataset.state = 'error';
      return;
    }
    setJoinBusy(true);
    ui.joinStatus.textContent = 'Checking that code…';
    ui.joinStatus.dataset.state = 'info';
    const result = await requestJSON(`/party/${encodeURIComponent(code)}/state`);
    setJoinBusy(false);
    if (result.status === 404) {
      ui.joinStatus.textContent = 'That code was not found. Check it and try again.';
      ui.joinStatus.dataset.state = 'error';
      return;
    }
    if (result.status === 410) {
      ui.joinStatus.textContent = 'That watch party has ended.';
      ui.joinStatus.dataset.state = 'error';
      return;
    }
    if (!result.ok) {
      ui.joinStatus.textContent = result.timeout
        ? 'The party server did not answer in time. Try again.'
        : 'Could not reach the watch party server. Try again.';
      ui.joinStatus.dataset.state = 'error';
      return;
    }
    closeJoinDialog();
    enterParty(code);
  }

  // --- panel shell -------------------------------------------------------

  function showPanel() {
    state.panelOpen = true;
    state.minimized = false;
    state.unreadChat = 0;
    ui.panel.hidden = false;
    ui.chip.hidden = true;
    renderChip();
    window.setTimeout(() => { ui.chatList.scrollTop = ui.chatList.scrollHeight; }, 0);
  }

  function minimizePanel() {
    state.panelOpen = false;
    state.minimized = true;
    ui.panel.hidden = true;
    ui.chip.hidden = false;
    renderChip();
  }

  function hidePanelAndChip() {
    state.panelOpen = false;
    state.minimized = false;
    ui.panel.hidden = true;
    ui.chip.hidden = true;
  }

  function renderChip() {
    if (!ui.chip) return;
    ui.chipPeers.textContent = `${state.peers.size + 1} in call`;
    ui.chipBadge.hidden = state.unreadChat === 0;
    ui.chipBadge.textContent = state.unreadChat > 9 ? '9+' : String(state.unreadChat);
  }

  function setHeadStatus(kind, text) {
    ui.headDot.dataset.state = kind;
    ui.headTitle.textContent = text;
  }

  // --- entering / leaving a party -----------------------------------------

  function enterParty(code) {
    state.code = code;
    writeStorage(CODE_KEY, code);
    state.wsAttempt = 0;
    state.intentionalClose = false;
    ui.headCode.textContent = code;
    ui.chatList.replaceChildren();
    ui.chatEmpty.hidden = false;
    updateLaunchButton();
    showPanel();
    setHeadStatus('live', 'Watch Party');
    startStatePolling(code);
    connectSignal(code);
    beginCall();
  }

  function leaveParty() {
    state.intentionalClose = true;
    closeSignal();
    teardownCall();
    stopStatePolling();
    removeStorage(CODE_KEY);
    state.code = null;
    state.discoveredCode = null;
    hidePanelAndChip();
    updateLaunchButton();
  }

  function partyEnded(reason) {
    state.intentionalClose = true;
    closeSignal();
    teardownCall();
    stopStatePolling();
    removeStorage(CODE_KEY);
    state.code = null;
    updateLaunchButton();
    setHeadStatus('lost', reason || 'This watch party has ended.');
    // Leave the panel up for a moment so the message is readable, then drop it.
    window.setTimeout(() => { if (!state.code) hidePanelAndChip(); }, 2400);
  }

  // --- /party/:code/state liveness polling (read-only, never drives the player) --

  function stopStatePolling() {
    if (state.statePollTimer) {
      window.clearInterval(state.statePollTimer);
      state.statePollTimer = 0;
    }
  }

  function startStatePolling(code) {
    stopStatePolling();
    state.statePollTimer = window.setInterval(async () => {
      if (document.visibilityState === 'hidden') return;
      const result = await requestJSON(`/party/${encodeURIComponent(code)}/state`);
      if (state.code !== code) return; // left/switched while the request was in flight
      if (result.status === 404 || result.status === 410) {
        partyEnded('This watch party has ended.');
      }
    }, STATE_POLL_MS);
  }

  // --- /party/active discovery (best-effort; needs this browser's own device id) --

  function stopActivePolling() {
    if (state.activePollTimer) {
      window.clearInterval(state.activePollTimer);
      state.activePollTimer = 0;
    }
  }

  async function checkActiveOnce() {
    if (state.code) return; // already in one, no need to hint
    const deviceId = storedDeviceId();
    if (!deviceId) return;
    if (document.visibilityState === 'hidden') return;
    const result = await requestJSON(`/party/active?householdId=${encodeURIComponent(deviceId)}`);
    if (state.code) return;
    if (result.status === 200 && result.body && plainText(result.body.code)) {
      state.discoveredCode = normalizeCode(result.body.code);
    } else {
      state.discoveredCode = null;
    }
    updateLaunchButton();
  }

  function startActivePolling() {
    checkActiveOnce();
    state.activePollTimer = window.setInterval(checkActiveOnce, ACTIVE_POLL_MS);
  }

  // --- signaling websocket ---------------------------------------------------

  function closeSignal() {
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = 0;
    }
    if (state.ws) {
      const ws = state.ws;
      state.ws = null;
      try { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(1000); } catch { /* already closing */ }
    }
  }

  function sendSignal(type, extra) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    try {
      state.ws.send(JSON.stringify({ type, ...extra }));
    } catch {
      // A send on a socket that is closing mid-flight is dropped, same as the server does.
    }
  }

  function connectSignal(code) {
    if (state.ws) closeSignal();
    const url = `${FLEET_WS_BASE}/party/${encodeURIComponent(code)}/signal?peerId=${encodeURIComponent(state.myPeerId)}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      setHeadStatus('lost', 'Could not open the watch party connection.');
      return;
    }
    state.ws = ws;

    ws.onopen = () => {
      state.wsAttempt = 0;
      if (state.code === code) setHeadStatus('live', 'Watch Party');
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      handleSignalMessage(msg);
    };

    ws.onclose = (event) => {
      if (state.ws !== ws) return; // superseded by a newer connection already
      state.ws = null;
      if (state.intentionalClose) return;
      const reason = CLOSE_REASONS[event.code];
      if (event.code === 4404 || event.code === 4410) {
        partyEnded(reason);
        return;
      }
      if (event.code === 4409) {
        setHeadStatus('lost', reason);
        return; // another tab/connection owns this peer id now; do not fight it
      }
      // Unexpected drop (network blip, tunnel hiccup) — try to pick the room back up.
      if (state.wsAttempt >= MAX_RECONNECT_ATTEMPTS) {
        setHeadStatus('lost', 'Connection lost. Reopen the panel to try again.');
        return;
      }
      state.wsAttempt += 1;
      setHeadStatus('lost', 'Reconnecting…');
      state.reconnectTimer = window.setTimeout(() => {
        if (state.code === code) connectSignal(code);
      }, RECONNECT_BASE_MS * state.wsAttempt);
    };

    ws.onerror = () => {
      // 'close' always follows; nothing extra to do here.
    };
  }

  function handleSignalMessage(msg) {
    switch (msg.type) {
      case 'peer-list':
        (Array.isArray(msg.peers) ? msg.peers : []).forEach((peerId) => {
          if (typeof peerId === 'string' && peerId) offerTo(peerId);
        });
        break;
      case 'peer-joined':
        // The newcomer initiates (see peer-list above); we just wait for their offer.
        break;
      case 'peer-left':
        if (typeof msg.from === 'string') teardownPeer(msg.from);
        break;
      case 'offer':
        if (typeof msg.from === 'string' && msg.payload) handleOffer(msg.from, msg.payload);
        break;
      case 'answer':
        if (typeof msg.from === 'string' && msg.payload) handleAnswer(msg.from, msg.payload);
        break;
      case 'ice-candidate':
        if (typeof msg.from === 'string' && msg.payload) handleIceCandidate(msg.from, msg.payload);
        break;
      case 'chat':
        if (typeof msg.from === 'string' && typeof msg.text === 'string') {
          appendChatMessage(msg.from, msg.text, false);
        }
        break;
      case 'reaction':
        if (typeof msg.from === 'string' && typeof msg.emoji === 'string') {
          spawnReactionToast(msg.emoji, shortLabel(msg.from));
        }
        break;
      default:
        // Unknown type: ignore, matching the server's own forward-compatible posture.
        break;
    }
  }

  // --- call: local media --------------------------------------------------

  async function requestLocalMedia() {
    const attempts = [
      { video: true, audio: true },
      { audio: true },
      { video: true },
    ];
    for (const constraints of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (stream && stream.getTracks().length) return stream;
      } catch {
        // Try the next, narrower constraint set.
      }
    }
    return null;
  }

  function renderSelfTile() {
    if (ui.selfTile) return;
    ui.selfTile = element('div', 'wp-tile wp-tile-self');
    const video = element('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = state.localStream;
    const label = element('span', 'wp-tile-label', 'You');
    const controls = element('div', 'wp-tile-controls');
    const hasVideo = state.localStream.getVideoTracks().length > 0;
    const hasAudio = state.localStream.getAudioTracks().length > 0;
    if (hasAudio) {
      ui.micToggle = element('button', 'wp-tile-toggle', '🎤');
      ui.micToggle.type = 'button';
      ui.micToggle.setAttribute('aria-label', 'Mute microphone');
      ui.micToggle.addEventListener('click', () => {
        const track = state.localStream.getAudioTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        ui.micToggle.dataset.off = track.enabled ? 'false' : 'true';
        ui.micToggle.textContent = track.enabled ? '🎤' : '🔇';
      });
      controls.appendChild(ui.micToggle);
    }
    if (hasVideo) {
      ui.camToggle = element('button', 'wp-tile-toggle', '📷');
      ui.camToggle.type = 'button';
      ui.camToggle.setAttribute('aria-label', 'Turn off camera');
      ui.camToggle.addEventListener('click', () => {
        const track = state.localStream.getVideoTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        ui.camToggle.dataset.off = track.enabled ? 'false' : 'true';
        video.style.visibility = track.enabled ? 'visible' : 'hidden';
      });
      controls.appendChild(ui.camToggle);
    } else {
      ui.selfTile.appendChild(element('div', 'wp-tile-avatar', 'You'));
    }
    ui.selfTile.append(video, label, controls);
    ui.tiles.appendChild(ui.selfTile);
  }

  function removeSelfTile() {
    if (ui.selfTile) {
      ui.selfTile.remove();
      ui.selfTile = null;
      ui.micToggle = null;
      ui.camToggle = null;
    }
  }

  function setCallNote(text) {
    ui.callNote.hidden = !text;
    ui.callNoteText.textContent = text || '';
  }

  // Fetched per call rather than once at load: with coturn REST credentials the
  // server hands out an HMAC that expires, so a stale one taken at page load
  // could be dead by the time somebody actually starts a call. Best effort — a
  // failure here leaves the STUN-only fallback in place rather than blocking.
  async function loadIceConfig() {
    const result = await requestJSON(`/party/ice?peerId=${encodeURIComponent(state.myPeerId)}`);
    const body = result.ok ? result.body : null;
    if (body && Array.isArray(body.iceServers) && body.iceServers.length) {
      state.rtcConfig = { iceServers: body.iceServers };
      state.relayAvailable = body.relay === true;
    } else {
      state.rtcConfig = DEFAULT_RTC_CONFIG;
      state.relayAvailable = false;
    }
  }

  async function beginCall() {
    state.callState = 'requesting';
    ui.tiles.hidden = true;
    setCallNote('Asking for camera & microphone access…');
    await loadIceConfig();
    const stream = await requestLocalMedia();
    if (state.code === null) { // left the party while the prompt was open
      if (stream) stream.getTracks().forEach((track) => track.stop());
      return;
    }
    if (!stream) {
      state.callState = 'unavailable';
      setCallNote('Camera & microphone are off — chat and reactions still work.');
      return;
    }
    state.localStream = stream;
    state.callState = 'active';
    setCallNote('');
    ui.tiles.hidden = false;
    renderSelfTile();
    // Any peer already meshed up (unlikely this early, but harmless) gets our tracks too.
    state.peers.forEach(({ pc }) => attachLocalTracks(pc));
  }

  function retryCall() {
    if (state.callState === 'active' || state.callState === 'requesting') return;
    beginCall();
  }

  function attachLocalTracks(pc) {
    if (!state.localStream) return;
    const already = new Set(pc.getSenders().map((sender) => sender.track).filter(Boolean));
    state.localStream.getTracks().forEach((track) => {
      if (!already.has(track)) pc.addTrack(track, state.localStream);
    });
  }

  // --- call: mesh peer connections ----------------------------------------

  // Per-person mute is LOCAL: it sets <video>.muted on that one tile and tells
  // nobody. Muting a person for everyone would be a moderation power the
  // signaling contract does not have and nobody asked for; this is the "I can't
  // hear myself think over that one room" control.
  function applyPeerMute(entry, peerId) {
    if (!entry || !entry.videoEl) return;
    const muted = entry.muted === true;
    entry.videoEl.muted = muted;
    if (entry.muteToggle) {
      entry.muteToggle.dataset.off = muted ? 'true' : 'false';
      entry.muteToggle.textContent = muted ? '🔇' : '🔊';
      entry.muteToggle.setAttribute(
        'aria-label',
        `${muted ? 'Unmute' : 'Mute'} ${shortLabel(peerId)} for me`,
      );
      entry.muteToggle.setAttribute('aria-pressed', muted ? 'true' : 'false');
    }
    if (entry.tile) entry.tile.dataset.muted = muted ? 'true' : 'false';
  }

  function ensureTile(peerId) {
    let entry = state.peers.get(peerId);
    if (entry && entry.tile) return entry;
    const tile = element('div', 'wp-tile');
    const video = element('video');
    video.autoplay = true;
    video.playsInline = true;
    const avatar = element('div', 'wp-tile-avatar', shortLabel(peerId).replace('Guest-', ''));
    const label = element('span', 'wp-tile-label', shortLabel(peerId));
    const controls = element('div', 'wp-tile-controls');
    const muteToggle = element('button', 'wp-tile-toggle', '🔊');
    muteToggle.type = 'button';
    controls.appendChild(muteToggle);
    tile.append(video, avatar, label, controls);
    ui.tiles.appendChild(tile);
    ui.tiles.hidden = false;
    if (!entry) entry = { pc: null, pending: [] };
    entry.tile = tile;
    entry.videoEl = video;
    entry.avatarEl = avatar;
    entry.muteToggle = muteToggle;
    muteToggle.addEventListener('click', () => {
      entry.muted = entry.muted !== true;
      applyPeerMute(entry, peerId);
      // A browser that blocked unmuted autoplay leaves the element paused; the
      // click that unmutes is the gesture that is allowed to start it.
      if (!entry.muted) entry.videoEl.play().catch(() => {});
    });
    state.peers.set(peerId, entry);
    applyPeerMute(entry, peerId);
    return entry;
  }

  function createPeerConnection(peerId) {
    const pc = new RTCPeerConnection(state.rtcConfig);
    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal('ice-candidate', { to: peerId, payload: event.candidate });
    };
    pc.ontrack = (event) => {
      const entry = ensureTile(peerId);
      const [stream] = event.streams;
      entry.videoEl.srcObject = stream || new MediaStream([event.track]);
      entry.avatarEl.hidden = true;
      applyPeerMute(entry, peerId); // a mute set before they connected must survive their stream arriving
      entry.videoEl.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      // A 'failed' state with no relay configured is the specific, predictable
      // failure this whole ICE change is about: two networks that will not form
      // a direct path. Say so, instead of leaving a tile that never fills in.
      if (pc.connectionState === 'failed' && !state.relayAvailable) {
        setCallNote('Could not reach ' + shortLabel(peerId) + ' directly. Calling across different networks needs a relay server, which is not switched on yet.');
      }
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') teardownPeer(peerId);
    };
    attachLocalTracks(pc);
    return pc;
  }

  function getOrCreatePeerEntry(peerId) {
    let entry = state.peers.get(peerId);
    if (!entry) {
      entry = { pc: null, pending: [] };
      state.peers.set(peerId, entry);
    }
    if (!entry.pc) entry.pc = createPeerConnection(peerId);
    ensureTile(peerId);
    return entry;
  }

  async function offerTo(peerId) {
    if (state.callState !== 'active') return; // never join the call without a local grant
    const entry = getOrCreatePeerEntry(peerId);
    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      sendSignal('offer', { to: peerId, payload: offer });
    } catch {
      teardownPeer(peerId);
    }
  }

  async function handleOffer(peerId, payload) {
    if (state.callState !== 'active') return; // chat-only mode never joins the mesh
    // A fresh offer from a peer we already track means their page reloaded —
    // start that connection clean instead of feeding a stale PC.
    if (state.peers.has(peerId) && state.peers.get(peerId).pc) teardownPeer(peerId, true);
    const entry = getOrCreatePeerEntry(peerId);
    try {
      await entry.pc.setRemoteDescription(payload);
      (entry.pending || []).forEach((candidate) => entry.pc.addIceCandidate(candidate).catch(() => {}));
      entry.pending = [];
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      sendSignal('answer', { to: peerId, payload: answer });
    } catch {
      teardownPeer(peerId);
    }
  }

  async function handleAnswer(peerId, payload) {
    const entry = state.peers.get(peerId);
    if (!entry || !entry.pc) return;
    try {
      await entry.pc.setRemoteDescription(payload);
      (entry.pending || []).forEach((candidate) => entry.pc.addIceCandidate(candidate).catch(() => {}));
      entry.pending = [];
    } catch {
      teardownPeer(peerId);
    }
  }

  function handleIceCandidate(peerId, payload) {
    const entry = state.peers.get(peerId);
    if (!entry) return;
    if (!entry.pc || !entry.pc.remoteDescription) {
      entry.pending = entry.pending || [];
      entry.pending.push(payload);
      return;
    }
    entry.pc.addIceCandidate(payload).catch(() => {});
  }

  function teardownPeer(peerId, keepTileSlotForRejoin) {
    const entry = state.peers.get(peerId);
    if (!entry) return;
    if (entry.pc) {
      try { entry.pc.close(); } catch { /* already closed */ }
    }
    if (entry.tile) entry.tile.remove();
    if (keepTileSlotForRejoin) {
      state.peers.set(peerId, { pc: null, pending: [], muted: entry.muted === true });
    } else {
      state.peers.delete(peerId);
    }
    renderChip();
  }

  function teardownCall() {
    state.peers.forEach((_, peerId) => teardownPeer(peerId));
    state.peers.clear();
    removeSelfTile();
    if (state.localStream) {
      state.localStream.getTracks().forEach((track) => track.stop());
      state.localStream = null;
    }
    state.callState = 'idle';
    ui.tiles.replaceChildren();
    ui.tiles.hidden = true;
    setCallNote('');
  }

  // --- chat --------------------------------------------------------------

  function appendChatMessage(peerId, text, mine) {
    ui.chatEmpty.hidden = true;
    const row = element('div', 'wp-chat-row');
    row.dataset.mine = mine ? 'true' : 'false';
    row.appendChild(element('span', 'wp-chat-tag', mine ? 'You' : shortLabel(peerId)));
    row.appendChild(element('span', 'wp-chat-bubble', text.slice(0, 1000)));
    ui.chatList.appendChild(row);
    while (ui.chatList.children.length > MAX_CHAT_ROWS) ui.chatList.removeChild(ui.chatList.firstChild);
    ui.chatList.scrollTop = ui.chatList.scrollHeight;
    if (!mine && (!state.panelOpen || document.visibilityState === 'hidden')) {
      state.unreadChat += 1;
      renderChip();
    }
  }

  function sendChatMessage(event) {
    event.preventDefault();
    const text = plainText(ui.chatInput.value).slice(0, 1000);
    if (!text) return;
    ui.chatInput.value = '';
    sendSignal('chat', { text });
    appendChatMessage(state.myPeerId, text, true);
  }

  // --- reactions -----------------------------------------------------------

  function spawnReactionToast(emoji, tag) {
    const toast = element('span', 'wp-toast');
    toast.style.left = `${8 + Math.random() * 70}%`;
    toast.textContent = emoji;
    if (tag) toast.appendChild(element('span', 'wp-toast-tag', tag));
    ui.toastLayer.appendChild(toast);
    window.setTimeout(() => toast.remove(), TOAST_LIFETIME_MS);
  }

  function sendReaction(emoji) {
    sendSignal('reaction', { emoji });
    spawnReactionToast(emoji, 'You');
  }

  // --- DOM assembly --------------------------------------------------------

  function buildUi() {
    addStyle();
    const topbar = document.querySelector('.topbar');
    const searchButton = document.getElementById('search-button');
    if (!topbar || !searchButton) return false;

    ui.launch = element('button', 'wp-launch');
    ui.launch.type = 'button';
    ui.launch.id = 'watch-party-launch-button';
    const launchDot = element('span', 'wp-launch-dot');
    ui.launchLabel = element('span', '', 'Party');
    ui.launch.append(launchDot, ui.launchLabel);
    topbar.insertBefore(ui.launch, searchButton);

    // Join dialog
    ui.joinLayer = element('section', 'wp-join-layer');
    ui.joinLayer.hidden = true;
    ui.joinLayer.setAttribute('aria-hidden', 'true');
    const joinBackdrop = element('button', 'wp-join-backdrop');
    joinBackdrop.type = 'button';
    joinBackdrop.setAttribute('aria-label', 'Close');
    const joinPanel = element('section', 'wp-join-panel');
    joinPanel.setAttribute('role', 'dialog');
    joinPanel.setAttribute('aria-modal', 'true');
    joinPanel.setAttribute('aria-labelledby', 'wp-join-heading');
    ui.joinClose = element('button', 'wp-join-close', 'Close');
    ui.joinClose.type = 'button';
    const joinKicker = element('p', 'wp-join-kicker', 'Watch Party');
    const joinHeading = element('h2', 'wp-join-heading', 'Join the party');
    joinHeading.id = 'wp-join-heading';
    const joinCopy = element('p', 'wp-join-copy', 'Enter the code shown on the TV for chat, reactions, and a video call.');
    ui.joinStatus = element('p', 'wp-join-status');
    ui.joinStatus.setAttribute('role', 'status');
    ui.joinStatus.setAttribute('aria-live', 'polite');
    const joinForm = element('form', 'wp-join-form');
    ui.joinInput = element('input', 'wp-join-input');
    ui.joinInput.type = 'text';
    ui.joinInput.id = 'watch-party-join-input';
    ui.joinInput.name = 'watch-party-code';
    ui.joinInput.maxLength = 12;
    ui.joinInput.autocomplete = 'off';
    ui.joinInput.setAttribute('autocapitalize', 'characters');
    ui.joinInput.placeholder = 'CODE';
    ui.joinInput.setAttribute('aria-label', 'Watch party code');
    ui.joinSubmit = element('button', 'wp-join-submit', 'Join');
    ui.joinSubmit.type = 'submit';
    joinForm.append(ui.joinInput, ui.joinSubmit);
    joinPanel.append(ui.joinClose, joinKicker, joinHeading, joinCopy, ui.joinStatus, joinForm);
    ui.joinLayer.append(joinBackdrop, joinPanel);
    document.body.appendChild(ui.joinLayer);

    // Chip (minimized state)
    ui.chip = element('button', 'wp-chip');
    ui.chip.type = 'button';
    ui.chip.hidden = true;
    const chipDot = element('span', 'wp-chip-dot');
    ui.chipPeers = element('span', '', '1 in call');
    ui.chipBadge = element('span', 'wp-chip-badge', '0');
    ui.chipBadge.hidden = true;
    ui.chip.append(chipDot, ui.chipPeers, ui.chipBadge);
    document.body.appendChild(ui.chip);

    // Main panel
    ui.panel = element('section', 'wp-panel');
    ui.panel.hidden = true;
    ui.panel.setAttribute('aria-label', 'Watch party');
    const head = element('div', 'wp-head');
    ui.headDot = element('span', 'wp-head-dot');
    const headText = element('span', 'wp-head-title');
    ui.headTitle = element('span', '', 'Watch Party');
    ui.headCode = element('span', 'wp-head-code');
    headText.append(ui.headTitle, document.createTextNode(' · '), ui.headCode);
    ui.headMinimize = element('button', 'wp-head-btn', '—');
    ui.headMinimize.type = 'button';
    ui.headMinimize.setAttribute('aria-label', 'Minimize watch party');
    ui.headLeave = element('button', 'wp-head-btn wp-head-leave', 'Leave');
    ui.headLeave.type = 'button';
    head.append(ui.headDot, headText, ui.headMinimize, ui.headLeave);

    const body = element('div', 'wp-body');
    const callWrap = element('div', 'wp-call');
    ui.callNote = element('div', 'wp-call-note');
    ui.callNote.hidden = true;
    ui.callNoteText = element('span', '', '');
    ui.callRetry = element('button', 'wp-call-retry', 'Try camera & mic');
    ui.callRetry.type = 'button';
    ui.callNote.append(ui.callNoteText, ui.callRetry);
    ui.tiles = element('div', 'wp-tiles');
    ui.tiles.hidden = true;
    ui.toastLayer = element('div', 'wp-toast-layer');
    callWrap.append(ui.callNote, ui.tiles, ui.toastLayer);

    const reactions = element('div', 'wp-reactions');
    ui.reactionButtons = REACTIONS.map((emoji) => {
      const button = element('button', 'wp-reaction-btn', emoji);
      button.type = 'button';
      button.setAttribute('aria-label', `Send ${emoji} reaction`);
      button.addEventListener('click', () => sendReaction(emoji));
      reactions.appendChild(button);
      return button;
    });

    ui.chatList = element('div', 'wp-chat-list');
    ui.chatList.setAttribute('role', 'log');
    ui.chatList.setAttribute('aria-live', 'polite');
    ui.chatEmpty = element('p', 'wp-chat-empty', 'Say hi — messages only reach people currently in this party.');
    ui.chatList.appendChild(ui.chatEmpty);

    body.append(callWrap, reactions, ui.chatList);

    ui.chatForm = element('form', 'wp-chat-form');
    ui.chatInput = element('input', 'wp-chat-input');
    ui.chatInput.type = 'text';
    ui.chatInput.id = 'watch-party-chat-input';
    ui.chatInput.name = 'watch-party-message';
    ui.chatInput.maxLength = 1000;
    ui.chatInput.autocomplete = 'off';
    ui.chatInput.placeholder = 'Message the party…';
    ui.chatInput.setAttribute('aria-label', 'Chat message');
    ui.chatSend = element('button', 'wp-chat-send', '➤');
    ui.chatSend.type = 'submit';
    ui.chatSend.setAttribute('aria-label', 'Send message');
    ui.chatForm.append(ui.chatInput, ui.chatSend);

    ui.panel.append(head, body, ui.chatForm);
    document.body.appendChild(ui.panel);

    // Events
    ui.launch.addEventListener('click', () => {
      if (state.code) {
        showPanel();
        return;
      }
      openJoinDialog(state.discoveredCode);
    });
    ui.joinClose.addEventListener('click', closeJoinDialog);
    joinBackdrop.addEventListener('click', closeJoinDialog);
    ui.joinInput.addEventListener('input', () => {
      const start = ui.joinInput.selectionStart;
      ui.joinInput.value = ui.joinInput.value.toUpperCase();
      if (typeof start === 'number') ui.joinInput.setSelectionRange(start, start);
    });
    joinForm.addEventListener('submit', submitJoin);
    ui.chip.addEventListener('click', showPanel);
    ui.headMinimize.addEventListener('click', minimizePanel);
    ui.headLeave.addEventListener('click', leaveParty);
    ui.callRetry.addEventListener('click', retryCall);
    ui.chatForm.addEventListener('submit', sendChatMessage);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !ui.joinLayer.hidden) closeJoinDialog();
    });
    window.addEventListener('pagehide', () => {
      if (!state.code) return;
      state.intentionalClose = true;
      closeSignal();
      teardownCall();
    });

    updateLaunchButton();
    return true;
  }

  function boot() {
    if (!buildUi()) return;
    startActivePolling();
    const stored = normalizeCode(readStorage(CODE_KEY));
    if (stored) enterParty(stored);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
