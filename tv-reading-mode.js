/**
 * CONTINUOUS TOP-TO-BOTTOM READING — the long-strip (webtoon) mode, shared by
 * every image reader in this client.
 *
 * WHY IT EXISTS. A real viewer asked for it and Markus passed it on directly:
 * "he said it makes it feel more like a movie." Manga is drawn as a vertical
 * strip far more often than it is drawn as facing pages, and a paged reader
 * cuts that strip into arbitrary slices — the panel you are reading ends at the
 * bottom of the screen and the next press throws the whole image away.
 *
 * PAGED READING IS NOT DELETED. Some comics really are drawn as pages, and a
 * strip would be wrong for them, so this is a MODE and the reader keeps both.
 * The choice is remembered per device in localStorage, because a reader who
 * wants the strip wants it every time and should not have to say so again.
 *
 * THE SCROLL IS SMOOTH, NOT A JUMP. That is the whole request. A D-pad press
 * moves a THIRD of the screen and eases into it; holding the key pushes the
 * target further before the previous move has finished, so the strip glides
 * continuously instead of stepping. This is a target-and-ease loop rather than
 * a velocity-and-keyup loop on purpose: a television remote does not reliably
 * send keyup, and a scroller that needs one runs away when it never arrives.
 *
 * CSS `scroll-behavior: smooth` IS DELIBERATELY OFF on the strip (see
 * styles.css). The browser's own smooth scrolling fights an rAF loop that sets
 * scrollTop every frame — the two chase each other and the result stutters.
 * There is exactly one thing moving the strip and it is the loop below.
 */
