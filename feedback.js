/**
 * Send feedback — Settings → "Send feedback" (Markus, 17 Oct 2026):
 *
 *   "blazing stream needs to also have a feedback area where some can leave
 *    notes about whats wrong and they also send me a log back of errors or
 *    things they dont like"
 *
 *   POST https://fleet.lyreosai.com/feedback?deviceId=<id>
 *   X-Device-Token: <token>
 *
 * The FLEET, bare path, same credentials and same door as telemetry.js. The
 * server (blazing-fleet feedback.js) adds this device's last 24 hours of
 * play_failed / error telemetry on its own and pushes the note to Markus's
 * phone. This file adds the half the server cannot see: what went wrong inside
 * this browser, kept locally so it survives the reload a person does after the
 * app breaks.
 *
 * THE ERROR LOG. The newest 50 lines of: uncaught errors, unhandled promise
 * rejections, console.error, scripts and images that failed to load, and the
 * play_failed / error events app.js hands to telemetry. Kept in localStorage,
 * never sent anywhere until the person presses Send with "Include the error
 * log" on, and shown to them first if they ask. Scrubbed as it is recorded —
 * query strings, magnet links and token-shaped strings never reach storage —
 * and scrubbed again by the server, because a debrid key in a feedback note
 * would sit on a dashboard forever.
 *
 * Loaded straight after telemetry.js, early on purpose: the log can only hold
 * errors that happen after these hooks are in place.
 *
 * Same file on a phone, a desktop browser, a Samsung TV and an LG TV, so the
 * form is plain focusable buttons and fields — a D-pad reaches every control.
 */
'use strict';

