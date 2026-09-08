/**
 * The comics reader — keyboard and D-pad driven, for a browser on a TV.
 *
 * The first version of this file said "Mock implementation" at the top, nothing
 * ever loaded it, nothing ever constructed it, and its loadComic() took an array
 * of pages that no caller could supply. Meanwhile the Comics tab printed
 * "Connected to Pullbox server. 0 comics found." while connected to nothing.
 * There is no Pullbox server and there never was.
 *
 * The fleet has had the real routes the whole time, and this walks them:
 *   GET /comics/discover                  -> { popular: [ Comic ], newest: [...] }
 *   GET /comics/<comicId>/chapters        -> { chapters: [ { id, chapter, title, readable } ] }
 *   GET /comics/chapter/<chapterId>/pages -> { count, pages: [ "/comics/archive/<key>/page/N" ] }
 * Page paths come back RELATIVE, so they are joined onto the fleet base here.
 *
 * TWO READING MODES. Paged is what this always did: one page fills the screen
 * and a press replaces it. CONTINUOUS is the long-strip (webtoon) read a real
 * viewer asked for — every page stacked in one scrolling column, and a D-pad
 * press GLIDES a third of the screen instead of throwing the page away. Paged
 * is not deleted; some comics are drawn as pages and a strip is wrong for them.
 * The choice is remembered per device by tv-reading-mode.js, which also owns
 * the eased scroller.
 */
class TVComicReader {
  constructor(containerId, fleetBase) {
    this.container = document.getElementById(containerId);
    this.base = String(fleetBase || 'https://fleet.lyreosai.com').replace(/\/+$/, '');
    this.pages = [];
    this.index = 0;
    this.request = 0;
    this.strip = null;
    if (this.container) {
      this.image = this.container.querySelector('.comic-page');
      this.label = this.container.querySelector('.comic-label');
      this.counter = this.container.querySelector('.comic-counter');
      const close = this.container.querySelector('.comic-close');
      if (close) close.addEventListener('click', () => this.close(true));
      this.previous = this.container.querySelector('.comic-previous');
      this.next = this.container.querySelector('.comic-next');
      this.previous?.addEventListener('click', () => this.go(-1));
      this.next?.addEventListener('click', () => this.go(1));
      this.stripHost = this.container.querySelector('.comic-strip');
      this.modeButton = this.container.querySelector('.comic-mode');
      this.modeButton?.addEventListener('click', () => this.switchMode());
      // The strip reports the page under the top of the viewport, which is
      // what "where am I" means when nothing is turning.
      this.strip = window.BlazingReadingMode?.createStrip(this.stripHost, {
        onPage: (index) => { this.index = index; this.updateCounter(); },
      }) || null;
      this.paintMode();
    }
    this.bindKeys();
  }

  mode() { return window.BlazingReadingMode?.get() === 'strip' ? 'strip' : 'paged'; }

  paintMode() {
    const strip = this.mode() === 'strip';
    if (this.modeButton) this.modeButton.textContent = strip ? 'Page by page' : 'Continuous scroll';
    if (this.image) this.image.hidden = strip;
    if (this.stripHost) this.stripHost.hidden = !strip;
    // A page turn is meaningless in a continuous strip, so those two buttons
    // go away rather than sit there doing nothing.
    if (this.previous) this.previous.hidden = strip;
    if (this.next) this.next.hidden = strip;
  }

  switchMode() {
    window.BlazingReadingMode?.toggle();
    this.paintMode();
    this.render();
    if (this.mode() === 'strip') this.stripHost?.focus();
  }

  bindKeys() {
    const handler = (event) => this.handleKey(event);
    // On the CONTAINER first. dpad.js listens on `document` and drags focus to
    // whatever button is nearest on every arrow key; an event that reaches it
    // loses the page turn — or, in strip mode, the scroll — to a focus jump.
    // Bubbling hits the container before the document, so this wins whenever
    // focus is inside the reader, which is where the reader puts it.
    this.container?.addEventListener('keydown', handler);
    // The window listener is the fallback for focus that escaped the overlay.
    // Guarded so a key never counts twice.
    window.addEventListener('keydown', handler);
  }

