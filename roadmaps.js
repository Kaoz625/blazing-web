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
    /* The entry cards the last pass of this roadmap drew, id -> [wrapper], so a
       re-render MOVES them instead of building new ones. `nodesKey` is the
       `${slug}|${cap}` they were built for — see the block above entryCard. */
    nodes: new Map(),
    nodesKey: '',
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

  /* ── What a title is RATED, resolved HERE rather than left inside app.js ───
   *
   * THE HOLE THIS CLOSES. app.js's visibleMetas() (app.js:5930) resolves a tier
   * for every meta it is handed, keeps that answer in a LOCAL VARIABLE, and
   * returns the metas it kept without ever writing the tier onto them. This
   * screen used to hand it `contentRating: ''` for every row, so the tier that
   * admitted a card died inside that call — while app.js goes on to re-read
   * meta.contentRating on the SAME card twice more: at openDetail (app.js:3257)
   * and 550ms into a hover or a tab-focus in attachHoverTrailer (app.js:2423 and
   * :2430). ratingAllowed('') is false for exactly one cap, 'general', which is
   * every Kids profile — so under that cap a saga was drawn in full, with its
   * position numbers, and then a press answered "This title is not available for
   * this profile." while a hover DELETED the card out of the grid and left its
   * caption behind. Resolving the tier here and writing it onto the meta means
   * ONE value admits a card and re-admits it at every later check.
   *
   * ONLY A `tt` ID IS WORTH ASKING ABOUT: a `tmdb:` id is the one TMDB knew
   * without an IMDb id (see normaliseEntry's `playable` below) and no ratings
   * source can classify it, so asking costs a round trip to be told nothing.
   * Asking twice about one id is the same waste, and a saga repeats ids across
   * its orders. Both rules are the Roku's, from source/lib/RatingApi.brs:96-108.
   *
   * A SECOND COPY OF THIS LIVES IN calendar.js, for the same reason and with the
   * same numbers. app.js's copy cannot be borrowed: window.BlazingCatalogue
   * (app.js:5969) publishes visibleMetas() and not ratingTierFor(), so there is
   * no way to ask app.js what tier it resolved.
   */
  /** The Roku's RatingSessionStart numbers, rounded to what a browser should
   *  have open at once. app.js:5878 carries the same pair. */
  const RATING_BUDGET = 150;
  const RATING_LOOKUPS = 6;
  /** `${kind}:${id}` -> tier, for the session. A FAILED request is NOT an answer
   *  and is not remembered here: caching it would pin a title to "unknown" for
   *  the rest of the session, the mistake the Roku's calendar task writes down at
   *  AddonTask.brs:438. */
  const TIERS = new Map();

  /** The key a rating answer is filed under, or '' for an id no ratings source
   *  can classify. The `split(':')[0]` is for a Stremio episode id
   *  (tt0903747:5:14), which is rated as its series. */
  function ratingKey(entry) {
    const id = String((entry && entry.id) || '').trim();
    if (id.slice(0, 2).toLowerCase() !== 'tt') return '';
    return `${entry.type === 'series' ? 'series' : 'movie'}:${id.split(':')[0]}`;
  }

  /** The keys this pass should ask about: classifiable ids only, once each,
   *  never one already answered, and never more than the budget. */
  function ratingWants(entries, known = TIERS, budget = RATING_BUDGET) {
    const wants = [];
    const seen = new Set();
    for (const entry of entries || []) {
      const key = ratingKey(entry);
      if (!key || seen.has(key) || known.has(key)) continue;
      seen.add(key);
      if (wants.length >= budget) break;
      wants.push(key);
    }
    return wants;
  }

  /** Fill TIERS for everything in `entries` worth asking about. Six at a time,
   *  and a failure leaves the id unknown rather than wrong. */
  async function resolveTiers(entries) {
    const wants = ratingWants(entries);
    let cursor = 0;
    const worker = async () => {
      while (cursor < wants.length) {
        const key = wants[cursor];
        cursor += 1;
        const cut = key.indexOf(':');
        try {
          const data = await fetchJSON(
            `${FLEET}/rating/${key.slice(0, cut)}/${encodeURIComponent(key.slice(cut + 1))}`,
          );
          TIERS.set(key, String((data && data.tier) || '').toLowerCase());
        } catch { /* see TIERS above: not an answer, so not remembered */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(RATING_LOOKUPS, wants.length) }, worker));
  }

  /**
   * The ids that may be DRAWN, out of the metas app.js's visibleMetas() kept.
   *
   * THE RESIDUAL THIS CLOSES, and it is the last way the two halves can still
   * disagree. TIERS deliberately does not remember a FAILED request (see the
   * note on TIERS above), so a `tt` entry whose lookup threw reaches entryMeta()
   * with contentRating '' — and app.js then asks the SAME question again on its
   * own budget (app.js:5943-5947, a separate cache from ours, so a miss here is
   * always a second request there). If OUR request failed and THAT one
   * succeeded, visibleMetas() admits the entry on a tier it keeps to itself
   * while the card still carries '' — and ratingAllowed('') is false for exactly
   * one cap, 'general' (app.js:5850). So under a kids cap that single card goes
   * back to being drawn with its position number, refusing a press
   * (app.js:3257) and deleting itself 550ms into a hover (app.js:2423) — the
   * whole of finding 2, for one entry.
   *
   * So under that cap an entry is drawn only if the card can carry the tier that
   * admitted it. Anything else is dropped, which OVER-blocks by at most the
   * entries whose lookup failed while app.js's retry succeeded — a narrow
   * window, and it fails safe rather than drawing a dead control. Under every
   * other cap ratingAllowed('') is true at all three checks, so nothing needs
   * dropping and nothing is dropped. The header counts are recomputed from what
   * survived (gateChapters below), so a dropped entry leaves no hole in the
   * numbering either.
   *
   * A MISSING CAP IS THE KIDS CAP, not "no cap". app.js:5846 reads
   * `state.profileCap || 'general'`, so cap() answering null — nobody connected
   * — gates exactly like 'general' there. Mirror it here or this guard would be
   * off by one profile state, which is the state a page load starts in.
   *
   * The identical helper is in calendar.js, beside the identical TIERS walk.
   */
  function admitted(metas, cap) {
    const list = Array.isArray(metas) ? metas : [];
    if (String(cap || 'general').toLowerCase() !== 'general') return list.slice();
    return list.filter((meta) => meta && meta.contentRating);
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
   * here — this is Fire TV's own comment at RoadmapsActivity.openFranchise.
   * resolveTiers() goes FIRST so app.js's visibleMetas() judges each entry on the
   * tier the card will carry, rather than on an answer it keeps to itself.
   */
  async function gateChapters(detail, request) {
    const flat = [];
    for (const chapter of detail.chapters) for (const entry of chapter.items) flat.push(entry);
    await resolveTiers(flat);
    if (request !== state.request) return null;
    const visible = await state.services.visibleMetas(flat.map((entry) => entryMeta(entry)));
    if (request !== state.request) return null;
    /* Not `visible` straight into the Set — see admitted() above for the one
       entry a kids cap can still be handed dead. */
    const allowed = new Set(admitted(visible, state.services.cap()).map((meta) => meta.id));
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
      /* Nothing survived, so there is nothing worth holding on to — and holding
         it would keep a whole detached grid alive for a screen that is empty. */
      state.nodes = new Map();
      state.nodesKey = '';
      detailStatus.textContent = raw.chapters.length
        ? 'Nothing in this roadmap is available for this profile.'
        : 'This roadmap has nothing in it yet.';
      return;
    }
    detailStatus.textContent = '';
    /* The cards the last pass drew, to be moved into the new order rather than
       rebuilt — see the block above entryCard for what rebuilding costs and why
       the cap is half of the key. `keep` becomes the pool for the next pass, so
       anything this order did not use is simply dropped. */
    const key = `${gated.slug}|${state.gate}`;
    const pool = state.nodesKey === key ? state.nodes : new Map();
    const keep = new Map();
    chapters.replaceChildren(
      ...sections(orderedChapters(gated.chapters, mode))
        .map((section) => chapterSection(section, pool, keep)),
    );
    state.nodesKey = key;
    state.nodes = keep;
  }

  /** The shape app.js's buildCard() and openDetail() want.
   *
   * contentRating is the tier resolveTiers() found, NOT '' — see the block at
   * the top of this file. entryCard() builds a fresh meta for every card and
   * gateChapters() builds another set for the gate, so the tier has to come from
   * TIERS rather than from whichever object survived the last call.
   *
   * `tiers` is an argument only so roadmaps.test.mjs can hand in a map without a
   * network; production always takes the default. Note the call sites pass one
   * entry each rather than using `.map(entryMeta)`, which would hand the array
   * index in as the map. */
  function entryMeta(entry, tiers = TIERS) {
    return {
      id: entry.id,
      type: entry.type,
      name: entry.name,
      poster: entry.poster,
      background: entry.backdrop || entry.poster,
      description: entry.overview,
      releaseInfo: entry.year,
      contentRating: tiers.get(ratingKey(entry)) || '',
    };
  }

  function chapterSection(section, pool, keep) {
    const host = node('section', 'roadmap-chapter');
    host.append(node('h2', 'row-title', section.name));
    host.append(node('p', 'roadmap-chapter-sub', subline(section)));
    const grid = node('div', 'search-results');
    section.items.forEach((entry, offset) => {
      grid.append(entryCard(entry, section.startAt + offset, pool, keep));
    });
    host.append(grid);
    return host;
  }

  /* ── A RE-RENDER MOVES THE CARDS. IT DOES NOT BUILD NEW ONES ───────────────
   *
   * WHAT REBUILDING COSTS, measured rather than reasoned. The order button
   * re-renders, and `chapters.replaceChildren(...)` (renderDetail below) threw
   * away every card and asked buildCard() for a new one — which means a new
   * `<img class="card-image">` per entry (app.js:2497-2503) carrying the same
   * poster URL as the one just discarded. Whether a NEW element for an image
   * the page already has costs a request is then the BROWSER's decision, not
   * ours, and the two browsers this repo runs on disagree.
   *
   * MEASURED 13 Sep 2026, one press of #roadmap-order in
   * roadmaps-calendar.smoke.mjs, counting every request that left the page:
   *     Comet 151 (local)      0 requests                      63 ok / 0 FAIL
   *     Playwright chromium    1 request, /art.png             62 ok / 1 FAIL
   * That is the whole of "changing the order costs nothing on the wire" passing
   * here and failing on CI — comet.mjs:130 hands CI chromium and this Mac
   * Comet. The fixture's art is served by route.fulfill with no Cache-Control
   * and no validator, so nothing about it is heuristically fresh and a fresh
   * element is entitled to ask again; a real poster CDN would usually answer
   * from cache, which makes this a cost that appears on exactly the devices
   * with the least to spare.
   *
   * AND IT IS NOT THE RATING LOOKUPS, which is the obvious suspect now that
   * resolveTiers() runs on every render. Checked: the same harness at 1e437c9,
   * before any of the tier work existed, fails this same line under chromium
   * with the same single /art.png. TIERS answers from the map on the second
   * pass, so a reorder asks the fleet for nothing.
   *
   * SO THE CARDS ARE KEPT AND MOVED, which is worth having on its own: a saga
   * runs to a few hundred cards, and rebuilding all of them to show the SAME
   * titles in another order re-decodes every poster and flashes the grid.
   * Moving a node keeps its listeners with it — including app.js's hover
   * trailer (app.js:2423) — so nothing is re-attached either.
   *
   * A LIST PER ID, NOT ONE NODE PER ID: a franchise may list the same title in
   * two chapters, and one element cannot be in two places — appending it twice
   * would silently move it and leave the first slot empty. Taking from a list
   * and building when the list runs out draws a repeated id as many times as
   * the order asks for it.
   *
   * THE POOL IS KEYED ON THE CAP as well as the slug (renderDetail below). A
   * card carries the tier that admitted it (see entryMeta), and a tier that was
   * unknown when the card was built stays unknown on that card for as long as
   * it is re-used — harmless under every cap but 'general', which is the one
   * cap that refuses an unknown tier (app.js:5850). A cap change therefore
   * starts from nothing rather than re-using what the old cap drew.
   */

  /** A wrapper this roadmap drew earlier for `entry`, or null.
   *
   *  A wrapper whose card is GONE is not handed back: app.js removes the card
   *  outright when a rating check refuses it (app.js:2423/2430), and re-using
   *  the husk would put a card back on the screen that app.js has just taken
   *  off it. The test is for the position span, which is a child of the card
   *  (buildEntryCard below) and so leaves with it — and it is also the one node
   *  entryCard has to write to. */
  function spareEntry(pool, entry) {
    const list = pool.get(entry.id);
    while (list && list.length) {
      const wrap = list.shift();
      if (wrap.querySelector('.roadmap-pos')) return wrap;
    }
    return null;
  }

  function entryCard(entry, position, pool, keep) {
    const wrap = spareEntry(pool, entry) || buildEntryCard(entry);
    /* The position is the ONE thing that differs between two orders of the same
       title — it is a place in the watch order, not a property of the film. */
    wrap.querySelector('.roadmap-pos').textContent = String(position);
    const drawn = keep.get(entry.id);
    if (drawn) drawn.push(wrap); else keep.set(entry.id, [wrap]);
    return wrap;
  }

  function buildEntryCard(entry) {
    const wrap = node('div', 'roadmap-entry');
    const card = state.services.buildCard(entryMeta(entry));
    const pos = node('span', 'roadmap-pos', '');
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
      orders, orderLabel, orderedChapters, dateKey, ratingKey, ratingWants,
      entryMeta, admitted,
    },
  };
})();
