/* Blazing web Games — a poster wall of the fleet's RAWG-backed catalogue.
 *
 * DISCOVERY ONLY, matching Roku's GamesScreen/Games.brs and Fire TV's
 * GameStore-adjacent catalogue: a poster, a description, screenshots and
 * (sometimes) a promo trailer clip — never playable game content. This file
 * was built directly against roku channels/source/lib/Games.brs and
 * components/screens/{GamesScreen,GameDetailScreen}.brs — read those for the
 * on-device behavior this mirrors.
 *
 * WIRE CONTRACT (fleet.lyreosai.com, blazing-fleet repo):
 *   GET /games/catalog?page=<n>&pageSize=40[&search=<q>]
 *       -> { configured: bool, count, page, hasNext, games: [{id,name,poster}] }
 *       configured !== true means the RAWG key is not set up server-side —
 *       NOT the same as an empty result, and shown as its own message.
 *   GET /games/catalog/<id>
 *       -> { found: bool, id, name, description, released, rating,
 *            metacritic, poster, genres[], platforms[], screenshots[],
 *            trailer, error? }
 *
 * No profile/rating gate here on purpose: grepping the whole Roku channel for
 * a gamesAllowedNow() finds nothing — unlike Manga (see manga.js), Games has
 * no age gate on any client in this fleet.
 */
'use strict';