  handleKey(event) {
    if (!this.container || this.container.hidden) return;
    if (event.blazingComicHandled) return;
    const key = event.key;
    const strip = this.mode() === 'strip';
    if (key === 'Tab') {
      const buttons = [...this.container.querySelectorAll('button:not(:disabled):not([hidden])')];
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    } else if (key === 'Escape' || key === 'Backspace' || key === 'BrowserBack') {
      this.close(true);
    } else if (strip && (key === 'PageDown' || key === 'PageUp')) {
      this.strip?.leap(key === 'PageUp' ? -1 : 1);
    } else if (strip && ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(key)) {
      this.strip?.nudge(key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1);
    } else if (key === 'ArrowRight' || key === 'PageDown' || key === 'ArrowDown') {
      this.go(1);
    } else if (key === 'ArrowLeft' || key === 'PageUp' || key === 'ArrowUp') {
      this.go(-1);
    } else {
      return;
    }
    event.blazingComicHandled = true;
    event.preventDefault();
    event.stopPropagation();
  }

  async open(comicId, name) {
    if (!this.container) return;
    const request = ++this.request;
    this.returnFocus = document.activeElement;
    this.pages = [];
    this.strip?.clear();
    if (this.image) this.image.removeAttribute('src');
    this.container.hidden = false;
    this.paintMode();
    this.container.querySelector('.comic-close')?.focus();
    document.body.classList.add('no-scroll');
    this.setLabel(name || 'Loading…', '');
    try {
      const chapters = await this.json(`/comics/${encodeURIComponent(comicId)}/chapters`);
      if (request !== this.request) return;
      // `readable:false` means the fleet cannot unpack that archive. Offering it
      // would open a reader onto nothing.
      const first = (chapters.chapters || []).find((c) => c && c.readable);
      if (!first) return this.fail('This comic has no readable chapters.');
      const pages = await this.json(`/comics/chapter/${encodeURIComponent(first.id)}/pages`);
      if (request !== this.request) return;
      const list = Array.isArray(pages.pages) ? pages.pages : [];
      if (!list.length) return this.fail('This chapter has no pages.');
      this.pages = list.map((p) => (/^https?:/.test(p) ? p : `${this.base}${p}`));
      this.index = 0;
      this.setLabel(pages.label || name || 'Comic', '');
      this.render();
    } catch (e) {
      if (request !== this.request) return;
      this.fail('Could not reach the comics library.');
    }
  }

  async json(path) {
    const r = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    return r.json();
  }

  fail(message) {
    this.pages = [];
    this.strip?.clear();
    if (this.image) this.image.removeAttribute('src');
    this.setLabel(message, '');
  }

  setLabel(text, counter) {
    if (this.label) this.label.textContent = text;
    if (this.counter) this.counter.textContent = counter;
  }

  updateCounter() {
    if (this.counter && this.pages.length) this.counter.textContent = `${this.index + 1} / ${this.pages.length}`;
  }

  go(step) {
    if (!this.pages.length) return;
    const next = this.index + step;
    if (next < 0 || next >= this.pages.length) return;
    this.index = next;
    this.render();
  }

  render() {
    if (!this.pages.length) return;
    if (this.mode() === 'strip') {
      if (!this.strip) return;
      // setPages is idempotent, so calling it on every paint is free and a new
      // chapter with the same page count still rebuilds.
      this.strip.setPages(this.pages, 'Page');
      this.strip.goToPage(this.index);
      this.updateCounter();
      return;
    }
    if (!this.image) return;
    this.image.src = this.pages[this.index];
    this.image.alt = `${this.label?.textContent || 'Comic'} · Page ${this.index + 1}`;
    if (this.previous) this.previous.disabled = this.index === 0;
    if (this.next) this.next.disabled = this.index === this.pages.length - 1;
    this.updateCounter();
    // One page ahead only. Prefetching a whole 169-page chapter over a TV's
    // connection would stall the page that is actually on screen.
    const ahead = this.pages[this.index + 1];
    if (ahead) new Image().src = ahead;
  }

  close(restoreFocus = false) {
    ++this.request;
    if (!this.container) return;
    this.container.hidden = true;
    document.body.classList.remove('no-scroll');
    if (this.image) this.image.removeAttribute('src');
    this.strip?.clear();
    this.pages = [];
    if (restoreFocus && this.returnFocus?.isConnected && this.returnFocus.getClientRects().length) this.returnFocus.focus();
    this.returnFocus = null;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.comicReader = new TVComicReader(
    'comic-reader',
    window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com',
  );
});
