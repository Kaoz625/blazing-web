/**
 * THE BOOKS ROW — find any book, and OPEN the ones that can be opened.
 *
 * This sits in the Books & Audio view, above the public-domain library that
 * media-library.js already draws. The two are different shelves and neither
 * replaces the other: /media/books is Project Gutenberg, which is public domain
 * only, so it can never hold a book published in 1992. This row searches the
 * real sources.
 *
 *   GET /search/book?q=<title>&limit=<n>
 *     { query, count, results:[Row], sources:[string], usenetEnabled:boolean,
 *       unavailable: { reason, message } | null }
 *     Row { source:'annas'|'usenet', provider, title, format, size,
 *           url, direct, playable, tier, sizeSuspect? }
 *
 * A ROW THAT CANNOT BE OPENED SAYS WHY. This is the whole reason the row is
 * built this way. A row with no reference is a real result but not a file, and
 * a Read button on one would open a reader onto nothing. Everything that cannot
 * be paged gets a sentence in plain words instead of a dead button, exactly as
 * the manga chapter list does for a licensed chapter it cannot serve.
 *
 * THERE ARE TWO REFERENCE PATHS AND BOTH ARE OURS — measured live, not assumed.
 *
 *   /usenet/<48 hex>     a Usenet reference TorBox turns into the file
 *   /book/ref/<48 hex>   an Anna's Archive md5 the libgen mirrors serve
 *
 * The second one was MISSING and it cost the whole feature. This file was
 * written against an older contract in which an Anna's row was always a
 * download page (`direct:false`), and it matched `/usenet/` alone. The server
 * has since learned to fetch an Anna's book — server.js `registerAnnas` mints
 * `${base}/book/ref/<token>` — so on 7 Sep 2026 a live `/search/book?q=dune`
 * returned SIX rows, every one of them `direct:true` on `/book/ref/`, and this
 * row refused all six with "points somewhere other than our own server". Not
 * one book in the shelf could be opened, and the smoke suite was green because
 * its fixture still described the old contract.
 *
 * So the shapes are listed, both of them, and the smoke fixture now carries the
 * live shape. THE TOKEN IS STILL TAKEN FROM OUR OWN URL AND NOTHING ELSE:
 * `row.url` is checked to be on the addon's own origin before its last path
 * segment is read. A row whose url points anywhere else is treated as not
 * openable — a client must never be handed, or follow, a provider link.
 *
 * THE PROFILE GATE IS THE SAME ONE THE SHELF BESIDE IT USES. These results
 * carry no age rating of any kind, so Kids, Guest and Teen fail closed and no
 * profile at all reads as the strictest cap, matching media-library.js's
 * profileAllowed() and the manga policy. It is a copy of that predicate rather
 * than a call into it, so load order between two independent modules can never
 * decide whether a gate runs.
 */