(() => {
  const FLEET_BASE = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  const FETCH_TIMEOUT_MS = 20000;
  const PAGE_SIZE = 40;

  const state = {
    mounted: false,
    items: [],
    page: 0,
    hasNext: false,
    mode: 'catalog', // 'catalog' | 'search'
    query: '',
    loading: false,
  };

  function element(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function plainText(value, fallback = '') {
    const out = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return out ? out.slice(0, 600) : fallback;
  }

  // Same rule app.js's safeHttpsUrl uses everywhere a catalog value reaches an
  // <img src>, a background-image or a <video src>: https only, so a bad
  // upstream value can never become a javascript: or data: URI in the DOM.
  function safeHttpsUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  // Same shape as app.js's setBackground(): a left-to-right darkening so the
  // title text over the art stays readable, poster on the right.
  function setBackground(node, value) {
    const image = safeHttpsUrl(value);
    node.style.backgroundImage = image
      ? `linear-gradient(90deg, rgba(10,10,11,.98) 0%, rgba(10,10,11,.7) 42%, rgba(10,10,11,.15) 100%), url("${image.replace(/"/g, '%22')}")`
      : '';
  }

  async function fetchJSON(url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function refs() {
    return {
      form: document.getElementById('games-search-form'),
      input: document.getElementById('games-search-input'),
      status: document.getElementById('games-status'),
      results: document.getElementById('games-results'),
      loadMore: document.getElementById('games-load-more'),
      dialog: document.getElementById('game-detail-dialog'),
      close: document.getElementById('game-detail-close'),
      title: document.getElementById('game-detail-title'),
      meta: document.getElementById('game-detail-meta'),
      desc: document.getElementById('game-detail-desc'),
      platforms: document.getElementById('game-detail-platforms'),
      shots: document.getElementById('game-detail-shots'),
      art: document.getElementById('game-detail-art'),
      trailerHost: document.getElementById('game-detail-trailer'),
      trailerBtn: document.getElementById('game-detail-trailer-btn'),
      dstatus: document.getElementById('game-detail-status'),
    };
  }

  function card(game) {
    const id = plainText(game.id);
    const name = plainText(game.name, 'Untitled');
    const button = element('button', 'card');
    button.type = 'button';
    button.setAttribute('aria-label', `View ${name}`);
    const poster = safeHttpsUrl(game.poster);
    const image = element('img', 'card-image');
    image.loading = 'lazy';
    image.decoding = 'async';
    image.alt = '';
    if (poster) image.src = poster;
    else button.classList.add('no-image');
    const label = element('span', 'card-label');
    label.textContent = name;
    button.append(image, label);
    button.addEventListener('click', () => openDetail(id));
    return button;
  }

  function renderNewCards() {
    const { results } = refs();
    if (!results) return;
    const already = results.children.length;
    const fresh = state.items.slice(already);
    results.append(...fresh.map(card));
  }

  async function loadPage(page, { append }) {
    if (state.loading) return;
    state.loading = true;
    const { status, results, loadMore } = refs();
    if (!append) {
      status.textContent = 'Loading…';
      results.replaceChildren();
    }
    loadMore.hidden = true;

    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (state.mode === 'search' && state.query) params.set('search', state.query);
    const data = await fetchJSON(`${FLEET_BASE}/games/catalog?${params.toString()}`);
    state.loading = false;

    if (!data) {
      if (!append) {
        state.items = [];
        results.replaceChildren();
        status.textContent = 'Could not reach the games catalogue.';
      } else {
        loadMore.hidden = !state.hasNext;
      }
      return;
    }

    // The raw server payload, not something this file computed — see the
    // contract note above. A missing/false `configured` means the fleet has
    // no RAWG key wired up, which is a server config gap, not "no results".
    if (data.configured !== true) {
      state.items = [];
      state.hasNext = false;
      results.replaceChildren();
      status.textContent = data.error || 'The games catalogue is not configured on the server.';
      return;
    }

    const incoming = Array.isArray(data.games) ? data.games : [];
    state.page = Number(data.page) || page;
    state.hasNext = data.hasNext === true;
    state.items = append ? state.items.concat(incoming) : incoming;

    if (!state.items.length) {
      results.replaceChildren();
      status.textContent = state.mode === 'search'
        ? `No games matched "${state.query}".`
        : 'No games are available right now. Come back later.';
      loadMore.hidden = true;
      return;
    }

    renderNewCards();
    status.textContent = `${state.items.length} game${state.items.length === 1 ? '' : 's'}${state.hasNext ? '+' : ''}`;
    loadMore.hidden = !state.hasNext;
  }

  function closeTrailer() {
    const { trailerHost } = refs();
    if (!trailerHost) return;
    trailerHost.classList.remove('loaded');
    trailerHost.replaceChildren();
  }

  async function openDetail(id) {
    const { dialog, title, meta, desc, platforms, shots, art, trailerBtn, dstatus } = refs();
    if (!dialog || !id) return;
    title.textContent = 'Loading…';
    meta.textContent = '';
    desc.textContent = '';
    platforms.textContent = '';
    shots.replaceChildren();
    art.style.backgroundImage = '';
    trailerBtn.hidden = true;
    trailerBtn.dataset.trailer = '';
    dstatus.textContent = '';
    closeTrailer();
    if (typeof dialog.showModal === 'function') dialog.showModal();

    const data = await fetchJSON(`${FLEET_BASE}/games/catalog/${encodeURIComponent(id)}`);
    if (!data || data.found !== true) {
      title.textContent = plainText(data && data.name, 'This game could not be loaded.');
      dstatus.textContent = (data && data.error) || 'This game could not be loaded.';
      return;
    }

    title.textContent = plainText(data.name, 'Untitled');
    setBackground(art, data.poster);

    const bits = [];
    if (data.released) bits.push(plainText(data.released));
    if (data.rating) bits.push(`★ ${plainText(data.rating)}`);
    if (data.metacritic) bits.push(`Metacritic ${plainText(data.metacritic)}`);
    const genres = Array.isArray(data.genres) ? data.genres.map((g) => plainText(g)).filter(Boolean).join(', ') : '';
    if (genres) bits.push(genres);
    meta.textContent = bits.join('   ·   ');
    desc.textContent = plainText(data.description);

    const platformList = Array.isArray(data.platforms) ? data.platforms.map((p) => plainText(p)).filter(Boolean).join(', ') : '';
    platforms.textContent = platformList ? `Platforms: ${platformList}` : '';

    const shotUrls = (Array.isArray(data.screenshots) ? data.screenshots : []).map(safeHttpsUrl).filter(Boolean);
    shots.replaceChildren(...shotUrls.map((url) => {
      const img = element('img', '');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = url;
      return img;
    }));

    const trailerUrl = safeHttpsUrl(data.trailer);
    trailerBtn.hidden = !trailerUrl;
    trailerBtn.dataset.trailer = trailerUrl;
  }

  function playTrailer() {
    const { trailerHost, trailerBtn } = refs();
    const url = trailerBtn && trailerBtn.dataset.trailer;
    if (!trailerHost || !url) return;
    const video = element('video', '');
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    trailerHost.replaceChildren(video);
    trailerHost.classList.add('loaded');
  }

  function closeDialog() {
    const { dialog } = refs();
    closeTrailer();
    if (dialog && dialog.open) dialog.close();
  }

  function bindOnce() {
    const { form, input, loadMore, dialog, close, trailerBtn } = refs();
    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const q = (input.value || '').trim();
        state.mode = q ? 'search' : 'catalog';
        state.query = q;
        loadPage(1, { append: false });
      });
    }
    if (loadMore) loadMore.addEventListener('click', () => loadPage(state.page + 1, { append: true }));
    if (close) close.addEventListener('click', closeDialog);
    if (dialog) dialog.addEventListener('close', closeTrailer);
    if (trailerBtn) trailerBtn.addEventListener('click', playTrailer);
  }

  function mount() {
    if (state.mounted) return;
    state.mounted = true;
    bindOnce();
    loadPage(1, { append: false });
  }

  window.BlazingGames = { mount };
})();
