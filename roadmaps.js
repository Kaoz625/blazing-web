/* Blazing web Roadmaps — every film AND series in a universe, in the order
 * worth watching them.
 *
 * B25. This chip opened a static product blurb: three fixed <article> cards
 * under "What is next" with no franchise data, no fetch and nothing to press,
 * while the Roku, the Fire Stick and the Apple TV all browsed 170 real
 * franchises behind the same word. Same chip, same word, an entirely different
 * and non-interactive screen.
 *
 * WHAT THIS IS A COPY OF. The three televisions are one screen written three
 * times and this is the fourth. Read them for the behaviour, not this file:
 *   roku    components/screens/RoadmapsScreen.{xml,brs}, source/lib/Roadmaps.brs
 *   firetv  client/app/src/main/java/com/nyctailblazers/blazingtv/RoadmapsActivity.kt
 *   tvos    Sources/Roadmaps.swift
 * Every string below — "Franchise Roadmaps", the subtitle, the card caption,
 * the stats line, the chapter subline, the order pill — is the string those
 * three already print, character for character.
 *
 * WIRE CONTRACT (fleet.lyreosai.com, blazing-fleet/roadmaps.js):
 *   GET /roadmaps
 *       -> { roadmaps: [{slug,name,overview,backdrop,poster,
 *                        titles,films,series,chapters}] }   chapters is a COUNT
 *   GET /roadmaps/<slug>
 *       -> { slug,name,overview,backdrop,poster,titles,films,series,
 *            chapters: [{name,note,items:[…]}] }            chapters is a LIST
 *       item: {id,tmdb,type,name,year,date,poster,backdrop,overview,genres,
 *              runtime,rating} plus `seasons` on a series.
 *
 * WHAT THE FLEET DOES NOT SEND, and every client therefore computes: no `years`
 * range, no per-chapter count, no running position, no chronological flag.
 * See `years`, `sections` and `stats` below — they are the tvOS versions.
 *
 * AND NOTHING HERE SORTS THE SAGA ORDER. The fleet's chapter order IS the
 * feature; a client that quietly reorders a watch order has thrown away the
 * thing it was asked to show. The order button is the one exception and it is
 * explicit, labelled, and only offers orders that are real — see `orders`.
 *
 * A COLD /roadmaps IS GENUINELY SLOW. The first build asks TMDB about roughly
 * 150 franchises; every call after that is a disk-cache read. The Roku allows
 * it 40s (source/lib/Roadmaps.brs) and so does this.
 */
'use strict';

