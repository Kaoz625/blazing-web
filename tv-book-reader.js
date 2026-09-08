/**
 * THE BOOK READER — read a real book on a television, in a browser.
 *
 * Book SEARCH already worked and nothing could OPEN one, which is the
 * "found but unplayable" failure this fleet keeps writing rules about. The
 * server half is finished and lives in blazing-addon; this file is the client
 * half and it invents nothing:
 *
 *   GET /book/pages/<token>?page=N&chars=M
 *     200 { mode:'text',  token, format, chapters, charsPerPage, count, page, title, pages:[{n,text}] }
 *     200 { mode:'image', ... pages:[url] }        the fixed-layout branch, see below
 *     202 { state:'queued'|'downloading', retryAfter }    Usenet is still fetching it
 *     400 { error:'invalid-reference' }
 *     404 { error:'no-such-page', count }
 *     415 { error, format, mode:'unsupported' }    a PDF, today
 *     503 { error:'reader-busy' } | { reason:'usenet-disabled' }
 *     502 { error:'book-fetch-failed' | 'file-too-large' }
 *
 * `token` is the 48-hex reference /search/book already minted for every
 * `direct:true` row. Nothing new had to be plumbed to open a book.
 *
 * TWO MODES, BECAUSE A BOOK IS NOT A COMIC.
 *  - EPUB and plain text REFLOW, so they arrive as TEXT and this client
 *    chooses the type size. That is the whole point of reflowable text: the
 *    reader picks, not the publisher. The size chosen here decides
 *    `chars=` on the wire, so a bigger face really does mean fewer words a
 *    page rather than a page that overflows the screen.
 *  - A PDF is FIXED LAYOUT and can only be read as page IMAGES, so
 *    `mode:'image'` is drawn through the same page rail the comics reader
 *    uses, paged or as a continuous strip. The server does not render PDF page
 *    images yet — it answers 415 with the real format — so that branch is
 *    written against the contract and reached today only by a stub. It is here
 *    because the alternative is a client that has to be changed on the day the
 *    renderer lands, and because 415 has to be SAID OUT LOUD in the meantime
 *    instead of showing an empty reader.
 *
 * ONE PAGE AT A TIME, ALWAYS. The route can return the whole book and this
 * never asks it to. Roku cannot hold a book in memory and neither should a
 * browser on a five-year-old television; `count` still reports the total, which
 * is all a page indicator needs.
 *
 * NO UPSTREAM URL IS EVER TOUCHED. Every request goes to our own addon, and an
 * image page is accepted only when it resolves onto that same origin. A raw
 * Anna's or Usenet link would carry an account credential and must never reach
 * a client — the same rule as video.
 */
