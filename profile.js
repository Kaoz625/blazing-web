/* Blazing web profile gate. Device credentials persist; profile unlocks do not. */
'use strict';

(() => {
  const FLEET_BASE = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  const DEVICE_STORAGE_KEY = 'blazing-web-profile-device-v1';
  const REQUEST_TIMEOUT_MS = 15000;
  const DEVICE_VERSION = 73;

  const state = {
    credentials: null,
    profiles: [],
    activeProfile: null,
    pendingProfile: null,
    pinDigits: [],
    unlockToken: null,
    unlockExpiresAt: 0,
    unlockTimer: 0,
    busy: false,
  };

  const ui = {};

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function text(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : fallback;
  }

  function profileFrom(value) {
    if (!value || typeof value !== 'object') return null;
    const id = text(value.id);
    if (!id) return null;
    return {
      id,
      name: text(value.name, 'Profile'),
      avatar: text(value.avatar),
      isKids: value.isKids === true,
      hasPin: value.hasPin === true,
      maxRating: text(value.maxRating, 'teen'),
      allowAdult: value.allowAdult === true,
    };
  }

  function storedCredentials() {
    try {
      const value = JSON.parse(localStorage.getItem(DEVICE_STORAGE_KEY) || 'null');
      if (!value || typeof value !== 'object') return null;
      const id = text(value.id);
      const token = text(value.token);
      return id && token ? { id, token } : null;
    } catch {
      return null;
    }
  }

  function saveCredentials(credentials) {
    try {
      localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify({
        id: credentials.id,
        token: credentials.token,
      }));
      return true;
    } catch {
      return false;
    }
  }

  function clearStoredCredentials() {
    try {
      localStorage.removeItem(DEVICE_STORAGE_KEY);
    } catch {
      // A blocked storage area has nothing useful to remove.
    }
  }

  function addStyle() {
    const style = element('style');
    style.textContent = `
      .bp-connect { flex: 0 0 auto; min-height: 42px; border: 1px solid rgba(255,255,255,.12); border-radius: 13px; padding: 8px 11px; color: var(--text, #fff); background: rgba(28,28,31,.85); font-size: 13px; font-weight: 800; white-space: nowrap; }
      .bp-connect:hover { background: var(--surface-focus, #1c1c1f); }
      .bp-connect[data-connected="true"] { border-color: rgba(255,61,71,.42); }
      .bp-layer { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 16px; }
      .bp-backdrop { position: absolute; inset: 0; width: 100%; border: 0; background: rgba(0,0,0,.72); backdrop-filter: blur(5px); }
      .bp-panel { position: relative; width: min(520px, 100%); max-height: min(720px, calc(100vh - 32px)); overflow: auto; border: 1px solid rgba(255,255,255,.12); border-radius: 24px; padding: 24px; color: var(--text, #f7f7f8); background: var(--surface, #141416); box-shadow: 0 30px 100px rgba(0,0,0,.7); }
      .bp-close { position: absolute; top: 13px; right: 13px; min-width: 42px; min-height: 42px; border: 0; border-radius: 13px; color: inherit; background: rgba(255,255,255,.06); font-weight: 800; }
      .bp-close:hover { background: rgba(255,255,255,.12); }
      .bp-kicker { margin: 0 48px 7px 0; color: var(--accent, #ff3d47); font-size: 12px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
      .bp-heading { margin: 0; font-size: clamp(27px, 6vw, 40px); line-height: 1.02; letter-spacing: -.05em; }
      .bp-copy { margin: 12px 0 0; color: var(--muted, #a3a3aa); font-size: 14px; line-height: 1.5; }
      .bp-status { min-height: 24px; margin: 18px 0 0; color: var(--muted, #a3a3aa); font-size: 14px; line-height: 1.45; }
      .bp-status[data-state="error"] { color: #ff9aa1; }
      .bp-status[data-state="pending"] { color: #ffd289; }
      .bp-profiles { display: grid; gap: 10px; margin-top: 20px; }
      .bp-profile { display: flex; align-items: center; gap: 13px; width: 100%; min-height: 72px; border: 1px solid rgba(255,255,255,.1); border-radius: 17px; padding: 12px; color: inherit; background: rgba(255,255,255,.035); text-align: left; }
      .bp-profile:hover, .bp-profile:focus-visible, .bp-profile[data-active="true"] { border-color: rgba(255,61,71,.78); background: rgba(255,61,71,.09); }
      .bp-avatar { display: grid; place-items: center; width: 42px; height: 42px; flex: 0 0 auto; border-radius: 14px; color: #fff; background: linear-gradient(145deg, var(--accent, #ff3d47), var(--accent-strong, #e11d2b)); font-size: 16px; font-weight: 900; }
      .bp-profile-copy { min-width: 0; flex: 1; }
      .bp-profile-name { display: block; overflow: hidden; font-size: 16px; font-weight: 850; text-overflow: ellipsis; white-space: nowrap; }
      .bp-profile-meta { display: block; margin-top: 3px; color: var(--muted, #a3a3aa); font-size: 12px; }
      .bp-profile-tag { flex: 0 0 auto; border: 1px solid rgba(255,255,255,.13); border-radius: 999px; padding: 4px 7px; color: var(--muted, #a3a3aa); font-size: 10px; font-weight: 900; letter-spacing: .05em; }
      .bp-pin { margin-top: 22px; }
      .bp-pin[hidden] { display: none; }
      .bp-pin-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .bp-back { min-height: 40px; border: 0; border-radius: 999px; padding: 8px 12px; color: inherit; background: rgba(255,255,255,.08); font-weight: 800; }
      .bp-back:hover { background: rgba(255,255,255,.14); }
      .bp-dots { display: flex; justify-content: center; gap: 12px; margin: 24px 0; }
      .bp-dot { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.45); border-radius: 50%; }
      .bp-dot[data-filled="true"] { border-color: var(--accent, #ff3d47); background: var(--accent, #ff3d47); box-shadow: 0 0 0 4px rgba(255,61,71,.15); }
      .bp-pad { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
      .bp-digit, .bp-action { min-height: 58px; border: 1px solid rgba(255,255,255,.11); border-radius: 16px; color: inherit; background: rgba(255,255,255,.055); font-size: 20px; font-weight: 850; }
      .bp-digit:hover, .bp-digit:focus-visible, .bp-action:hover, .bp-action:focus-visible { border-color: rgba(255,61,71,.85); background: rgba(255,61,71,.12); }
      .bp-action { font-size: 13px; }
      .bp-pad-spacer { min-height: 58px; }
      .bp-pin-actions, .bp-footer { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 16px; }
      .bp-verify, .bp-refresh { min-height: 43px; border: 1px solid var(--accent, #ff3d47); border-radius: 999px; padding: 10px 16px; color: #fff; background: linear-gradient(140deg, var(--accent, #ff3d47), var(--accent-strong, #e11d2b)); font-size: 14px; font-weight: 850; }
      .bp-secondary { min-height: 43px; border: 1px solid rgba(255,255,255,.12); border-radius: 999px; padding: 10px 16px; color: inherit; background: rgba(255,255,255,.055); font-size: 14px; font-weight: 800; }
      .bp-verify:disabled, .bp-refresh:disabled, .bp-profile:disabled, .bp-digit:disabled, .bp-action:disabled, .bp-back:disabled { cursor: wait; opacity: .52; }
      @media (max-width: 720px) { .bp-connect { width: 42px; padding: 0; font-size: 0; } .bp-connect::before { content: "Profile"; font-size: 11px; } .bp-panel { padding: 22px 18px 18px; } }
      @media (prefers-reduced-motion: reduce) { .bp-profile, .bp-digit, .bp-action { transition: none; } }
    `;
    document.head.appendChild(style);
  }

  function setStatus(message, type = 'info') {
    ui.status.textContent = message;
    ui.status.dataset.state = type;
  }

  function setBusy(busy) {
    state.busy = busy;
    ui.connect.disabled = busy;
    ui.refresh.disabled = busy;
    ui.close.disabled = busy;
    ui.verify.disabled = busy || state.pinDigits.length !== 4;
    ui.back.disabled = busy;
    document.querySelectorAll('.bp-profile, .bp-digit, .bp-action').forEach((button) => {
      button.disabled = busy;
    });
  }

  function clearUnlock() {
    state.unlockToken = null;
    state.unlockExpiresAt = 0;
    if (state.unlockTimer) {
      window.clearTimeout(state.unlockTimer);
      state.unlockTimer = 0;
    }
  }

  function setUnlock(token, expiresAt) {
    clearUnlock();
    state.unlockToken = token;
    state.unlockExpiresAt = expiresAt;
    const delay = Math.max(0, Math.min(expiresAt - Date.now() + 100, 2147483647));
    state.unlockTimer = window.setTimeout(() => {
      clearUnlock();
      if (!ui.layer.hidden) setStatus('This profile unlock has expired.', 'info');
    }, delay);
  }

  function updateConnectButton() {
    const profile = state.activeProfile;
    ui.connect.textContent = profile ? profile.name : 'Connect profile';
    ui.connect.dataset.connected = profile ? 'true' : 'false';
    ui.connect.setAttribute('aria-label', profile ? `Profile: ${profile.name}` : 'Connect profile');
  }

  function dispatchProfileSelection(profile) {
    document.dispatchEvent(new CustomEvent('blazing-profile-selected', {
      detail: {
        id: profile.id,
        name: profile.name,
        isKids: profile.isKids,
        maxRating: profile.maxRating,
        allowAdult: profile.allowAdult,
        unlocked: Boolean(state.unlockToken && state.unlockExpiresAt > Date.now()),
      },
    }));
  }

  function renderProfileList() {
    ui.profiles.replaceChildren();
    const profiles = state.profiles;
    if (!profiles.length) return;
    profiles.forEach((profile) => {
      const button = element('button', 'bp-profile');
      button.type = 'button';
      button.disabled = state.busy;
      button.dataset.active = state.activeProfile && state.activeProfile.id === profile.id ? 'true' : 'false';
      button.setAttribute('aria-label', `Choose ${profile.name}${profile.hasPin ? ', PIN required' : ''}`);

      const avatar = element('span', 'bp-avatar', profile.name.slice(0, 1).toUpperCase());
      avatar.setAttribute('aria-hidden', 'true');
      const copy = element('span', 'bp-profile-copy');
      copy.append(element('span', 'bp-profile-name', profile.name));
      const meta = profile.isKids ? 'Kids profile' : `${profile.maxRating} rating`;
      copy.append(element('span', 'bp-profile-meta', meta));
      button.append(avatar, copy);
      if (profile.hasPin) button.append(element('span', 'bp-profile-tag', 'PIN'));
      button.addEventListener('click', () => selectProfile(profile));
      ui.profiles.appendChild(button);
    });
  }

  function renderPin() {
    const profile = state.pendingProfile;
    ui.pin.hidden = !profile;
    if (!profile) return;
    ui.pinName.textContent = profile.name;
    ui.dots.replaceChildren();
    for (let index = 0; index < 4; index += 1) {
      const dot = element('span', 'bp-dot');
      dot.dataset.filled = index < state.pinDigits.length ? 'true' : 'false';
      dot.setAttribute('aria-hidden', 'true');
      ui.dots.appendChild(dot);
    }
    ui.dots.setAttribute('aria-label', `${state.pinDigits.length} of 4 digits entered`);
    ui.verify.disabled = state.busy || state.pinDigits.length !== 4;
    ui.clear.disabled = state.busy || state.pinDigits.length === 0;
    ui.delete.disabled = state.busy || state.pinDigits.length === 0;
  }

  function clearPinEntry() {
    state.pinDigits = [];
    renderPin();
  }

  function openPin(profile) {
    clearUnlock();
    state.activeProfile = null;
    updateConnectButton();
    state.pendingProfile = profile;
    clearPinEntry();
    ui.profiles.hidden = true;
    ui.pin.hidden = false;
    setStatus('Enter four digits, then select Verify. A failed check uses one server attempt.', 'info');
    window.setTimeout(() => ui.digitButtons[0]?.focus(), 0);
  }

  function showProfiles(message) {
    state.pendingProfile = null;
    clearPinEntry();
    ui.pin.hidden = true;
    ui.profiles.hidden = false;
    renderProfileList();
    if (message) setStatus(message, 'info');
  }

  function selectProfile(profile) {
    if (state.busy) return;
    clearUnlock();
    if (profile.hasPin) {
      openPin(profile);
      return;
    }
    state.pendingProfile = null;
    state.activeProfile = profile;
    updateConnectButton();
    renderProfileList();
    dispatchProfileSelection(profile);
    setStatus(`${profile.name} is selected for this browser session.`, 'info');
  }

  function addDigit(digit) {
    if (state.busy || !/^\d$/.test(digit) || state.pinDigits.length >= 4) return;
    state.pinDigits.push(digit);
    renderPin();
  }

  function deleteDigit() {
    if (state.busy) return;
    state.pinDigits.pop();
    renderPin();
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    try {
      const response = await fetch(`${FLEET_BASE}${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body,
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
    } catch (error) {
      return { status: 0, ok: false, timeout: error && error.name === 'AbortError', body: null };
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function serverError(result, fallback) {
    const detail = text(result && result.body && result.body.error);
    return detail ? `Profile server: ${detail}` : fallback;
  }

  async function registerDevice() {
    const payload = JSON.stringify({
      model: 'Blazing Web',
      fireOs: 'web',
      abi: 'web',
      appVersions: { web: DEVICE_VERSION },
      label: 'Blazing Web',
    });
    const result = await request('/agent/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    if (!result.ok) {
      if (result.status === 429) {
        setStatus('Profile registration is temporarily limited. Wait, then select Connect profile again.', 'error');
      } else {
        setStatus(serverError(result, result.timeout
          ? 'The profile server did not answer in time. Try again.'
          : 'Could not register this browser with the profile server.'), 'error');
      }
      return null;
    }
    const id = text(result.body && result.body.deviceId);
    const token = text(result.body && result.body.deviceToken);
    if (!id || !token) {
      setStatus('The profile server did not return a browser connection. Nothing was selected.', 'error');
      return null;
    }
    const credentials = { id, token };
    if (!saveCredentials(credentials)) {
      setStatus('Browser storage is blocked. This browser cannot keep its profile connection.', 'error');
      return null;
    }
    state.credentials = credentials;
    return credentials;
  }

  async function listProfiles(credentials) {
    return request(`/profiles?deviceId=${encodeURIComponent(credentials.id)}`, {
      headers: { 'X-Device-Token': credentials.token },
    });
  }

  function shouldRepairCredentials(result) {
    if (result.status === 401) return true;
    const detail = text(result.body && result.body.error).toLowerCase();
    return result.status === 404 && detail.startsWith('unknown device');
  }

  function applyProfileList(result) {
    if (result.status === 403) {
      state.profiles = [];
      state.activeProfile = null;
      clearUnlock();
      updateConnectButton();
      showProfiles();
      setStatus('This browser is waiting for admin approval. Its connection is saved. Approve it in the Blazing dashboard, then select Refresh profiles.', 'pending');
      return;
    }
    if (!result.ok) {
      showProfiles();
      if (result.status === 429) {
        setStatus('The profile server is temporarily limiting requests. Wait, then select Refresh profiles.', 'error');
      } else {
        setStatus(serverError(result, result.timeout
          ? 'The profile server did not answer in time. Check the connection, then try again.'
          : 'Could not load profiles from the profile server.'), 'error');
      }
      return;
    }
    const rawProfiles = result.body && Array.isArray(result.body.profiles) ? result.body.profiles : null;
    if (!rawProfiles) {
      showProfiles();
      setStatus('The profile server returned an invalid profile list. Try Refresh profiles.', 'error');
      return;
    }
    state.profiles = rawProfiles.map(profileFrom).filter(Boolean);
    if (state.activeProfile && !state.profiles.some((profile) => profile.id === state.activeProfile.id)) {
      state.activeProfile = null;
      clearUnlock();
      updateConnectButton();
    }
    showProfiles();
    if (!state.profiles.length) {
      setStatus('This approved browser has no profiles yet. Add a profile on an approved TV, then select Refresh profiles.', 'info');
      return;
    }
    setStatus('Choose who is watching.', 'info');
    window.setTimeout(() => ui.profiles.querySelector('.bp-profile')?.focus(), 0);
  }

  async function connectProfiles() {
    if (state.busy) return;
    setBusy(true);
    state.pendingProfile = null;
    clearPinEntry();
    ui.pin.hidden = true;
    ui.profiles.hidden = false;
    setStatus('Connecting to profiles…', 'info');
    try {
      let credentials = state.credentials || storedCredentials();
      if (!credentials) {
        credentials = await registerDevice();
        if (!credentials) return;
      }
      state.credentials = credentials;
      let result = await listProfiles(credentials);
      if (shouldRepairCredentials(result)) {
        clearStoredCredentials();
        state.credentials = null;
        setStatus('This browser connection is no longer valid. Registering a new browser connection…', 'info');
        credentials = await registerDevice();
        if (!credentials) return;
        result = await listProfiles(credentials);
      }
      applyProfileList(result);
    } finally {
      setBusy(false);
      renderPin();
      renderProfileList();
    }
  }

  async function verifyPin() {
    const profile = state.pendingProfile;
    if (state.busy || !profile || state.pinDigits.length !== 4 || !state.credentials) return;
    let candidate = state.pinDigits.join('');
    let requestBody = JSON.stringify({ pin: candidate });
    clearPinEntry();
    setBusy(true);
    setStatus('Checking this profile…', 'info');
    let result;
    try {
      result = await request(`/profiles/${encodeURIComponent(profile.id)}/verify?deviceId=${encodeURIComponent(state.credentials.id)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Token': state.credentials.token,
        },
        body: requestBody,
      });
    } finally {
      candidate = '';
      requestBody = '';
    }
    setBusy(false);
    renderPin();
    if (result.status === 403) {
      applyProfileList(result);
      return;
    }
    if (shouldRepairCredentials(result)) {
      clearStoredCredentials();
      state.credentials = null;
      clearUnlock();
      showProfiles();
      setStatus('This browser connection is no longer valid. Select Refresh profiles to register a new browser connection.', 'error');
      return;
    }
    if (!result.ok) {
      if (result.status === 429) {
        setStatus('Too many PIN checks. Wait before trying this profile again.', 'error');
      } else {
        setStatus(serverError(result, result.timeout
          ? 'The profile server did not answer in time. No unlock was created.'
          : 'Could not check this PIN. No unlock was created.'), 'error');
      }
      return;
    }
    const body = result.body || {};
    if (body.ok !== true) {
      const lockedUntil = text(body.lockedUntil);
      if (lockedUntil) {
        const date = new Date(lockedUntil);
        const when = Number.isNaN(date.getTime()) ? 'the time shown by the profile server' : date.toLocaleString();
        setStatus(`This profile is locked until ${when}.`, 'error');
      } else if (Number.isInteger(body.attemptsLeft)) {
        setStatus(`That PIN was not accepted. ${body.attemptsLeft} attempt${body.attemptsLeft === 1 ? '' : 's'} left.`, 'error');
      } else {
        setStatus('That PIN was not accepted. Try again.', 'error');
      }
      return;
    }
    const unlockToken = text(body.unlockToken);
    const expiresAt = Date.parse(text(body.expiresAt));
    if (!unlockToken || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      clearUnlock();
      setStatus('The profile server returned an unusable unlock session. Nothing was unlocked.', 'error');
      return;
    }
    state.activeProfile = profile;
    state.pendingProfile = null;
    setUnlock(unlockToken, expiresAt);
    updateConnectButton();
    showProfiles();
    dispatchProfileSelection(profile);
    setStatus(`${profile.name} is selected. Its unlock stays only in this browser session.`, 'info');
  }

  function openPanel() {
    ui.layer.hidden = false;
    ui.layer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('no-scroll');
    window.setTimeout(() => ui.close.focus(), 0);
  }

  function closePanel() {
    if (state.busy) return;
    state.pendingProfile = null;
    clearPinEntry();
    ui.pin.hidden = true;
    ui.profiles.hidden = false;
    ui.layer.hidden = true;
    ui.layer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('no-scroll');
    ui.connect.focus();
  }

  function buildUi() {
    addStyle();
    const topbar = document.querySelector('.topbar');
    const searchButton = document.getElementById('search-button');
    if (!topbar || !searchButton) return false;

    ui.connect = element('button', 'bp-connect', 'Connect profile');
    ui.connect.type = 'button';
    ui.connect.id = 'profile-connect-button';
    ui.connect.setAttribute('aria-haspopup', 'dialog');
    topbar.insertBefore(ui.connect, searchButton);

    ui.layer = element('section', 'bp-layer');
    ui.layer.hidden = true;
    ui.layer.setAttribute('aria-hidden', 'true');
    const backdrop = element('button', 'bp-backdrop');
    backdrop.type = 'button';
    backdrop.setAttribute('aria-label', 'Close profile panel');
    const panel = element('section', 'bp-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'bp-heading');
    ui.close = element('button', 'bp-close', 'Close');
    ui.close.type = 'button';
    const kicker = element('p', 'bp-kicker', 'Profiles');
    const heading = element('h2', 'bp-heading', 'Who is watching?');
    heading.id = 'bp-heading';
    const copy = element('p', 'bp-copy', 'Connect this browser only when you want to use a shared profile.');
    ui.status = element('p', 'bp-status');
    ui.status.setAttribute('role', 'status');
    ui.status.setAttribute('aria-live', 'polite');
    ui.profiles = element('div', 'bp-profiles');

    ui.pin = element('section', 'bp-pin');
    ui.pin.hidden = true;
    const pinTop = element('div', 'bp-pin-top');
    ui.back = element('button', 'bp-back', 'Choose another profile');
    ui.back.type = 'button';
    ui.pinName = element('strong', '', '');
    pinTop.append(ui.back, ui.pinName);
    ui.dots = element('div', 'bp-dots');
    ui.dots.setAttribute('role', 'img');
    const pad = element('div', 'bp-pad');
    ui.digitButtons = [];
    for (let number = 1; number <= 9; number += 1) {
      const button = element('button', 'bp-digit', String(number));
      button.type = 'button';
      button.dataset.digit = String(number);
      button.setAttribute('aria-label', `Digit ${number}`);
      ui.digitButtons.push(button);
      pad.appendChild(button);
    }
    ui.clear = element('button', 'bp-action', 'Clear');
    ui.clear.type = 'button';
    ui.clear.setAttribute('aria-label', 'Clear entered digits');
    const zero = element('button', 'bp-digit', '0');
    zero.type = 'button';
    zero.dataset.digit = '0';
    zero.setAttribute('aria-label', 'Digit 0');
    ui.digitButtons.push(zero);
    ui.delete = element('button', 'bp-action', 'Delete');
    ui.delete.type = 'button';
    ui.delete.setAttribute('aria-label', 'Delete last digit');
    pad.append(ui.clear, zero, ui.delete);
    const pinActions = element('div', 'bp-pin-actions');
    ui.verify = element('button', 'bp-verify', 'Verify');
    ui.verify.type = 'button';
    ui.verify.disabled = true;
    pinActions.appendChild(ui.verify);
    ui.pin.append(pinTop, ui.dots, pad, pinActions);

    const footer = element('div', 'bp-footer');
    ui.refresh = element('button', 'bp-refresh', 'Refresh profiles');
    ui.refresh.type = 'button';
    const keepBrowsing = element('button', 'bp-secondary', 'Keep browsing');
    keepBrowsing.type = 'button';
    footer.append(ui.refresh, keepBrowsing);
    panel.append(ui.close, kicker, heading, copy, ui.status, ui.profiles, ui.pin, footer);
    ui.layer.append(backdrop, panel);
    document.body.appendChild(ui.layer);

    ui.connect.addEventListener('click', () => {
      openPanel();
      connectProfiles();
    });
    ui.refresh.addEventListener('click', connectProfiles);
    ui.close.addEventListener('click', closePanel);
    keepBrowsing.addEventListener('click', closePanel);
    backdrop.addEventListener('click', closePanel);
    ui.back.addEventListener('click', () => showProfiles('Choose who is watching.'));
    ui.clear.addEventListener('click', clearPinEntry);
    ui.delete.addEventListener('click', deleteDigit);
    ui.digitButtons.forEach((button) => button.addEventListener('click', () => addDigit(button.dataset.digit || '')));
    ui.verify.addEventListener('click', verifyPin);
    document.addEventListener('keydown', (event) => {
      if (ui.layer.hidden || state.busy) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closePanel();
        return;
      }
      if (!state.pendingProfile) return;
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        addDigit(event.key);
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        deleteDigit();
      } else if (event.key === 'Enter' && state.pinDigits.length === 4) {
        event.preventDefault();
        verifyPin();
      }
    });
    return true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUi, { once: true });
  } else {
    buildUi();
  }
})();