(() => {
  const FLEET_BASE = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  const DEVICE_KEY = 'blazing-web-profile-device-v1'; // owned by profile.js
  const LOG_KEY = 'blazing-web-error-log-v1';
  const APP_VERSION = '1.0.0-web';                    // same as telemetry.js
  const MAX_LOG = 50;
  const MAX_LINE = 400;
  const MAX_MESSAGE = 2000;
  const POST_TIMEOUT_MS = 15000;

  const KINDS = Object.freeze([
    { id: 'broken', label: "Something's broken" },
    { id: 'dislike', label: "I don't like something" },
    { id: 'idea', label: 'I have an idea' },
  ]);

  // ---- scrubbing ------------------------------------------------------------

  /** The same rules as the server's feedback.redact, so a line reads the same in both places. */
  function scrub(text) {
    return String(text == null ? '' : text)
      .replace(/magnet:\?[^\s"'<>]*/gi, 'magnet:[removed]')
      .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1?[removed]')
      .replace(/\b(token|key|secret|password|passwd|pin|auth|apikey|api_key)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, '$1$2[removed]')
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[removed]')
      .slice(0, MAX_LINE);
  }

  // ---- the error log --------------------------------------------------------

  function readLog() {
    try {
      const value = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
      return Array.isArray(value) ? value.slice(-MAX_LOG) : [];
    } catch { return []; }
  }

  let entries = readLog();

  function record(level, message, source) {
    try {
      const text = scrub(message).trim();
      if (!text) return;
      const last = entries[entries.length - 1];
      // One failure repeated in a tight loop (a row retrying, a poller) is one
      // line with a count, not fifty identical lines that push out the rest.
      if (last && last.message === text && last.level === level) {
        last.count = (last.count || 1) + 1;
        last.ts = Math.floor(Date.now() / 1000);
      } else {
        entries.push({
          ts: Math.floor(Date.now() / 1000),
          level,
          message: text,
          source: source ? scrub(source).slice(0, 120) : null,
        });
        if (entries.length > MAX_LOG) entries = entries.slice(-MAX_LOG);
      }
      localStorage.setItem(LOG_KEY, JSON.stringify(entries));
    } catch { /* a full or blocked storage must never cost the page anything */ }
  }

  function describeValue(value) {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }

  window.addEventListener('error', (event) => {
    const target = event && event.target;
    // A failed <script>, <img> or <link> fires a plain Event on the element, in
    // the capture phase only, with no message — that is why this listener is
    // capturing and why it reads the element instead.
    if (target && target !== window && target.tagName) {
      const src = target.currentSrc || target.src || target.href || '';
      record('error', `${String(target.tagName).toLowerCase()} failed to load`, src);
      return;
    }
    const where = event.filename ? `${event.filename.split('/').pop()}:${event.lineno || 0}` : null;
    record('error', event.message || describeValue(event.error), where);
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason;
    // An aborted fetch is the app cancelling its own request on purpose.
    if (reason && reason.name === 'AbortError') return;
    record('error', `unhandled: ${describeValue(reason)}`);
  });

  const originalConsoleError = console.error;
  console.error = function patchedConsoleError(...args) {
    record('console', args.map(describeValue).join(' '));
    return originalConsoleError.apply(this, args);
  };

  // The play_failed and error events app.js already reports. Wrapped rather
  // than duplicated, so the local log and the server's problem log name the
  // same failures in the same words.
  const telemetry = window.BlazingTelemetry;
  if (telemetry && typeof telemetry.log === 'function') {
    const send = telemetry.log;
    telemetry.log = (name, props) => {
      if (name === 'play_failed' || name === 'error') {
        const p = props || {};
        const detail = [p.title || p.id, p.message, p.code ? `code ${p.code}` : '', p.status ? `HTTP ${p.status}` : '']
          .filter(Boolean).join(', ');
        record('event', `${name}${detail ? `: ${detail}` : ''}`);
      }
      return send(name, props);
    };
  }

  // ---- about this screen ----------------------------------------------------

  function credentials() {
    try {
      const value = JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null');
      if (!value || typeof value !== 'object') return null;
      const id = String(value.id || '').trim();
      const token = String(value.token || '').trim();
      return id && token ? { id, token } : null;
    } catch { return null; }
  }

  /** samsung / lg / web — the same file runs on all three. */
  function platform() {
    const ua = navigator.userAgent || '';
    if (window.tizen || /Tizen/i.test(ua)) return 'samsung';
    if (window.webOS || window.PalmSystem || /Web0S|webOS/i.test(ua)) return 'lg';
    return 'web';
  }

  function deviceKind() {
    const ua = navigator.userAgent || '';
    if (/iPhone/.test(ua)) return 'iPhone';
    // iPadOS 13+ says "Macintosh"; a touch screen is what gives it away.
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
    if (/Tizen/i.test(ua)) return 'Samsung TV';
    if (/Web0S|webOS/i.test(ua)) return 'LG TV';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows PC';
    if (/CrOS/.test(ua)) return 'Chromebook';
    if (/Linux/.test(ua)) return 'Linux';
    return 'Browser';
  }

  function deviceInfo() {
    let standalone = false;
    try {
      standalone = Boolean(navigator.standalone) || window.matchMedia('(display-mode: standalone)').matches;
    } catch { /* old TV browsers have no matchMedia display-mode */ }
    return {
      model: deviceKind(),
      standalone,
      width: window.screen ? window.screen.width : 0,
      height: window.screen ? window.screen.height : 0,
      language: navigator.language || '',
      userAgent: scrub(navigator.userAgent || '').slice(0, 300),
      online: navigator.onLine !== false,
    };
  }

  // ---- the form ---------------------------------------------------------------

  // Kept between visits, so leaving Settings half-way through a note does not
  // throw the note away.
  const draft = { kind: 'broken', message: '', contact: '', includeLog: true };
  let sending = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function stamp(ts) {
    try {
      return new Date(ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch { return ''; }
  }

  function logLines() {
    return entries.map((entry) => {
      const count = entry.count > 1 ? ` (×${entry.count})` : '';
      const where = entry.source ? ` — ${entry.source}` : '';
      return `${stamp(entry.ts)}  ${entry.message}${count}${where}`;
    });
  }

  /**
   * Draw the form into `host` (settings.js hands it #settings-host).
   * `onClose` goes back to Settings. `getProfile` answers settings.js's current
   * profile at the moment Send is pressed, so a profile switched while the form
   * is open is the one the note is signed with.
   */
  function mount(host, { getProfile = () => null, onClose = () => {} } = {}) {
    if (!host) return;
    host.replaceChildren();

    host.append(element('h2', 'settings-section', 'Send feedback'));
    host.append(element('p', 'settings-note',
      "Tell us what's wrong or what you'd change. Your note goes straight to the Blazing team, "
      + "with this screen's recent error log if you leave it on."));

    /* What kind of note. Three buttons acting as one choice, because a select
       is hard to drive from a TV remote and a radio group is hard to see. */
    const kinds = element('div', 'feedback-kinds');
    kinds.setAttribute('role', 'radiogroup');
    kinds.setAttribute('aria-label', 'What kind of feedback');
    const kindButtons = KINDS.map((kind) => {
      const button = element('button', 'feedback-kind', kind.label);
      button.type = 'button';
      button.id = `feedback-kind-${kind.id}`;
      button.setAttribute('role', 'radio');
      const paint = () => button.setAttribute('aria-checked', String(draft.kind === kind.id));
      paint();
      button.addEventListener('click', () => {
        draft.kind = kind.id;
        kindButtons.forEach((b) => b.paint());
      });
      button.paint = paint;
      kinds.append(button);
      return button;
    });
    host.append(kinds);

    const messageLabel = element('label', 'feedback-label', 'What happened?');
    messageLabel.htmlFor = 'feedback-message';
    const message = document.createElement('textarea');
    message.id = 'feedback-message';
    message.className = 'settings-input feedback-message';
    message.rows = 5;
    message.maxLength = MAX_MESSAGE;
    message.placeholder = 'What were you trying to do, and what did the app do instead?';
    message.value = draft.message;
    message.addEventListener('input', () => { draft.message = message.value; });
    host.append(messageLabel, message);

    const contactLabel = element('label', 'feedback-label', 'How can we reach you? (optional)');
    contactLabel.htmlFor = 'feedback-contact';
    const contact = document.createElement('input');
    contact.id = 'feedback-contact';
    contact.className = 'settings-input';
    contact.type = 'text';
    contact.maxLength = 200;
    contact.autocomplete = 'off';
    contact.placeholder = 'Only if you want an answer';
    contact.value = draft.contact;
    contact.addEventListener('input', () => { draft.contact = contact.value; });
    host.append(contactLabel, contact);

    /* The log toggle cycles like every other Settings row, and says how much
       is in it, so "attach the log" is never a mystery box. */
    const logToggle = element('button', 'settings-row');
    logToggle.type = 'button';
    logToggle.id = 'feedback-include-log';
    const paintToggle = () => {
      logToggle.textContent = entries.length
        ? `Include the error log: ${draft.includeLog ? 'On' : 'Off'} (${entries.length} line${entries.length === 1 ? '' : 's'})`
        : 'Include the error log: nothing recorded on this screen yet';
      logToggle.disabled = !entries.length;
    };
    paintToggle();
    logToggle.addEventListener('click', () => { draft.includeLog = !draft.includeLog; paintToggle(); });
    host.append(logToggle);

    const preview = element('pre', 'feedback-log');
    preview.id = 'feedback-log-preview';
    preview.hidden = true;
    const showLog = element('button', 'settings-row', 'Show what the log will send');
    showLog.type = 'button';
    showLog.id = 'feedback-show-log';
    showLog.disabled = !entries.length;
    showLog.addEventListener('click', () => {
      preview.hidden = !preview.hidden;
      preview.textContent = logLines().join('\n');
      showLog.textContent = preview.hidden ? 'Show what the log will send' : 'Hide the log';
    });
    host.append(showLog, preview);

    const actions = element('div', 'settings-actions');
    const send = element('button', 'primary-button', 'Send');
    send.type = 'button';
    send.id = 'feedback-send';
    const back = element('button', 'secondary-button', 'Back to Settings');
    back.type = 'button';
    back.id = 'feedback-back';
    back.addEventListener('click', () => onClose());
    actions.append(send, back);
    host.append(actions);

    const status = element('p', 'settings-note');
    status.id = 'feedback-status';
    status.setAttribute('role', 'status');
    host.append(status);
    const say = (text, tone) => { status.textContent = text; status.dataset.tone = tone; };

    send.addEventListener('click', async () => {
      if (sending) return;
      const text = message.value.trim();
      if (!text) {
        say('Write a few words first: what happened, or what you would change.', 'error');
        message.focus();
        return;
      }
      const creds = credentials();
      if (!creds) {
        say('This screen is not connected to Blazing yet. Choose a profile first, then send this again.', 'error');
        return;
      }
      sending = true;
      send.disabled = true;
      say('Sending…', 'loading');
      const body = {
        kind: draft.kind,
        message: text,
        contact: contact.value.trim(),
        screen: 'settings',
        platform: platform(),
        appVersion: APP_VERSION,
        profileId: (() => { const p = getProfile(); return p && p.id ? String(p.id) : ''; })(),
        device: deviceInfo(),
        log: draft.includeLog ? entries.map((entry) => ({
          ts: entry.ts,
          level: entry.level,
          message: entry.count > 1 ? `${entry.message} (×${entry.count})` : entry.message,
          source: entry.source,
        })) : [],
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
      let res = null;
      try {
        res = await fetch(`${FLEET_BASE}/feedback?deviceId=${encodeURIComponent(creds.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Device-Token': creds.token },
          body: JSON.stringify(body),
          signal: controller.signal,
          credentials: 'omit',
        });
      } catch { res = null; } finally { clearTimeout(timer); }
      sending = false;
      send.disabled = false;

      if (res && (res.status === 202 || res.status === 200)) {
        draft.message = '';
        draft.contact = '';
        message.value = '';
        contact.value = '';
        say(body.log.length
          ? 'Sent. Thank you. The team has it now, with the log attached.'
          : 'Sent. Thank you. The team has it now.', 'success');
        try { window.BlazingTelemetry && window.BlazingTelemetry.log('feedback_sent', { kind: draft.kind, lines: body.log.length }); } catch {}
        return;
      }
      // The note stays in the box on every failure; nobody should have to type it twice.
      let reason = '';
      if (res) {
        try { reason = String(((await res.json()) || {}).error || ''); } catch { reason = ''; }
      }
      if (res && res.status === 429) say(reason || 'Too many notes from this screen in the last hour. Try again later.', 'error');
      else if (res && (res.status === 401 || res.status === 403)) {
        say('This screen is not approved on Blazing yet, so the note could not be sent. Once it is approved, send it again.', 'error');
      } else say('Could not send. Check the connection and press Send again; your note is still here.', 'error');
    });

    // The chosen kind, not the text box: on a Samsung or LG TV focusing a field
    // throws the on-screen keyboard over the form before anyone asked for it.
    const chosen = kindButtons.find((b) => b.id === `feedback-kind-${draft.kind}`) || kindButtons[0];
    chosen.focus();
  }

  window.BlazingFeedback = {
    mount,
    scrub,
    /** For the console and the smoke test. Carries nothing secret by construction. */
    log: {
      entries: () => entries.map((entry) => ({ ...entry })),
      record,
      clear() { entries = []; try { localStorage.removeItem(LOG_KEY); } catch {} },
    },
  };
})();
