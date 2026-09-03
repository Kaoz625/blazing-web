/* Blazing web profile gate. Device credentials persist; profile unlocks do not. */
'use strict';

(() => {
  const FLEET_BASE = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  // The add-on, only ever for the login art. There are TWO progress stores and
  // they hold different halves of the same history: the televisions write to the
  // fleet (PUT /profiles/:id/progress), and THIS app writes to the add-on
  // (app.js POSTs /api/sync/progress and reads /api/sync/progress/recent for the
  // Continue Watching row). Reading only the fleet would leave a browser-only
  // household with no art at all, and reading only the add-on would ignore
  // everything watched on a TV — so loadProfileArt() asks both and keeps
  // whichever answer is newer.
  const ADDON_BASE = window.BLAZING_API_BASE || 'https://addon.lyreosai.com';
  const DEVICE_STORAGE_KEY = 'blazing-web-profile-device-v1';
  const REQUEST_TIMEOUT_MS = 15000;
  const DEVICE_VERSION = 73;
  // The OWNER pin is 7 digits; profile pins stay 4. This constant was USED in
  // two places and declared in none, and this file is 'use strict' inside an
  // IIFE — so the first reference threw ReferenceError and took the whole pad
  // with it. The pad was not rejecting a wrong length; it was not working.
  const OWNER_PIN_LENGTH = 7;
  // Pairing. 3 s is the interval the design contract names for GET /pair/status,
  // and it is the same number every TV client polls at, so a code that looks
  // dead on one screen is dead on all of them rather than dead on one.
  const PAIR_POLL_MS = 3000;
  // Minimum password length for an account. The server rejects shorter; saying
  // so here means the viewer finds out before a round trip.
  const MIN_PASSWORD = 8;

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
    // Where the owner pad was opened from: 'gate' or 'pending'. Back on the pad
    // used to call showProfiles() whatever the answer, and from the gate that
    // is an EMPTY rail — no profiles, no owner or invite hatch (those are only
    // unhidden by a 403 from /profiles), and the gate itself gone. The owner
    // was stranded on a blank screen for pressing Back.
    padFrom: '',
    pinDigits: [],
    unlockToken: null,
    unlockExpiresAt: 0,
    unlockTimer: 0,
    busy: false,
    // ── the gate ──────────────────────────────────────────────────────────
    // The live pairing request: its code, its poll timer, and whether the ONE
    // free automatic restart on expiry has already been spent. A second silent
    // restart would be a page that mints codes for ever with nobody watching.
    pairCode: '',
    pairTimer: 0,
    pairRestarted: false,
    // The same doctrine as pairRestarted, for the other silent restart: a poll
    // that finds this browser's identity stale repairs it and asks for one new
    // code. Once. A repair that does not stick must not become a page minting
    // codes on a three-second timer with nobody watching.
    pairRepaired: false,
    // An account-invite code that /accounts/invite/check said was real. Held
    // only long enough to post it back with the signup form.
    inviteCode: '',
    // The approver sheet (?pair=CODE) is offered once per page load, never on
    // a loop, and only after this browser has passed its own gate.
    approverDone: false,
    approveCode: '',
    // The approver opened with NO code — the help line sends a phone to
    // blazingstream.lyreosai.com/pair, and the site answers that with
    // /app/?pair= (an empty value). The sheet then offers a six-character box
    // for the code read aloud from the TV, and peeks once the six are in.
    approveEntry: false,
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

      /* ── THE GATE ────────────────────────────────────────────────────────
         Markus, 1 Sep 2026: the root of blazingstream must open on the same
         shape of screen movieboxpro.app shows a logged-out visitor — one
         centred column on a near-black page, a door, PRIVATE CLUB, and three
         identical pills. None of their art or their words are here: the door
         is drawn in this file, the copy is ours.

         It is the SAME panel, not a second one. data-view="gate" widens the
         420px rail to the whole viewport and centres it; every other screen
         leaves the rail exactly as it was. Building a separate full-screen
         element would have meant a second gate to keep in step with this one,
         which is the drift navparity.smoke.mjs exists to catch elsewhere. */
      .bp-layer[data-view="gate"] { background: var(--bg, #0A0A0A); }
      /* The per-profile art belongs to the rail. On the gate there is no
         profile yet, so there is nothing honest to show behind it. */
      .bp-layer[data-view="gate"] .bp-art { display: none; }
      .bp-layer[data-view="gate"] .bp-panel {
        width: 100%;
        justify-content: center;
        align-items: center;
        border-right: 0;
        padding: calc(24px + env(safe-area-inset-top, 0px)) 20px calc(28px + env(safe-area-inset-bottom, 0px));
        text-align: center;
        background: var(--bg, #0A0A0A);
      }
      .bp-layer[data-view="gate"] .bp-kicker, .bp-layer[data-view="gate"] .bp-copy { display: none; }
      /* NOT display:none. The panel is aria-labelledby="bp-heading", so the
         heading has to keep existing for a screen reader even while the gate
         draws its own title. */
      .bp-layer[data-view="gate"] .bp-heading {
        position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
        overflow: hidden; white-space: nowrap; clip-path: inset(50%);
      }
      .bp-layer[data-view="gate"] .bp-welcome, .bp-layer[data-view="gate"] .bp-invite,
      .bp-layer[data-view="gate"] .bp-qr, .bp-layer[data-view="gate"] .bp-signup,
      .bp-layer[data-view="gate"] .bp-email, .bp-layer[data-view="gate"] .bp-approve,
      .bp-layer[data-view="gate"] .bp-pin, .bp-layer[data-view="gate"] .bp-status {
        width: 100%; max-width: 360px;
      }
      /* Refresh / Keep browsing belong to the rail. The gate offers its own
         small links instead, so the footer would only be a second row of
         buttons saying the same things. */
      .bp-layer[data-view="gate"] .bp-footer { display: none; }
      .bp-qr[hidden], .bp-signup[hidden], .bp-email[hidden], .bp-approve[hidden] { display: none; }

      .bp-gate-mark { display: block; width: min(272px, 62vw); height: auto; margin: 0 auto; }
      .bp-gate-title { margin: 20px 0 0; color: #fff; font-size: clamp(23px, 5.4vw, 30px); font-weight: 900; letter-spacing: .2em; text-transform: uppercase; }
      .bp-gate-sub { margin: 10px 0 0; color: var(--muted, #a3a3aa); font-size: clamp(15px, 3.6vw, 18px); }
      .bp-gate-key { display: block; width: 46px; height: 18px; margin: 18px auto 0; }
      .bp-gate-pills { display: flex; flex-direction: column; align-items: center; gap: 13px; margin-top: 24px; }
      /* One pill shape for all three, which is the whole point of the
         reference screen: no option is dressed up as the important one. */
      .bp-pill {
        display: flex; align-items: center; gap: 14px;
        width: min(320px, 100%); min-height: 56px;
        border: 1px solid rgba(255,255,255,.12); border-radius: 999px;
        padding: 8px 22px; color: var(--text, #f7f7f8); background: transparent;
        font: inherit; text-align: left;
        transition: border-color .15s, background .15s;
      }
      .bp-pill:hover:not(:disabled), .bp-pill:focus-visible:not(:disabled) { border-color: rgba(255,61,71,.85); background: rgba(255,61,71,.12); }
      /* Visibly off, and it stays off while busy toggles around it — Google
         sign-in is not built, and a pill that looks live is a promise. */
      .bp-pill:disabled { opacity: .42; }
      .bp-pill-icon { flex: 0 0 auto; width: 22px; height: 22px; }
      .bp-pill-copy { min-width: 0; flex: 1; }
      .bp-pill-label { display: block; font-size: 13px; font-weight: 900; letter-spacing: .14em; text-transform: uppercase; }
      .bp-pill-sub { display: block; margin-top: 2px; color: var(--muted, #a3a3aa); font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: none; }
      .bp-gate-links { display: flex; flex-wrap: wrap; justify-content: center; gap: 2px; margin-top: 16px; }
      .bp-gate-link { min-height: 44px; border: 0; border-radius: 999px; padding: 8px 13px; color: var(--muted, #a3a3aa); background: transparent; font-size: 13px; font-weight: 700; text-decoration: underline; text-underline-offset: 3px; }
      .bp-gate-link:hover, .bp-gate-link:focus-visible { color: var(--text, #f7f7f8); }
      .bp-sheet-title { margin: 0 0 4px; color: #fff; font-size: 20px; font-weight: 900; letter-spacing: .04em; }
      .bp-sheet-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
      /* Big enough to read across a room and off a photograph of the screen. */
      .bp-paircode { margin: 16px 0 0; color: #fff; font-size: clamp(38px, 11vw, 56px); font-weight: 900; letter-spacing: .18em; line-height: 1.05; }
      /* White plate under the QR on purpose: a QR inverted on a near-black
         ground is unreadable to a lot of phone cameras. */
      .bp-pairqr { display: block; width: 188px; height: 188px; margin: 18px auto 0; border-radius: 14px; padding: 9px; background: #fff; }
      .bp-pairhelp { max-width: 330px; margin: 16px auto 0; color: var(--muted, #a3a3aa); font-size: 14px; line-height: 1.5; }
      .bp-input { width: 100%; min-height: 52px; margin-top: 10px; border: 1px solid rgba(255,255,255,.14); border-radius: 14px; padding: 0 14px; color: inherit; background: rgba(255,255,255,.05); font-size: 16px; font-weight: 700; }
      .bp-form-actions { display: flex; flex-direction: column; gap: 10px; margin-top: 18px; }
      /* Both set display themselves, which beats the UA's [hidden] rule. */
      .bp-pairqr[hidden], .bp-form-actions[hidden] { display: none; }
      .bp-gate-key { color: var(--muted, #a3a3aa); }
      /* The gate centres everything; an email address centred in its box
         reads as decoration rather than a field. */
      .bp-email .bp-input, .bp-signup .bp-input { text-align: left; }
      .bp-approve-question { margin: 6px 0 0; color: #fff; font-size: 18px; font-weight: 800; line-height: 1.4; }
      /* The typed pairing code: the same size and spacing the code is shown at
         on the other screen, so the two can be compared by eye. */
      .bp-approve-code { text-align: center; font-size: 26px; font-weight: 900; letter-spacing: .22em; text-transform: uppercase; }
      .bp-approve-code[hidden] { display: none; }
    `;
    document.head.appendChild(style);
  }

  function setStatus(message, type = 'info') {
    ui.status.textContent = message;
    ui.status.dataset.state = type;
  }

  /**
   * Every control the busy flag owns, by ui key. A list rather than a wall of
   * assignments because the gate roughly doubled the number of them, and the
   * old form threw a TypeError the moment one of the named controls was not
   * built — which is exactly the class of failure pinpad.smoke.mjs exists for.
   * A missing key is skipped, not thrown on.
   *
   * The Google pill is deliberately absent: it is disabled for good, and
   * setBusy(false) would switch it back on.
   */
  const BUSY_CONTROLS = [
    'connect', 'refresh', 'close', 'back',
    'pillQr', 'pillCode', 'gateEmail', 'gateOwner', 'owner', 'gateRecheck',
    // inviteFromPending fell out of this list in the gate rewrite. It sits in
    // the footer next to Refresh, so it was live during an in-flight
    // /profiles request — and the invite screen it opens was torn down under
    // the viewer the moment that request answered.
    'inviteFromPending',
    'inviteBack', 'inviteInput', 'inviteSubmit',
    'createBack', 'createName', 'createKids', 'createSubmit',
    'qrBack', 'qrRetry',
    'signupBack', 'signupName', 'signupEmail', 'signupPassword', 'signupSubmit',
    'emailBack', 'emailAddress', 'emailPassword', 'emailSubmit',
    'approveBack', 'approveInput', 'approveYes', 'approveNo',
  ];

  function setBusy(busy) {
    state.busy = busy;
    BUSY_CONTROLS.forEach((key) => {
      if (ui[key]) ui[key].disabled = busy;
    });
    // pinLength(), not a hard 4: in owner mode the pad wants seven, and the old
    // literal left Verify disabled after every setBusy(false) until renderPin()
    // happened to run again.
    if (ui.verify) ui.verify.disabled = busy || state.pinDigits.length !== pinLength();
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

  /**
   * The two stores answer in two shapes: the fleet wraps its list in
   * `progress`, the add-on returns `items` at the top level.
   */
  function progressItems(body) {
    if (!body || typeof body !== 'object') return [];
    if (body.progress && Array.isArray(body.progress.items)) return body.progress.items;
    if (Array.isArray(body.items)) return body.items;
    return [];
  }

  /**
   * Newest wins, and on a tie the earlier item wins — which is what keeps the
   * add-on's answer usable: /api/sync/progress/recent is already in recent order
   * and its items may carry no `updatedAt` at all, so every one of them scores
   * zero and the order it arrived in is the only recency there is.
   */
  function freshestArt(bodies) {
    let best = null;
    for (const body of bodies) {
      for (const item of progressItems(body)) {
        const art = httpsArt(item && (item.background || item.poster));
        if (!art) continue;
        const when = Date.parse((item && item.updatedAt) || '') || 0;
        if (!best || when > best.when) best = { art, when };
      }
    }
    return best ? best.art : '';
  }

  async function addonProgress(profileId) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${ADDON_BASE}/api/sync/progress/recent?profileId=${encodeURIComponent(profileId)}`,
        { headers: { Accept: 'application/json' }, signal: controller.signal, mode: 'cors', credentials: 'omit', cache: 'no-store' },
      );
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
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
        const [fleet, addon] = await Promise.all([
          request(
            `/profiles/${encodeURIComponent(profile.id)}/progress?deviceId=${encodeURIComponent(credentials.id)}`,
            { headers: { 'X-Device-Token': credentials.token } },
          ),
          addonProgress(profile.id),
        ]);
        profile.artUrl = freshestArt([fleet.ok ? fleet.body : null, addon]);
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
    // "Choose another profile" is a lie on the owner pad: from the gate there
    // are no profiles to choose from yet, and Back goes to the gate.
    ui.back.textContent = state.ownerMode ? 'Back' : 'Choose another profile';
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
    setPanelView('');
    ui.pin.hidden = false;
    setStatus('Enter four digits, then select Verify. A failed check uses one server attempt.', 'info');
    window.setTimeout(() => ui.digitButtons[0]?.focus(), 0);
  }

  /**
   * Ask for the owner PIN so this browser can approve itself.
   *
   * Reachable from the pending screen and, through openOwnerPinFromGate(), from
   * the gate. The server does the deciding — this only collects the digits and
   * posts them — and it needs this browser's device token, so the PIN alone is
   * not enough from somewhere else.
   *
   * `from` ('gate' | 'pending') is where Back and a refused fleet go afterwards.
   */
  function openOwnerPin(from = 'pending') {
    if (state.busy) return;
    if (!state.credentials) {
      setStatus('This browser has no connection to approve yet. Select Refresh profiles first.', 'error');
      return;
    }
    state.pendingProfile = null;
    state.ownerMode = true;
    state.padFrom = from;
    clearPinEntry();
    hideAllScreens();
    ui.owner.hidden = true;
    ui.pin.hidden = false;
    setStatus('Enter the seven-digit owner PIN to approve this browser. Attempts are limited.', 'info');
    window.setTimeout(() => ui.digitButtons[0]?.focus(), 0);
  }

  /**
   * "I am the owner" on the GATE. openOwnerPin() refuses without a device
   * token, because the PIN is posted WITH that token — and a first-visit
   * browser has none yet. So this mints the identity first, then opens the
   * pad. It is the one gate control that registers before it shows anything,
   * and only because the pad it opens is useless without the identity.
   *
   * The panel stays in gate view on purpose: the gate CSS already lays
   * `.bp-pin` out as a centred column, and the owner is still at the gate.
   */
  async function openOwnerPinFromGate() {
    if (state.busy) return;
    setBusy(true);
    setStatus('Preparing this browser…', 'info');
    let credentials = null;
    try {
      credentials = await ensureDevice();
    } finally {
      setBusy(false);
    }
    // registerDevice() already put the reason in the status line.
    if (!credentials) return;
    openOwnerPin('gate');
  }

  /**
   * Leave the owner pad for the screen it was opened from. From the gate that
   * is the gate — showProfiles() there is an empty rail with the door shut
   * behind it (see state.padFrom). From the pending screen it is the rail,
   * where Refresh profiles brings the hatches back.
   */
  function leaveOwnerPad(message, type = 'info') {
    const from = state.padFrom;
    state.ownerMode = false;
    state.padFrom = '';
    clearPinEntry();
    if (from === 'gate') {
      showGate(message, type);
      return;
    }
    showProfiles();
    if (message) setStatus(message, type);
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
        leaveOwnerPad('Owner approval is not switched on for this fleet. Approve this browser in the Blazing dashboard instead.', 'error');
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
      state.padFrom = '';
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
    setPanelView('');
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
    // Leaving this screen stops the pairing poll. Without it, walking back to
    // the gate from the QR screen left a timer asking /pair/status every three
    // seconds for the rest of the session, and a late 'approved' would have
    // yanked whoever was reading the screen into the profile rail.
    stopPairPolling();
    ui.welcome.hidden = true;
    ui.invite.hidden = true;
    ui.createProfile.hidden = true;
    ui.pin.hidden = true;
    ui.profiles.hidden = true;
    if (ui.qr) ui.qr.hidden = true;
    if (ui.signup) ui.signup.hidden = true;
    if (ui.email) ui.email.hidden = true;
    if (ui.approve) ui.approve.hidden = true;
  }

  /**
   * The panel is one element wearing two shapes. '' is the 420px profile rail
   * it has always been; 'gate' is the full-viewport centred column. See the
   * data-view block in addStyle().
   */
  function setPanelView(view) {
    if (ui.layer) ui.layer.dataset.view = view;
  }

  /**
   * THE GATE — the first screen anyone sees, and the screen a browser that is
   * not paired keeps seeing.
   *
   * Nothing is registered by showing it. A device record is minted only when a
   * viewer actually picks a way in (Scan QR, Type code, Sign in, I am the
   * owner), so a visitor who closes the tab here leaves nothing behind on the
   * dashboard. That rule is pinned by pinpad.smoke.mjs.
   *
   * `.bp-welcome` is still on the section on purpose: it is the same first-run
   * screen, wearing the new shape, and the existing hide rule and the existing
   * smoke test both address it by that name.
   */
  function showGate(message, type = 'info') {
    hideAllScreens();
    setPanelView('gate');
    ui.welcome.hidden = false;
    ui.kicker.textContent = 'Get Access';
    ui.heading.textContent = 'Private club';
    // Offered only once this browser has an identity to re-check. On a first
    // visit there is nothing to check again, and a button that can only say
    // "nothing happened" is worse than no button.
    if (ui.gateRecheck) ui.gateRecheck.hidden = !(state.credentials || storedCredentials());
    setStatus(message || 'Choose how you want to get in.', type);
  }

  // Kept as a name because four call sites and one smoke test know it. The
  // gate IS the welcome screen now.
  const showWelcome = showGate;

  function showInvite() {
    // Every other "show X" that a button reaches checks this. Without it a
    // click that slipped through while /profiles was in flight opened the
    // invite box, and applyProfileList() tore it down a moment later.
    if (state.busy) return;
    hideAllScreens();
    setPanelView('gate');
    ui.invite.hidden = false;
    ui.kicker.textContent = 'Invite Code';
    ui.heading.textContent = 'Enter your code';
    ui.inviteInput.value = '';
    setStatus('Type the code you were given.', 'info');
    window.setTimeout(() => ui.inviteInput.focus(), 0);
  }

  /**
   * A device identity, made only when one is actually needed. Every gate flow
   * except "type an invite code with an existing identity" needs a deviceId and
   * a token before it can ask the fleet anything.
   */
  async function ensureDevice() {
    const existing = state.credentials || storedCredentials();
    if (existing) {
      state.credentials = existing;
      return existing;
    }
    const created = await registerDevice();
    if (created) state.credentials = created;
    return created;
  }

  // ── SCAN QR TO LOGIN ───────────────────────────────────────────────────────
  // This browser is the NEW device. It shows a short code and the QR of the
  // same code, then asks the fleet every three seconds whether somebody has
  // approved it from a screen that is already signed in.

  function stopPairPolling() {
    if (state.pairTimer) {
      window.clearInterval(state.pairTimer);
      state.pairTimer = 0;
    }
  }

  function showQr(message, type = 'info') {
    hideAllScreens();
    setPanelView('gate');
    ui.qr.hidden = false;
    ui.kicker.textContent = 'Scan QR';
    ui.heading.textContent = 'Pair this browser';
    // Start empty. Re-entering this sheet used to show the PREVIOUS code and
    // QR while the new one was fetched — measured in a browser: AAA111 stayed
    // on screen until BBB222 arrived — and a phone that scanned in that window
    // scanned a code the fleet had already retired. state.pairCode goes too:
    // startPairing() starts the poll on it, so a stale one would have polled
    // for a code this sheet no longer shows.
    state.pairCode = '';
    ui.pairCode.hidden = true;
    ui.pairCode.textContent = '';
    ui.pairImage.hidden = true;
    ui.pairImage.removeAttribute('src');
    ui.pairHelp.hidden = true;
    ui.qrRetry.hidden = true;
    setStatus(message || 'Getting a code…', type);
  }

  function renderPairCode(code) {
    state.pairCode = code;
    ui.pairCode.textContent = code;
    ui.pairCode.hidden = false;
    // The fleet renders the QR, so the app carries no QR library and the image
    // a phone photographs is the same one every TV client shows.
    ui.pairImage.src = `${FLEET_BASE}/pair/qr/${encodeURIComponent(code)}.png`;
    ui.pairImage.hidden = false;
    ui.pairHelp.hidden = false;
    ui.qrRetry.hidden = true;
  }

  function showPairRetry(message) {
    stopPairPolling();
    ui.pairCode.hidden = true;
    ui.pairImage.hidden = true;
    ui.pairHelp.hidden = true;
    ui.qrRetry.hidden = false;
    // A sentence and a button, never a spinner that spins for ever. A pairing
    // screen with nothing on it reads as a broken app rather than a bad minute
    // of network.
    setStatus(message, 'error');
  }

  /**
   * The OLD SERVER — a fleet that genuinely does not serve /pair/*. A proxy or
   * an older build can also say 405 or 501. None of those is "the code could
   * not be had, try again", because a retry asks the same absent route; it
   * means this browser is a plain pending device and the pending screen is the
   * honest answer.
   *
   * TWO CORRECTIONS, 2026-09-03. The comment here used to say the routes were
   * undeployed and answered 404 "today". All five went live and answer.
   *
   * And this used to be `status === 404 || 405 || 501`, which is wrong, because
   * the fleet has TWO different 404s that mean opposite things:
   *
   *   {"error":"unknown device; register first"}  the route RAN — our identity is stale
   *   {"error":"not found","path":"..."}          the route does not exist
   *
   * Reading only the status meant a browser the fleet had forgotten was parked
   * on the pending wall for ever, on a fleet that pairs perfectly, with the
   * blame pointed at the server — while the fix (repairCredentials, right
   * there in this file) was never reached. Same bug as Roku PartyApi.brs
   * (4770fc8), the Roku heartbeat (b0e4d2f) and Fire TV (ab87abb).
   *
   * shouldRepairCredentials() is the other half of this test and the callers
   * check it first, so the two never both claim the same answer.
   */
  function oldServer(result) {
    if (result.status === 405 || result.status === 501) return true;
    if (result.status !== 404) return false;
    return !text(result.body && result.body.error).toLowerCase().startsWith('unknown device');
  }

  async function startPairing() {
    if (state.busy) return;
    showQr();
    setBusy(true);
    let credentials = null;
    try {
      credentials = await ensureDevice();
      if (!credentials) {
        // registerDevice() already said why in the status line.
        showPairRetry(ui.status.textContent || 'Could not reach the profile server.');
        return;
      }
      const askForCode = (creds) => request('/pair/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': creds.token },
        body: JSON.stringify({ deviceId: creds.id }),
      });
      let result = await askForCode(credentials);
      // The fleet says it does not know this browser. That is a stale identity,
      // not an old server — and repairCredentials RECLAIMS it (id + token) before
      // it will clear anything, so an approved browser stays approved. Exactly
      // the shape createProfile() already uses below.
      if (shouldRepairCredentials(result)) {
        const repaired = await repairCredentials(credentials);
        if (!repaired) {
          // repairCredentials() already said why in the status line.
          if (!state.credentials) showGate(ui.status.textContent, 'error');
          else showPairRetry(ui.status.textContent || 'Could not get a pairing code.');
          return;
        }
        credentials = repaired;
        result = await askForCode(repaired);
      }
      if (oldServer(result)) {
        // No QR, no code, no poll: the screen the old fleet can actually act
        // on, with "I am the owner" and the invite code as the ways forward.
        showPendingApproval(credentials);
        return;
      }
      if (!result.ok) {
        showPairRetry(result.status === 429
          ? 'Too many codes were asked for. Wait a few minutes, then try again.'
          : serverError(result, result.timeout
            ? 'The profile server did not answer in time.'
            : 'Could not get a pairing code.'));
        return;
      }
      const code = text(result.body && result.body.code).toUpperCase();
      if (!code) {
        showPairRetry('The profile server did not return a pairing code.');
        return;
      }
      renderPairCode(code);
      setStatus('Waiting for approval…', 'pending');
    } finally {
      setBusy(false);
    }
    if (credentials && state.pairCode) {
      state.pairTimer = window.setInterval(() => pollPairStatus(credentials), PAIR_POLL_MS);
    }
  }

  async function pollPairStatus(credentials) {
    if (state.busy || !state.pairTimer) return;
    const result = await request(
      `/pair/status?deviceId=${encodeURIComponent(credentials.id)}`,
      { headers: { 'X-Device-Token': credentials.token } },
    );
    // A poll that lands after the viewer walked away is answering a question
    // nobody asked any more.
    if (!state.pairTimer) return;
    // Checked BEFORE oldServer(), because an 'unknown device' 404 is a stale
    // identity and the pending wall would be a dead end for it. Restart the
    // whole flow rather than repairing in place: this poll runs on an interval
    // holding the OLD credentials in its closure, so a repaired identity would
    // never reach it. startPairing() re-registers and asks for a fresh code.
    if (shouldRepairCredentials(result)) {
      stopPairPolling();
      if (state.pairRepaired) {
        showPairRetry('This browser connection went stale again. Select Try again when you are ready.');
        return;
      }
      state.pairRepaired = true;
      setStatus('This browser connection went stale. Reconnecting…', 'info');
      startPairing();
      return;
    }
    if (oldServer(result)) {
      // /pair/start answered but /pair/status does not: a fleet mid-deploy, or
      // a proxy that knows one route and not the other. Same answer as above.
      stopPairPolling();
      showPendingApproval(credentials);
      return;
    }
    if (!result.ok) {
      showPairRetry(result.timeout || result.status === 0
        ? 'The profile server stopped answering. Check the connection.'
        : serverError(result, 'The profile server refused the pairing check.'));
      return;
    }
    const pairState = text(result.body && result.body.state).toLowerCase();
    if (pairState === 'approved') {
      stopPairPolling();
      setStatus('This browser is approved. Loading profiles…', 'info');
      // connectProfiles() is what puts the normal profile rail up, and picking
      // a profile there is what fires blazing-profile-selected — the ONE event
      // app.js listens for to leave BrightMinds safe mode. Skipping it would
      // leave a paired browser looking at the kids catalogue.
      await connectProfiles();
      return;
    }
    if (pairState === 'expired') {
      stopPairPolling();
      if (!state.pairRestarted) {
        state.pairRestarted = true;
        setStatus('That code expired. Here is a new one.', 'pending');
        await startPairing();
        return;
      }
      showPairRetry('That code expired again. Select Try again when you are ready.');
    }
  }

  // ── HAVE AN EMAIL LOGIN? SIGN IN ───────────────────────────────────────────

  function showEmail() {
    hideAllScreens();
    setPanelView('gate');
    ui.email.hidden = false;
    ui.kicker.textContent = 'Sign In';
    ui.heading.textContent = 'Sign in';
    ui.emailPassword.value = '';
    setStatus('Sign in with the email and password on your account.', 'info');
    window.setTimeout(() => ui.emailAddress.focus(), 0);
  }

  /**
   * The three refusals the contract names, each in its own sentence. A single
   * "login failed" sends a suspended account hunting for a typo.
   */
  function accountErrorMessage(result, fallback) {
    if (result.status === 401) return 'That email or password is not right.';
    if (result.status === 429) return 'Too many tries. Wait a few minutes.';
    if (result.status === 403) {
      const detail = text(result.body && result.body.error).toLowerCase();
      if (detail === 'account suspended') return 'This account is suspended. Ask the owner.';
      if (detail === 'account pending approval') return 'This account is waiting for the owner to approve it.';
      return 'This account cannot sign in yet. Ask the owner.';
    }
    return serverError(result, result.timeout
      ? 'The profile server did not answer in time. Try again.'
      : fallback);
  }

  async function submitEmailLogin() {
    if (state.busy) return;
    const email = (ui.emailAddress.value || '').trim().toLowerCase();
    const password = ui.emailPassword.value || '';
    if (!email || !password) {
      setStatus('Enter both the email address and the password.', 'error');
      return;
    }
    setBusy(true);
    setStatus('Signing in…', 'info');
    try {
      const credentials = await ensureDevice();
      if (!credentials) return;
      const result = await request('/accounts/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, deviceId: credentials.id }),
      });
      if (!result.ok) {
        setStatus(accountErrorMessage(result, 'Could not sign in.'), 'error');
        return;
      }
      ui.emailPassword.value = '';
      setStatus('Signed in. Loading profiles…', 'info');
      setBusy(false);
      await connectProfiles();
    } finally {
      setBusy(false);
    }
  }

  // ── TYPE CODE → an ACCOUNT invite → sign up ────────────────────────────────

  function showSignup(name) {
    hideAllScreens();
    setPanelView('gate');
    ui.signup.hidden = false;
    ui.kicker.textContent = 'New Account';
    ui.heading.textContent = 'Make your account';
    ui.signupName.value = name || '';
    ui.signupPassword.value = '';
    setStatus('That code opens a new account. Fill this in and you are in.', 'info');
    window.setTimeout(() => ui.signupName.focus(), 0);
  }

  async function submitSignup() {
    if (state.busy) return;
    const name = (ui.signupName.value || '').trim();
    const email = (ui.signupEmail.value || '').trim().toLowerCase();
    const password = ui.signupPassword.value || '';
    if (!name) {
      setStatus('Enter a name for the account.', 'error');
      return;
    }
    if (!email) {
      setStatus('Enter an email address.', 'error');
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setStatus(`Use at least ${MIN_PASSWORD} characters for the password.`, 'error');
      return;
    }
    setBusy(true);
    setStatus('Making the account…', 'info');
    try {
      const credentials = await ensureDevice();
      if (!credentials) return;
      const result = await request('/accounts/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: state.inviteCode, email, password, name, deviceId: credentials.id }),
      });
      if (!result.ok) {
        if (result.status === 409) {
          setStatus('That email already has an account. Sign in instead.', 'error');
        } else if (result.status === 410) {
          setStatus('That code has expired. Ask for a new one.', 'error');
        } else if (result.status === 404) {
          setStatus('That code was not recognized. Check it and try again.', 'error');
        } else {
          setStatus(accountErrorMessage(result, 'Could not make that account.'), 'error');
        }
        return;
      }
      ui.signupPassword.value = '';
      state.inviteCode = '';
      setStatus('Account made. Loading profiles…', 'info');
      setBusy(false);
      await connectProfiles();
    } finally {
      setBusy(false);
    }
  }

  // ── APPROVER MODE (?pair=CODE, opened from the QR on another screen) ───────

  // A pairing code is six of A-Z and 2-9 — the alphabet the fleet mints from,
  // with the four characters a code read aloud gets wrong (0/O, 1/I) left out.
  const PAIR_CODE_LENGTH = 6;
  const PAIR_CODE_CHARS = /[^A-Z2-9]/g;
  const PAIR_PATH = /^\/pair\/([A-Z2-9]{6})$/i;

  function normalizePairCode(value) {
    return String(value || '').toUpperCase().replace(PAIR_CODE_CHARS, '').slice(0, PAIR_CODE_LENGTH);
  }

  /**
   * Was this page opened to approve a device, and with which code?
   *
   * Two spellings. The QR encodes blazingstream.lyreosai.com/pair/<CODE>, and
   * the help line under it sends a phone to blazingstream.lyreosai.com/pair to
   * type the code — the site turns both into /app/?pair=<CODE> and /app/?pair=
   * (an EMPTY value). The approver used to read only a non-empty ?pair=, so
   * the address the help line promises opened the app and asked nothing. Now
   * `present` with no `code` opens the sheet with a box for the six characters.
   * The bare /pair/<CODE> path is read too, belt and braces, in case a rewrite
   * ever hands the app the path instead of the query.
   */
  function pairParam() {
    try {
      const url = new URL(window.location.href);
      const fromPath = PAIR_PATH.exec(url.pathname);
      if (fromPath) return { present: true, code: fromPath[1].toUpperCase() };
      if (!url.searchParams.has('pair')) return { present: false, code: '' };
      return { present: true, code: normalizePairCode(url.searchParams.get('pair')) };
    } catch {
      return { present: false, code: '' };
    }
  }

  /**
   * Take ?pair= off the address bar so a refresh, a bookmark or a shared link
   * does not ask the same question again — the code is single use and the
   * second ask can only fail.
   */
  function clearPairParam() {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('pair')) return;
      url.searchParams.delete('pair');
      window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
    } catch {
      // An address bar we cannot rewrite is not worth failing the approval for.
    }
  }

  /**
   * The approver sheet. With a code in hand it says "Checking…" and waits for
   * the peek; opened to TYPE one (`entry`) it shows the six-character box and
   * nothing else until the six are in.
   */
  function showApprove(entry = false) {
    hideAllScreens();
    setPanelView('gate');
    ui.approve.hidden = false;
    ui.kicker.textContent = 'Approve Device';
    ui.heading.textContent = 'Approve a device';
    ui.approveActions.hidden = true;
    ui.approveQuestion.textContent = '';
    ui.approveInput.hidden = !entry;
    if (entry) {
      ui.approveInput.value = '';
      setStatus('Type the six-character code shown on the other screen.', 'info');
      window.setTimeout(() => ui.approveInput.focus(), 0);
      return;
    }
    setStatus('Checking that code…', 'info');
  }

  /**
   * The approver half of the QR flow. It runs only AFTER this browser has come
   * through the gate and a profile has actually been picked — approving a
   * device is an account action, and until a profile is chosen there is nobody
   * here to take it.
   */
  async function maybeShowApprover() {
    if (state.approverDone) return;
    const param = pairParam();
    if (!param.present || !state.activeProfile || !state.credentials) return;
    state.approverDone = true;
    openPanel();
    if (!param.code) {
      state.approveEntry = true;
      showApprove(true);
      return;
    }
    state.approveEntry = false;
    showApprove();
    await peekPairCode(param.code);
  }

  /**
   * Ask the fleet which device is behind a code, and put the question up.
   *
   * `deviceId` goes with the code: the contract makes it required (400 'need
   * deviceId') because the approver has to be a bound, active device itself.
   * This call sent only ?code= — so against the real route the sheet could
   * never reach Approve. /pair/status and /pair/approve already sent it.
   */
  async function peekPairCode(code) {
    if (state.busy || !state.credentials) return;
    state.approveCode = code;
    // Busy for the round trip: the box is in BUSY_CONTROLS, so a seventh
    // keystroke cannot start a second peek under the first.
    setBusy(true);
    let result;
    try {
      result = await request(
        `/pair/peek?code=${encodeURIComponent(code)}&deviceId=${encodeURIComponent(state.credentials.id)}`,
        { headers: { 'X-Device-Token': state.credentials.token } },
      );
    } finally {
      setBusy(false);
    }
    // A dead code typed by hand is a typo until proven otherwise: keep the box
    // and let the viewer fix it. A dead code from a link is dead — drop it so a
    // refresh does not ask again.
    const dead = (message) => {
      state.approveCode = '';
      setStatus(message, 'error');
      if (state.approveEntry) {
        ui.approveInput.value = '';
        window.setTimeout(() => ui.approveInput.focus(), 0);
        return;
      }
      clearPairParam();
    };
    if (result.status === 404) {
      dead('No device is waiting on that code.');
      return;
    }
    if (result.status === 410) {
      dead('That code expired. Ask the other screen for a new one.');
      return;
    }
    if (!result.ok) {
      state.approveCode = '';
      setStatus(serverError(result, result.timeout
        ? 'The profile server did not answer in time. Try the link again.'
        : 'Could not check that pairing code.'), 'error');
      return;
    }
    const model = text(result.body && (result.body.model || result.body.label), 'that device');
    ui.approveInput.hidden = true;
    ui.approveQuestion.textContent = `Approve ${model} as a device on your account?`;
    ui.approveActions.hidden = false;
    setStatus('Only approve a screen you can see right now.', 'info');
    window.setTimeout(() => ui.approveYes.focus(), 0);
  }

  /**
   * The typed code. Upper-cased and filtered to the code alphabet as it is
   * typed — a phone keyboard offers lower case and the viewer should not have
   * to fight it — and peeked the moment the sixth character lands, so there is
   * no button to find. Enter does the same for a keyboard.
   */
  function onApproveInput() {
    const code = normalizePairCode(ui.approveInput.value);
    if (ui.approveInput.value !== code) ui.approveInput.value = code;
    if (code.length === PAIR_CODE_LENGTH) submitApproveCode();
  }

  function submitApproveCode() {
    if (state.busy || !state.approveEntry) return;
    const code = normalizePairCode(ui.approveInput.value);
    if (code.length !== PAIR_CODE_LENGTH) {
      setStatus(`The code is ${PAIR_CODE_LENGTH} characters.`, 'error');
      return;
    }
    setStatus('Checking that code…', 'info');
    peekPairCode(code);
  }

  async function approvePairedDevice() {
    if (state.busy || !state.approveCode || !state.credentials) return;
    setBusy(true);
    setStatus('Approving…', 'info');
    try {
      const result = await request('/pair/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': state.credentials.token },
        body: JSON.stringify({ code: state.approveCode, deviceId: state.credentials.id }),
      });
      if (!result.ok) {
        if (result.status === 404) setStatus('No device is waiting on that code.', 'error');
        else if (result.status === 410) setStatus('That code expired before it was approved.', 'error');
        else setStatus(serverError(result, 'Could not approve that device.'), 'error');
        return;
      }
      ui.approveActions.hidden = true;
      ui.approveQuestion.textContent = 'That device is now on your account.';
      setStatus('That device is now on your account.', 'info');
      state.approveCode = '';
      state.approveEntry = false;
      clearPairParam();
    } finally {
      setBusy(false);
    }
  }

  function dismissApprover() {
    state.approveCode = '';
    state.approveEntry = false;
    clearPairParam();
    // Nothing was approved and this browser is already through its own gate, so
    // the honest next screen is the app it was using.
    if (state.activeProfile) {
      ui.approve.hidden = true;
      setPanelView('');
      ui.profiles.hidden = false;
      closePanel();
      return;
    }
    showGate();
  }

  function showCreateProfile() {
    hideAllScreens();
    setPanelView('');
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
          // Not a household invite. The same six characters may be an ACCOUNT
          // invite from the owner — the kind that opens a NEW account rather
          // than joining an existing one — and the viewer was never told which
          // kind they were handed. Ask before calling it unknown.
          const invite = await request(`/accounts/invite/check?code=${encodeURIComponent(code)}`);
          if (invite.ok && invite.body && invite.body.valid === true) {
            state.inviteCode = code;
            showSignup(text(invite.body.name));
            return;
          }
          if (invite.status === 410) {
            setStatus('That code has expired or has already been used. Ask for a new one.', 'error');
            return;
          }
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
      const create = (credentials) => request(`/profiles?deviceId=${encodeURIComponent(credentials.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': credentials.token },
        body: JSON.stringify({ name, isKids: !!ui.createKids.checked }),
      });
      let result = await create(state.credentials);
      if (shouldRepairCredentials(result)) {
        const repaired = await repairCredentials(state.credentials);
        if (!repaired) {
          // repairCredentials() said why. A browser left with no identity at
          // all belongs at the gate; one that kept its identity stays here.
          if (!state.credentials) showGate(ui.status.textContent, 'error');
          return;
        }
        // A repaired identity that turned out to be a NEW one is pending, and
        // the retry's 403 below puts the pending screen up.
        result = await create(repaired);
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
    // AFTER closePanel(), not after the dispatch: the approver sheet reopens
    // the panel, and closePanel() would have shut it again a line later.
    maybeShowApprover();
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

  /**
   * POST /agent/register. With `existing` credentials it is a RECLAIM: the
   * stored deviceId goes in the body and the stored token in X-Device-Token,
   * which is how every TV client re-registers (tvOS 7142fd5 is the shape). The
   * fleet answers a reclaim with the SAME deviceId and NO deviceToken — it
   * never re-issues a token it has already handed out — so the old token is
   * kept. Without the pair, the fleet mints a fresh pending identity.
   */
  async function postRegister(existing) {
    const body = {
      model: 'Blazing Web',
      fireOs: 'web',
      abi: 'web',
      appVersions: { web: DEVICE_VERSION },
      label: 'Blazing Web',
    };
    const headers = { 'Content-Type': 'application/json' };
    if (existing) {
      body.deviceId = existing.id;
      headers['X-Device-Token'] = existing.token;
    }
    return request('/agent/register', { method: 'POST', headers, body: JSON.stringify(body) });
  }

  /** The identity a 2xx register answer amounts to, or null when it has none. */
  function credentialsFrom(result, existing) {
    const id = text(result.body && result.body.deviceId);
    let token = text(result.body && result.body.deviceToken);
    // A reclaim: same id back, no token in the body. The one we sent still stands.
    if (!token && existing && id === existing.id) token = existing.token;
    return id && token ? { id, token } : null;
  }

  function registerFailed(result) {
    if (result.status === 429) {
      setStatus('Profile registration is temporarily limited. Wait, then select Connect profile again.', 'error');
      return;
    }
    setStatus(serverError(result, result.timeout
      ? 'The profile server did not answer in time. Try again.'
      : 'Could not register this browser with the profile server.'), 'error');
  }

  function keepCredentials(credentials) {
    if (!saveCredentials(credentials)) {
      setStatus('Browser storage is blocked. This browser cannot keep its profile connection.', 'error');
      return null;
    }
    state.credentials = credentials;
    return credentials;
  }

  async function registerDevice(existing = null) {
    const result = await postRegister(existing);
    if (!result.ok) {
      registerFailed(result);
      return null;
    }
    const credentials = credentialsFrom(result, existing);
    if (!credentials) {
      setStatus('The profile server did not return a browser connection. Nothing was selected.', 'error');
      return null;
    }
    return keepCredentials(credentials);
  }

  /**
   * A 401, or a 404 'unknown device', on a device route. Three call sites used
   * to answer that by clearing the stored identity and registering a brand-new
   * one. That is how tvOS minted 21 pending "Apple TV" phantoms in one
   * afternoon (7142fd5): the fleet had only lost the record, or a proxy had
   * dropped the header, and the APPROVED identity was thrown away for it —
   * orphaned on the dashboard, and the viewer sent back to wait for approval
   * they already had.
   *
   * So: reclaim first, with the id and token this browser holds. A 2xx that
   * echoes the id keeps the identity (a fresh id with a token is the fleet
   * saying it has already replaced the lost record, and that is kept too).
   * Only a refusal — the fleet itself saying 401 or 'unknown device' to the
   * reclaim — clears anything. A timeout, a 429, a 5xx keep the identity and
   * say so; a bad minute of network must not cost an approval.
   */
  async function repairCredentials(existing) {
    setStatus('Checking this browser connection…', 'info');
    const reclaim = await postRegister(existing);
    if (reclaim.ok) {
      const credentials = credentialsFrom(reclaim, existing);
      if (credentials) return keepCredentials(credentials);
      setStatus('The profile server did not return a browser connection. Try again.', 'error');
      return null;
    }
    if (!shouldRepairCredentials(reclaim)) {
      registerFailed(reclaim);
      return null;
    }
    clearStoredCredentials();
    state.credentials = null;
    setStatus('This browser connection is no longer valid. Registering a new browser connection…', 'info');
    return registerDevice();
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

  /**
   * The pending screen: this browser has an identity, and the fleet has not
   * bound it to an account. Reached by a 403 from /profiles, and by the OLD
   * fleet answering 404 to /pair/start (see oldServer()).
   *
   * The first eight characters of the deviceId are in the sentence because
   * every browser registers as "Blazing Web": without them the owner cannot
   * tell this one from the others on the dashboard. The televisions show the
   * same eight.
   */
  function showPendingApproval(credentials) {
    state.profiles = [];
    state.approved = false;
    state.activeProfile = null;
    clearUnlock();
    updateConnectButton();
    showProfiles();
    const id = text(credentials && credentials.id).slice(0, 8);
    setStatus(`This browser is waiting for approval${id ? ` (device ${id})` : ''}. Approve it in the Blazing dashboard, use "I am the owner" below, or enter an invite code.`, 'pending');
    // THE OWNER MUST NEVER BE LOCKED OUT. Approval is an admin action, and since
    // this gate became mandatory a pending browser cannot be used at all — so
    // without a way in from the pending screen itself, a new phone away from home
    // is simply locked out of the household's own service. An invite code is the
    // same escape hatch for a household member who is not the owner.
    if (ui.owner) ui.owner.hidden = false;
    if (ui.inviteFromPending) ui.inviteFromPending.hidden = false;
  }

  function applyProfileList(result) {
    if (ui.owner) ui.owner.hidden = true;
    if (ui.inviteFromPending) ui.inviteFromPending.hidden = true;
    if (result.status === 403) {
      showPendingApproval(state.credentials);
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
        credentials = await repairCredentials(credentials);
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
      clearUnlock();
      setBusy(true);
      try {
        const repaired = await repairCredentials(state.credentials);
        if (!repaired) {
          showProfiles();
          return;
        }
        // The PIN digits are gone (cleared before the request, on purpose), so
        // the viewer picks the profile again — from a list this identity can
        // actually see, which is the pending screen if the repair minted a new one.
        applyProfileList(await listProfiles(repaired));
        if (state.approved) setStatus('This browser connection was repaired. Choose the profile again.', 'info');
      } finally {
        setBusy(false);
        renderPin();
        renderProfileList();
      }
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
    maybeShowApprover();
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

  // ── THE GATE'S ART. Drawn here, not fetched: no image request that can
  // fail on a bad connection, and nothing borrowed — the door, the flame and
  // the key are this file's own lines. #FF3D47 is the accent every Blazing
  // client uses; #0A0A0B is the page.
  const DOOR_MARK = `
    <svg class="bp-gate-mark" viewBox="0 0 272 200">
      <rect width="272" height="200" rx="28" fill="#0A0A0B"/>
      <path d="M84 178V96a52 52 0 0 1 104 0v82" fill="none" stroke="#FF3D47" stroke-width="10" stroke-linecap="round"/>
      <path d="M60 178h152" fill="none" stroke="#FF3D47" stroke-width="6" stroke-linecap="round" opacity=".55"/>
      <path d="M136 152c-22 0-34-15-30-33 3-12 12-18 12-32 8 8 12 16 12 24 5-10 3-22 10-38 5 18 22 28 26 48 4 20-8 31-30 31z" fill="#FF3D47"/>
      <path d="M136 150c-11 0-17-9-14-19 2-7 9-11 8-20 8 7 14 15 14 24 0 8-3 15-8 15z" fill="#FFB36B"/>
    </svg>`;
  const KEY_GLYPH = `
    <svg class="bp-gate-key" viewBox="0 0 46 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <circle cx="8" cy="9" r="6"/>
      <path d="M14 9h30M36 9v5M42 9v4"/>
    </svg>`;
  const ICON_GOOGLE = `
    <svg class="bp-pill-icon" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M19 11a8 8 0 1 1-2.4-5.7M11 11h8"/>
    </svg>`;
  const ICON_QR = `
    <svg class="bp-pill-icon" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="6" height="6" rx="1"/><rect x="13" y="3" width="6" height="6" rx="1"/><rect x="3" y="13" width="6" height="6" rx="1"/>
      <path d="M13 13h2v2h-2zM17 13h2M13 17h2M17 17h2v2"/>
    </svg>`;
  const ICON_CODE = `
    <svg class="bp-pill-icon" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="6" width="18" height="11" rx="2"/>
      <path d="M6 10h1M10 10h1M14 10h1M7 13.5h8"/>
    </svg>`;

  /** Inline SVG from markup. Decorative, always — the words sit next to it. */
  function svg(markup) {
    const template = document.createElement('template');
    template.innerHTML = markup.trim();
    const node = template.content.firstElementChild;
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('focusable', 'false');
    return node;
  }

  /**
   * Every gate control gets an id starting `bp-`, because gate.smoke.mjs
   * drives the screen by id rather than by label text — labels are copy, and
   * copy changes.
   */
  function button(className, label, id) {
    const node = element('button', className, label);
    node.type = 'button';
    node.id = id;
    return node;
  }

  /** One pill shape for all three ways in; see the .bp-pill comment in addStyle(). */
  function pill(id, icon, label, sub) {
    const node = button('bp-pill', undefined, id);
    const copy = element('span', 'bp-pill-copy');
    copy.append(element('span', 'bp-pill-label', label), element('span', 'bp-pill-sub', sub));
    node.append(svg(icon), copy);
    return node;
  }

  function input(id, type, label, autocomplete) {
    const node = document.createElement('input');
    node.type = type;
    node.id = id;
    node.className = 'bp-input';
    node.autocomplete = autocomplete;
    node.placeholder = label;
    node.spellcheck = false;
    node.setAttribute('aria-label', label);
    return node;
  }

  /** Back button + title, the top row of every gate sheet. */
  function sheetTop(backKey, backId, title) {
    const top = element('div', 'bp-sheet-top');
    ui[backKey] = button('bp-back', 'Back', backId);
    top.append(ui[backKey], element('strong', 'bp-sheet-title', title));
    return top;
  }

  /** Enter in a text field does what its submit button does. */
  const enterSubmits = (submit) => (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submit();
  };

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

    // THE GATE. Same section, same `.bp-welcome` class and `ui.welcome` key,
    // because showGate(), hideAllScreens() and pinpad.smoke.mjs all address it
    // by that name — only what is inside changed. Nothing here touches the
    // network on its own: a pill is a choice, and the device record is minted
    // by the flow it starts, never by looking at the screen.
    ui.welcome = element('section', 'bp-welcome');
    ui.welcome.id = 'bp-gate';
    ui.welcome.hidden = true;
    const gateTitle = element('h2', 'bp-gate-title', 'Private Club');
    gateTitle.id = 'bp-gate-title';
    const gateSub = element('p', 'bp-gate-sub', 'Blazing Stream is invite only.');
    gateSub.id = 'bp-gate-sub';
    // Google is a real pill so the row reads as three equal choices, and it is
    // disabled for good — the route behind it answers 501. It is NOT in
    // BUSY_CONTROLS, or setBusy(false) would switch it on.
    ui.pillGoogle = pill('bp-pill-google', ICON_GOOGLE, 'Login with Google', 'Coming soon');
    ui.pillGoogle.disabled = true;
    ui.pillGoogle.setAttribute('aria-disabled', 'true');
    ui.pillQr = pill('bp-pill-qr', ICON_QR, 'Scan QR to login', 'Show a code for a signed-in phone');
    ui.pillCode = pill('bp-pill-code', ICON_CODE, 'Type code to open', 'Invite or pairing code');
    const pills = element('div', 'bp-gate-pills');
    pills.id = 'bp-gate-pills';
    pills.append(ui.pillGoogle, ui.pillQr, ui.pillCode);
    ui.gateEmail = button('bp-gate-link', 'Have an email login? Sign in', 'bp-gate-email');
    // A SECOND "I am the owner", not the footer's. The footer one (ui.owner)
    // belongs to the pending screen and is what pinpad.smoke.mjs clicks; the
    // footer is display:none in gate view, so the gate needs its own. This
    // one also has to mint an identity first — see openOwnerPinFromGate().
    ui.gateOwner = button('bp-gate-link', 'I am the owner', 'bp-gate-owner');
    // Hidden until showGate() finds stored credentials to re-check with.
    ui.gateRecheck = button('bp-gate-link', 'Check again', 'bp-gate-recheck');
    ui.gateRecheck.hidden = true;
    const gateLinks = element('div', 'bp-gate-links');
    gateLinks.id = 'bp-gate-links';
    gateLinks.append(ui.gateEmail, ui.gateOwner, ui.gateRecheck);
    ui.welcome.append(svg(DOOR_MARK), gateTitle, gateSub, svg(KEY_GLYPH), pills, gateLinks);
    // The two first-run buttons this screen used to carry, kept as KEYS so the
    // code that knows them still finds an element. "I Have an Invite Code" is
    // the Type-code pill; "Request Access" was connectProfiles(), which is
    // exactly what Check again does.
    ui.enterCode = ui.pillCode;
    ui.requestAccess = ui.gateRecheck;

    // SCAN QR TO LOGIN — this browser is the new device. Code, QR of the same
    // code, one line of help, and a retry that only appears when a code could
    // not be had. startPairing()/renderPairCode()/showPairRetry() own the
    // hidden flags.
    ui.qr = element('section', 'bp-qr');
    ui.qr.id = 'bp-qr';
    ui.qr.hidden = true;
    const qrTop = sheetTop('qrBack', 'bp-qr-back', 'Pair this browser');
    ui.pairCode = element('p', 'bp-paircode');
    ui.pairCode.id = 'bp-pair-code';
    ui.pairCode.hidden = true;
    ui.pairCode.setAttribute('aria-label', 'Pairing code');
    ui.pairImage = document.createElement('img');
    ui.pairImage.className = 'bp-pairqr';
    ui.pairImage.id = 'bp-pair-image';
    ui.pairImage.alt = 'Pairing QR code';
    ui.pairImage.decoding = 'async';
    ui.pairImage.hidden = true;
    ui.pairHelp = element('p', 'bp-pairhelp', 'On a phone that is already signed in, scan this or open blazingstream.lyreosai.com/pair and enter the code.');
    ui.pairHelp.id = 'bp-pair-help';
    ui.pairHelp.hidden = true;
    ui.qrRetry = button('bp-secondary', 'Try again', 'bp-qr-retry');
    ui.qrRetry.hidden = true;
    ui.qr.append(qrTop, ui.pairCode, ui.pairImage, ui.pairHelp, ui.qrRetry);

    // HAVE AN EMAIL LOGIN? SIGN IN — email + password, binds this browser.
    // autocomplete=username on the address is what lets a password manager
    // pair the two fields.
    ui.email = element('section', 'bp-email');
    ui.email.id = 'bp-email';
    ui.email.hidden = true;
    const emailTop = sheetTop('emailBack', 'bp-email-back', 'Sign in');
    ui.emailAddress = input('bp-email-address', 'email', 'Email address', 'username');
    ui.emailPassword = input('bp-email-password', 'password', 'Password', 'current-password');
    const emailActions = element('div', 'bp-form-actions');
    ui.emailSubmit = button('bp-verify', 'Sign in', 'bp-email-submit');
    emailActions.append(ui.emailSubmit);
    ui.email.append(emailTop, ui.emailAddress, ui.emailPassword, emailActions);

    // TYPE CODE → an ACCOUNT invite → make the account. Reached only from
    // redeemInviteCode(), which holds the code in state.inviteCode.
    ui.signup = element('section', 'bp-signup');
    ui.signup.id = 'bp-signup';
    ui.signup.hidden = true;
    const signupTop = sheetTop('signupBack', 'bp-signup-back', 'Make your account');
    ui.signupName = input('bp-signup-name', 'text', 'Your name', 'name');
    ui.signupEmail = input('bp-signup-email', 'email', 'Email address', 'email');
    ui.signupPassword = input('bp-signup-password', 'password', `Password (${MIN_PASSWORD}+ characters)`, 'new-password');
    ui.signupPassword.minLength = MIN_PASSWORD;
    const signupActions = element('div', 'bp-form-actions');
    ui.signupSubmit = button('bp-verify', 'Create account', 'bp-signup-submit');
    signupActions.append(ui.signupSubmit);
    ui.signup.append(signupTop, ui.signupName, ui.signupEmail, ui.signupPassword, signupActions);

    // APPROVE A DEVICE — the ?pair=CODE sheet. The question and the two
    // buttons appear only after /pair/peek names the device; until then, and
    // when the code is dead, Back is the way out of this sheet.
    ui.approve = element('section', 'bp-approve');
    ui.approve.id = 'bp-approve';
    ui.approve.hidden = true;
    const approveTop = sheetTop('approveBack', 'bp-approve-back', 'Approve a device');
    // The six-character box, for a phone sent here by the help line with no
    // code in the address (see pairParam()). Hidden whenever a code came in
    // the address. Plain `text`, not `tel`: the alphabet is letters and digits.
    ui.approveInput = input('bp-approve-input', 'text', 'Code from the other screen', 'off');
    ui.approveInput.classList.add('bp-approve-code');
    ui.approveInput.maxLength = PAIR_CODE_LENGTH;
    ui.approveInput.autocapitalize = 'characters';
    ui.approveInput.inputMode = 'text';
    ui.approveInput.hidden = true;
    ui.approveQuestion = element('p', 'bp-approve-question');
    ui.approveQuestion.id = 'bp-approve-question';
    ui.approveActions = element('div', 'bp-form-actions');
    ui.approveActions.id = 'bp-approve-actions';
    ui.approveActions.hidden = true;
    ui.approveYes = button('bp-verify', 'Approve', 'bp-approve-yes');
    ui.approveNo = button('bp-secondary', 'Not now', 'bp-approve-no');
    ui.approveActions.append(ui.approveYes, ui.approveNo);
    ui.approve.append(approveTop, ui.approveInput, ui.approveQuestion, ui.approveActions);

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
    panel.append(ui.close, kicker, heading, copy, ui.status, ui.welcome, ui.invite, ui.qr, ui.email, ui.signup, ui.approve, ui.createProfile, ui.profiles, ui.pin, footer);
    // Art FIRST, so the close-catcher and the rail both paint over it.
    ui.layer.append(ui.art, backdrop, panel);
    document.body.appendChild(ui.layer);

    ui.connect.addEventListener('click', () => {
      openPanel();
      connectProfiles();
    });
    ui.refresh.addEventListener('click', connectProfiles);
    ui.owner.addEventListener('click', () => openOwnerPin('pending'));
    ui.inviteFromPending.addEventListener('click', () => showInvite());
    // The gate. ui.enterCode / ui.requestAccess are aliases of pillCode /
    // gateRecheck (see buildUi), so they get no listener of their own — a
    // second one on the same element fired every handler twice.
    ui.pillQr.addEventListener('click', () => startPairing());
    ui.pillCode.addEventListener('click', () => showInvite());
    ui.gateEmail.addEventListener('click', () => showEmail());
    ui.gateOwner.addEventListener('click', () => openOwnerPinFromGate());
    ui.gateRecheck.addEventListener('click', () => connectProfiles());
    ui.qrBack.addEventListener('click', () => showGate());
    ui.qrRetry.addEventListener('click', () => startPairing());
    ui.emailBack.addEventListener('click', () => showGate());
    ui.emailSubmit.addEventListener('click', () => submitEmailLogin());
    ui.emailPassword.addEventListener('keydown', enterSubmits(submitEmailLogin));
    ui.signupBack.addEventListener('click', () => showInvite());
    ui.signupSubmit.addEventListener('click', () => submitSignup());
    ui.signupPassword.addEventListener('keydown', enterSubmits(submitSignup));
    ui.approveBack.addEventListener('click', () => dismissApprover());
    ui.approveInput.addEventListener('input', onApproveInput);
    ui.approveInput.addEventListener('keydown', enterSubmits(submitApproveCode));
    ui.approveYes.addEventListener('click', () => approvePairedDevice());
    ui.approveNo.addEventListener('click', () => dismissApprover());
    ui.inviteBack.addEventListener('click', () => {
      // Back goes to the screen that fits what this browser IS: one that has
      // listed profiles belongs on the rail, anything else — never registered,
      // or registered and still unpaired — belongs at the gate. It used to key
      // on stored credentials, which sent a pending browser to an empty rail.
      if (state.approved) showProfiles();
      else showGate();
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
    ui.back.addEventListener('click', () => {
      // Back goes to where the pad was opened from. The owner pad opened from
      // the gate returns to the gate; showProfiles() there is an empty rail
      // with no hatch and no way back (see state.padFrom).
      if (state.ownerMode) {
        leaveOwnerPad(state.padFrom === 'gate' ? undefined : 'Choose who is watching.');
        return;
      }
      showProfiles('Choose who is watching.');
    });
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
