/* One room for the existing anime player, manga reader and comics reader. */
'use strict';
(() => {
  const FLEET = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  const KITSU = 'https://anime-kitsu.strem.fun';
  const $ = (id) => document.getElementById(id);
  const state = { services: null, route: '', category: 'all', generation: 0, profile: null, loaded: '', bound: false };
  const node = (tag, cls, text) => {
    const out = document.createElement(tag);
    if (cls) out.className = cls;
    if (text) out.textContent = text;
    return out;
  };
  const text = (value) => String(value || '').replace(/<[^>]*>/g, '').slice(0, 600);
  const imageURL = (value) => {
    if (typeof value !== 'string' || !value.trim()) return '';
    const source = value.trim();
    const absolute = /^[a-z][\w+.-]*:/i.test(source) ? source
      : source.startsWith('//') ? `https:${source}` : `${FLEET.replace(/\/$/, '')}/${source.replace(/^\/+/, '')}`;
    try { const url = new URL(absolute); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
  };
  const canRead = () => Boolean(state.profile?.id) && !state.profile.isKids
    && ['mature', 'adult'].includes(state.profile.maxRating);
  const current = (request) => request === state.generation && Boolean(state.profile?.id);
  async function json(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error('Library unavailable');
    return response.json();
  }
  function unique(items) {
    const seen = new Set();
    return items.filter((item) => {
      if (!item?.id || seen.has(item.id)) return false;
      seen.add(item.id); return true;
    });
  }
  function animeItems(data) {
    return unique((data?.items || data?.metas || []).map((raw) => state.services.safeMeta({ ...raw, type: raw.type === 'movie' ? 'movie' : 'series', isAnime: true }))
      .filter((item) => item && state.services.ratingAllowed(item.contentRating)));
  }
  function readCard(raw, kind) {
    const name = text(raw.title || raw.name);
    const button = node('button', 'card');
    button.type = 'button';
    button.setAttribute('aria-label', `${kind === 'manga' ? 'See chapters for' : 'Read'} ${name}`);
    const image = node('img', 'card-image');
    image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
    const url = imageURL(raw.cover || raw.poster);
    if (url) image.src = url; else button.classList.add('no-image');
    image.addEventListener('error', () => button.classList.add('no-image'), { once: true });
    button.append(image, node('span', 'card-label', name));
    button.addEventListener('click', () => {
      if (!canRead()) return;
      if (kind === 'manga') window.BlazingManga?.openTitle(raw);
      else window.comicReader?.open(String(raw.id), name);
    });
    return button;
  }
  function section(title, items, kind = 'anime') {
    const row = node('section', 'anime-room-shelf');
    row.append(node('h2', 'row-title', title));
    const grid = node('div', 'anime-room-grid');
    grid.append(...items.map((item) => {
      if (kind !== 'anime') return readCard(item, kind);
      const card = state.services.buildCard(item); card.dataset.animeId = item.id; return card;
    }));
    row.append(grid);
    return row;
  }
  function status(message, retry) {
    $('anime-room-status').textContent = message;
    if (retry) {
      const button = node('button', 'secondary-button', 'Try again');
      button.type = 'button'; button.addEventListener('click', retry);
      $('anime-room-status').append(' ', button);
    }
  }
  function feature(item) {
    const host = $('anime-room-feature'); host.replaceChildren(); host.hidden = !item;
    if (!item) return;
    const art = imageURL(item.background);
    host.classList.toggle('anime-feature-poster', !art);
    if (art) {
      const image = node('img', 'anime-feature-art');
      image.src = art; image.alt = ''; image.decoding = 'async'; host.append(image);
    }
    if (!art && imageURL(item.poster)) {
      const poster = node('img', 'anime-feature-cover'); poster.src = imageURL(item.poster); poster.alt = ''; host.append(poster);
    }
    const body = node('div', 'anime-feature-body');
    body.append(node('p', 'eyebrow', 'Explore the story'), node('h2', '', item.name));
    const meta = [item.releaseInfo, item.imdbRating ? `IMDb ${item.imdbRating}` : ''].filter(Boolean).join(' · ');
    if (meta) body.append(node('p', 'anime-feature-meta', meta));
    if (item.description) body.append(node('p', 'anime-feature-description', item.description));
    const actions = node('div', 'anime-feature-actions');
    const watch = node('button', 'primary-button', 'View episodes'); watch.type = 'button';
    watch.addEventListener('click', () => state.services.openDetail(item)); actions.append(watch);
    if (canRead()) {
      const read = node('button', 'secondary-button', 'Find the manga'); read.type = 'button';
      read.addEventListener('click', () => search(item.name)); actions.append(read);
    }
    body.append(actions); host.append(body);
  }
  function continueReading() {
    const host = $('anime-room-continue'); host.replaceChildren();
    if (!canRead()) return;
    const records = window.BlazingManga?.history() || [];
    if (!records.length) return;
    host.append(window.BlazingManga.historySection(records.slice(0, 4)));
  }
  async function discover() {
    if (!state.profile?.id) return;
    const request = ++state.generation;
    const key = `${state.profile.id}:${state.category}`;
    state.loaded = '';
    status('Loading anime…'); feature(null); $('anime-room-results').replaceChildren(); continueReading();
    const category = encodeURIComponent(state.category);
    try {
      const data = await json(`${FLEET}/discover/cat/anime/${category}`);
      if (!current(request)) return;
      const items = animeItems(data);
      if (!items.length) { status('No anime titles are available for this profile here yet.', discover); return; }
      state.loaded = key; status('');
      const selected = items.find((item) => item.background) || items[0];
      feature(selected);
      $('anime-room-results').append(section(text(data.name) || 'Explore anime', items));
      if (!selected.background || !selected.description) {
        const full = await state.services.fetchFullMeta(selected);
        if (!current(request) || !full) return;
        // A detail lookup can add a rating that was absent from discovery.
        if (full.contentRating) selected.contentRating = full.contentRating;
        if (!state.services.ratingAllowed(selected.contentRating)) {
          feature(null);
          $('anime-room-results').querySelectorAll('[data-anime-id]').forEach((card) => { if (card.dataset.animeId === selected.id) card.remove(); });
          return;
        }
        feature({ ...selected, background: selected.background || full.background, description: selected.description || full.description, imdbRating: selected.imdbRating || full.imdbRating });
      }
    } catch {
      if (current(request)) status('The anime library could not be reached.', discover);
    }
  }
  async function search(query) {
    query = text(query).trim().slice(0, 180);
    if (!query || !state.profile?.id) { $('anime-room-query').focus(); return; }
    $('anime-room-query').value = query;
    state.services.navigate('anime-search');
    state.loaded = '';
    const request = ++state.generation;
    status(`Searching for “${query}”…`); feature(null);
    $('anime-room-continue').replaceChildren(); $('anime-room-results').replaceChildren();
    const encoded = encodeURIComponent(query);
    const jobs = [json(`${KITSU}/catalog/anime/kitsu-anime-list/search=${encoded}.json`)];
    if (canRead()) jobs.push(json(`${FLEET}/manga/search?q=${encoded}&limit=20`), json(`${FLEET}/comics/search?q=${encoded}&limit=20`));
    const results = await Promise.allSettled(jobs);
    if (!current(request)) return;
    const groups = [];
    const failures = [];
    const names = ['Anime', 'Manga', 'Comics'];
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') { failures.push(names[index]); return; }
      const data = result.value;
      const items = index === 0 ? animeItems(data) : unique(data[index === 1 ? 'manga' : 'comics'] || []);
      if (items.length) groups.push(section(names[index], items, ['anime', 'manga', 'comics'][index]));
    });
    $('anime-room-results').replaceChildren(...groups);
    const count = $('anime-room-results').querySelectorAll('.card').length;
    let message = count ? `${count} results for “${query}”` : `No matches for “${query}”.`;
    if (failures.length) message = `${count ? message + '. ' : ''}${failures.join(' and ')} search could not be reached.`;
    if (!canRead()) message += ' Manga and comics need a Mature or Adult profile.';
    status(message, failures.length ? () => search(query) : null);
  }
  async function loadComics() {
    const host = $('comics-rows');
    const request = ++state.generation;
    host.replaceChildren();
    if (!canRead()) { host.append(node('p', 'empty-copy', 'Comics have no age ratings. Switch to a Mature or Adult profile to open them.')); return; }
    host.append(node('p', 'empty-copy', 'Loading comics…'));
    try {
      const data = await json(`${FLEET}/comics/discover?limit=20`);
      if (!current(request) || !canRead()) return;
      const popular = unique(data.popular || []);
      const ids = new Set(popular.map((item) => item.id));
      const latest = unique(data.latest || data.newest || []).filter((item) => !ids.has(item.id));
      const groups = [];
      if (popular.length) groups.push(section('Popular comics', popular, 'comics'));
      if (latest.length) groups.push(section('Recently added', latest, 'comics'));
      host.replaceChildren(...groups);
      if (!groups.length) host.append(node('p', 'empty-copy', 'No comics are available right now.'));
    } catch {
      if (!current(request)) return;
      const message = node('p', 'empty-copy', 'The comics library could not be reached. ');
      const retry = node('button', 'secondary-button', 'Try again'); retry.type = 'button';
      retry.addEventListener('click', loadComics); message.append(retry); host.replaceChildren(message);
    }
  }
  function mount(route, services) {
    state.services = services;
    if (route !== state.route) ++state.generation;
    state.route = route;
    if (!state.bound) {
      state.bound = true;
      document.querySelectorAll('[data-room-view]').forEach((button) => button.addEventListener('click', () => services.navigate(button.dataset.roomView)));
      document.querySelectorAll('[data-anime-category]').forEach((button) => button.addEventListener('click', () => {
        state.category = button.dataset.animeCategory;
        document.querySelectorAll('[data-anime-category]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
        discover();
      }));
      $('anime-room-search').addEventListener('submit', (event) => { event.preventDefault(); search($('anime-room-query').value); });
    }
    document.querySelectorAll('[data-room-view]').forEach((button) => button.setAttribute('aria-current', button.dataset.roomView === route ? 'page' : 'false'));
    $('anime-room-filters').hidden = route !== 'anime';
    if (route === 'anime') {
      continueReading();
      if (state.loaded !== `${state.profile?.id}:${state.category}`) discover();
    }
  }
  function reset(profile) {
    ++state.generation; state.profile = profile; state.loaded = '';
    for (const id of ['anime-room-results', 'anime-room-feature', 'anime-room-continue', 'comics-rows']) $(id)?.replaceChildren();
    $('anime-room-query').value = ''; $('anime-room-status').textContent = '';
    window.comicReader?.close();
    if (!profile || !state.services) return;
    if (state.route === 'anime') discover();
    if (state.route === 'comics') loadComics();
  }
  document.addEventListener('blazing-profile-selected', (event) => reset(event.detail?.id ? event.detail : null));
  document.addEventListener('blazing-profile-signed-out', () => reset(null));
  document.addEventListener('blazing-reading-progress', continueReading);
  window.BlazingAnimeRoom = { mount, search, loadComics };
})();
