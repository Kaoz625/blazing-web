/* Blazing web: an original, small-screen first client for the shared add-on. */
'use strict';

const API_BASE = 'https://addon.lyreosai.com';
const FLEET_BASE = 'https://fleet.lyreosai.com';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const FETCH_TIMEOUT = 20000;
const LIST_KEY = 'blazing-my-list-v1';
const FRESH_HOME_SHELVES = Object.freeze([
  {
    id: 'fresh-in-theaters',
    title: 'New Movies · In Theaters',
    type: 'movie',
    path: '/discover/filter/in-theaters',
  },
  {
    id: 'fresh-new-seasons',
    title: 'New Shows · Now Airing',
    type: 'series',
    path: '/discover/filter/new-seasons',
  },
  {
    id: 'fresh-top-rated',
    title: 'Top Rated Movies',
    type: 'movie',
    path: '/discover/filter/top-rated',
  },
]);

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const el = (tag, className) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

async function fetchJSON(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal, mode: 'cors', credentials: 'omit' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function plainText(value, fallback = '') {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function safeMeta(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  return {
    id: plainText(raw.id),
    type: plainText(raw.type, 'movie'),
    name: plainText(raw.name, 'Untitled'),
    poster: safeHttpsUrl(raw.poster),
    background: safeHttpsUrl(raw.background),
    description: plainText(raw.description),
    releaseInfo: plainText(raw.releaseInfo),
    website: safeHttpsUrl(raw.website),
  };
}

function isMwp(meta) {
  return Boolean(meta && /^mwp:tv:[1-9]\d*$/.test(meta.id));
}

function sourceLabel(meta) {
  return isMwp(meta) ? 'MrWorldPremiere source' : '';
}

function setBackground(node, value) {
  const image = safeHttpsUrl(value);
  node.style.backgroundImage = image
    ? `linear-gradient(90deg, rgba(10,10,11,.98) 0%, rgba(10,10,11,.7) 42%, rgba(10,10,11,.15) 100%), url("${image.replace(/"/g, '%22')}")`
    : '';
}

function readList() {
  try {
    const stored = JSON.parse(localStorage.getItem(LIST_KEY) || '[]');
    return Array.isArray(stored) ? stored.map(safeMeta).filter(Boolean).slice(0, 100) : [];
  } catch {
    return [];
  }
}

const state = {
  catalogs: [],
  featured: null,
  selected: null,
  route: 'home',
  myList: readList(),
};

const homeView = $('#home-view');
const searchView = $('#search-view');
const libraryView = $('#library-view');
const discoverView = $('#discover-view');
const roadmapsView = $('#roadmaps-view');
const rowsWrap = $('#rows');
const hero = $('#hero');
const heroArt = $('#hero-art');
const heroTitle = $('#hero-title');
const heroCopy = $('#hero-copy');
const heroOpen = $('#hero-open');
const heroSave = $('#hero-save');
const drawerLayer = $('#drawer-layer');
const menuButton = $('#menu-button');
const detailDialog = $('#detail-dialog');
const detailTitle = $('#detail-title');
const detailCopy = $('#detail-copy');
const detailYear = $('#detail-year');
const detailArt = $('#detail-art');
const detailSource = $('#detail-source');
const detailSourceLink = $('#detail-source-link');
const detailPlay = $('#detail-play');
const detailStatus = $('#detail-status');
const player = $('#player');
const video = $('#video');
const playerSpinner = $('#player-spinner');
const playerMsg = $('#player-msg');
const playerTitle = $('#player-title');
const discoverTitle = $('#discover-title');
const discoverCopy = $('#discover-copy');
const discoverStatus = $('#discover-status');
const discoverResults = $('#discover-results');
let discoverRequest = 0;

function persistList() {
  localStorage.setItem(LIST_KEY, JSON.stringify(state.myList));
}

function listHas(meta) {
  return state.myList.some((item) => item.id === meta.id && item.type === meta.type);
}

function toggleMyList(meta) {
  if (!meta) return;
  const index = state.myList.findIndex((item) => item.id === meta.id && item.type === meta.type);
  if (index >= 0) state.myList.splice(index, 1);
  else state.myList.unshift(meta);
  persistList();
  updateSaveLabels();
  if (state.route === 'library') renderLibrary();
}

function updateSaveLabels() {
  const saved = state.selected && listHas(state.selected);
  $('#detail-save').textContent = saved ? 'Remove from list' : 'My list';
  heroSave.textContent = state.featured && listHas(state.featured) ? 'Saved' : 'My list';
}

function openDrawer() {
  drawerLayer.hidden = false;
  menuButton.setAttribute('aria-expanded', 'true');
  $('#drawer button[data-view]')?.focus();
}

function closeDrawer() {
  drawerLayer.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
}

function updateNavigation(route) {
  $$('[data-view]').forEach((button) => {
    const active = button.dataset.view === route;
    button.classList.toggle('active', active);
    if (button.closest('nav')) button.setAttribute('aria-current', active ? 'page' : 'false');
  });
}

function applyRowFilter(route) {
  $$('.row', rowsWrap).forEach((row) => {
    const type = row.dataset.type || '';
    const name = row.dataset.name || '';
    let visible = route === 'home';
    if (route === 'movies') visible = type === 'movie';
    if (route === 'shows') visible = type === 'series';
    if (route === 'anime') visible = /anime/i.test(name);
    row.hidden = !visible;
  });
  hero.hidden = route !== 'home';
}

function showRoute(route) {
  const browseRoute = ['home', 'movies', 'shows', 'anime'].includes(route);
  state.route = route;
  homeView.hidden = !browseRoute;
  searchView.hidden = route !== 'search';
  libraryView.hidden = route !== 'library';
  adminView.hidden = route !== 'admin' && route !== 'link';
  discoverView.hidden = route !== 'discover';
  roadmapsView.hidden = route !== 'roadmaps';
  if (browseRoute) applyRowFilter(route);
  if (route === 'library') renderLibrary();
  if (route === 'search') setTimeout(() => $('#search-input').focus(), 0);
  updateNavigation(route);
  closeDrawer();
  window.scrollTo(0, 0);
}

function buildRowSkeleton(catalog) {
  const section = el('section', 'row');
  section.dataset.type = plainText(catalog.type);
  section.dataset.name = plainText(catalog.name);
  const heading = el('h2', 'row-title');
  heading.textContent = plainText(catalog.name, catalog.id);
  const track = el('div', 'row-track');
  for (let i = 0; i < 6; i += 1) track.appendChild(el('div', 'card skeleton'));
  section.append(heading, track);
  return section;
}

function buildCard(meta) {
  const card = el('button', 'card');
  card.type = 'button';
  card.setAttribute('aria-label', `View ${meta.name}`);
  const image = el('img', 'card-image');
  image.loading = 'lazy';
  image.decoding = 'async';
  image.alt = '';
  if (meta.poster) {
    image.src = meta.poster;
    image.addEventListener('error', () => card.classList.add('no-image'), { once: true });
  } else {
    card.classList.add('no-image');
  }
  const label = el('span', 'card-label');
  label.textContent = meta.name;
  const source = sourceLabel(meta);
  if (source) {
    const badge = el('span', 'card-source');
    badge.textContent = 'MWP';
    card.appendChild(badge);
  }
  card.append(image, label);
  card.addEventListener('click', () => openDetail(meta));
  return card;
}

function setHero(meta) {
  state.featured = meta;
  hero.classList.remove('hero-loading');
  setBackground(heroArt, meta.background || meta.poster);
  heroTitle.textContent = meta.name;
  heroCopy.textContent = meta.description || meta.releaseInfo || 'Open the details to see available sources.';
  heroOpen.disabled = false;
  heroSave.disabled = false;
  updateSaveLabels();
}

function emptyHero(message) {
  hero.classList.remove('hero-loading');
  heroTitle.textContent = 'Your library is ready';
  heroCopy.textContent = message;
  heroOpen.disabled = true;
  heroSave.disabled = true;
}

async function loadRow(catalog, section) {
  const track = $('.row-track', section);
  try {
    const data = await fetchJSON(
      `${API_BASE}/catalog/${encodeURIComponent(catalog.type)}/${encodeURIComponent(catalog.id)}.json`
    );
    const metas = (Array.isArray(data.metas) ? data.metas : []).map(safeMeta).filter(Boolean);
    if (!metas.length) {
      section.remove();
      return [];
    }
    track.replaceChildren(...metas.map(buildCard));
    return metas;
  } catch {
    section.remove();
    return [];
  }
}

async function loadFreshHomeRow(shelf, section) {
  const track = $('.row-track', section);
  try {
    const data = await fetchJSON(`${FLEET_BASE}${shelf.path}`);
    const metas = (Array.isArray(data.items) ? data.items : [])
      .map((item) => safeDiscoverMeta({ ...item, type: item.type || shelf.type }))
      .filter(Boolean);
    if (!metas.length) {
      section.remove();
      return [];
    }
    track.replaceChildren(...metas.map(buildCard));
    return metas;
  } catch {
    section.remove();
    return [];
  }
}

function activeCatalogs(rawCatalogs) {
  const adult = /adult|nsfw|jav|hentai|porn|xxx|18\+/i;
  return rawCatalogs.filter((catalog) => {
    const text = `${catalog.id || ''} ${catalog.type || ''} ${catalog.name || ''}`;
    const extras = Array.isArray(catalog.extra) ? catalog.extra : [];
    return !adult.test(text) && !extras.some((extra) => extra && extra.isRequired);
  });
}

async function boot() {
  rowsWrap.replaceChildren();
  state.featured = null;
  hero.classList.add('hero-loading');

  // These fleet shelves are current when the add-on manifest is stale or slow.
  // They are added first and kept in fixed visual order. Existing add-on rows
  // still load below them as the broad catalog fallback.
  const freshJobs = FRESH_HOME_SHELVES.map((shelf) => {
    const section = buildRowSkeleton({ id: shelf.id, name: shelf.title, type: shelf.type });
    section.dataset.freshShelf = 'true';
    rowsWrap.appendChild(section);
    return loadFreshHomeRow(shelf, section);
  });
  const freshDone = Promise.all(freshJobs).then((rows) => {
    const first = rows.find((metas) => metas.length)?.[0];
    if (first) setHero(first);
    return rows;
  });

  const catalogDone = fetchJSON(`${API_BASE}/manifest.json`)
    .then((manifest) => {
      state.catalogs = activeCatalogs(Array.isArray(manifest.catalogs) ? manifest.catalogs : []);
      const jobs = state.catalogs.map((catalog) => {
        const section = buildRowSkeleton(catalog);
        rowsWrap.appendChild(section);
        return loadRow(catalog, section);
      });
      return Promise.all(jobs);
    })
    .then((rows) => {
      // Do not leave a usable catalog behind a slow fresh-feed request. A fresh
      // result replaces this temporary hero as soon as it arrives.
      const first = rows.find((metas) => metas.length)?.[0];
      if (first && !state.featured) setHero(first);
      return rows;
    })
    .catch(() => []);

  const [freshRows, catalogRows] = await Promise.all([freshDone, catalogDone]);
  const first = freshRows.find((metas) => metas.length)?.[0]
    || catalogRows.find((metas) => metas.length)?.[0];
  if (first) {
    // `freshDone` normally sets this early. This covers the case where a cache
    // or test stub resolves the two sources in a different order.
    if (!state.featured) setHero(first);
  } else {
    emptyHero('Nothing is available right now. Try again soon.');
  }
  applyRowFilter(state.route);
}

function openDetail(meta) {
  state.selected = meta;
  detailTitle.textContent = meta.name;
  detailYear.textContent = meta.releaseInfo;
  detailCopy.textContent = meta.description || 'Open this title to check available streams.';
  setBackground(detailArt, meta.background || meta.poster);
  const source = sourceLabel(meta);
  detailSource.hidden = !source;
  detailSource.textContent = source;
  const sourceOnly = isMwp(meta);
  detailPlay.hidden = sourceOnly;
  
  if (typeof detailUpscale !== 'undefined') {
    detailUpscale.disabled = false;
    detailUpscale.textContent = '4K Upscale';
    // No queue count here: GET /api/upscale/status does not exist. The service's
    // own spec (https://upscale.lyreosai.com/openapi.json) lists only
    // POST /api/search, /api/upscale/request, /api/upscale/approve and /api/clone.
    // A fetch was added here, and on Fire TV and tvOS, all calling that 404 —
    // and from an https page a http:// call to the old LAN address was blocked
    // as mixed content on top of it. Removed until the endpoint exists.
  }
  
  const sourceUrl = isMwp(meta) ? meta.website : '';
  detailSourceLink.hidden = !sourceUrl;
  if (sourceUrl) detailSourceLink.href = sourceUrl;
  detailStatus.textContent = sourceOnly
    ? 'Source page only. Open MrWorldPremiere in a web browser to watch.'
    : '';
  updateSaveLabels();
  if (typeof detailDialog.showModal === 'function') detailDialog.showModal();
  else detailDialog.setAttribute('open', '');
  
  if (!sourceOnly) {
    loadStreams(meta);
  } else {
    $('#detail-streams').innerHTML = '';
  }
}

function closeDetail() {
  if (detailDialog.open && typeof detailDialog.close === 'function') detailDialog.close();
  else detailDialog.removeAttribute('open');
  state.selected = null;
  $('#detail-streams').innerHTML = '';
}

async function resolveStreams(meta) {
  const data = await fetchJSON(
    `${API_BASE}/stream/${encodeURIComponent(meta.type)}/${encodeURIComponent(meta.id)}.json`
  );
  return Array.isArray(data.streams) ? data.streams : [];
}

async function playSelected() {
  const meta = state.selected;
  if (!meta) return;
  detailStatus.textContent = 'Checking direct streams…';
  try {
    const streams = await resolveStreams(meta);
    const deadLinks = JSON.parse(localStorage.getItem('dead_links') || '[]');
    const getPenalty = (s) => {
      if (deadLinks.includes(s.url)) return 1000;
      let p = 0;
      const b = (s.name + ' ' + (s.title || '')).toLowerCase();
      if (/rus|russian|ita|italian|latino|french/.test(b)) p += 100;
      return p;
    };
    streams.sort((a, b) => getPenalty(a) - getPenalty(b));
    const playable = streams.find((stream) => stream && safeHttpsUrl(stream.url) && !deadLinks.includes(stream.url)) || streams.find((stream) => stream && safeHttpsUrl(stream.url));
    if (!playable) {
      detailStatus.textContent = isMwp(meta)
        ? 'This source page has no verified direct stream for this device yet.'
        : 'No compatible direct stream is available right now.';
      return;
    }
    closeDetail();
    openPlayer(meta.name, playable.url);
  } catch {
    detailStatus.textContent = 'Could not check streams. Try again.';
  }
}

function setPlayerState(kind, message) {
  playerSpinner.hidden = kind !== 'loading';
  playerMsg.hidden = kind !== 'error';
  playerMsg.textContent = kind === 'error' ? message || 'Something went wrong.' : '';
  video.classList.toggle('ready', kind === 'playing');
}

function openPlayer(title, rawUrl) {
  const url = safeHttpsUrl(rawUrl);
  if (!url) return;
  playerTitle.textContent = title;
  player.hidden = false;
  document.body.classList.add('no-scroll');
  setPlayerState('loading');
  video.addEventListener('loadedmetadata', () => setPlayerState('playing'), { once: true });
  video.addEventListener('error', () => {
    setPlayerState('error', 'This stream cannot play in this browser. Try another source.');
  }, { once: true });
  video.src = url;
  video.load();
  const play = video.play();
  if (play && typeof play.catch === 'function') play.catch(() => setPlayerState('playing'));
}

function closePlayer() {
  video.pause();
  video.removeAttribute('src');
  video.load();
  player.hidden = true;
  document.body.classList.remove('no-scroll');
}

async function catalogSearch(type, query) {
  const data = await fetchJSON(`${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`);
  return (Array.isArray(data.metas) ? data.metas : []).map(safeMeta).filter(Boolean);
}

async function mwpSearch(query) {
  const data = await fetchJSON(`${API_BASE}/catalog/movie/mwp-search/search=${encodeURIComponent(query)}.json`);
  return (Array.isArray(data.metas) ? data.metas : []).map(safeMeta).filter(Boolean);
}

function buildResultRow(title, metas) {
  const section = el('section', 'result-row');
  const heading = el('h2', 'row-title');
  heading.textContent = title;
  const grid = el('div', 'result-grid');
  grid.append(...metas.map(buildCard));
  section.append(heading, grid);
  return section;
}

async function runSearch(event) {
  event.preventDefault();
  const query = plainText($('#search-input').value);
  const status = $('#search-status');
  const target = $('#search-results');
  target.replaceChildren();
  if (!query) {
    status.textContent = 'Type a title first.';
    return;
  }
  status.textContent = 'Searching all sources…';
  const [movies, shows, mwp] = await Promise.allSettled([
    catalogSearch('movie', query),
    catalogSearch('series', query),
    mwpSearch(query),
  ]);
  const groups = [
    ['Movies', movies.status === 'fulfilled' ? movies.value : []],
    ['Shows', shows.status === 'fulfilled' ? shows.value : []],
    ['MrWorldPremiere', mwp.status === 'fulfilled' ? mwp.value : []],
  ];
  const seen = new Set();
  let count = 0;
  for (const [title, sourceMetas] of groups) {
    const metas = sourceMetas.filter((meta) => {
      const key = `${meta.type}/${meta.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!metas.length) continue;
    count += metas.length;
    target.appendChild(buildResultRow(title, metas));
  }
  status.textContent = count ? `${count} result${count === 1 ? '' : 's'} found.` : 'No titles found.';
}

function renderLibrary() {
  const target = $('#library-results');
  target.replaceChildren();
  if (!state.myList.length) {
    const message = el('p', 'empty-copy');
    message.textContent = 'Open a title and use My list to save it here.';
    target.appendChild(message);
    return;
  }
  target.appendChild(buildResultRow('Saved titles', state.myList));
}

function safeDiscoverMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return safeMeta({ ...raw, releaseInfo: raw.year || raw.releaseInfo });
}

async function openDiscover(kind, slug, label) {
  if (!/^(filter|provider)$/.test(kind) || !/^[a-z0-9-]{1,48}$/.test(slug)) return;
  const request = ++discoverRequest;
  showRoute('discover');
  discoverTitle.textContent = label;
  discoverCopy.textContent = kind === 'provider'
    ? `Titles available with ${label}.`
    : `Browse ${label.toLowerCase()} titles.`;
  discoverStatus.textContent = `Loading ${label}…`;
  discoverResults.replaceChildren();
  try {
    const data = await fetchJSON(`${FLEET_BASE}/discover/${kind}/${encodeURIComponent(slug)}`);
    if (request !== discoverRequest || state.route !== 'discover') return;
    const metas = (Array.isArray(data.items) ? data.items : []).map(safeDiscoverMeta).filter(Boolean);
    discoverTitle.textContent = plainText(data.name, label);
    if (!metas.length) {
      discoverStatus.textContent = `Nothing came back for ${plainText(data.name, label)}.`;
      return;
    }
    discoverStatus.textContent = `${metas.length} titles`;
    discoverResults.appendChild(buildResultRow(plainText(data.name, label), metas));
  } catch {
    if (request === discoverRequest && state.route === 'discover') {
      discoverStatus.textContent = `Could not load ${label}. Try again.`;
    }
  }
}

$$('[data-view]').forEach((button) => {
  button.addEventListener('click', () => showRoute(button.dataset.view || 'home'));
});
$$('[data-discover-kind]').forEach((button) => {
  button.addEventListener('click', () => {
    openDiscover(button.dataset.discoverKind || '', button.dataset.discoverSlug || '', button.textContent || 'Discover');
  });
});
$('#menu-button').addEventListener('click', openDrawer);
$('#drawer-backdrop').addEventListener('click', closeDrawer);
$('#hero-open').addEventListener('click', () => state.featured && openDetail(state.featured));
$('#hero-save').addEventListener('click', () => state.featured && toggleMyList(state.featured));
$('#detail-close').addEventListener('click', closeDetail);
$('#detail-play').addEventListener('click', playSelected);
$('#detail-save').addEventListener('click', () => state.selected && toggleMyList(state.selected));
$('#search-form').addEventListener('submit', runSearch);
$('#player-close').addEventListener('click', closePlayer);
detailDialog.addEventListener('click', (event) => {
  if (event.target === detailDialog) closeDetail();
});
detailDialog.addEventListener('cancel', () => {
  state.selected = null;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !player.hidden) closePlayer();
  if (event.key === 'Escape' && !drawerLayer.hidden) closeDrawer();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

boot();

const detailUpscale = $('#detail-upscale');

detailUpscale.addEventListener('click', async () => {
  const meta = state.selected;
  if (!meta) return;
  detailUpscale.disabled = true;
  detailUpscale.textContent = 'Requesting...';
  try {
    const res = await fetch('https://upscale.lyreosai.com/api/upscale/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: meta.name,
        media_type: meta.type,
        video_url: 'pending:no-stream-selected'
      })
    });
    const data = await res.json();
    if (data.status === 'queued') {
      detailUpscale.textContent = data.message || 'Queued';
    } else {
      detailUpscale.textContent = 'Service does not accept it';
    }
  } catch (err) {
    detailUpscale.textContent = 'Failed';
  }
});

async function loadStreams(meta) {
  const container = $('#detail-streams');
  container.innerHTML = '';
  if (isMwp(meta)) return;
  
  detailStatus.textContent = 'Loading streams...';
  try {
    let streams = await resolveStreams(meta);
    if (!streams.length) {
      detailStatus.textContent = 'No compatible stream available.';
      return;
    }
    
    // Sort logic
    const deadLinks = JSON.parse(localStorage.getItem('dead_links') || '[]');
    const getPenalty = (s) => {
      if (deadLinks.includes(s.url)) return 1000;
      let p = 0;
      const b = (s.name + ' ' + (s.title || '')).toLowerCase();
      if (/rus|russian|ita|italian|latino|french/.test(b)) p += 100;
      return p;
    };
    
    streams.sort((a, b) => getPenalty(a) - getPenalty(b));
    
    detailStatus.textContent = '';
    
    streams.forEach(s => {
      const row = document.createElement('div');
      row.className = 'stream-row';
      if (deadLinks.includes(s.url)) row.classList.add('dead');
      
      const q = s.name || 'SD';
      const title = s.title || '';
      
      row.innerHTML = `
        <div class="stream-info">
          <div class="stream-q">${q}</div>
          <div class="stream-title">${title}</div>
        </div>
      `;
      
      row.onclick = () => {
        closeDetail();
        openPlayer(meta.name, s.url);
      };
      
      row.oncontextmenu = (e) => {
        e.preventDefault();
        if (!deadLinks.includes(s.url)) deadLinks.push(s.url);
        localStorage.setItem('dead_links', JSON.stringify(deadLinks));
        row.classList.add('dead');
        container.appendChild(row); // move to bottom
      };
      
      container.appendChild(row);
    });
    
  } catch (err) {
    detailStatus.textContent = 'Failed to load streams.';
  }
}