'use strict';
(() => {
  const ADDON_BASE = (window.BLAZING_API_BASE || 'https://addon.lyreosai.com').replace(/\/+$/, '');
  const TIMEOUT_MS = 30000;
  /** Both of our own reference paths. See the header: matching only the first
   *  of these made every live result unopenable. */
  const OWN_REFERENCE = /^\/(?:usenet|book\/ref)\/([a-f0-9]{48})$/;

  const text = (value, length = 300) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, length);
  const profileAllowed = (profile) => typeof profile?.id === 'string' && Boolean(profile.id)
    && profile.isKids !== true && ['mature', 'adult'].includes(profile.effectiveMaxRating || profile.maxRating);

  const state = { active: false, profile: null, query: '', request: 0, room: null, controller: null };

  const node = (tag, cls, value) => {
    const out = document.createElement(tag);
    if (cls) out.className = cls;
    if (value != null) out.textContent = value;
    return out;
  };
  const button = (label, fn, cls = 'secondary-button') => {
    const out = node('button', cls, label);
    out.type = 'button';
    if (fn) out.addEventListener('click', fn);
    return out;
  };

  /** A size the reader can judge. 0 means "the source did not say". */
  function size(bytes) {
    const value = Number(bytes) || 0;
    if (value <= 0) return '';
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
    if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
    return `${Math.max(1, Math.round(value / 1024))} KB`;
  }

  /**
   * The 48-hex reference, or '' — and '' is a real answer, not a failure.
   * Only a url on the addon's own origin, shaped exactly /usenet/<token> or
   * /book/ref/<token>, is read. Anything else is a row we do not open.
   */
  function reference(row) {
    if (!row?.direct) return '';
    try {
      const url = new URL(String(row.url || ''), `${ADDON_BASE}/`);
      const home = new URL(`${ADDON_BASE}/`);
      if (url.origin !== home.origin) return '';
      const match = OWN_REFERENCE.exec(url.pathname);
      return match ? match[1] : '';
    } catch { return ''; }
  }

  /**
   * Why this row has no Read button. Never blank: silence is the bug.
   *
   * THE ORDER IS THE MEANING. `direct:true` and yet reference() refused it is
   * checked FIRST, because that is the one shape that would mean a client had
   * been handed a provider link, and it is a different fault from "there is no
   * file yet". It used to sit below the source check, so an Anna's row with a
   * foreign link was reported as an ordinary download page and the real fault
   * — a link that is not ours — was never said.
   */
  function refusal(row, usenetEnabled) {
    if (row.direct) {
      return 'This copy points somewhere other than our own server, so it will not be opened here.';
    }
    if (row.source === 'annas') {
      return "Anna's Archive lists this as a download page, not a file, so it cannot be opened on this screen.";
    }
    if (usenetEnabled === false) {
      return 'Usenet is switched off on the server, so this copy cannot be fetched.';
    }
    return 'This copy has no readable reference yet. Try the search again in a few minutes.';
  }

  function status(message, retry) {
    const room = state.room; if (!room) return;
    room.status.replaceChildren();
    if (!message) return;
    room.status.append(node('span', '', text(message)));
    if (retry) room.status.append(button('Try again', retry));
  }

  function chooseProfile() {
    status('These results carry no age ratings. Choose a Mature or Adult profile to search for books.');
    state.room?.status.append(button('Choose profile', () => window.BlazingProfile?.open?.()));
  }

  function card(row, usenetEnabled) {
    const item = node('article', 'book-row');
    const head = node('div', 'book-row-head');
    head.append(node('strong', 'book-row-title', text(row.title, 200)));
    const meta = node('div', 'book-row-meta');
    meta.append(node('span', 'book-chip', text(row.provider, 40) || (row.source === 'annas' ? "Anna's Archive" : 'Usenet')));
    if (row.format) meta.append(node('span', 'book-chip', text(row.format, 12)));
    const bytes = size(row.size);
    // A size the indexer flagged as untrustworthy is shown WITH the doubt, not
    // silently: a label is a claim, not a measurement.
    if (bytes) meta.append(node('span', 'book-chip', row.sizeSuspect ? `${bytes}?` : bytes));
    head.append(meta);
    item.append(head);

    const token = reference(row);
    if (token) {
      const open = button('Read', () => {
        if (!state.active || !profileAllowed(state.profile)) return;
        window.BlazingBookReader?.open({ token, title: row.title, profileId: state.profile.id });
      }, 'primary-button book-open');
      open.setAttribute('aria-label', `Read ${text(row.title, 120)}`);
      item.append(open);
    } else {
      item.append(node('p', 'book-row-why', refusal(row, usenetEnabled)));
    }
    return item;
  }

  async function search(query) {
    const room = state.room; if (!room) return;
    const request = ++state.request;
    state.controller?.abort();
    state.controller = new AbortController();
    const controller = state.controller;
    const q = text(query, 160);
    state.query = q;
    room.input.value = q;
    room.results.replaceChildren();
    if (!profileAllowed(state.profile)) { chooseProfile(); return; }
    if (!q) { status('Type a title or an author, then press Search.'); return; }
    status(`Searching for “${q}”…`);

    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let data = null, failed = false;
    try {
      const response = await fetch(`${ADDON_BASE}/search/book?q=${encodeURIComponent(q)}&limit=20`, { signal: controller.signal });
      data = await response.json().catch(() => null);
      if (!response.ok && !data) failed = true;
    } catch { failed = true; } finally { clearTimeout(timer); }
    if (request !== state.request || !state.active) return;

    if (failed || !data) { status('The book search could not be reached.', () => search(q)); return; }
    const rows = Array.isArray(data.results) ? data.results.filter((row) => row && text(row.title)) : [];
    if (!rows.length) {
      status(text(data.unavailable?.message) || `No books matched “${q}”. Try the author, or a shorter title.`,
        () => search(q));
      return;
    }
    room.results.replaceChildren(...rows.map((row) => card(row, data.usenetEnabled)));
    const openable = rows.filter((row) => reference(row)).length;
    status(openable
      ? `${rows.length} result${rows.length === 1 ? '' : 's'} · ${openable} can be opened here.`
      : `${rows.length} result${rows.length === 1 ? '' : 's'}, and none of them is a file this reader can open. Each row says why.`);
  }

  function build(host) {
    const section = node('section', 'book-search');
    const heading = node('h2', 'book-search-title', 'Find any book');
    const blurb = node('p', 'book-search-blurb',
      'Search real sources, not only the public-domain shelf below. Anything that arrives as a file opens in the reader.');
    const form = node('form', 'media-library-search');
    /**
     * THE NAME AND THE PLACEHOLDER MUST NOT MATCH THE SHELF BELOW.
     *
     * media-library.js draws its own book search in the same view, and it was
     * also labelled "Search books" with the placeholder "Book title or author".
     * Two identical boxes, one above the other, on the same screen: a person
     * cannot tell which shelf they are searching, a screen reader announces the
     * same words twice, and `getByRole('searchbox')` inside #media-view stopped
     * resolving at all — which is how this was found. Ours says it searches
     * EVERYTHING, because that is the difference between the two.
     */
    const label = node('label', '', 'Search every book source');
    const input = node('input');
    input.type = 'search'; input.maxLength = 160; input.name = 'bq';
    input.id = 'book-search-input';
    input.placeholder = 'Any book — title or author';
    label.append(input);
    const submit = node('button', 'primary-button', 'Search'); submit.type = 'submit';
    form.append(label, submit);
    const message = node('div', 'media-library-status book-search-status'); message.setAttribute('role', 'status');
    const results = node('div', 'book-results');
    form.addEventListener('submit', (event) => { event.preventDefault(); search(input.value); });
    section.append(heading, blurb, form, message, results);
    host.replaceChildren(section);
    state.room = { input, status: message, results };
  }

  function mount(route, services = {}) {
    const host = services.host || document.getElementById('book-search-host');
    if (route !== 'books' || !host) { leave(); return false; }
    const profileChanged = Object.hasOwn(services, 'profile')
      && JSON.stringify(services.profile) !== JSON.stringify(state.profile);
    if (Object.hasOwn(services, 'profile')) state.profile = profileAllowed(services.profile) ? { ...services.profile } : null;
    // NOT keyed on state.active: leaving the route and coming back must keep
    // the results that were on screen, not throw the reader back to an empty
    // prompt and make them search again.
    const fresh = !state.room || state.room.input.isConnected === false;
    state.active = true;
    host.hidden = false;
    if (fresh) build(host);
    if (fresh || profileChanged) {
      ++state.request;
      state.room.results.replaceChildren();
      if (!profileAllowed(state.profile)) chooseProfile();
      else status('Type a title or an author, then press Search.');
    }
    return true;
  }

  function leave() {
    state.active = false;
    ++state.request;
    state.controller?.abort();
    const host = document.getElementById('book-search-host');
    if (host) host.hidden = true;
  }

  function reset(profile) {
    state.profile = profileAllowed(profile) ? { ...profile } : null;
    ++state.request;
    state.controller?.abort();
    window.BlazingBookReader?.close(false);
    if (!state.room || !state.active) return;
    state.room.input.value = '';
    state.room.results.replaceChildren();
    if (profileAllowed(state.profile)) status('Type a title or an author, then press Search.');
    else chooseProfile();
  }

  document.addEventListener('blazing-profile-selected', (event) => reset(event.detail));
  document.addEventListener('blazing-profile-signed-out', () => reset(null));
  document.addEventListener('blazing-profile-unlock-expired', () => reset(null));

  window.BlazingBooks = { mount, leave, reset, search, core: { reference, refusal, profileAllowed, size } };
})();