'use strict';
(() => {
  const KEY = 'blazing-reading-mode-v1';
  const PAGED = 'paged';
  const STRIP = 'strip';
  const MODES = [PAGED, STRIP];

  /** A blocked or full private store must never stop somebody reading. */
  const store = () => { try { return window.localStorage; } catch { return null; } };

  /**
   * The mode a reader should open in.
   *
   * `fallback` is what to use when the reader has NEVER CHOSEN. It is not a
   * preference and it is NEVER WRITTEN DOWN — writing it on first open would
   * make "has this reader chosen?" unanswerable for ever after, and this one
   * key is shared by manga, comics and books, so the answer would be wrong for
   * all three at once.
   *
   * That is why the difference lives at the CALL and not in the store. Manga
   * passes STRIP, because a webtoon is DRAWN as one vertical strip and a real
   * viewer asked for exactly that: "it makes it feel more like a movie." A
   * feature the viewer has to find a button to switch on is not delivered.
   * Comics and books pass nothing and stay paged, because plenty of them
   * really are drawn as facing pages.
   *
   * A STORED VALUE ALWAYS WINS, in BOTH directions. A reader who deliberately
   * put manga back to paged must not be shoved onto the strip the next time
   * they open it — an app that overrules a choice it just accepted reads as
   * broken, and is worse than one that opens the wrong way once.
   */
  function get(fallback) {
    const preferred = MODES.includes(fallback) ? fallback : PAGED;
    try {
      const raw = store()?.getItem(KEY);
      return MODES.includes(raw) ? raw : preferred;
    } catch { return preferred; }
  }

  const listeners = new Set();

  function set(mode) {
    const next = MODES.includes(mode) ? mode : PAGED;
    try { store()?.setItem(KEY, next); } catch { /* remembered this session only */ }
    for (const fn of listeners) { try { fn(next); } catch { /* one bad listener is not the others' problem */ } }
    return next;
  }

  // The fallback rides along, so a surface that OPENS on the strip also toggles
  // AWAY from it. Without it, the first press on a manga reader already showing
  // the strip would read the shared default (paged) and "switch" to the strip
  // it is already on: a button that does nothing the first time it is used.
  const toggle = (fallback) => set(get(fallback) === STRIP ? PAGED : STRIP);
  const subscribe = (fn) => { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); };

  /**
   * The strip itself: a scrolling column of page images plus the eased
   * scroller that drives it.
   *
   * @param {HTMLElement} element  the scroll container, already in the DOM
   * @param {object} [options]
   * @param {(index:number, total:number) => void} [options.onPage]  fired when
   *        the page at the top of the viewport changes, for the counter and for
   *        saving a reading position.
   */
  function createStrip(element, { onPage } = {}) {
    if (!element) return null;
    let pages = [];
    let signature = '';
    let target = 0;
    let frame = 0;
    let reported = -1;

    /** A third of the screen. Small enough that nobody could call it a page
     *  turn, large enough that reading a chapter is not a hundred presses. */
    const step = () => Math.max(120, Math.round(element.clientHeight * 0.33));
    const limit = () => Math.max(0, element.scrollHeight - element.clientHeight);
    const clamp = (value) => Math.max(0, Math.min(limit(), value));

    /**
     * How far down the CONTENT a page starts, in scrollTop's own units.
     *
     * NOT `child.offsetTop`. offsetTop is measured from the nearest POSITIONED
     * ancestor, and the reader overlay is `position: fixed`, so every page came
     * back 64px too large — the height of the toolbar above the strip. That is
     * a constant error in both directions: goToPage(0) scrolled to 64 instead
     * of the top, and the page counter changed one toolbar-height early.
     * Subtracting the FIRST child's own offsetTop cancels whatever the
     * offsetParent happens to be, because every child shares it.
     */
    function topOf(index) {
      const first = element.children[0];
      const child = element.children[index];
      return first && child ? child.offsetTop - first.offsetTop : 0;
    }

    /** Which page is under the top of the viewport — what a counter means by
     *  "where am I". Read from real offsets, so a tall page counts once. */
    function pageIndex() {
      const images = element.children;
      const top = element.scrollTop + 4;
      let index = 0;
      for (let i = 0; i < images.length; i++) {
        if (topOf(i) <= top) index = i; else break;
      }
      return index;
    }

    function report() {
      if (!pages.length || typeof onPage !== 'function') return;
      const index = pageIndex();
      if (index === reported) return;
      reported = index;
      onPage(index, pages.length);
    }

    function tick() {
      frame = 0;
      const distance = target - element.scrollTop;
      if (Math.abs(distance) < 0.6) {
        element.scrollTop = target;
        report();
        return;
      }
      // 22% of the remaining distance a frame: fast enough to feel immediate,
      // slow enough that the eye follows the artwork instead of losing it.
      element.scrollTop += distance * 0.22;
      report();
      frame = requestAnimationFrame(tick);
    }

    function glide(to) {
      target = clamp(to);
      if (!frame) frame = requestAnimationFrame(tick);
    }

    return {
      element,
      get length() { return pages.length; },

      /**
       * IDEMPOTENT, and that is load-bearing rather than an optimisation.
       *
       * Callers repaint the strip whenever the mode is toggled or a page is
       * turned, and a rebuild resets scrollTop to zero — so a reader who
       * switched modes mid-chapter would be thrown back to page one. Comparing
       * the URLs, not the COUNT, is the other half: two different chapters of
       * the same series routinely have the same number of pages, and a
       * count-only guard would leave chapter 4's artwork on screen with
       * chapter 5's label above it.
       */
      setPages(urls, altPrefix = 'Page') {
        const next = Array.isArray(urls) ? urls.filter((url) => typeof url === 'string' && url) : [];
        const nextSignature = next.join('\n');
        if (nextSignature === signature && element.children.length === next.length) return;
        signature = nextSignature;
        pages = next;
        reported = -1;
        const nodes = pages.map((url, index) => {
          const image = document.createElement('img');
          image.className = 'comic-strip-page';
          image.src = url;
          image.alt = `${altPrefix} ${index + 1}`;
          // Lazily, because a 169-page chapter as one document is the whole
          // reason a paged reader existed in the first place. Only what is
          // near the viewport is ever fetched.
          //
          // A LAZY IMAGE WITH NO RESERVED BOX IS ZERO PIXELS TALL, and a column
          // of zero-tall pages has nothing to scroll — the strip would show
          // page one and refuse to move, which reads as a broken reader rather
          // than as a loading state. So every page holds a 3:4 box until its
          // own bytes arrive, and `is-loaded` hands the box back to the real
          // artwork so a wide spread is never letterboxed.
          image.addEventListener('load', () => image.classList.add('is-loaded'), { once: true });
          image.loading = 'lazy';
          image.decoding = 'async';
          return image;
        });
        element.replaceChildren(...nodes);
        element.scrollTop = 0;
        target = 0;
        report();
      },

      clear() {
        if (frame) cancelAnimationFrame(frame);
        frame = 0; target = 0; reported = -1; pages = []; signature = '';
        element.replaceChildren();
        element.scrollTop = 0;
      },

      /**
       * One D-pad press. +1 is down the strip, -1 is back up it.
       *
       * MEASURED FROM THE TARGET WHILE ONE IS IN FLIGHT, not from scrollTop.
       * A held D-pad repeats every few tens of milliseconds, far faster than
       * the glide finishes; measuring from scrollTop meant every repeat asked
       * for "a third of a screen from where we are RIGHT NOW", which is very
       * nearly where the previous press was already going. MEASURED: three
       * presses moved 274px — the same distance as one. Holding the key now
       * pushes the target further each time, which is what "continuous" means.
       */
      nudge(direction) { glide((frame ? target : element.scrollTop) + step() * (direction < 0 ? -1 : 1)); },

      /** PageDown / PageUp — a screenful, with an overlap so no line is lost. */
      leap(direction) {
        const screenful = Math.max(160, element.clientHeight - 80);
        glide((frame ? target : element.scrollTop) + screenful * (direction < 0 ? -1 : 1));
      },

      /** Jump straight to a page, used when the reader resumes or switches
       *  out of paged mode: you land where you were, not at the top. */
      goToPage(index) {
        const at = Math.max(0, Math.min(pages.length - 1, Number(index) || 0));
        if (!element.children[at]) return;
        element.scrollTop = topOf(at);
        target = element.scrollTop;
        reported = -1;
        report();
      },

      page: pageIndex,
      atEnd: () => element.scrollTop >= limit() - 1,
      stop() { if (frame) cancelAnimationFrame(frame); frame = 0; target = element.scrollTop; },
    };
  }

  window.BlazingReadingMode = { PAGED, STRIP, MODES, get, set, toggle, subscribe, createStrip };
})();
