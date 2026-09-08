/* Blazing web Manga — a fleet-backed manga discovery reader, the feature this
 * client alone lacked (Roku, Fire TV and Apple TV all have it). Built
 * directly against roku channels/source/lib/Manga.brs and
 * components/screens/{MangaChaptersScreen,MangaReaderScreen}.brs, and reuses
 * tv-comics-reader.js's own reader shape (arrow keys, one-page-ahead
 * prefetch, Escape closes) since a manga chapter and a comic chapter are the
 * same "ordered image pages" problem.
 *
 * MATURE SECTION — same policy as Roku's mangaAllowedNow() (MainScene.brs):
 *   "Manga has no per-title server tiers and includes suggestive titles.
 *    Match the Fire TV policy: it is a Mature section, so Kids, Guest and
 *    Teen fail closed; Mature and Adult profiles may open it."
 * No profile chosen yet reads as the strictest cap, same as app.js's own
 * ratingAllowed(): "NO PROFILE MEANS THE STRICTEST CAP, not 'no cap'."
 *
 * WIRE CONTRACT (fleet.lyreosai.com, blazing-fleet repo):
 *   GET /manga/discover?limit=<n>       -> { popular: [Manga], latest: [Manga] }
 *   GET /manga/search?q=<q>&limit=<n>   -> { manga: [Manga] }
 *   GET /manga/<id>/chapters?limit=<n>  -> { chapters: [Chapter] | { list:[Chapter], error, via }, error? }
 *   GET /manga/chapter/<id>/pages       -> { pages: [path|url] | { list:[path|url], error }, error? }
 *   Manga:   { id, title, aliases[], description, year, status,
 *              originalLanguage, lastChapter, cover, source }
 *   Chapter: { id, chapter, volume, title, pages, readable }
 *   Cover/page paths come back RELATIVE (/manga/image?...) and are
 *   absolute-ised here, same as MangaClient.kt's absolute() and
 *   Manga.brs's MangaAbsoluteUrl().
 *
 * Both chapter-list shapes are read on purpose. Manga.brs carries a whole
 * comment about this: the fleet moved the list inside an object once and a
 * client that only understood a bare array showed zero chapters for EVERY
 * title, licensed or not, and lost the "why" message that moved with it.
 */
'use strict';

