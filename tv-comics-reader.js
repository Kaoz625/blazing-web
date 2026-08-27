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
 */
class TVComicReader {
  constructor(containerId, fleetBase) {
    this.container = document.getElementById(containerId);
    this.base = String(fleetBase || 'https://fleet.lyreosai.com').replace(/\/+$/, '');
    this.pages = [];
    this.index = 0;
    if (this.container) {
      this.image = this.container.querySelector('.comic-page');
      this.label = this.container.querySelector('.comic-label');
      this.counter = this.container.querySelector('.comic-counter');
      const close = this.container.querySelector('.comic-close');
      if (close) close.addEventListener('click', () => this.close());
    }
    this.bindKeys();
  }

  bindKeys() {
    window.addEventListener('keydown', (event) => {
      if (!this.container || this.container.hidden) return;
      const key = event.key;
      if (key === 'ArrowRight' || key === 'PageDown' || key === 'ArrowDown') this.go(1);
      else if (key === 'ArrowLeft' || key === 'PageUp' || key === 'ArrowUp') this.go(-1);
      else if (key === 'Escape' || key === 'Backspace' || key === 'BrowserBack') this.close();
      else return;
      event.preventDefault();
    });
  }

  async open(comicId, name) {
    if (!this.container) return;
    this.container.hidden = false;
    document.body.classList.add('no-scroll');
    this.setLabel(name || 'Loading…', '');
    try {
      const chapters = await this.json(`/comics/${encodeURIComponent(comicId)}/chapters`);
      // `readable:false` means the fleet cannot unpack that archive. Offering it
      // would open a reader onto nothing.
      const first = (chapters.chapters || []).find((c) => c && c.readable);
      if (!first) return this.fail('This comic has no readable chapters.');
      const pages = await this.json(`/comics/chapter/${encodeURIComponent(first.id)}/pages`);
      const list = Array.isArray(pages.pages) ? pages.pages : [];
      if (!list.length) return this.fail('This chapter has no pages.');
      this.pages = list.map((p) => (/^https?:/.test(p) ? p : `${this.base}${p}`));
      this.index = 0;
      this.setLabel(pages.label || name || 'Comic', '');
      this.render();
    } catch (e) {
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
    if (this.image) this.image.removeAttribute('src');
    this.setLabel(message, '');
  }

  setLabel(text, counter) {
    if (this.label) this.label.textContent = text;
    if (this.counter) this.counter.textContent = counter;
  }

  go(step) {
    if (!this.pages.length) return;
    const next = this.index + step;
    if (next < 0 || next >= this.pages.length) return;
    this.index = next;
    this.render();
  }

  render() {
    if (!this.image || !this.pages.length) return;
    this.image.src = this.pages[this.index];
    if (this.counter) this.counter.textContent = `${this.index + 1} / ${this.pages.length}`;
    // One page ahead only. Prefetching a whole 169-page chapter over a TV's
    // connection would stall the page that is actually on screen.
    const ahead = this.pages[this.index + 1];
    if (ahead) new Image().src = ahead;
  }

  close() {
    if (!this.container) return;
    this.container.hidden = true;
    document.body.classList.remove('no-scroll');
    if (this.image) this.image.removeAttribute('src');
    this.pages = [];
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.comicReader = new TVComicReader(
    'comic-reader',
    window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com',
  );
});
