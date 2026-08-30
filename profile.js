/* Blazing web profile gate. Device credentials persist; profile unlocks do not. */
'use strict';

(() => {
  const FLEET_BASE = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  const DEVICE_STORAGE_KEY = 'blazing-web-profile-device-v1';
  const REQUEST_TIMEOUT_MS = 15000;
  const DEVICE_VERSION = 73;
  // The OWNER pin is 7 digits; profile pins stay 4. This constant was USED in
  // two places and declared in none, and this file is 'use strict' inside an
  // IIFE — so the first reference threw ReferenceError and took the whole pad
  // with it. The pad was not rejecting a wrong length; it was not working.
  const OWNER_PIN_LENGTH = 7;

  const state = {
    credentials: null,
    profiles: [],
    // True once a listProfiles() call has come back 200 for this browser. The
    // "+ Add profile" tile depends on this, not on state.profiles.length,
    // because a brand-new approved browser has zero profiles and must still
    // see the tile — and a still-pending browser must never see it.
    approved: false,
    activeProfile: null,
    pendingProfile: null,
    // True while the pad is asking for the OWNER PIN rather than a profile PIN.
    ownerMode: false,
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
      .bp-connect { flex: 0 0 auto; min-height: 44px; border: 1px solid rgba(255,255,255,.12); border-radius: 13px; padding: 8px 11px; color: var(--text, #fff); background: rgba(28,28,31,.85); font-size: 13px; font-weight: 800; white-space: nowrap; }
      .bp-connect:hover { background: var(--surface-focus, #1c1c1f); }
      .bp-connect[data-connected="true"] { border-color: rgba(255,61,71,.42); }
      .bp-welcome-actions { display: flex; flex-direction: column; gap: 10px; margin-top: 20px; }
      .bp-invite-input, .bp-create-input { width: 100%; min-height: 52px; margin: 16px 0; border: 1px solid rgba(255,255,255,.14); border-radius: 14px; padding: 0 14px; color: inherit; background: rgba(255,255,255,.05); font-size: 18px; font-weight: 800; }
      .bp-invite-input { letter-spacing: .1em; text-transform: uppercase; }
      .bp-kids-row { display: flex; align-items: center; gap: 10px; margin: 4px 0 18px; color: var(--muted, #a3a3aa); font-size: 14px; }
      .bp-welcome[hidden], .bp-invite[hidden], .bp-create[hidden] { display: none; }
      .bp-profile-add { border-style: dashed; border-color: rgba(255,255,255,.22); }
      /* DebridStream reference: full-bleed art, a LEFT rail only, "nothing
         else is drawn." One thing kept deliberately different, not missed:
         the rating/PIN meta line stays on each row — the reference shows only a name, but
         "which profile needs a PIN" and "what's this one capped at" are real
         answers Markus's household needs, not decoration to cut for parity.
         Everything else here is CSS only — no line in this file's actual
         gate logic (verifyPin, rate limits, unlock expiry) changed, on
         purpose: this is the parental-control surface, and a redesign
         session is not where that logic should move too. */
      .bp-layer {
        position: fixed;
        inset: 0;
        z-index: 80;
        display: flex;
        align-items: stretch;
        background: radial-gradient(120% 100% at 0% 0%, rgba(255,61,71,.16), transparent 55%), #08080a;
      }
      /* The per-profile art, swapped as the focus moves down the rail. It is
         the FIRST child of the layer and pointer-events:none, so it can never
         take a click or a focus stop away from the gate — this is the parental
         control surface, and a decoration must not be reachable on it. The
         gradient on .bp-layer stays underneath, so a profile with no history,
         or a profile server that did not answer, looks deliberate rather than
         broken. Its ::after keeps the rail readable over a photograph. */
      .bp-art {
        position: absolute; inset: 0; z-index: 0; pointer-events: none;
        background-position: center; background-size: cover; background-repeat: no-repeat;
        opacity: 0; transition: opacity .45s ease;
      }
      .bp-art[data-shown="true"] { opacity: .5; }
      .bp-art::after {
        content: ""; position: absolute; inset: 0;
        background: linear-gradient(90deg, #08080a 0%, rgba(8,8,10,.88) 30%, rgba(8,8,10,.4) 66%, rgba(8,8,10,.6) 100%);
      }
      .bp-backdrop { position: absolute; inset: 0; width: 100%; border: 0; background: transparent; }
      .bp-panel {
        position: relative;
        width: min(420px, 100%);
        max-height: 100vh;
        max-height: 100dvh;
        overflow: auto;
        display: flex;
        flex-direction: column;
        justify-content: center;
        border: 0;
        border-right: 1px solid rgba(255,255,255,.06);
        border-radius: 0;
        padding: 40px clamp(24px, 5vw, 56px);
        color: var(--text, #f7f7f8);
        background: linear-gradient(180deg, rgba(20,20,22,.4), rgba(10,10,11,.85));
        box-shadow: none;
      }
      .bp-close { position: absolute; top: 13px; right: 13px; min-width: 44px; min-height: 44px; border: 0; border-radius: 13px; color: inherit; background: rgba(255,255,255,.06); font-weight: 800; }
      .bp-close:hover { background: rgba(255,255,255,.12); }
      .bp-kicker { margin: 0 48px 7px 0; color: var(--accent, #ff3d47); font-size: 12px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
      .bp-heading { margin: 0; font-size: clamp(27px, 6vw, 40px); line-height: 1.02; letter-spacing: -.05em; }
      .bp-copy { margin: 12px 0 0; color: var(--muted, #a3a3aa); font-size: 14px; line-height: 1.5; }
      .bp-status { min-height: 24px; margin: 18px 0 0; color: var(--muted, #a3a3aa); font-size: 14px; line-height: 1.45; }
      .bp-status[data-state="error"] { color: #ff9aa1; }
      .bp-status[data-state="pending"] { color: #ffd289; }
      .bp-profiles { display: grid; gap: 10px; margin-top: 20px; }
      .bp-profile { display: flex; align-items: center; gap: 16px; width: 100%; min-height: 72px; border: 1px solid transparent; border-radius: 17px; padding: 10px 12px; color: inherit; background: transparent; text-align: left; transition: background .15s, border-color .15s; }
      .bp-profile:hover, .bp-profile:focus-visible, .bp-profile[data-active="true"] { border-color: rgba(255,255,255,.5); background: rgba(255,255,255,.045); }
      /* Rounded-square, not a circle — the reference's "cartoon avatar" tile
         shape — and bigger: a left-rail avatar column is the ONLY chrome on
         that screen, so it can afford the size a card-row layout couldn't.

         Neutral, not the accent gradient it used to be. Three profiles all
         wearing the same red gradient and the same red glow told you nothing
         about which was which, and spent the brand colour on decoration for
         rows that are all equally inactive. The accent now arrives only on the
         row you are actually on (below), which is the one thing on this screen
         worth colouring. */
      .bp-avatar { display: grid; place-items: center; width: 54px; height: 54px; flex: 0 0 auto; border-radius: 16px; color: var(--text, #f7f7f8); background: rgba(255,255,255,.07); font-size: 20px; font-weight: 900; transition: background .15s, color .15s; }
      .bp-profile:hover .bp-avatar, .bp-profile:focus-visible .bp-avatar, .bp-profile[data-active="true"] .bp-avatar { color: #fff; background: linear-gradient(145deg, var(--accent, #ff3d47), var(--accent-strong, #e11d2b)); }
      .bp-profile-copy { min-width: 0; flex: 1; }
      .bp-profile-name { display: block; overflow: hidden; font-size: 16px; font-weight: 850; text-overflow: ellipsis; white-space: nowrap; }
      .bp-profile-meta { display: block; margin-top: 3px; color: var(--muted, #a3a3aa); font-size: 12px; }
      .bp-profile-tag { flex: 0 0 auto; border: 1px solid rgba(255,255,255,.13); border-radius: 999px; padding: 4px 7px; color: var(--muted, #a3a3aa); font-size: 10px; font-weight: 900; letter-spacing: .05em; }
      .bp-pin { margin-top: 22px; }
      .bp-pin[hidden] { display: none; }
      .bp-pin-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .bp-back { min-height: 44px; border: 0; border-radius: 999px; padding: 8px 12px; color: inherit; background: rgba(255,255,255,.08); font-weight: 800; }
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
      .bp-verify, .bp-refresh { min-height: 44px; border: 1px solid var(--accent, #ff3d47); border-radius: 999px; padding: 10px 16px; color: #fff; background: linear-gradient(140deg, var(--accent, #ff3d47), var(--accent-strong, #e11d2b)); font-size: 14px; font-weight: 850; }
      .bp-secondary { min-height: 44px; border: 1px solid rgba(255,255,255,.12); border-radius: 999px; padding: 10px 16px; color: inherit; background: rgba(255,255,255,.055); font-size: 14px; font-weight: 800; }
      .bp-verify:disabled, .bp-refresh:disabled, .bp-profile:disabled, .bp-digit:disabled, .bp-action:disabled, .bp-back:disabled { cursor: wait; opacity: .52; }
      /* A LEFT RAIL IS A DESKTOP SHAPE. It only reads as a rail when there is
         something beside it; the reference has full-bleed art there and this
         app deliberately does not (see the note above). Measured on the real
         thing before this block existed:

           390x844 phone   panel 390x844, content 198px from the top,
                           list ends at 591 -> 198 above + 253 below = 451px
                           of empty screen wrapped around three rows
           768x1024 tablet panel 420x1024, 280px above the content, and 348px
                           of the window to the right of the panel with
                           nothing in it at all

         "justify-content: center" is what put it in the middle: correct for a
         420px rail on a 900px-tall desktop window, and the reason a phone
         renders a header that starts halfway down the screen. Under 900px the
         panel stops being a rail and becomes what it actually is on that
         screen — the whole screen — anchored at the top like every other view
         in the app, so the eye starts where the content starts. */
      @media (max-width: 900px) {
        .bp-panel {
          width: 100%;
          justify-content: flex-start;
          border-right: 0;
          padding: calc(28px + env(safe-area-inset-top, 0px)) 20px calc(32px + env(safe-area-inset-bottom, 0px));
        }
        /* Capped, not full-bleed. On a 768px tablet an uncapped row put the
           name hard left and the PIN badge 700px away hard right, with the
           reader's eye crossing an empty middle to connect them. */
        .bp-kicker, .bp-heading, .bp-copy, .bp-status, .bp-profiles, .bp-pin, .bp-footer { width: 100%; max-width: 560px; }
        .bp-profiles { margin-top: 16px; }
      }
      /* The topbar button used to be squeezed to a 42px box with "font-size: 0"
         and the word "Profile" pushed back in through ::before at 11px. Two
         things wrong with that: 11px of text does not fit in 42px, so it hung
         out of its own pill on every phone screenshot, and it threw away the
         profile NAME the button is otherwise set to (line 215) to say the
         generic word instead. "Kids" is both shorter and the useful answer. */
      @media (max-width: 720px) {
        .bp-connect { max-width: 88px; min-width: 44px; overflow: hidden; padding: 8px 10px; text-overflow: ellipsis; }
        .bp-panel { padding-left: 18px; padding-right: 18px; }
      }
      /* styles.css scales any focused button by 1.08 on coarse pointers (the
         d-pad "magnetic focus" rule, which matches on a plain "button:
         focus-visible"). That was harmless while a profile row was 380px in a
         420px rail. Now that the row is the full width of a phone or tablet,
         1.08 of 728px measured 786px and hung 9px off BOTH edges at 768. A
         row this wide does not need to grow to show it is focused: it already
         gets a border, a lit background and a coloured avatar tile. */
      @media (pointer: coarse), (hover: none) {
        .bp-profile:focus-visible { transform: none; }
      }
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
    ui.requestAccess.disabled = busy;
    ui.enterCode.disabled = busy;
    ui.inviteFromPending.disabled = busy;
    ui.inviteBack.disabled = busy;
    ui.inviteInput.disabled = busy;
    ui.inviteSubmit.disabled = busy;
    ui.createBack.disabled = busy;
    ui.createName.disabled = busy;
    ui.createKids.disabled = busy;
    ui.createSubmit.disabled = busy;
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
    syncGateChrome();
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

  /**
   * The art behind the rail, per profile, taken from that profile's own last
   * watched title — DebridStream swaps a whole poster behind each profile, and
   * this screen drew one flat gradient for everybody because the comment above
   * said the app "has no data for it yet". It does: the fleet keeps per-profile
   * progress at GET /profiles/:id/progress and every item carries a
   * `background` URL.
   *
   * Three rules, all deliberate:
   *
   * 1. NOT FOR AN ADULT-ENABLED PROFILE. The gate is the screen the whole
   *    household stands in front of, and the progress payload carries NO
   *    contentRating — sanitizeProgressPayload (firetv/server/profiles.js)
   *    keeps id, name, poster, type, progress, positionSecs, videoId,
   *    background and updatedAt, and drops everything else. So there is no way
   *    to filter one title out; the only honest filter is the profile itself.
   * 2. IT NEVER BLOCKS THE GATE. Started after the rail is already on screen,
   *    never awaited by selectProfile, and every failure leaves the gradient
   *    exactly as it was. A slow profile server must not slow down choosing a
   *    profile.
   * 3. THE FRESHEST ITEM IS PICKED HERE. getProgress returns the stored order
   *    capped at MAX_PROGRESS_ITEMS and does not sort — there is no
   *    server-side recency, so "last watched" is this client's own decision.
   */
  function artEligible(profile) {
    return Boolean(profile)
      && profile.allowAdult !== true
      && String(profile.maxRating || '').toLowerCase() !== 'adult';
  }

  function httpsArt(value) {
    const raw = text(value);
    if (!raw) return '';
    try {
      const url = new URL(raw, window.location.href);
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function freshestArt(body) {
    const items = body && body.progress && Array.isArray(body.progress.items)
      ? body.progress.items
      : [];
    let best = null;
    for (const item of items) {
      const art = httpsArt(item && (item.background || item.poster));
      if (!art) continue;
      const when = Date.parse((item && item.updatedAt) || '') || 0;
      if (!best || when > best.when) best = { art, when };
    }
    return best ? best.art : '';
  }

  function showProfileArt(profile) {
    if (!ui.art) return;
    const art = profile && profile.artUrl;
    if (!art) {
      ui.art.dataset.shown = 'false';
      return;
    }
    // Quotes are the only character that can break out of url("…"); a URL that
    // reached here already passed httpsArt(), which is a real URL parse.
    ui.art.style.backgroundImage = `url("${art.replace(/"/g, '%22')}")`;
    ui.art.dataset.shown = 'true';
  }

  async function loadProfileArt() {
    const credentials = state.credentials;
    if (!credentials || !ui.art) return;
    // A refresh replaces state.profiles with a NEW array, so holding the old one
    // is how a late answer knows it is answering a question nobody asked any more.
    const generation = state.profiles;
    try {
      await Promise.all(generation.filter(artEligible).map(async (profile) => {
        const result = await request(
          `/profiles/${encodeURIComponent(profile.id)}/progress?deviceId=${encodeURIComponent(credentials.id)}`,
          { headers: { 'X-Device-Token': credentials.token } },
        );
        if (result.ok) profile.artUrl = freshestArt(result.body);
      }));
      if (state.profiles !== generation) return;
      const opening = generation.find((profile) => (
        state.activeProfile && profile.id === state.activeProfile.id && profile.artUrl
      )) || generation.find((profile) => profile.artUrl);
      if (opening) showProfileArt(opening);
    } catch {
      // Decoration. It is never worth a broken gate.
    }
  }

  function renderProfileList() {
    ui.profiles.replaceChildren();
    const profiles = state.profiles;
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
      // Hover AND focus: a mouse hovers, a television remote only ever focuses,
      // and the art has to follow both or it follows neither on a TV.
      const swap = () => showProfileArt(profile);
      button.addEventListener('mouseenter', swap);
      button.addEventListener('focus', swap);
      ui.profiles.appendChild(button);
    });
    // Only once this browser is confirmed approved — a pending browser's own
    // POST would just 403, and showing the tile there is a promise this
    // screen can't keep yet.
    if (state.approved) {
      const addButton = element('button', 'bp-profile bp-profile-add');
      addButton.type = 'button';
      addButton.disabled = state.busy;
      addButton.setAttribute('aria-label', 'Create a new profile');
      const addAvatar = element('span', 'bp-avatar', '+');
      addAvatar.setAttribute('aria-hidden', 'true');
      const addCopy = element('span', 'bp-profile-copy');
      addCopy.append(element('span', 'bp-profile-name', 'Add profile'));
      addButton.append(addAvatar, addCopy);
      addButton.addEventListener('click', showCreateProfile);
      ui.profiles.appendChild(addButton);
    }
  }

  function renderPin() {
    // The pad serves two jobs now: unlocking a profile, and proving ownership of
    // this browser. `ownerMode` is the only difference, and the owner PIN is seven
    // digits rather than four — a hundred times the keyspace for the same effort,
    // which matters because this one is reachable from the open internet.
    const profile = state.pendingProfile;
    const active = state.ownerMode || !!profile;
    ui.pin.hidden = !active;
    if (!active) return;
    const length = pinLength();
    ui.pinName.textContent = state.ownerMode ? 'Owner PIN' : profile.name;
    ui.dots.replaceChildren();
    for (let index = 0; index < length; index += 1) {
      const dot = element('span', 'bp-dot');
      dot.dataset.filled = index < state.pinDigits.length ? 'true' : 'false';
      dot.setAttribute('aria-hidden', 'true');
      ui.dots.appendChild(dot);
    }
    ui.dots.setAttribute('aria-label', `${state.pinDigits.length} of ${length} digits entered`);
    ui.verify.disabled = state.busy || state.pinDigits.length !== length;
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
    hideAllScreens();
    ui.pin.hidden = false;
    setStatus('Enter four digits, then select Verify. A failed check uses one server attempt.', 'info');
    window.setTimeout(() => ui.digitButtons[0]?.focus(), 0);
  }

  /**
   * Ask for the owner PIN so this browser can approve itself.
   *
   * Only reachable from the pending screen. The server does the deciding — this
   * only collects six digits and posts them — and it needs this browser's device
   * token, so the PIN alone is not enough from somewhere else.
   */
  function openOwnerPin() {
    if (state.busy) return;
    if (!state.credentials) {
      setStatus('This browser has no connection to approve yet. Select Refresh profiles first.', 'error');
      return;
    }
    state.pendingProfile = null;
    state.ownerMode = true;
    clearPinEntry();
    hideAllScreens();
    ui.owner.hidden = true;
    ui.pin.hidden = false;
    setStatus('Enter the seven-digit owner PIN to approve this browser. Attempts are limited.', 'info');
    window.setTimeout(() => ui.digitButtons[0]?.focus(), 0);
  }

  async function verifyOwnerPin() {
    if (state.busy || !state.ownerMode || state.pinDigits.length !== OWNER_PIN_LENGTH) return;
    if (!state.credentials) {
      setStatus('This browser has no connection to approve. Select Refresh profiles first.', 'error');
      return;
    }
    setBusy(true);
    setStatus('Checking…', 'info');
    try {
      const result = await request('/devices/self-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': state.credentials.token },
        body: JSON.stringify({ deviceId: state.credentials.id, pin: state.pinDigits.join('') }),
      });
      clearPinEntry();
      if (result.status === 503) {
        // Said plainly rather than as "wrong PIN", because the two need different
        // actions and confusing them sends the owner hunting for a typo.
        state.ownerMode = false;
        showProfiles();
        setStatus('Owner approval is not switched on for this fleet. Approve this browser in the Blazing dashboard instead.', 'error');
        return;
      }
      if (result.status === 429) {
        setStatus('Too many attempts. Wait an hour, or approve this browser in the Blazing dashboard.', 'error');
        return;
      }
      if (!result.ok) {
        const left = result.body && Number.isFinite(result.body.attemptsLeft)
          ? ` ${result.body.attemptsLeft} attempt(s) left before this browser is locked out for an hour.`
          : '';
        setStatus(`That is not the owner PIN.${left}`, 'error');
        return;
      }
      // Approved. Go straight back and load the profiles it can now see, so the
      // owner is not left to work out that a second button press is needed.
      state.ownerMode = false;
      showProfiles();
      setStatus('This browser is approved.', 'info');
      await connectProfiles();
    } finally {
      setBusy(false);
      renderPin();
    }
  }

  function showProfiles(message) {
    state.pendingProfile = null;
    state.ownerMode = false;
    clearPinEntry();
    hideAllScreens();
    ui.profiles.hidden = false;
    ui.kicker.textContent = 'Profiles';
    ui.heading.textContent = 'Who is watching?';
    renderProfileList();
    if (message) setStatus(message, 'info');
  }

  /**
   * Hide every full-screen section of the panel. Every "show X" function
   * calls this first so exactly one section is ever visible — before this,
   * showing the welcome/invite/create screens meant separately remembering
   * to hide profiles and pin, and it was easy to leave two visible at once.
   */
  function hideAllScreens() {
    ui.welcome.hidden = true;
    ui.invite.hidden = true;
    ui.createProfile.hidden = true;
    ui.pin.hidden = true;
    ui.profiles.hidden = true;
  }

  /**
   * The first screen a browser with no stored device identity ever sees.
   * Nothing is registered yet — that only happens once "Request Access" or
   * an invite code is actually submitted, so a visitor who closes the tab
   * here has created no pending device for Markus to see on the dashboard.
   */
  function showWelcome() {
    hideAllScreens();
    ui.welcome.hidden = false;
    ui.kicker.textContent = 'Get Access';
    ui.heading.textContent = 'New to Blazing?';
    setStatus('Choose how you want to get in.', 'info');
  }

  function showInvite() {
    hideAllScreens();
    ui.invite.hidden = false;
    ui.kicker.textContent = 'Invite Code';
    ui.heading.textContent = 'Enter your code';
    ui.inviteInput.value = '';
    setStatus('Enter the invite code you were given.', 'info');
    window.setTimeout(() => ui.inviteInput.focus(), 0);
  }

  function showCreateProfile() {
    hideAllScreens();
    ui.createProfile.hidden = false;
    ui.kicker.textContent = 'New Profile';
    ui.heading.textContent = 'Create a profile';
    ui.createName.value = '';
    ui.createKids.checked = false;
    setStatus('Name this profile. A PIN can be added later on a TV.', 'info');
    window.setTimeout(() => ui.createName.focus(), 0);
  }

  async function redeemInviteCode() {
    if (state.busy) return;
    const code = (ui.inviteInput.value || '').trim().toUpperCase();
    if (!code) {
      setStatus('Enter the invite code first.', 'error');
      return;
    }
    setBusy(true);
    setStatus('Checking that code…', 'info');
    try {
      let credentials = state.credentials || storedCredentials();
      if (!credentials) {
        credentials = await registerDevice();
        if (!credentials) return;
      }
      state.credentials = credentials;
      const result = await request('/devices/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: credentials.id, code }),
      });
      if (!result.ok) {
        if (result.status === 404) {
          setStatus('That code was not recognized. Check it and try again.', 'error');
        } else if (result.status === 409) {
          setStatus('That code has already been used. Ask for a new one.', 'error');
        } else if (result.status === 410) {
          setStatus('That code has expired. Ask for a new one.', 'error');
        } else if (result.status === 429) {
          setStatus('Too many attempts. Wait a bit, then try again.', 'error');
        } else {
          setStatus(serverError(result, result.timeout
            ? 'The profile server did not answer in time. Try again.'
            : 'Could not check that invite code.'), 'error');
        }
        return;
      }
      setStatus('Code accepted. Loading profiles…', 'info');
      const listing = await listProfiles(credentials);
      applyProfileList(listing);
    } finally {
      setBusy(false);
    }
  }

  async function submitCreateProfile() {
    if (state.busy) return;
    const name = (ui.createName.value || '').trim();
    if (!name) {
      setStatus('Enter a name for the profile.', 'error');
      return;
    }
    if (!state.credentials) {
      setStatus('This browser is not connected yet. Select Refresh profiles first.', 'error');
      return;
    }
    setBusy(true);
    setStatus('Creating this profile…', 'info');
    try {
      const result = await request(`/profiles?deviceId=${encodeURIComponent(state.credentials.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': state.credentials.token },
        body: JSON.stringify({ name, isKids: !!ui.createKids.checked }),
      });
      if (shouldRepairCredentials(result)) {
        clearStoredCredentials();
        state.credentials = null;
        showWelcome();
        setStatus('This browser connection is no longer valid. Start again.', 'error');
        return;
      }
      if (result.status === 403) {
        applyProfileList(result);
        return;
      }
      if (!result.ok) {
        setStatus(serverError(result, result.timeout
          ? 'The profile server did not answer in time. Try again.'
          : 'Could not create this profile.'), 'error');
        return;
      }
      const created = profileFrom(result.body && result.body.profile);
      if (!created) {
        setStatus('The profile server returned an unusable profile. Try Refresh profiles.', 'error');
        return;
      }
      const listing = await listProfiles(state.credentials);
      applyProfileList(listing);
      const match = state.profiles.find((profile) => profile.id === created.id) || created;
      selectProfile(match);
    } finally {
      setBusy(false);
    }
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
    // Picking somebody IS the answer to "who is watching?", so get out of the
    // way. Leaving the panel up made the user close a dialog they had just
    // finished with — and while it was the gate, that read as "it did not work".
    closePanel();
  }

  const pinLength = () => (state.ownerMode ? OWNER_PIN_LENGTH : 4);

  function addDigit(digit) {
    if (state.busy || !/^\d$/.test(digit) || state.pinDigits.length >= pinLength()) return;
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
    if (ui.owner) ui.owner.hidden = true;
    if (ui.inviteFromPending) ui.inviteFromPending.hidden = true;
    if (result.status === 403) {
      state.profiles = [];
      state.approved = false;
      state.activeProfile = null;
      clearUnlock();
      updateConnectButton();
      showProfiles();
      setStatus('This browser is waiting for approval. Approve it in the Blazing dashboard, use "I am the owner" below, or enter an invite code.', 'pending');
      // THE OWNER MUST NEVER BE LOCKED OUT. Approval is an admin action, and since
      // this gate became mandatory a pending browser cannot be used at all — so
      // without a way in from the pending screen itself, a new phone away from home
      // is simply locked out of the household's own service. An invite code is the
      // same escape hatch for a household member who is not the owner.
      if (ui.owner) ui.owner.hidden = false;
      if (ui.inviteFromPending) ui.inviteFromPending.hidden = false;
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
    state.approved = true;
    if (state.activeProfile && !state.profiles.some((profile) => profile.id === state.activeProfile.id)) {
      state.activeProfile = null;
      clearUnlock();
      updateConnectButton();
    }
    showProfiles();
    if (!state.profiles.length) {
      setStatus('This approved browser has no profiles yet. Select "Add profile" below, or add one on an approved TV.', 'info');
      return;
    }
    setStatus('Choose who is watching.', 'info');
    window.setTimeout(() => ui.profiles.querySelector('.bp-profile')?.focus(), 0);
    // Deliberately not awaited: the rail is already usable, and this is art.
    loadProfileArt();
  }

  async function connectProfiles() {
    if (state.busy) return;
    setBusy(true);
    state.pendingProfile = null;
    clearPinEntry();
    hideAllScreens();
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
    // One button, two jobs. The branch is here rather than at the listener so the
    // keyboard Enter path cannot diverge from the button.
    if (state.ownerMode) return verifyOwnerPin();
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
    closePanel();
  }

  /**
   * Show or hide the ways out, so the panel does not offer a button that will
   * refuse. Called whenever the gate state can have changed.
   */
  function syncGateChrome() {
    const held = gateRequired();
    if (ui.copy) {
      ui.copy.textContent = held
        ? 'Choose a profile to start watching.'
        : 'Connect this browser only when you want to use a shared profile.';
    }
    if (ui.close) ui.close.hidden = held;
    if (ui.keepBrowsing) ui.keepBrowsing.hidden = held;
    if (ui.layer) ui.layer.dataset.gate = held ? 'required' : 'optional';
  }

  function openPanel() {
    syncGateChrome();
    ui.layer.hidden = false;
    ui.layer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('no-scroll');
    window.setTimeout(() => ui.close.focus(), 0);
  }

  /**
   * Is the gate still holding the screen?
   *
   * Until a profile is chosen there is nobody to apply a rating cap to, and the
   * four televisions all refuse to show anything in that state. The web now
   * matches them: this returns true, and every way out of the panel — Close, the
   * backdrop, Escape, "Keep browsing" — refuses while it does.
   */
  function gateRequired() {
    return !state.activeProfile;
  }

  function closePanel() {
    if (state.busy) return;
    if (gateRequired()) {
      // Not an error, and not silent either. Saying nothing here reads as a
      // broken button.
      setStatus('Choose who is watching before you start.', 'info');
      return;
    }
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
    ui.art = element('div', 'bp-art');
    ui.art.dataset.shown = 'false';
    ui.art.setAttribute('aria-hidden', 'true');
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
    ui.kicker = kicker;
    const heading = element('h2', 'bp-heading', 'Who is watching?');
    heading.id = 'bp-heading';
    ui.heading = heading;
    // Two lines, because the panel is now two different things: a gate on first
    // load, and an ordinary profile switcher afterwards. Telling a person who
    // cannot proceed that this is optional is worse than saying nothing.
    ui.copy = element('p', 'bp-copy', 'Choose a profile to start watching.');
    const copy = ui.copy;
    ui.status = element('p', 'bp-status');
    ui.status.setAttribute('role', 'status');
    ui.status.setAttribute('aria-live', 'polite');
    ui.profiles = element('div', 'bp-profiles');

    // First-run screen: no stored device identity yet. Neither button here
    // touches the network on its own — "Request Access" hands off to the
    // existing connectProfiles() (which registers), "I Have an Invite Code"
    // just switches screens.
    ui.welcome = element('section', 'bp-welcome');
    ui.welcome.hidden = true;
    const welcomeCopy = element('p', 'bp-copy', 'New here? Request access, or enter an invite code from someone in your household.');
    ui.requestAccess = element('button', 'bp-verify', 'Request Access');
    ui.requestAccess.type = 'button';
    ui.enterCode = element('button', 'bp-secondary', 'I Have an Invite Code');
    ui.enterCode.type = 'button';
    const welcomeActions = element('div', 'bp-welcome-actions');
    welcomeActions.append(ui.requestAccess, ui.enterCode);
    ui.welcome.append(welcomeCopy, welcomeActions);

    // Invite-code redemption. Reachable from the welcome screen (no identity
    // yet) AND from the pending-approval screen (identity exists, waiting on
    // Markus) — registerDevice() inside redeemInviteCode() only runs when
    // there is no stored identity, so the pending path never re-registers.
    ui.invite = element('section', 'bp-invite');
    ui.invite.hidden = true;
    const inviteTop = element('div', 'bp-pin-top');
    ui.inviteBack = element('button', 'bp-back', 'Back');
    ui.inviteBack.type = 'button';
    inviteTop.append(ui.inviteBack, element('strong', '', 'Invite code'));
    ui.inviteInput = document.createElement('input');
    ui.inviteInput.type = 'text';
    ui.inviteInput.className = 'bp-invite-input';
    ui.inviteInput.maxLength = 6;
    ui.inviteInput.autocomplete = 'off';
    ui.inviteInput.spellcheck = false;
    ui.inviteInput.placeholder = 'ABCD23';
    ui.inviteInput.setAttribute('aria-label', 'Invite code');
    ui.inviteSubmit = element('button', 'bp-verify', 'Join');
    ui.inviteSubmit.type = 'button';
    ui.invite.append(inviteTop, ui.inviteInput, ui.inviteSubmit);

    // Profile creation. Only ever shown to an approved browser — see the
    // "+ Add profile" tile in renderProfileList(), which is the only thing
    // that opens this screen.
    ui.createProfile = element('section', 'bp-create');
    ui.createProfile.hidden = true;
    const createTop = element('div', 'bp-pin-top');
    ui.createBack = element('button', 'bp-back', 'Back');
    ui.createBack.type = 'button';
    createTop.append(ui.createBack, element('strong', '', 'New profile'));
    ui.createName = document.createElement('input');
    ui.createName.type = 'text';
    ui.createName.className = 'bp-create-input';
    ui.createName.maxLength = 40;
    ui.createName.placeholder = 'Profile name';
    ui.createName.setAttribute('aria-label', 'Profile name');
    const kidsRow = element('label', 'bp-kids-row');
    ui.createKids = document.createElement('input');
    ui.createKids.type = 'checkbox';
    kidsRow.append(ui.createKids, document.createTextNode(' Kids profile'));
    ui.createSubmit = element('button', 'bp-verify', 'Create Profile');
    ui.createSubmit.type = 'button';
    ui.createProfile.append(createTop, ui.createName, kidsRow, ui.createSubmit);

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
    // Only ever shown while this browser is pending. See applyProfileList.
    ui.owner = element('button', 'bp-secondary', 'I am the owner');
    ui.owner.type = 'button';
    ui.owner.hidden = true;
    // Only ever shown while this browser is pending. See applyProfileList.
    ui.inviteFromPending = element('button', 'bp-secondary', 'Enter Invite Code');
    ui.inviteFromPending.type = 'button';
    ui.inviteFromPending.hidden = true;
    ui.keepBrowsing = element('button', 'bp-secondary', 'Keep browsing');
    ui.keepBrowsing.type = 'button';
    const keepBrowsing = ui.keepBrowsing;
    footer.append(ui.refresh, ui.owner, ui.inviteFromPending, keepBrowsing);
    panel.append(ui.close, kicker, heading, copy, ui.status, ui.welcome, ui.invite, ui.createProfile, ui.profiles, ui.pin, footer);
    // Art FIRST, so the close-catcher and the rail both paint over it.
    ui.layer.append(ui.art, backdrop, panel);
    document.body.appendChild(ui.layer);

    ui.connect.addEventListener('click', () => {
      openPanel();
      connectProfiles();
    });
    ui.refresh.addEventListener('click', connectProfiles);
    ui.owner.addEventListener('click', () => openOwnerPin());
    ui.requestAccess.addEventListener('click', connectProfiles);
    ui.enterCode.addEventListener('click', () => showInvite());
    ui.inviteFromPending.addEventListener('click', () => showInvite());
    ui.inviteBack.addEventListener('click', () => {
      // Route back to wherever this screen was reached from: a browser that
      // already has an identity (pending or approved) belongs on the normal
      // profile screen, a true first-timer belongs back on the welcome screen.
      if (state.credentials || storedCredentials()) showProfiles();
      else showWelcome();
    });
    ui.inviteSubmit.addEventListener('click', redeemInviteCode);
    ui.inviteInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        redeemInviteCode();
      }
    });
    ui.createBack.addEventListener('click', () => showProfiles());
    ui.createSubmit.addEventListener('click', submitCreateProfile);
    ui.createName.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitCreateProfile();
      }
    });
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
        // closePanel() itself refuses while the gate holds; going through it
        // rather than around it keeps that decision in ONE place.
        closePanel();
        return;
      }
      if (!state.pendingProfile && !state.ownerMode) return;
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        addDigit(event.key);
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        deleteDigit();
      } else if (event.key === 'Enter' && state.pinDigits.length === pinLength()) {
        event.preventDefault();
        verifyPin();
      }
    });
    return true;
  }

  /**
   * THE GATE. The web used to ask "Connect profile" as an invitation and let
   * anyone browse the whole library without answering. The four televisions have
   * always asked first and refused to go on. This makes the web behave the same.
   *
   * It opens on every load, because the selection lives in this tab only — an
   * unlock is a session, not a login, and that is deliberate.
   */
  function boot() {
    if (!buildUi()) return;
    openPanel();
    // A browser that has never registered gets the welcome screen instead of
    // a silent auto-registration — "Request Access" is what creates the
    // pending device now, not a page load. A browser that already has an
    // identity (pending or approved) skips straight to it, unchanged.
    if (storedCredentials()) {
      connectProfiles();
    } else {
      showWelcome();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