'use strict';
(() => {
  const ADDON_BASE = (window.BLAZING_API_BASE || 'https://addon.lyreosai.com').replace(/\/+$/, '');
  const TOKEN = /^[a-f0-9]{48}$/;
  const TIMEOUT_MS = 45000;
  const SIZE_KEY = 'blazing-book-text-size-v1';
  const PROGRESS_KEY = 'blazing-book-progress-v1:';
  /** Retries while Usenet is still fetching the file. Ten minutes of patience,
   *  then it stops and waits to be asked again — an unbounded auto-retry is a
   *  client hammering a provider forever behind a screen nobody is watching. */
  const MAX_PREPARING_RETRIES = 60;

  /**
   * Type size, and the page size that goes with it.
   *
   * The two are ONE control. A reader who makes the words bigger has not asked
   * for the same 1800 characters in a taller box that scrolls; they have asked
   * for less on the screen at once. `chars` is what goes on the wire, and the
   * server clamps it to 200..20000, so every value here is honoured.
   */
  const SIZES = [
    { label: 'Smallest', px: 22, chars: 3200 },
    { label: 'Small', px: 28, chars: 2400 },
    { label: 'Medium', px: 34, chars: 1800 },
    { label: 'Large', px: 42, chars: 1300 },
    { label: 'Largest', px: 52, chars: 900 },
  ];
  const DEFAULT_SIZE = 2;

  const store = () => { try { return window.localStorage; } catch { return null; } };
  const text = (value, length = 300) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, length);

  /**
   * NEVER `Number(getItem(...))` ALONE HERE. A key that was never written comes
   * back as null, `Number(null)` is 0, and 0 is a perfectly valid size index —
   * so every first-time reader opened their first book at the SMALLEST type,
   * 22px, on a television. The absence of a choice has to be told apart from
   * the choice "smallest" before the number is looked at.
   */
  function readSize() {
    const raw = store()?.getItem(SIZE_KEY);
    if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_SIZE;
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 && index < SIZES.length ? index : DEFAULT_SIZE;
  }
  function writeSize(index) {
    try { store()?.setItem(SIZE_KEY, String(index)); } catch { /* this session only */ }
  }

  function readProgress(profileId, token) {
    if (!profileId || !TOKEN.test(token)) return null;
    try {
      const all = JSON.parse(store()?.getItem(PROGRESS_KEY + encodeURIComponent(profileId)) || '{}');
      const entry = all && typeof all === 'object' ? all[token] : null;
      return Number.isInteger(entry?.page) && entry.page >= 1 ? entry : null;
    } catch { return null; }
  }
  function writeProgress(profileId, token, entry) {
    if (!profileId || !TOKEN.test(token)) return;
    try {
      const raw = JSON.parse(store()?.getItem(PROGRESS_KEY + encodeURIComponent(profileId)) || '{}');
      const all = raw && typeof raw === 'object' ? raw : {};
      delete all[token];
      all[token] = { ...entry, at: Date.now() };
      // Newest 40. A reader's shelf, not a log.
      const trimmed = Object.fromEntries(Object.entries(all).slice(-40));
      store()?.setItem(PROGRESS_KEY + encodeURIComponent(profileId), JSON.stringify(trimmed));
    } catch { /* a full private store must not stop somebody reading */ }
  }

  /**
   * An image page is only ever OUR OWN. A relative path is joined onto the
   * addon; an absolute URL is accepted only when it lands on that same origin.
   * Anything else is dropped rather than rendered, because the one thing a
   * client must never be handed is a provider link.
   */
  /**
   * ONE PAGE'S WORDS, out of the shape the route actually sends.
   *
   * The server returns `pages: [{ n, text }]` — page OBJECTS. This client read
   * `pages[0]` as a string, so `typeof pages[0] !== 'string'` was true for
   * every real book and every one of them was refused with "This book could
   * not be read. Choose another copy." Measured live 7 Sep 2026 against
   * /book/pages/e7c75dc…: `pages[0]` is `{n: 1, text: 'Frank Herbert\n\nDune…'}`.
   *
   * The suite did not catch it because its fixture returned strings — the
   * client and the test agreed with each other and both disagreed with the
   * server. A fixture is a claim about the server, so the fixture was corrected
   * to the measured shape at the same time as this.
   *
   * BOTH SHAPES ARE ACCEPTED, not just the new one. A bare string is what the
   * whole-book branch of the same route returns for other callers, it costs one
   * line, and a reader that refuses a page it can plainly render is the exact
   * failure being fixed here. `null` — never '' — means "this is not a page":
   * a legitimately blank page is a string and must render as a blank page
   * rather than as an error.
   */
  function pageText(entry) {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && typeof entry.text === 'string') return entry.text;
    return null;
  }

  /** The same tolerance for an image page: a bare url, or `{url}` / `{src}`. */
  function pageUrl(entry) {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') return String(entry.url || entry.src || '');
    return '';
  }

  function ownUrl(value) {
    const raw = String(value || '');
    if (!raw) return '';
    try {
      const url = new URL(raw, `${ADDON_BASE}/`);
      const home = new URL(`${ADDON_BASE}/`);
      if (url.origin !== home.origin || url.username || url.password) return '';
      return url.href;
    } catch { return ''; }
  }

  const state = {
    request: 0,
    token: '',
    title: '',
    profileId: null,
    page: 1,
    count: 0,
    charsPerPage: SIZES[DEFAULT_SIZE].chars,
    size: DEFAULT_SIZE,
    mode: 'text',
    images: [],
    returnFocus: null,
    retries: 0,
    timer: 0,
    slowTimer: 0,
    focusBody: false,
    strip: null,
    unsubscribe: null,
    bound: false,
  };

  function refs() {
    const container = document.getElementById('book-reader');
    if (!container) return null;
    return {
      container,
      label: container.querySelector('.comic-label'),
      counter: container.querySelector('.comic-counter'),
      body: container.querySelector('.book-page'),
      strip: container.querySelector('.book-strip'),
      image: container.querySelector('.book-image'),
      status: container.querySelector('.book-status'),
      previous: container.querySelector('.book-previous'),
      next: container.querySelector('.book-next'),
      smaller: container.querySelector('.book-smaller'),
      bigger: container.querySelector('.book-bigger'),
      mode: container.querySelector('.book-mode'),
      close: container.querySelector('.comic-close'),
    };
  }

  /** THE SLOW NOTICE SPEAKS ONLY WHILE A REQUEST IS IN FLIGHT, so the moment one
   *  lands it has to be called off — and until 8 Sep 2026 nothing called it off.
   *  loadPage armed a 400ms timer and every path below it returned without
   *  clearing it, so about 400ms after a page turn that had ALREADY SUCCEEDED the
   *  words "Turning the page…" came back and sat under a page the reader was
   *  reading. On the fetch-failure path it was worse: the timer outlived
   *  setStatus() and painted over a real error sentence, so "The reader could not
   *  be reached" turned back into "Turning the page…" and the reader was told to
   *  wait for something that had already stopped.
   *
   *  It also made book-reader.smoke.mjs section 4b flaky rather than failing
   *  honestly — that assertion checks the status line is hidden after a 404
   *  bounce, and whether it passed depended on whether the machine got there
   *  inside 400ms. A test that fails on a slow machine and passes on a fast one
   *  reads as noise, which is how this survived. */
  function cancelSlowNotice() {
    if (state.slowTimer) { clearTimeout(state.slowTimer); state.slowTimer = 0; }
  }

  function cancelTimer() {
    if (state.timer) { clearTimeout(state.timer); state.timer = 0; }
    cancelSlowNotice();
  }

  function setStatus(message, retry) {
    const r = refs(); if (!r?.status) return;
    r.status.replaceChildren();
    if (!message) { r.status.hidden = true; return; }
    r.status.hidden = false;
    r.status.append(document.createTextNode(text(message)));
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'secondary-button book-retry'; button.textContent = 'Try again';
      button.addEventListener('click', retry);
      r.status.append(button);
    }
  }

  function applySize() {
    const r = refs(); if (!r) return;
    r.container.style.setProperty('--book-text-size', `${SIZES[state.size].px}px`);
    if (r.smaller) r.smaller.disabled = state.size === 0;
    if (r.bigger) r.bigger.disabled = state.size === SIZES.length - 1;
  }

  function showSurface() {
    const r = refs(); if (!r) return;
    const strip = state.mode === 'image' && window.BlazingReadingMode?.get() === 'strip';
    r.body.hidden = state.mode !== 'text';
    r.image.hidden = !(state.mode === 'image' && !strip);
    r.strip.hidden = !strip;
    // The mode switch is for IMAGE books only. Reflowable text has no strip:
    // its "continuous scroll" is simply a bigger page, which the size control
    // already gives, and offering a dead switch is the failure this whole
    // feature exists to stop.
    if (r.mode) r.mode.hidden = state.mode !== 'image';
    if (r.previous) r.previous.hidden = state.mode === 'image' && strip;
    if (r.next) r.next.hidden = state.mode === 'image' && strip;
  }

  function renderCounter() {
    const r = refs(); if (!r?.counter) return;
    if (!state.count) { r.counter.textContent = ''; return; }
    r.counter.textContent = `Page ${state.page} of ${state.count}`;
  }

  function saveWhereIAm() {
    if (!state.count || !state.token) return;
    writeProgress(state.profileId, state.token, {
      page: state.page, count: state.count, title: state.title, mode: state.mode,
    });
  }

  function renderText(page) {
    const r = refs(); if (!r?.body) return;
    r.body.textContent = String(page ?? '');
    r.body.scrollTop = 0;
    if (r.previous) r.previous.disabled = state.page <= 1;
    if (r.next) r.next.disabled = state.page >= state.count;
    renderCounter();
    saveWhereIAm();
  }

  function ensureStrip() {
    const r = refs(); if (!r?.strip) return null;
    if (!state.strip) {
      state.strip = window.BlazingReadingMode?.createStrip(r.strip, {
        onPage: (index, total) => {
          state.page = index + 1; state.count = total;
          renderCounter(); saveWhereIAm();
        },
      }) || null;
    }
    return state.strip;
  }

  function renderImages() {
    const r = refs(); if (!r) return;
    const strip = window.BlazingReadingMode?.get() === 'strip';
    showSurface();
    if (strip) {
      const rail = ensureStrip();
      if (!rail) return;
      // setPages compares the URLs, so a mode toggle keeps the place.
      rail.setPages(state.images, state.title || 'Page');
      rail.goToPage(state.page - 1);
      r.strip.focus();
      return;
    }
    r.image.src = state.images[state.page - 1] || '';
    r.image.alt = `${state.title || 'Book'} · Page ${state.page}`;
    if (r.previous) r.previous.disabled = state.page <= 1;
    if (r.next) r.next.disabled = state.page >= state.count;
    renderCounter();
    saveWhereIAm();
    const ahead = state.images[state.page];
    if (ahead) new Image().src = ahead;
  }

  /** Every refusal this route can answer with, said in plain words. */
  function explain(status, data) {
    const reason = text(data?.error || data?.reason || '');
    const message = text(data?.message || '');
    if (status === 400) return 'That book reference is not one this reader can open. Search again and pick another copy.';
    if (status === 404) return message || 'That page is past the end of this book.';
    if (status === 415) {
      const format = text(data?.format || '', 12).toUpperCase();
      return `${format ? `This copy is a ${format} file. ` : ''}${message || 'This copy cannot be read as text.'} Choose another copy — an EPUB reads best.`;
    }
    if (reason === 'usenet-disabled') return message || 'Usenet is switched off, so this book cannot be fetched.';
    if (reason === 'reader-busy') return message || 'The reader is fetching other books. Try again shortly.';
    if (reason === 'file-too-large') return message || 'This file is too large to read as text.';
    if (status === 503) return message || 'This book could not be fetched. Choose another copy.';
    return message || 'This book could not be downloaded. Choose another copy.';
  }

  async function loadPage(page, { resetRetries = true } = {}) {
    const r = refs(); if (!r || !state.token) return;
    const request = ++state.request;
    cancelTimer();
    if (resetRetries) state.retries = 0;
    if (state.count) {
      // A page turn is a round trip, but a status line that appears and
      // disappears on every press is a layout shift under the words somebody
      // is reading. Say nothing unless the wait is long enough to notice.
      setStatus('');
      state.slowTimer = setTimeout(() => {
        if (request === state.request) setStatus('Turning the page…');
      }, 400);
    } else {
      setStatus('Opening the book…');
    }

    const chars = SIZES[state.size].chars;
    const url = `${ADDON_BASE}/book/pages/${encodeURIComponent(state.token)}?page=${encodeURIComponent(page)}&chars=${chars}`;
    let response = null, data = null;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      data = await response.json().catch(() => null);
    } catch {
      // Before the staleness guard on purpose: a superseded request must still
      // disarm its own notice, or it fires under the newer request's page.
      cancelSlowNotice();
      if (request !== state.request) return;
      setStatus('The reader could not be reached. Check the connection and try again.', () => loadPage(page));
      return;
    }
    cancelSlowNotice();
    if (request !== state.request) return;

    // 202 — the file is real and Usenet is still pulling it. This is the ONE
    // status worth waiting on, so it waits, visibly, and says how long.
    if (response.status === 202) {
      const wait = Math.max(3, Math.min(60, Number(data?.retryAfter) || 10));
      if (state.retries >= MAX_PREPARING_RETRIES) {
        setStatus('Usenet is still fetching this book. It is taking a long time — try again, or choose another copy.',
          () => loadPage(page));
        return;
      }
      state.retries++;
      setStatus(`${text(data?.message) || 'Usenet is fetching this book.'} Checking again in ${wait}s…`,
        () => loadPage(page));
      state.timer = setTimeout(() => { if (request === state.request) loadPage(page, { resetRetries: false }); }, wait * 1000);
      return;
    }

    // 404 CARRIES THE REAL COUNT, SO USE IT INSTEAD OF STOPPING.
    //
    // resize() cannot know the new pagination before it asks — it AIMS, using
    // oldCount × oldChars / newChars — and an estimate that overshoots by one
    // page lands here. Without this, making the type bigger near the end of a
    // book put "This book has 412 pages" on screen with a Try again button that
    // asks for the same impossible page for ever. The route tells us the real
    // total in the same breath as the refusal, so bounce once onto the nearest
    // page that exists. Only ONCE: the retry is for a page inside the count the
    // server just gave, so a second 404 is a real fault and is shown.
    if (response.status === 404) {
      const real = Number(data?.count);
      const nearest = Number.isInteger(real) && real >= 1 ? Math.max(1, Math.min(real, page)) : page;
      if (nearest !== page) {
        state.count = real;
        loadPage(nearest, { resetRetries: false });
        return;
      }
    }

    if (!response.ok) { setStatus(explain(response.status, data), () => loadPage(page)); return; }

    if (data?.mode === 'image') {
      const images = (Array.isArray(data.pages) ? data.pages : []).map((entry) => ownUrl(pageUrl(entry))).filter(Boolean);
      if (!images.length) { setStatus('This book returned no readable pages. Choose another copy.', () => loadPage(page)); return; }
      state.mode = 'image';
      state.images = images;
      state.count = Number(data.count) || images.length;
      // An image book arrives as a whole rail, so the page asked for is the
      // page shown; a text book gets exactly the one page it asked for.
      state.page = Math.max(1, Math.min(state.count, Number(data.page) || page));
      state.title = text(data.title) || state.title;
      setStatus('');
      renderImages();
      return;
    }

    const pages = Array.isArray(data?.pages) ? data.pages : [];
    const words = pageText(pages[0]);
    if (data?.mode !== 'text' || words === null) {
      setStatus('This book could not be read. Choose another copy.', () => loadPage(page));
      return;
    }
    state.mode = 'text';
    state.count = Number(data.count) || 1;
    state.page = Math.max(1, Math.min(state.count, Number(data.page) || page));
    state.charsPerPage = Number(data.charsPerPage) || chars;
    if (text(data.title)) state.title = text(data.title);
    const r2 = refs();
    if (r2?.label) r2.label.textContent = state.title || 'Book';
    setStatus('');
    showSurface();
    renderText(words);
    // Focus the TEXT when the book first opens, so the arrows turn pages
    // straight away. Never on a later page, because that would drag focus off
    // the Next or A+ button the reader just pressed and every second press
    // would go somewhere else.
    if (state.focusBody) { state.focusBody = false; refs()?.body?.focus(); }
  }

  function go(step) {
    if (state.mode === 'image' && window.BlazingReadingMode?.get() === 'strip') return;
    const next = state.page + step;
    if (!state.count || next < 1 || next > state.count) return;
    if (state.mode === 'image') { state.page = next; renderImages(); return; }
    loadPage(next);
  }

  /**
   * Resize, and STAY WHERE YOU WERE.
   *
   * Changing the type size changes how many characters fit a page, so page 40
   * of 412 becomes a different place in the book. The position is carried
   * across as a fraction and the nearest page in the new pagination is asked
   * for. Without this, making the words bigger throws the reader back to the
   * start, which is exactly the moment somebody stops using the control.
   */
  function resize(step) {
    const previous = state.size;
    const next = Math.max(0, Math.min(SIZES.length - 1, previous + step));
    if (next === previous) return;
    state.size = next;
    writeSize(next);
    applySize();
    if (state.mode !== 'text' || !state.count) return;
    // How far through the book we are, in the OLD pagination.
    const ratio = (state.page - 1) / Math.max(1, state.count);
    // The new total is not known until the response arrives, but it is
    // predictable: the same book cut into different-sized pages, so
    // newCount ≈ oldCount × oldChars / newChars. Aim at the same fraction of
    // that. If the estimate overshoots, the route answers 404 with the real
    // count and the message says so rather than silently showing page one.
    const scaled = state.count * (SIZES[previous].chars / SIZES[next].chars);
    const aim = Math.max(1, Math.min(Math.round(scaled), Math.round(ratio * scaled) + 1));
    loadPage(aim);
  }

  function switchMode() {
    const mode = window.BlazingReadingMode?.toggle();
    const r = refs();
    if (r?.mode) r.mode.textContent = mode === 'strip' ? 'Page by page' : 'Continuous scroll';
    if (state.mode === 'image' && state.images.length) renderImages();
    else showSurface();
  }

  function close(restoreFocus = true) {
    ++state.request;
    cancelTimer();
    const r = refs(); if (!r) return;
    saveWhereIAm();
    r.container.hidden = true;
    document.body.classList.remove('no-scroll');
    state.strip?.clear();
    if (r.image) r.image.removeAttribute('src');
    if (r.body) r.body.textContent = '';
    state.token = ''; state.count = 0; state.page = 1; state.images = []; state.mode = 'text';
    const target = state.returnFocus;
    state.returnFocus = null;
    if (restoreFocus && target?.isConnected && target.getClientRects().length) target.focus();
  }

  function bind() {
    if (state.bound) return;
    const r = refs(); if (!r) return;
    state.bound = true;
    r.close?.addEventListener('click', () => close(true));
    r.previous?.addEventListener('click', () => go(-1));
    r.next?.addEventListener('click', () => go(1));
    r.smaller?.addEventListener('click', () => resize(-1));
    r.bigger?.addEventListener('click', () => resize(1));
    r.mode?.addEventListener('click', switchMode);

    // Bound on the CONTAINER, not on window, and it stops the event there.
    // dpad.js listens on `document` and drags focus around on every arrow key;
    // a reader that lets an arrow through loses the page turn to a magnetic
    // focus jump. Stopping it at the container is what the media-library
    // reader already does, for the same reason.
    const bar = r.container.querySelector('.comic-bar');
    const barButtons = () => [...(bar?.querySelectorAll('button:not(:disabled):not([hidden])') || [])];

    r.container.addEventListener('keydown', (event) => {
      if (r.container.hidden) return;
      const key = event.key;
      const strip = state.mode === 'image' && window.BlazingReadingMode?.get() === 'strip';
      /** Is the reader standing on the toolbar, or on the words? */
      const inBar = Boolean(bar && bar.contains(document.activeElement));
      if (key === 'Tab') {
        const buttons = [...r.container.querySelectorAll('button:not(:disabled):not([hidden])')];
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      } else if (key === 'Escape' || key === 'Backspace' || key === 'BrowserBack' || event.keyCode === 461) {
        close(true);
      } else if (key === '+' || key === '=') {
        resize(1);
      } else if (key === '-' || key === '_') {
        resize(-1);

      /* ── THE TOOLBAR HAS TO BE REACHABLE FROM A REMOTE ──────────────────
         Every arrow used to turn a page, whatever was focused, which is what
         the comics reader does — and it is right there, because a comic has no
         control worth reaching. A BOOK DOES. The type size is the whole point
         of reflowable text ("the reader picks, not the publisher"), and a
         television remote has no Tab key and no `+` key, so on the one device
         this app is built for the A− and A+ buttons could not be reached at
         all. The size control existed and could never be used.

         So the reader is two rows, exactly as every other screen in this app
         behaves under dpad.js: UP leaves the words for the toolbar, DOWN comes
         back to them, and LEFT/RIGHT walk along whichever row you are standing
         in. Page turning is untouched on the text itself, and Previous/Next
         are still on the bar for a pointer. Not applied in the continuous
         strip, where ArrowUp IS the scroll and taking it would break the mode;
         Tab remains the way out of that one, as it is for comics. */
      } else if (inBar && (key === 'ArrowLeft' || key === 'ArrowRight')) {
        const buttons = barButtons();
        const at = buttons.indexOf(document.activeElement);
        // Clamped, not wrapped: on a remote, running off the end of a row and
        // reappearing at the other end is disorienting. It simply stops.
        buttons[Math.max(0, Math.min(buttons.length - 1, at + (key === 'ArrowRight' ? 1 : -1)))]?.focus();
      } else if (inBar && key === 'ArrowDown') {
        const surface = strip ? r.strip : (state.mode === 'text' ? r.body : null);
        // A paged image has nothing focusable under the bar, so down still
        // means the next page there rather than doing nothing at all.
        if (surface) surface.focus(); else go(1);
      } else if (!strip && key === 'ArrowUp') {
        // Already on the top row? Then up does nothing. It must NOT fall
        // through to "previous page", which would turn the page behind the
        // button the reader is standing on with no sign of why.
        if (!inBar) (barButtons()[0] || r.close)?.focus();

      } else if (strip && (key === 'ArrowDown' || key === 'ArrowUp')) {
        state.strip?.nudge(key === 'ArrowDown' ? 1 : -1);
      } else if (strip && (key === 'PageDown' || key === 'PageUp' || key === ' ')) {
        state.strip?.leap(key === 'PageUp' ? -1 : 1);
      } else if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown' || key === ' ') {
        go(1);
      // ArrowUp is deliberately NOT here any more: the two branches above own
      // it in both modes, so listing it would be a line that can never run.
      } else if (key === 'ArrowLeft' || key === 'PageUp') {
        go(-1);
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    });

    state.unsubscribe = window.BlazingReadingMode?.subscribe((mode) => {
      if (r.mode) r.mode.textContent = mode === 'strip' ? 'Page by page' : 'Continuous scroll';
    }) || null;
    window.addEventListener('pagehide', () => saveWhereIAm());
  }

  /**
   * Open a book.
   *
   * @param {object} book
   * @param {string} book.token     the 48-hex reference from /search/book
   * @param {string} [book.title]
   * @param {string} [book.profileId]  whose reading position this is
   */
  function open(book) {
    const token = String(book?.token || '');
    if (!TOKEN.test(token)) return false;
    const r = refs(); if (!r) return false;
    bind();
    cancelTimer();
    state.returnFocus = document.activeElement;
    state.token = token;
    state.title = text(book.title) || 'Book';
    state.profileId = book.profileId ? String(book.profileId) : null;
    state.size = readSize();
    state.mode = 'text';
    state.images = [];
    state.count = 0;
    state.strip?.clear();
    if (r.label) r.label.textContent = state.title;
    if (r.counter) r.counter.textContent = '';
    if (r.body) r.body.textContent = '';
    if (r.image) r.image.removeAttribute('src');
    if (r.mode) r.mode.textContent = window.BlazingReadingMode?.get() === 'strip' ? 'Page by page' : 'Continuous scroll';
    r.container.hidden = false;
    document.body.classList.add('no-scroll');
    applySize();
    showSurface();
    r.close?.focus();
    const saved = readProgress(state.profileId, token);
    state.page = saved?.page || 1;
    state.focusBody = true;
    loadPage(state.page);
    return true;
  }

  window.BlazingBookReader = { open, close, SIZES, readProgress, isOpen: () => refs()?.container.hidden === false };
  window.addEventListener('DOMContentLoaded', bind);
})();