(() => {
  const FLEET = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  const FETCH_TIMEOUT_MS = 40000;

  const state = {
    bound: false,
    cards: null,        // null = never fetched, [] = fetched and empty
    loadingIndex: false,
    detail: null,       // the normalised roadmap on screen, or null for the index
    slug: '',
    orderIndex: 0,
    request: 0,
    gate: '',           // the cap the rows on screen were filtered against
    services: null,
  };

  // ── small helpers, the same shapes games.js and anime-room.js use ──────────

  const node = (tag, cls, copy) => {
    const out = document.createElement(tag);
    if (cls) out.className = cls;
    if (copy) out.textContent = copy;
    return out;
  };

  const text = (value, limit = 600) =>
    String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);

  /* Same rule app.js's safeHttpsUrl uses everywhere a catalogue value reaches an
     <img src> or a background-image: https only, so a bad upstream value can
     never become a javascript: or data: URI in the DOM. */
  const httpsUrl = (value) => {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  };

  /** A JSON number whichever numeric shape it arrived as. 0 when it did not. */
  const int = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  };

  async function fetchJSON(url) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      mode: 'cors',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  // ── the rules, all of them pure so roadmaps.test.mjs can hold them ─────────

  /**
   * One index card. A row with no slug or no name is not a franchise and is
   * dropped, the same way the Roku's RoadmapsList drops it.
   */
  function normaliseCard(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const slug = text(raw.slug, 120);
    const name = text(raw.name, 200);
    if (!slug || !name) return null;
    return {
      slug,
      name,
      overview: text(raw.overview),
      art: httpsUrl(raw.backdrop) || httpsUrl(raw.poster),
      titles: int(raw.titles),
      films: int(raw.films),
      series: int(raw.series),
      chapters: int(raw.chapters),
    };
  }

  /**
   * "54 titles  ·  6 chapters  ·  34 films, 33 series" — the site's own caption
   * plus the film/series split, which is the case Markus wanted surfaced.
   * Identical to RoadmapCardMeta (Roku) and RoadmapCard.caption (tvOS).
   */
  function cardCaption(card) {
    const bits = [`${card.titles} titles`];
    if (card.chapters > 1) bits.push(`${card.chapters} chapters`);
    if (card.films > 0 && card.series > 0) bits.push(`${card.films} films, ${card.series} series`);
    return bits.join('  ·  ');
  }

  /**
   * One title in a chapter.
   *
   * A row with a blank id or a blank name is DROPPED, and that matters beyond
   * tidiness: the Roku drops the same rows (RoadmapItems in lib/Roadmaps.brs),
   * so a row nobody can open must not take up a position number here either, or
   * the numbering stops meaning the same thing on the two devices.
   */
  function normaliseEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = text(raw.id, 120);
    const name = text(raw.name, 300);
    if (!id || !name) return null;
    const type = raw.type === 'series' ? 'series' : 'movie';
    return {
      id,
      name,
      type,
      isSeries: type === 'series',
      year: text(raw.year, 8),
      date: text(raw.date, 20),
      poster: httpsUrl(raw.poster),
      backdrop: httpsUrl(raw.backdrop),
      overview: text(raw.overview),
      seasons: int(raw.seasons),
      runtime: int(raw.runtime),
      /* A `tmdb:` id means TMDB knew the title but not its IMDb id. It still
         appears — dropping a film out of its own saga is worse than showing one
         that cannot open — but nothing tries to open it and the poster is
         dimmed, so the card says so before a press does. */
      playable: id.slice(0, 2) === 'tt',
    };
  }

  function normaliseDetail(raw, slug) {
    const chapters = [];
    if (raw && Array.isArray(raw.chapters)) {
      for (const chapter of raw.chapters) {
        if (!chapter || typeof chapter !== 'object') continue;
        const items = (Array.isArray(chapter.items) ? chapter.items : [])
          .map(normaliseEntry).filter(Boolean);
        if (!items.length) continue;
        chapters.push({ name: text(chapter.name, 200), note: text(chapter.note, 200), items });
      }
    }
    return {
      slug: text((raw && raw.slug) || slug, 120),
      name: text(raw && raw.name, 200),
      overview: text(raw && raw.overview),
      art: httpsUrl(raw && raw.backdrop) || httpsUrl(raw && raw.poster),
      titles: int(raw && raw.titles),
      films: int(raw && raw.films),
      series: int(raw && raw.series),
      chapters,
    };
  }

  /**
   * The release year as a number, or 0. `year` first, `date` as the fallback,
   * and anything under 1000 is treated as absent rather than allowed to drag a
   * chapter's range back to the start of the calendar.
   */
  function releaseYear(entry) {
    const y = Number(entry && entry.year);
    if (Number.isFinite(y) && y > 1000) return Math.trunc(y);
    const d = String((entry && entry.date) || '');
    if (d.length >= 4) {
      const fromDate = Number(d.slice(0, 4));
      if (Number.isFinite(fromDate) && fromDate > 1000) return fromDate;
    }
    return 0;
  }

  /**
   * A chapter's years range, from the min and max item year. The fleet sends no
   * `years` field, so this is it. A single year rather than "2006 - 2006" when
   * they match: rocky-and-creed's middle chapter holds exactly one film.
   *
   * AN ASCII HYPHEN, NOT AN EN DASH, and it is not a typographic preference: the
   * Roku's font helper cannot draw U+2013 and rendered the whole subline as
   * nothing, so the deployed channel reads "1977 - 1983". Three clients that are
   * copies of one screen must not differ over a dash.
   */
  function years(items) {
    const list = (items || []).map(releaseYear).filter((y) => y > 0);
    if (!list.length) return '';
    const lo = Math.min(...list);
    const hi = Math.max(...list);
    return lo === hi ? String(lo) : `${lo} - ${hi}`;
  }

  /**
   * The section subline, and ONLY what the televisions put in it:
   * "{years}  ·  {n} titles".
   *
   * The chapter's `note` is deliberately not appended. It looks like a third
   * clause going spare, but on every roadmap that has one it IS the years range
   * in a second format — rocky-and-creed sends note:"1976-1990" for the chapter
   * this code computes "1976 - 1990" for — so appending it renders
   * "1976 - 1990  ·  5 titles  ·  1976-1990".
   */
  function subline(section) {
    const bits = [];
    const span = years(section.items);
    if (span) bits.push(span);
    bits.push(section.items.length === 1 ? '1 title' : `${section.items.length} titles`);
    return bits.join('  ·  ');
  }

  /**
   * The chapters as numbered sections, in the order given, empty ones dropped.
   * Nothing is sorted.
   *
   * Numbering runs CONTINUOUSLY across chapters — chapter two's first entry
   * carries whatever number chapter one ended on — because the number is a
   * position in the watch order, not a position in a chapter.
   */
  function sections(chapters) {
    let at = 0;
    const out = [];
    (chapters || []).forEach((chapter, index) => {
      if (!chapter || !chapter.items || !chapter.items.length) return;
      out.push({ index, name: chapter.name, items: chapter.items, startAt: at + 1 });
      at += chapter.items.length;
    });
    return out;
  }

  function runtimeLabel(minutes) {
    const mins = int(minutes);
    if (mins <= 0) return '';
    const h = Math.floor(mins / 60);
    const m = mins - h * 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  /**
   * Minutes of FILM. Movies only: the fleet sends no runtime on a series at all,
   * and folding a season count into a minute total would invent a number rather
   * than report one.
   */
  function filmMinutes(chapters) {
    let total = 0;
    for (const chapter of chapters || []) {
      for (const entry of chapter.items || []) {
        if (!entry.isSeries) total += int(entry.runtime);
      }
    }
    return total;
  }

  /**
   * The header stats line:
   *   {titles} titles  ·  {films} films, {series} series  ·  {Xh Ym} of film
   * Each clause is dropped when its number is zero, because half of the fleet's
   * 170 roadmaps are films only and "0 series" is noise.
   */
  function stats(detail) {
    const bits = [];
    if (detail.titles === 1) bits.push('1 title');
    else if (detail.titles > 1) bits.push(`${detail.titles} titles`);
    if (detail.films > 0 && detail.series > 0) bits.push(`${detail.films} films, ${detail.series} series`);
    else if (detail.films > 0) bits.push(`${detail.films} films`);
    else if (detail.series > 0) bits.push(`${detail.series} series`);
    const mins = runtimeLabel(filmMinutes(detail.chapters));
    if (mins) bits.push(`${mins} of film`);
    return bits.join('  ·  ');
  }

  /**
   * The entry's own caption: the year, then a film's runtime or a show's season
   * count. The fleet sends `runtime` on a film and `seasons` on a show and no
   * episode count at all, so a show says seasons — which is the number that says
   * which of the two you are looking at when Films and Series share a roadmap.
   */
  function entryCaption(entry) {
    const bits = [];
    if (entry.year) bits.push(entry.year);
    if (entry.isSeries) {
      if (entry.seasons === 1) bits.push('1 season');
      else if (entry.seasons > 1) bits.push(`${entry.seasons} seasons`);
    } else {
      const mins = runtimeLabel(entry.runtime);
      if (mins) bits.push(mins);
    }
    return bits.join('  ·  ');
  }

  /**
   * WHICH ORDERS THIS FRANCHISE CAN HONESTLY OFFER — the Roku's BuildOrders.
   *
   * Saga and Release are always real: the fleet's curated chapters, and the same
   * titles by date. "Films first" is only real when the roadmap actually HOLDS
   * both — 30 of the 170 do, and Star Wars is the shape that asks for it, 11
   * films and 10 series shuffled together. On a films-only roadmap it would sort
   * nothing and say so in a pill, which is the same lie as an unpressable
   * button, and this screen has shipped one of those before.
   *
   * A fourth order, in-universe STORY order, is deliberately absent, and this is
   * the note that says why rather than leaving the next person to re-derive it:
   * the fleet sends no chronology and TMDB has none. Every item carries only
   * {id,type,name,year,date,poster,runtime,rating,genres}. Star Wars story order
   * cannot be recovered from a release date, so inventing one per franchise
   * would be a guess dressed as data.
   */
  function orders(chapters) {
    const out = ['saga', 'release'];
    let films = false;
    let series = false;
    for (const chapter of chapters || []) {
      for (const entry of chapter.items || []) {
        if (entry.isSeries) series = true; else films = true;
      }
    }
    if (films && series) out.push('films');
    return out;
  }

  function orderLabel(mode) {
    if (mode === 'release') return 'Release order';
    if (mode === 'films') return 'Films first';
    return 'Saga order';
  }

  /** Release date, then year, then nothing — the Roku's DateKey, verbatim. */
  function dateKey(entry) {
    if (entry.date) return entry.date;
    if (entry.year) return `${entry.year}-99-99`;
    return '9999-99-99';
  }

  function byDate(items) {
    return items.slice().sort((a, b) => {
      const ka = dateKey(a);
      const kb = dateKey(b);
      if (ka === kb) return 0;
      return ka < kb ? -1 : 1;
    });
  }

  function orderedChapters(chapters, mode) {
    const src = chapters || [];
    if (mode !== 'release' && mode !== 'films') return src;
    const all = [];
    for (const chapter of src) all.push(...(chapter.items || []));
    if (!all.length) return src;

    if (mode === 'films') {
      /* Two sections rather than one, because "Films first" is a claim about
         grouping and a single heading would not show it was honoured. Each side
         stays in date order — within the films, release order is the order
         anybody means. */
      const films = byDate(all.filter((entry) => !entry.isSeries));
      const series = byDate(all.filter((entry) => entry.isSeries));
      const out = [];
      if (films.length) out.push({ name: 'Films', note: '', items: films });
      if (series.length) out.push({ name: 'Series', note: '', items: series });
      return out.length ? out : src;
    }

    return [{ name: 'Release order', note: '', items: byDate(all) }];
  }

  // ── the screen ────────────────────────────────────────────────────────────

  function refs() {
    return {
      index: document.getElementById('roadmaps-index'),
      grid: document.getElementById('roadmaps-grid'),
      status: document.getElementById('roadmaps-status'),
      retry: document.getElementById('roadmaps-retry'),
      hint: document.getElementById('roadmaps-hint'),
      detail: document.getElementById('roadmap-detail'),
      back: document.getElementById('roadmap-back'),
      art: document.getElementById('roadmap-art'),
      name: document.getElementById('roadmap-name'),
      about: document.getElementById('roadmap-about'),
      statsLine: document.getElementById('roadmap-stats'),
      order: document.getElementById('roadmap-order'),
      chapters: document.getElementById('roadmap-chapters'),
      detailStatus: document.getElementById('roadmap-status'),
    };
  }

  /* The same left-to-right darkening app.js's setBackground() paints, so the
     name over the art stays readable on a light backdrop. */
  function setArt(host, url) {
    const image = httpsUrl(url);
    host.style.backgroundImage = image
      ? `linear-gradient(90deg, rgba(10,10,11,.98) 0%, rgba(10,10,11,.72) 46%, rgba(10,10,11,.2) 100%), url("${image.replace(/"/g, '%22')}")`
      : '';
  }

  function franchiseCard(card) {
    const button = node('button', 'roadmap-card');
    button.type = 'button';
    button.setAttribute('aria-label', `Open ${card.name}`);
    setArt(button, card.art);
    if (!card.art) button.classList.add('no-art');
    const body = node('span', 'roadmap-card-body');
    body.append(
      node('span', 'roadmap-card-name', card.name),
      node('span', 'roadmap-card-meta', cardCaption(card)),
    );
    if (card.overview) body.append(node('span', 'roadmap-card-copy', card.overview));
    button.append(body);
    button.addEventListener('click', () => openRoadmap(card.slug));
    return button;
  }

  async function loadIndex() {
    const { grid, status, retry, hint } = refs();
    if (!grid || state.loadingIndex) return;
    state.loadingIndex = true;
    status.textContent = 'Loading roadmaps…';
    retry.hidden = true;
    hint.textContent = '';
    grid.replaceChildren();

    let data = null;
    try {
      data = await fetchJSON(`${FLEET}/roadmaps`);
    } catch {
      state.loadingIndex = false;
      status.textContent = 'Roadmaps could not load. Check the network and try again.';
      retry.hidden = false;
      return;
    }
    state.loadingIndex = false;
    state.cards = (Array.isArray(data && data.roadmaps) ? data.roadmaps : [])
      .map(normaliseCard).filter(Boolean);
    renderIndex();
  }

  function renderIndex() {
    const { grid, status, retry, hint } = refs();
    if (!grid) return;
    retry.hidden = true;
    const cards = state.cards || [];
    if (!cards.length) {
      grid.replaceChildren();
      status.textContent = 'No roadmaps came back.';
      retry.hidden = false;
      hint.textContent = '';
      return;
    }
    status.textContent = '';
    hint.textContent = `${cards.length} franchise${cards.length === 1 ? '' : 's'}`;
    grid.replaceChildren(...cards.map(franchiseCard));
  }

  function showIndex() {
    const { index, detail } = refs();
    /* Bumped so a detail fetch still in flight cannot paint into the panel
       behind this one after the viewer has already walked back out of it. */
    state.request += 1;
    state.detail = null;
    state.slug = '';
    if (index) index.hidden = false;
    if (detail) detail.hidden = true;
    window.scrollTo(0, 0);
  }

  async function openRoadmap(slug) {
    const { index, detail, name, about, statsLine, art, chapters, detailStatus, order } = refs();
    if (!detail || !slug) return;
    const request = ++state.request;
    state.slug = slug;
    state.detail = null;
    state.orderIndex = 0;
    if (index) index.hidden = true;
    detail.hidden = false;
    const card = (state.cards || []).find((entry) => entry.slug === slug);
    name.textContent = card ? card.name : '';
    about.textContent = '';
    statsLine.textContent = '';
    order.hidden = true;
    setArt(art, card ? card.art : '');
    chapters.replaceChildren();
    detailStatus.textContent = card ? `Loading ${card.name}…` : 'Loading…';
    window.scrollTo(0, 0);

    let data = null;
    try {
      data = await fetchJSON(`${FLEET}/roadmaps/${encodeURIComponent(slug)}`);
    } catch {
      if (request !== state.request) return;
      detailStatus.textContent = 'This roadmap could not be loaded.';
      return;
    }
    if (request !== state.request) return;
    state.detail = normaliseDetail(data, slug);
    await renderDetail(request);
  }

  /**
   * RATED BEFORE DRAWN, and the counts in the header are recomputed from what
   * survived. A saga is a wall of real IMDb ids, so the lookup is the right tool
   * here — this is Fire TV's own comment at RoadmapsActivity.openFranchise, and
   * app.js's visibleMetas() is the lookup.
   */
  async function gateChapters(detail, request) {
    const flat = [];
    for (const chapter of detail.chapters) for (const entry of chapter.items) flat.push(entry);
    const visible = await state.services.visibleMetas(flat.map(entryMeta));
    if (request !== state.request) return null;
    const allowed = new Set(visible.map((meta) => meta.id));
    const chapters = [];
    let films = 0;
    let series = 0;
    for (const chapter of detail.chapters) {
      const items = chapter.items.filter((entry) => allowed.has(entry.id));
      if (!items.length) continue;
      for (const entry of items) { if (entry.isSeries) series += 1; else films += 1; }
      chapters.push({ ...chapter, items });
    }
    return { ...detail, chapters, films, series, titles: films + series };
  }

  async function renderDetail(request) {
    const { name, about, statsLine, art, chapters, detailStatus, order } = refs();
    const raw = state.detail;
    if (!raw) return;
    name.textContent = raw.name;
    about.textContent = raw.overview;
    setArt(art, raw.art);

    const gated = await gateChapters(raw, request);
    if (!gated || request !== state.request) return;
    state.gate = String(state.services.cap() || '');

    const modes = orders(gated.chapters);
    if (state.orderIndex >= modes.length) state.orderIndex = 0;
    const mode = modes[state.orderIndex] || 'saga';
    order.hidden = false;
    order.textContent = orderLabel(mode);
    order.setAttribute('aria-label', `Order: ${orderLabel(mode)}. Press to change.`);
    /* Two or three stops on ONE button, and the label is the only thing that
       says where you are — so it wraps rather than ending. */
    order.disabled = modes.length < 2;

    statsLine.textContent = stats(gated);

    if (!gated.chapters.length) {
      chapters.replaceChildren();
      detailStatus.textContent = raw.chapters.length
        ? 'Nothing in this roadmap is available for this profile.'
        : 'This roadmap has nothing in it yet.';
      return;
    }
    detailStatus.textContent = '';
    chapters.replaceChildren(
      ...sections(orderedChapters(gated.chapters, mode)).map(chapterSection),
    );
  }

  /** The shape app.js's buildCard() and openDetail() want. */
  function entryMeta(entry) {
    return {
      id: entry.id,
      type: entry.type,
      name: entry.name,
      poster: entry.poster,
      background: entry.backdrop || entry.poster,
      description: entry.overview,
      releaseInfo: entry.year,
      contentRating: '',
    };
  }

  function chapterSection(section) {
    const host = node('section', 'roadmap-chapter');
    host.append(node('h2', 'row-title', section.name));
    host.append(node('p', 'roadmap-chapter-sub', subline(section)));
    const grid = node('div', 'search-results');
    section.items.forEach((entry, offset) => {
      grid.append(entryCard(entry, section.startAt + offset));
    });
    host.append(grid);
    return host;
  }

  function entryCard(entry, position) {
    const wrap = node('div', 'roadmap-entry');
    const card = state.services.buildCard(entryMeta(entry));
    const pos = node('span', 'roadmap-pos', String(position));
    card.append(pos);
    if (!entry.playable) {
      /* The card says so before a press does: dimmed, and inert. Nothing tries
         to open a `tmdb:` id on any of the three televisions either. */
      card.classList.add('roadmap-unplayable');
      card.disabled = true;
      card.setAttribute('aria-label', `${entry.name} — not available to open`);
    }
    wrap.append(card);
    const caption = entryCaption(entry);
    if (caption) wrap.append(node('span', 'roadmap-entry-meta', caption));
    return wrap;
  }

  function bindOnce() {
    if (state.bound) return;
    state.bound = true;
    const { back, retry, order } = refs();
    if (back) back.addEventListener('click', showIndex);
    if (retry) retry.addEventListener('click', () => { state.cards = null; loadIndex(); });
    if (order) {
      order.addEventListener('click', () => {
        if (!state.detail) return;
        state.orderIndex += 1;
        redraw();
      });
    }
  }

  /**
   * Mounted on EVERY visit, not once. The cap can change under this screen —
   * somebody switches profile in another tab — and a roadmap built once would
   * keep whatever it was filtered against. The INDEX is only fetched once: the
   * list of franchises does not change while somebody is watching television,
   * and it is the expensive call.
   */
  function mount() {
    /* Pulled at mount, not pushed at load — index.html runs app.js before this
       file, so there is nothing to push to when app.js executes. */
    state.services = window.BlazingCatalogue;
    if (!state.services) return;
    bindOnce();
    if (state.cards === null) {
      if (!state.loadingIndex) loadIndex();
    } else {
      renderIndex();
    }
    if (state.detail && state.gate !== String(state.services.cap() || '')) redraw();
  }

  /** Re-render the open roadmap, and make every earlier pass stale first — two
   *  quick presses of the order button must not both reach replaceChildren. */
  function redraw() {
    state.request += 1;
    renderDetail(state.request);
  }

  window.BlazingRoadmaps = {
    mount,
    /** The pure rules, for roadmaps.test.mjs. */
    rules: {
      normaliseCard, normaliseEntry, normaliseDetail, cardCaption, releaseYear,
      years, subline, sections, runtimeLabel, filmMinutes, stats, entryCaption,
      orders, orderLabel, orderedChapters, dateKey,
    },
  };
})();