(() => {
  const FLEET_BASE = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  const FETCH_TIMEOUT_MS = 20000;
  const CHAPTERS_TIMEOUT_MS = 90000;
  const RATINGS = ['general', 'teen', 'mature', 'adult'];
  const MATURE_INDEX = RATINGS.indexOf('mature');

  const state = {
    mounted: false,
    isKids: true, // fail closed until profile.js says otherwise — locker.js's own default, same reason
    cap: null,    // no profile yet = the strictest cap, not "no cap"
    profileId: null,
    generation: 0,
    chapterRequest: 0,
    readerRequest: 0,
  };

  function allowed() {
    if (state.isKids) return false;
    const idx = RATINGS.indexOf(String(state.cap || '').toLowerCase());
    return idx >= MATURE_INDEX;
  }

  function element(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function plainText(value, fallback = '') {
    const out = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return out ? out.slice(0, 600) : fallback;
  }

  function safeHttpsUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function setBackground(node, value) {
    const image = safeHttpsUrl(value);
    node.style.backgroundImage = image
      ? `linear-gradient(90deg, rgba(10,10,11,.98) 0%, rgba(10,10,11,.7) 42%, rgba(10,10,11,.15) 100%), url("${image.replace(/"/g, '%22')}")`
      : '';
  }

  // /manga/image?... paths come back relative; already-absolute urls (and
  // protocol-relative //) survive untouched, matching MangaAbsoluteUrl().
  function absolute(path) {
    const value = String(path || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('//')) return `https:${value}`;
    return value.startsWith('/') ? `${FLEET_BASE}${value}` : `${FLEET_BASE}/${value}`;
  }

  async function fetchJSON(url, timeoutMs = FETCH_TIMEOUT_MS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function refs() {
    return {
      view: document.getElementById('manga-view'),
      form: document.getElementById('manga-search-form'),
      input: document.getElementById('manga-search-input'),
      status: document.getElementById('manga-status'),
      rows: document.getElementById('manga-rows'),
      dialog: document.getElementById('manga-chapters-dialog'),
      dclose: document.getElementById('manga-chapters-close'),
      dtitle: document.getElementById('manga-chapters-title'),
      dmeta: document.getElementById('manga-chapters-meta'),
      ddesc: document.getElementById('manga-chapters-desc'),
      dstatus: document.getElementById('manga-chapters-status'),
      dlist: document.getElementById('manga-chapters-list'),
      dart: document.getElementById('manga-chapters-art'),
    };
  }

  function readerRefs() {
    const container = document.getElementById('manga-reader');
    if (!container) return null;
    return {
      container,
      image: container.querySelector('.comic-page'),
      label: container.querySelector('.comic-label'),
      counter: container.querySelector('.comic-counter'),
      strip: container.querySelector('.comic-strip'),
      mode: container.querySelector('.comic-mode'),
      previous: container.querySelector('.manga-previous'),
      next: container.querySelector('.manga-next'),
    };
  }

  function normalizeManga(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = plainText(raw.id);
    const title = plainText(raw.title);
    if (!id || !title) return null;
    return {
      id,
      title,
      description: plainText(raw.description),
      year: plainText(raw.year),
      status: plainText(raw.status),
      originalLanguage: plainText(raw.originalLanguage),
      lastChapter: plainText(raw.lastChapter),
      cover: absolute(raw.cover),
      // The fleet aggregates several scanlation sources and says which one
      // answered — dropping it is what made a search return duplicate rows
      // with no way to tell which was worth opening (Manga.brs's own note).
      source: plainText(raw.source),
    };
  }

  function shelfCard(manga) {
    const button = element('button', 'card');
    button.type = 'button';
    button.setAttribute('aria-label', `See chapters for ${manga.title}`);
    const image = element('img', 'card-image');
    image.loading = 'lazy';
    image.decoding = 'async';
    image.alt = '';
    if (manga.cover) image.src = manga.cover;
    else button.classList.add('no-image');
    if (manga.source) {
      const source = element('span', 'card-source');
      source.textContent = manga.source;
      button.appendChild(source);
    }
    const label = element('span', 'card-label');
    label.textContent = manga.title;
    button.append(image, label);
    button.addEventListener('click', () => openChapters(manga));
    return button;
  }

  function shelf(name, items) {
    if (!items.length) return null;
    const section = element('section', 'row');
    section.dataset.name = name;
    const heading = element('h2', 'row-title');
    heading.textContent = name;
    const track = element('div', 'row-track');
    track.append(...items.map(shelfCard));
    section.append(heading, track);
    return section;
  }

  function renderGate() {
    const { view, status, rows } = refs();
    if (!view) return;
    if (!allowed()) {
      closeReader();
      closeChapters();
      status.textContent = 'Manga is a Mature section. Switch to a Mature or Adult profile to open it.';
      rows.replaceChildren();
      rows.dataset.loaded = 'false';
      return;
    }
    if (rows.dataset.loaded === 'true') return;
    loadDiscover();
  }

  async function loadDiscover() {
    const request = ++state.generation;
    const { status, rows } = refs();
    rows.dataset.loaded = 'true';
    status.textContent = 'Loading…';
    rows.replaceChildren();
    const data = await fetchJSON(`${FLEET_BASE}/manga/discover?limit=20`);
    if (!allowed() || request !== state.generation) return;
    if (!data) {
      status.textContent = 'Could not reach the manga library.';
      rows.dataset.loaded = 'false';
      return;
    }
    const popular = (Array.isArray(data.popular) ? data.popular : []).map(normalizeManga).filter(Boolean);
    const ids = new Set(popular.map((item) => item.id));
    const latest = (Array.isArray(data.latest) ? data.latest : []).map(normalizeManga).filter((item) => item && !ids.has(item.id));
    const sections = [shelf('Popular', popular), shelf('Latest', latest)].filter(Boolean);
    if (!sections.length) {
      status.textContent = 'No manga is available right now.';
      rows.dataset.loaded = 'false';
      return;
    }
    status.textContent = '';
    rows.replaceChildren(...sections);
  }

  async function runSearch(query) {
    const request = ++state.generation;
    const { status, rows } = refs();
    rows.dataset.loaded = 'true';
    status.textContent = `Searching for "${query}"…`;
    rows.replaceChildren();
    const data = await fetchJSON(`${FLEET_BASE}/manga/search?q=${encodeURIComponent(query)}&limit=20`);
    if (!allowed() || request !== state.generation) return;
    if (!data) {
      status.textContent = 'Manga search could not be completed.';
      rows.dataset.loaded = 'false';
      return;
    }
    const items = (Array.isArray(data.manga) ? data.manga : []).map(normalizeManga).filter(Boolean);
    if (!items.length) {
      status.textContent = `No manga matched "${query}".`;
      rows.replaceChildren();
      return;
    }
    status.textContent = '';
    rows.replaceChildren(shelf(`Results for "${query}"`, items));
  }

  // ---- chapters dialog ------------------------------------------------

  function chapterList(rawChapters) {
    if (Array.isArray(rawChapters)) return { list: rawChapters, error: '' };
    if (rawChapters && typeof rawChapters === 'object') {
      return {
        list: Array.isArray(rawChapters.list) ? rawChapters.list : [],
        error: plainText(rawChapters.error),
      };
    }
    return { list: [], error: '' };
  }

  function chapterRow(manga, chapter) {
    const id = plainText(chapter && chapter.id);
    const number = plainText(chapter && chapter.chapter, '?');
    const title = plainText(chapter && chapter.title);
    const pages = Number(chapter && chapter.pages) || 0;
    const readable = Boolean(chapter) && chapter.readable === true;

    const row = element('div', readable ? 'stream-row' : 'stream-row dead');
    const info = element('div', 'stream-info');
    const label = element('span', 'stream-title');
    label.textContent = `Chapter ${number}${title ? ` — ${title}` : ''}`;
    const tags = element('span', 'stream-tags');
    tags.textContent = readable
      ? `${pages || '?'} page${pages === 1 ? '' : 's'}`
      : 'Not available here — likely licensed and redirected to a publisher reader';
    info.append(label, tags);
    row.appendChild(info);

    if (readable && id) {
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      const open = () => openReader(manga, { id, number, title });
      row.addEventListener('click', open);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
    } else {
      row.setAttribute('aria-disabled', 'true');
    }
    return row;
  }

  async function openChapters(manga) {
    if (!allowed()) return; // the gate can close between a card render and a click
    const request = ++state.chapterRequest;
    const { dialog, dtitle, dmeta, ddesc, dstatus, dlist, dart } = refs();
    if (!dialog) return;
    dtitle.textContent = manga.title;
    setBackground(dart, manga.cover);

    const bits = [];
    if (manga.year) bits.push(manga.year);
    if (manga.status) bits.push(manga.status.charAt(0).toUpperCase() + manga.status.slice(1));
    if (manga.lastChapter) bits.push(`Through chapter ${manga.lastChapter}`);
    if (manga.originalLanguage) bits.push(manga.originalLanguage.toUpperCase());
    dmeta.textContent = bits.join('  ·  ');
    ddesc.textContent = manga.description;
    dstatus.textContent = 'Loading chapters…';
    dlist.replaceChildren();
    if (typeof dialog.showModal === 'function') dialog.showModal();

    const data = await fetchJSON(
      `${FLEET_BASE}/manga/${encodeURIComponent(manga.id)}/chapters?limit=2000`,
      CHAPTERS_TIMEOUT_MS,
    );
    if (!allowed() || request !== state.chapterRequest) return;
    if (!data) {
      dstatus.textContent = 'Could not load this manga’s chapters.';
      return;
    }

    const topError = plainText(data.error);
    const { list, error } = chapterList(data.chapters);
    const why = topError || error;

    if (!list.length) {
      dstatus.textContent = why
        || 'No English chapters are available. This often means the title is officially licensed and removed from this source.';
      return;
    }

    const readableCount = list.filter((c) => c && c.readable === true).length;
    dstatus.textContent = readableCount === 0
      ? `All ${list.length} chapters point to a publisher reader, so their pages are not available here.`
      : `${readableCount} readable chapter${readableCount === 1 ? '' : 's'} of ${list.length}`;
    dlist.replaceChildren(...list.map((c) => chapterRow(manga, c)));
  }

  /**
   * Open only the chapter range the fleet mapped to one selected anime
   * episode. The full chapter list is deliberately not fetched here: the
   * episode-map response is the boundary, and its exact flag owns the wording.
   */
  async function openEpisode(context) {
    if (!allowed()) return;
    const title = plainText(context && context.title);
    const episode = Math.floor(Number(context && context.episode));
    if (!title || episode < 1) return;
    const { dialog, dtitle, dmeta, ddesc, dstatus, dlist, dart } = refs();
    if (!dialog) return;
    const request = ++state.chapterRequest;
    dtitle.textContent = title;
    dmeta.textContent = `Season ${Math.floor(Number(context.season) || 1)}  ·  Episode ${episode}`;
    ddesc.textContent = plainText(context.episodeTitle, 'Manga chapters for this episode.');
    dstatus.textContent = 'Matching this episode to manga chapters…';
    dlist.replaceChildren();
    setBackground(dart, '');
    if (typeof dialog.showModal === 'function') dialog.showModal();

    const query = new URLSearchParams();
    const put = (key, value) => {
      if (value !== undefined && value !== null && String(value).trim() !== '') query.set(key, String(value));
    };
    put('title', title);
    put('animeId', context.animeId);
    put('season', context.season || 1);
    put('episode', episode);
    put('absoluteEpisode', context.absoluteEpisode || episode);
    put('episodeTitle', context.episodeTitle);
    put('episodeCount', context.episodeCount);
    put('mangaId', context.mangaId);
    const data = await fetchJSON(`${FLEET_BASE}/manga/episode-map?${query.toString()}`, CHAPTERS_TIMEOUT_MS);
    if (request !== state.chapterRequest) return;
    if (!allowed()) { closeChapters(); return; }
    if (!data || !data.mapping || !data.manga || !Array.isArray(data.chapters) || !data.chapters.length) {
      dstatus.textContent = plainText(data && data.error, 'No readable manga chapters matched this episode.');
      return;
    }

    const manga = normalizeManga({
      ...data.manga,
      id: data.manga.id,
      title: data.manga.title || title,
    });
    if (!manga) {
      dstatus.textContent = 'The mapped manga record was not usable.';
      return;
    }
    dtitle.textContent = manga.title;
    const mapping = data.mapping;
    const start = mapping.chapterStart;
    const end = mapping.chapterEnd;
    const range = start == null ? ''
      : (String(start) === String(end) ? `chapter ${start}` : `chapters ${start}–${end}`);
    dstatus.textContent = `${mapping.exact === true ? 'Exact match' : 'Estimated match'}${range ? ` · ${range}` : ''}`;
    dlist.replaceChildren(...data.chapters.map((chapter) => chapterRow(manga, chapter)));
  }

  function closeChapters() {
    ++state.chapterRequest;
    const { dialog } = refs();
    if (dialog && dialog.open) dialog.close();
  }

  // ---- reader -----------------------------------------------------------
  // Same behavior as tv-comics-reader.js's TVComicReader: one page ahead
  // prefetched, arrow/page keys turn pages, Escape closes.

  const readerState = { pages: [], index: 0, manga: null, chapter: null, returnFocus: null, returnChapters: false };
  const HISTORY_KEY = 'blazing-manga-progress-v1:';
  function history() {
    if (!state.profileId || !allowed()) return [];
    try {
      const data = JSON.parse(localStorage.getItem(HISTORY_KEY + encodeURIComponent(state.profileId)) || '[]');
      return (Array.isArray(data) ? data : []).filter((item) => item?.manga?.id && item?.chapter?.id && Number.isInteger(item.index) && item.index >= 0).slice(0, 24);
    } catch { return []; }
  }
  function saveProgress() {
    if (!allowed() || !state.profileId || !readerState.pages.length || !readerState.manga || !readerState.chapter) return;
    const record = { manga: readerState.manga, chapter: readerState.chapter, index: readerState.index, total: readerState.pages.length, updatedAt: Date.now() };
    const records = [record, ...history().filter((item) => item.manga.id !== record.manga.id)].slice(0, 24);
    try { localStorage.setItem(HISTORY_KEY + encodeURIComponent(state.profileId), JSON.stringify(records)); } catch { return; }
    renderHistory();
    document.dispatchEvent(new CustomEvent('blazing-reading-progress'));
  }
  function historySection(records = history()) {
    const section = element('section', 'manga-history');
    const heading = element('h2', 'row-title'); heading.textContent = 'Continue reading';
    const grid = element('div', 'manga-history-grid');
    for (const record of records) {
      const button = element('button', 'manga-history-item'); button.type = 'button';
      button.dataset.mangaId = record.manga.id;
      const image = element('img'); image.alt = ''; image.loading = 'lazy';
      const cover = safeHttpsUrl(record.manga.cover); if (cover) image.src = cover;
      const body = element('span');
      const title = element('strong'); title.textContent = plainText(record.manga.title);
      const place = element('span'); place.textContent = `Chapter ${plainText(record.chapter.number)} · Page ${record.index + 1} of ${record.total}`;
      body.append(title, place); button.append(image, body);
      button.addEventListener('click', () => { ensureBound(); openReader(record.manga, record.chapter, record.index); });
      grid.append(button);
    }
    section.append(heading, grid); return section;
  }
  function renderHistory() {
    const host = document.getElementById('manga-continue'); if (!host) return;
    const records = history(); host.replaceChildren(...(records.length ? [historySection(records)] : []));
  }

  /* ── Continuous top-to-bottom reading ───────────────────────────────────
   * A real viewer asked for this and Markus passed it on: "he said it makes it
   * feel more like a movie." Manga is the section where it matters most —
   * webtoons are DRAWN as one vertical strip, and paging them cuts the artwork
   * into arbitrary slices. Paged reading stays, because some series are drawn
   * as pages; tv-reading-mode.js owns the choice and the eased scroller, and
   * the choice is remembered per device. */
  let stripRail = null;
  // MANGA OPENS ON THE STRIP. That is the whole of what the viewer asked for,
  // and a default is the only way to actually give it to him: with the shared
  // paged default he opens a chapter, sees page-by-page, and has to discover a
  // button to get the thing he requested. Comics and books call get() bare and
  // stay paged — see tv-reading-mode.js's get() for why the difference lives
  // here at the call and never in the store.
  const readingMode = () => (window.BlazingReadingMode?.get('strip') === 'strip' ? 'strip' : 'paged');

  function ensureStrip() {
    const r = readerRefs();
    if (!r || !r.strip) return null;
    if (!stripRail) {
      stripRail = window.BlazingReadingMode?.createStrip(r.strip, {
        onPage: (index) => {
          readerState.index = index;
          if (r.counter && readerState.pages.length) r.counter.textContent = `${index + 1} / ${readerState.pages.length}`;
          saveProgress();
        },
      }) || null;
    }
    return stripRail;
  }

  function paintReaderMode() {
    const r = readerRefs(); if (!r) return;
    const strip = readingMode() === 'strip';
    if (r.mode) r.mode.textContent = strip ? 'Page by page' : 'Continuous scroll';
    if (r.image) r.image.hidden = strip;
    if (r.strip) r.strip.hidden = !strip;
    // A page turn means nothing in a continuous strip.
    if (r.previous) r.previous.hidden = strip;
    if (r.next) r.next.hidden = strip;
  }

  function switchReaderMode() {
    // Same fallback as readingMode(), or the first press on a reader that
    // opened on the strip would "switch" to the strip it is already showing.
    window.BlazingReadingMode?.toggle('strip');
    paintReaderMode();
    readerRender();
    if (readingMode() === 'strip') readerRefs()?.strip?.focus();
  }

  function readerRender() {
    const r = readerRefs();
    if (!r || !readerState.pages.length) return;
    if (readingMode() === 'strip') {
      const rail = ensureStrip();
      if (!rail) return;
      // setPages is idempotent — it compares the URLs, so a mode toggle keeps
      // the scroll position and a new chapter with the same page count still
      // rebuilds.
      rail.setPages(readerState.pages, readerState.manga?.title || 'Page');
      rail.goToPage(readerState.index);
      if (r.counter) r.counter.textContent = `${readerState.index + 1} / ${readerState.pages.length}`;
      saveProgress();
      return;
    }
    if (!r.image) return;
    const request = state.readerRequest;
    const pageIndex = readerState.index;
    r.image.onload = () => { if (request === state.readerRequest && pageIndex === readerState.index) saveProgress(); };
    r.image.onerror = () => { if (request === state.readerRequest && r.counter) r.counter.textContent = `Page ${pageIndex + 1} could not load. Try another page.`; };
    r.image.src = readerState.pages[readerState.index];
    r.image.alt = `${readerState.manga?.title || 'Manga'} · Page ${readerState.index + 1}`;
    if (r.counter) r.counter.textContent = `${readerState.index + 1} / ${readerState.pages.length}`;
    const ahead = readerState.pages[readerState.index + 1];
    if (ahead) new Image().src = ahead;
    r.container.querySelector('.manga-previous').disabled = readerState.index === 0;
    r.container.querySelector('.manga-next').disabled = readerState.index === readerState.pages.length - 1;
  }

  function readerGo(step) {
    const next = readerState.index + step;
    if (next < 0 || next >= readerState.pages.length) return;
    readerState.index = next;
    readerRender();
  }

  function readerFail(message) {
    const r = readerRefs();
    readerState.pages = [];
    stripRail?.clear();
    if (r && r.image) r.image.removeAttribute('src');
    if (r && r.label) r.label.textContent = message;
    if (r && r.counter) r.counter.textContent = '';
  }

  function closeReader({ restoreFocus = false } = {}) {
    ++state.readerRequest;
    const r = readerRefs();
    if (!r) return;
    r.container.hidden = true;
    document.body.classList.remove('no-scroll');
    stripRail?.clear();
    if (r.image) { r.image.onload = null; r.image.onerror = null; r.image.removeAttribute('src'); }
    if (restoreFocus && allowed()) {
      const dialog = refs().dialog;
      if (readerState.returnChapters && dialog && !dialog.open) dialog.showModal();
      let target = readerState.returnFocus;
      if (!target?.isConnected || !target.getClientRects().length) {
        target = [...document.querySelectorAll('.manga-history-item')].find((el) => el.dataset.mangaId === readerState.manga?.id && el.getClientRects().length);
      }
      if (target?.getClientRects().length) target.focus();
    }
    readerState.pages = [];
    readerState.manga = null; readerState.chapter = null;
    readerState.returnFocus = null; readerState.returnChapters = false;
  }

  async function openReader(manga, chapter, resumeIndex) {
    if (!allowed()) return; // re-checked: a profile switch can land between click and open
    const request = ++state.readerRequest;
    readerState.returnFocus = document.activeElement;
    readerState.returnChapters = Boolean(refs().dialog?.open);
    closeChapters();
    const r = readerRefs();
    if (!r) return;
    r.container.hidden = false;
    document.body.classList.add('no-scroll');
    if (r.label) r.label.textContent = `${manga.title} · Chapter ${chapter.number}`;
    if (r.counter) r.counter.textContent = '';
    readerState.pages = [];
    readerState.index = 0;
    readerState.manga = manga; readerState.chapter = chapter;
    stripRail?.clear();
    r.image.removeAttribute('src');
    paintReaderMode();
    r.container.querySelector('.comic-close')?.focus();

    const data = await fetchJSON(`${FLEET_BASE}/manga/chapter/${encodeURIComponent(chapter.id)}/pages`);
    if (!allowed() || request !== state.readerRequest) return;
    if (!data) return readerFail('Could not load this chapter’s pages.');

    // Older Suwayomi fleet builds wrap their {list,error} result in pages.
    // Read both shapes while devices and the fleet roll out independently.
    const result = data.pages;
    const why = plainText(data.error || result?.error);
    const list = Array.isArray(result) ? result : Array.isArray(result?.list) ? result.list : [];
    const pages = list.filter((page) => typeof page === 'string').map(absolute).filter(Boolean);
    if (!pages.length) return readerFail(why || 'Could not load this chapter’s pages.');

    readerState.pages = pages;
    const previous = history().find((item) => item.manga.id === manga.id && item.chapter.id === chapter.id);
    readerState.index = Math.max(0, Math.min(Number(resumeIndex ?? previous?.index) || 0, pages.length - 1));
    readerRender();
  }

  function bindReaderKeys() {
    const handler = (event) => {
      const r = readerRefs();
      if (!r || r.container.hidden) return;
      if (event.blazingMangaHandled) return;
      const key = event.key;
      const strip = readingMode() === 'strip';
      if (key === 'Tab') {
        const buttons = [...r.container.querySelectorAll('button:not(:disabled):not([hidden])')];
        const index = buttons.indexOf(document.activeElement);
        const next = index + (event.shiftKey ? -1 : 1);
        buttons[(next + buttons.length) % buttons.length]?.focus();
      } else if (key === 'Escape' || key === 'Backspace') {
        closeReader({ restoreFocus: true });
      } else if (strip && (key === 'PageDown' || key === 'PageUp')) {
        stripRail?.leap(key === 'PageUp' ? -1 : 1);
      } else if (strip && ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(key)) {
        stripRail?.nudge(key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1);
      } else if (key === 'ArrowRight' || key === 'PageDown' || key === 'ArrowDown') {
        readerGo(1);
      } else if (key === 'ArrowLeft' || key === 'PageUp' || key === 'ArrowUp') {
        readerGo(-1);
      } else {
        return;
      }
      event.blazingMangaHandled = true;
      event.preventDefault();
      event.stopPropagation();
    };
    // On the CONTAINER first, because dpad.js listens on `document` and drags
    // focus to the nearest button on every arrow key. Bubbling reaches the
    // container before the document, so the reader wins whenever focus is
    // inside it — which is where the reader puts it. The window listener is
    // the fallback for focus that escaped, guarded so no key counts twice.
    document.getElementById('manga-reader')?.addEventListener('keydown', handler);
    window.addEventListener('keydown', handler);
  }

  // ---- wiring -------------------------------------------------------------

  function bindOnce() {
    const { form, input, dclose } = refs();
    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!allowed()) return;
        const q = (input.value || '').trim();
        if (q) runSearch(q); else loadDiscover();
      });
    }
    if (dclose) dclose.addEventListener('click', closeChapters);
    refs().dialog?.addEventListener('cancel', () => { ++state.chapterRequest; });
    const reader = document.getElementById('manga-reader');
    if (reader) {
      const close = reader.querySelector('.comic-close');
      if (close) close.addEventListener('click', () => closeReader({ restoreFocus: true }));
      reader.querySelector('.manga-previous')?.addEventListener('click', () => readerGo(-1));
      reader.querySelector('.manga-next')?.addEventListener('click', () => readerGo(1));
      reader.querySelector('.comic-mode')?.addEventListener('click', switchReaderMode);
      paintReaderMode();
    }
    bindReaderKeys();
  }

  function ensureBound() {
    if (!state.mounted) {
      state.mounted = true;
      bindOnce();
    }
  }
  function mount() {
    ensureBound();
    renderHistory();
    renderGate();
  }

  // Same broadcast profile.js has fired on every switch since it was
  // written — see app.js's own listener a few lines from its ratingAllowed().
  // A profile switch must re-check what is ALREADY open, not just what loads
  // next: BRK-14 on the Roku side was exactly a row filtered once at fetch
  // time and never re-filtered on switch.
  document.addEventListener('blazing-profile-selected', (event) => {
    const detail = (event && event.detail) || {};
    ++state.generation;
    closeReader(); closeChapters();
    state.profileId = detail.id || null;
    state.isKids = detail.isKids === true;
    state.cap = detail.maxRating || null;
    const { rows, input } = refs();
    rows.replaceChildren(); rows.dataset.loaded = 'false'; input.value = '';
    renderHistory();
    if (state.mounted && !refs().view.hidden) renderGate();
  });
  document.addEventListener('blazing-profile-signed-out', () => {
    ++state.generation;
    state.profileId = null; state.cap = null; state.isKids = true;
    closeReader(); closeChapters(); renderHistory();
    const { rows, input } = refs(); rows.replaceChildren(); rows.dataset.loaded = 'false'; input.value = '';
  });
  function openTitle(raw) {
    ensureBound();
    const manga = normalizeManga(raw); if (manga) openChapters(manga);
  }
  window.BlazingManga = { mount, openEpisode: (context) => { ensureBound(); return openEpisode(context); }, openTitle, history, historySection };
})();
