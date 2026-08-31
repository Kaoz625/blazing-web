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
 *   GET /manga/chapter/<id>/pages       -> { pages: [path|url], error? }
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
    const { status, rows } = refs();
    rows.dataset.loaded = 'true';
    status.textContent = 'Loading…';
    rows.replaceChildren();
    const data = await fetchJSON(`${FLEET_BASE}/manga/discover?limit=20`);
    if (!allowed()) return; // downgraded while the request was in flight
    if (!data) {
      status.textContent = 'Could not reach the manga library.';
      rows.dataset.loaded = 'false';
      return;
    }
    const popular = (Array.isArray(data.popular) ? data.popular : []).map(normalizeManga).filter(Boolean);
    const latest = (Array.isArray(data.latest) ? data.latest : []).map(normalizeManga).filter(Boolean);
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
    const { status, rows } = refs();
    rows.dataset.loaded = 'true';
    status.textContent = `Searching for "${query}"…`;
    rows.replaceChildren();
    const data = await fetchJSON(`${FLEET_BASE}/manga/search?q=${encodeURIComponent(query)}&limit=20`);
    if (!allowed()) return;
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
    if (!allowed()) { closeChapters(); return; } // downgraded mid-fetch
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
    const request = (state.episodeRequest = (state.episodeRequest || 0) + 1);
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
    if (request !== state.episodeRequest) return;
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
    const { dialog } = refs();
    if (dialog && dialog.open) dialog.close();
  }

  // ---- reader -----------------------------------------------------------
  // Same behavior as tv-comics-reader.js's TVComicReader: one page ahead
  // prefetched, arrow/page keys turn pages, Escape closes.

  const readerState = { pages: [], index: 0 };

  function readerRender() {
    const r = readerRefs();
    if (!r || !r.image || !readerState.pages.length) return;
    r.image.src = readerState.pages[readerState.index];
    if (r.counter) r.counter.textContent = `${readerState.index + 1} / ${readerState.pages.length}`;
    const ahead = readerState.pages[readerState.index + 1];
    if (ahead) new Image().src = ahead;
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
    if (r && r.image) r.image.removeAttribute('src');
    if (r && r.label) r.label.textContent = message;
    if (r && r.counter) r.counter.textContent = '';
  }

  function closeReader() {
    const r = readerRefs();
    if (!r) return;
    r.container.hidden = true;
    document.body.classList.remove('no-scroll');
    if (r.image) r.image.removeAttribute('src');
    readerState.pages = [];
  }

  async function openReader(manga, chapter) {
    if (!allowed()) return; // re-checked: a profile switch can land between click and open
    const r = readerRefs();
    if (!r) return;
    r.container.hidden = false;
    document.body.classList.add('no-scroll');
    if (r.label) r.label.textContent = `${manga.title} · Chapter ${chapter.number}`;
    if (r.counter) r.counter.textContent = '';
    readerState.pages = [];
    readerState.index = 0;

    const data = await fetchJSON(`${FLEET_BASE}/manga/chapter/${encodeURIComponent(chapter.id)}/pages`);
    if (!allowed()) { closeReader(); return; } // downgraded mid-fetch
    if (!data) return readerFail('Could not load this chapter’s pages.');

    const why = plainText(data.error);
    const pages = (Array.isArray(data.pages) ? data.pages : []).map(absolute).filter(Boolean);
    if (!pages.length) return readerFail(why || 'Could not load this chapter’s pages.');

    readerState.pages = pages;
    readerState.index = 0;
    readerRender();
  }

  function bindReaderKeys() {
    window.addEventListener('keydown', (event) => {
      const r = readerRefs();
      if (!r || r.container.hidden) return;
      const key = event.key;
      if (key === 'ArrowRight' || key === 'PageDown' || key === 'ArrowDown') readerGo(1);
      else if (key === 'ArrowLeft' || key === 'PageUp' || key === 'ArrowUp') readerGo(-1);
      else if (key === 'Escape' || key === 'Backspace') closeReader();
      else return;
      event.preventDefault();
    });
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
    const reader = document.getElementById('manga-reader');
    if (reader) {
      const close = reader.querySelector('.comic-close');
      if (close) close.addEventListener('click', closeReader);
    }
    bindReaderKeys();
  }

  function mount() {
    if (!state.mounted) {
      state.mounted = true;
      bindOnce();
    }
    renderGate();
  }

  // Same broadcast profile.js has fired on every switch since it was
  // written — see app.js's own listener a few lines from its ratingAllowed().
  // A profile switch must re-check what is ALREADY open, not just what loads
  // next: BRK-14 on the Roku side was exactly a row filtered once at fetch
  // time and never re-filtered on switch.
  document.addEventListener('blazing-profile-selected', (event) => {
    const detail = (event && event.detail) || {};
    state.isKids = detail.isKids === true;
    state.cap = detail.maxRating || null;
    if (state.mounted) renderGate();
  });

  window.BlazingManga = { mount, openEpisode };
})();
