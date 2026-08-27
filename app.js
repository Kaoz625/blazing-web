/* Blazing web: an original, small-screen first client for the shared add-on. */
'use strict';

const API_BASE = 'https://addon.lyreosai.com';
const FLEET_BASE = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
// The ONLY host that serves the upscale routes. Measured 26 Aug 2026:
//   GET  https://upscale.lyreosai.com/api/upscale/request -> 405 (allow: POST)  route exists
//   GET  https://addon.lyreosai.com/api/upscale/request   -> 404               wrong host
// This page is served over https, so this must stay https — a http:// call is
// blocked outright as mixed content. That has already broken this repo once.
const UPSCALE_BASE = 'https://upscale.lyreosai.com';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const FETCH_TIMEOUT = 20000;
const RESOLVE_TIMEOUT = 12000;
const PLAYER_STALL_TIMEOUT = 25000;
const TOAST_LIFETIME_MS = 4200;
const UPSCALE_LABEL = '4K Upscale';
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

/* Transient messages. There was no app-wide toast before this: watch-party.js has
   one, but it is an emoji float positioned inside the party call panel, so it is
   not reusable here. This is the one general-purpose transient message widget.

   The host is MOVED rather than duplicated, because #detail-dialog is opened with
   showModal(): a body-level element renders under the top layer no matter its
   z-index, and .detail-dialog also sets backdrop-filter (which makes it the
   containing block for position:fixed descendants) plus overflow:hidden. So while
   a dialog is open the host is parked inside that dialog's card and positioned
   absolutely; otherwise it is fixed to the viewport. */
let toastHost = null;

function ensureToastHost() {
  if (!toastHost) {
    toastHost = el('div', 'toast-host');
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
  }
  const openDialog = $('dialog[open]');
  const parent = openDialog ? ($('.detail-card', openDialog) || openDialog) : document.body;
  if (toastHost.parentNode !== parent) {
    // Never carry a stale message across the move.
    while (toastHost.firstChild) toastHost.firstChild.remove();
    parent.appendChild(toastHost);
  }
  toastHost.classList.toggle('toast-host-inline', Boolean(openDialog));
  return toastHost;
}

function showToast(message, kind = 'info') {
  const text = plainText(message);
  if (!text) return;
  const host = ensureToastHost();
  const node = el('p', kind === 'error' ? 'toast toast-error' : 'toast');
  node.textContent = text;
  host.appendChild(node);
  window.setTimeout(() => {
    node.classList.add('toast-out');
    window.setTimeout(() => node.remove(), 220);
  }, TOAST_LIFETIME_MS);
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

/**
 * Only https, and only a map of short label -> https url. Anything else is
 * dropped rather than trusted: this value ends up in a <video src>, so it is
 * exactly the field an upstream catalog could use to point the player somewhere
 * it should not go.
 */
function safeQualityMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw).slice(0, 8)) {
    const label = plainText(key).slice(0, 12);
    const url = safeHttpsUrl(typeof value === 'string' ? value : (value && value.url));
    if (label && url) out[label] = url;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * safeMeta is an ALLOW list — anything not named here is thrown away.
 *
 * That is deliberate and worth keeping, but it also meant trailerUrl and
 * streamsByQuality were being deleted from every response before any screen
 * could see them. Trailer autoplay and the quality picker would have stayed
 * dead even after the addon is redeployed, and it would have looked like a
 * backend problem. The rating fields are here for the same reason: the brief
 * asks for IMDb/TMDB age and star ratings on the detail page, and they cannot
 * be shown if they are stripped on arrival.
 */
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
    trailerUrl: safeHttpsUrl(raw.trailerUrl),
    streamsByQuality: safeQualityMap(raw.streamsByQuality),
    imdbRating: plainText(raw.imdbRating || raw.rating).slice(0, 5),
    certification: plainText(raw.certification || raw.ageRating).slice(0, 12),
    runtime: plainText(raw.runtime).slice(0, 16),
    // Emby titles play straight off the fleet rather than through the addon's
    // /stream route, so the id has to survive this allow list. Dropping it here
    // is how the Emby play button ends up doing nothing at all.
    embyId: plainText(raw.embyId).slice(0, 64),
    // A Blazing tier (general/teen/mature/adult) or empty when unknown. Carried
    // so the profile cap has something to judge; the web app has no kids gate
    // yet, and this is the field it will need when it gets one.
    contentRating: plainText(raw.contentRating).slice(0, 12),
    genres: Array.isArray(raw.genres) ? raw.genres.slice(0, 4).map((g) => plainText(g).slice(0, 24)).filter(Boolean) : [],
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
  // The rating cap of the connected profile, or null when nobody has connected
  // one. profile.js has broadcast this on blazing-profile-selected since it was
  // written; until now NOTHING listened, so every Emby row reached every viewer
  // and the Kids profile on the web saw the whole library.
  profileCap: null,
};

const homeView = $('#home-view');
const searchView = $('#search-view');
let aiSearchActive = false;
const libraryView = $('#library-view');
// showRoute() has read this on every navigation since 67776fb, but nothing ever
// declared it. Under 'use strict' that threw ReferenceError before
// updateNavigation() and closeDrawer() could run. Proven with locker.smoke.mjs
// against a pristine HEAD checkout: "ReferenceError: adminView is not defined".
const adminView = $('#admin-view');
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
const detailUpscale = $('#detail-upscale');
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

/* ── Discover: browse by streaming service ───────────────────────────────────
 *
 * This existed as MARKUP ONLY. index.html carried "Netflix", "Hulu", "Disney+"
 * and the rest as buttons with data-discover-kind and data-discover-slug, the view
 * shell was in the page, and app.js declared discoverTitle / discoverResults /
 * discoverRequest — and then nothing. No listener was ever attached and
 * #discover-results was never written to, so every one of those buttons did
 * nothing at all when pressed. Roku and Fire TV have had this working for months.
 *
 * The list is also no longer hardcoded. It was, and it had drifted: 9 of the
 * fleet's 24 providers and 4 of its 6 filters, missing Tubi, Pluto, Plex,
 * Crunchyroll, BritBox, Starz, Showtime, MGM+, YouTube and six more. It is built
 * from /discover/menu now, so a provider added on the fleet appears here without
 * anyone editing HTML.
 */
const DISCOVER_MENU_PATH = '/discover/menu';

async function loadDiscoverMenu() {
  const filters = $('#drawer nav[aria-label="More"]');
  const providers = $('#drawer nav[aria-label="Channels and apps"]');
  if (!filters && !providers) return;
  let menu;
  try {
    menu = await fetchJSON(`${FLEET_BASE}${DISCOVER_MENU_PATH}`);
  } catch (e) {
    // The hardcoded buttons stay in the page as a fallback, so a fleet outage
    // leaves the short list rather than an empty drawer.
    console.warn('[discover] menu', e && e.message);
    return;
  }
  const build = (host, entries, kind) => {
    if (!host || !Array.isArray(entries) || !entries.length) return;
    host.replaceChildren(...entries
      .filter((entry) => entry && entry.slug && entry.name)
      .map((entry) => {
        const button = el('button');
        button.type = 'button';
        button.dataset.discoverKind = kind;
        button.dataset.discoverSlug = entry.slug;
        button.textContent = entry.name;
        return button;
      }));
  };
  build(filters, menu.more, 'filter');
  build(providers, menu.providers, 'provider');
}

/**
 * Called HERE, right after the definition, and that placement is the fix.
 *
 * It lived in two other places first and ran in neither: inside the
 * blazing-profile-selected listener, which never fires while the profile gate is
 * holding the screen; and then at the end of boot(), which is DEAD CODE — `boot`
 * is defined around line 780 and nothing in this file calls it. A third attempt at
 * the very end of the file did not run either, while the click listener a few lines
 * above this one did, so something between the two stops top-level execution.
 *
 * This spot is proven by the same evidence: the Discover click handler below it
 * works on the live site, so this line is reached.
 */
loadDiscoverMenu();

async function openDiscover(kind, slug, label) {
  if (!slug) return;
  const request = ++discoverRequest;
  closeDrawer();
  showRoute('discover');
  discoverTitle.textContent = label || slug;
  discoverCopy.textContent = kind === 'provider'
    ? 'What is streaming on this service right now.'
    : 'A curated filter from the Blazing catalog.';
  discoverStatus.textContent = '';
  discoverResults.replaceChildren(el('div', 'spinner big'));
  telemetry('nav_action', { action: 'discover', from: `${kind}:${slug}` });

  let data = null;
  try {
    data = await fetchJSON(`${FLEET_BASE}/discover/${kind}/${encodeURIComponent(slug)}`);
  } catch (e) {
    // A stale request must not overwrite a newer one — the user can press three
    // services before the first answers.
    if (request !== discoverRequest) return;
    discoverResults.replaceChildren();
    discoverStatus.textContent = 'That did not load. Try again in a moment.';
    return;
  }
  if (request !== discoverRequest) return;

  // The provider route answers {slug,name,subtitle,items}; the filter route uses
  // the same shape. Items carry imdb ids, so they open the ordinary detail sheet.
  const items = (data && (data.items || data.metas)) || [];
  if (data && data.name) discoverTitle.textContent = data.name;
  if (data && data.subtitle) discoverCopy.textContent = data.subtitle;
  const cards = items.map(embyMetaSafe).filter(Boolean);
  if (!cards.length) {
    discoverResults.replaceChildren();
    discoverStatus.textContent = 'Nothing is listed here today.';
    return;
  }
  discoverStatus.textContent = '';
  discoverResults.replaceChildren(...cards.map(buildCard));
}

/**
 * Discover items come from TMDB through the fleet, not from the add-on, so they
 * carry {id,type,name,poster,year} rather than a full add-on meta. buildCard wants
 * the add-on shape; this is the smallest honest translation, and it drops anything
 * with no id or no poster rather than drawing a grey rectangle.
 */
function embyMetaSafe(item) {
  if (!item || !item.id || !item.poster) return null;
  return {
    id: String(item.id),
    type: item.type === 'series' || item.mediaType === 'series' ? 'series' : 'movie',
    name: String(item.name || ''),
    poster: String(item.poster),
    description: String(item.description || ''),
    releaseInfo: String(item.year || item.releaseInfo || ''),
    contentRating: String(item.contentRating || ''),
  };
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-discover-kind][data-discover-slug]');
  if (!button) return;
  event.preventDefault();
  openDiscover(button.dataset.discoverKind, button.dataset.discoverSlug, button.textContent.trim());
});

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
  // The Trailers and Education sections shipped as markup with no code behind
  // them, so both tabs opened a blank page. They are lazy: a tab that is never
  // pressed costs nothing, and both back onto rows that are empty today.
  const trailersView = $('#trailers-view');
  const educationView = $('#education-view');
  const comicsView = $('#comics-view');
  const requestsView = $('#requests-view');
  if (trailersView) trailersView.hidden = route !== 'trailers';
  if (educationView) educationView.hidden = route !== 'education';
  if (comicsView) comicsView.hidden = route !== 'comics';
  if (requestsView) requestsView.hidden = route !== 'requests';
  
  const storiesView = $('#brightminds-stories');
  const podcastsView = $('#brightminds-podcasts');
  const familyView = $('#brightminds-family');
  
  if (storiesView) storiesView.hidden = route !== 'stories';
  if (podcastsView) podcastsView.hidden = route !== 'podcasts';
  if (familyView) familyView.hidden = route !== 'family';
  
  if (route === 'stories' && !storiesView.innerHTML.trim()) window.mountStorybook?.();
  if (route === 'podcasts' && !podcastsView.innerHTML.trim()) window.mountPodcastStudio?.();
  if (route === 'family' && !familyView.innerHTML.trim()) window.mountFamilyTree?.();

  if (route === 'trailers') loadTrailersView();
  if (route === 'education') loadEducationView();
  if (route === 'comics') loadComicsView();
  if (route === 'requests') loadRequestsView();
  telemetry('screen_view', { screen: route });
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

/**
 * Rows whose backend is committed but not deployed. MEASURED 26 Aug 2026: both
 * answer 200 with `metas: []`, because the running addon predates b65e115.
 * loadRow() already removes a section that comes back empty, so these cost one
 * request and leave no blank shelf behind.
 */
const TRENDING_ROWS = Object.freeze([
  { id: 'blazing-trending-movies', type: 'movie', name: '🔥 Trending Now' },
  { id: 'blazing-trending-series', type: 'series', name: '🔥 Trending Shows' },
]);

const TRAILER_ROWS = Object.freeze([
  { id: 'blazing-trailers-new', type: 'movie', name: '🎬 New in Theaters' },
  { id: 'blazing-trailers-upcoming', type: 'movie', name: '🗓 Coming Soon' },
]);

const EDU_SLUGS = Object.freeze(['science', 'history', 'stem', 'kids', 'languages']);

const HOVER_TRAILER_MS = 1000;

/**
 * Fade a card's poster into its muted trailer after a dwell.
 *
 * On dwell, not on hover: a mouse crossing a row would otherwise start and
 * cancel a video load per card, which on a slow connection queues a dozen
 * requests for something nobody asked to see.
 */
function attachHoverTrailer(card, meta) {
  if (!meta || !meta.trailerUrl) return;
  let timer = null;
  let video = null;
  const stop = () => {
    clearTimeout(timer);
    timer = null;
    if (video) {
      video.remove();
      video = null;
      card.classList.remove('card-previewing');
    }
  };
  card.addEventListener('mouseenter', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const url = safeHttpsUrl(meta.trailerUrl);
      if (!url) return;
      video = el('video', 'card-video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.src = url;
      video.addEventListener('error', stop, { once: true });
      card.appendChild(video);
      card.classList.add('card-previewing');
      const played = video.play();
      if (played && played.catch) played.catch(() => {});
    }, HOVER_TRAILER_MS);
  });
  card.addEventListener('mouseleave', stop);
  card.addEventListener('focusout', stop);
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
  attachHoverTrailer(card, meta);
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


async function loadSDUIRow(catalogInfo, section) {
  const track = $('.row-track', section);
  if (!catalogInfo.catalogSlug) {
    if (catalogInfo.id === 'continue') return loadContinueWatchingRow(section);
    section.remove();
    return [];
  }
  
  const fetchUrl = `${API_BASE}/catalog/tv/${catalogInfo.catalogSlug}.json`;
  
  try {
    const data = await fetchJSON(fetchUrl);
    const rawMetas = Array.isArray(data.metas) ? data.metas : (Array.isArray(data) ? data : []);
    
    const metas = rawMetas
      .map((item) => safeDiscoverMeta({ ...item, type: item.type || catalogInfo.type }))
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

async function loadContinueWatchingRow(section) {
  // Use existing logic for continue watching
  loadContinueWatching();
  section.remove(); // The existing logic creates its own row at the top
  return [];
}

/**
 * The home screen.
 *
 * THIS WAS NOT CALLED. The BlazeOS Phase 1 patch replaced the body with an
 * SDUI-only version and dropped the `boot();` call in the same change, so from
 * 48f1be5 until now NOTHING built the home: no hero, no shelves, no Continue
 * Watching. The only rows that ever appeared were the three Emby ones, drawn by
 * the blazing-profile-selected listener at the bottom of this file — which is
 * why the screen looked like it worked when a profile was picked, and why a
 * check that looked at the Emby rows passed. TRENDING_ROWS, FRESH_HOME_SHELVES,
 * loadRow, loadFreshHomeRow and activeCatalogs were all left defined, orphaned.
 *
 * AND THE SDUI PATH CANNOT WORK TODAY. /api/ui/home-config answers 404 on
 * addon.lyreosai.com. The route exists in the blazing-addon repo (server.js) and
 * the deployed addon does not have it — the same gap that leaves 13 of the edu
 * catalogs dead. So SDUI is TRIED, and the real shelves are the answer when it
 * is not there. Once the addon is deployed the layout it serves takes over with
 * no client change; until then the home is the one that works.
 */
async function boot() {
  const profileId = localStorage.getItem('profileId');
  if (!profileId) {
    try {
      const pRes = await fetch(`${API_BASE}/api/profiles`);
      const pData = await pRes.json();
      if (pData.profiles && pData.profiles.length > 1) {
        const d = $('#profile-picker');
        const l = $('#profile-list');
        pData.profiles.forEach((p) => {
          const b = document.createElement('button');
          b.className = 'primary-button';
          b.textContent = p.name;
          b.onclick = () => { localStorage.setItem('profileId', p.id); d.close(); loadContinueWatching(); };
          l.appendChild(b);
        });
        d.showModal();
      } else if (pData.profiles && pData.profiles.length === 1) {
        localStorage.setItem('profileId', pData.profiles[0].id);
        loadContinueWatching();
      }
    } catch (e) {}
  } else {
    loadContinueWatching();
  }

  rowsWrap.replaceChildren();
  state.featured = null;
  hero.classList.add('hero-loading');

  // Fire and forget: an Emby outage costs three hidden rows, never a slow or
  // broken home screen. Each row appends itself when it arrives.
  loadEmbyRows();

  if (await bootFromSDUI()) return;
  await bootFromShelves();
}


/**
 * Returns true only when the server actually described a layout AND at least one
 * of its rows had something in it. A 404, a throw, or a layout whose every row
 * came back empty all return false, so the caller falls through to the shelves
 * instead of leaving the viewer on an empty screen with a heading over it.
 */
async function bootFromSDUI() {
  try {
    const inviteCode = localStorage.getItem('validInviteCode');
    const mode = inviteCode ? 'blazing' : 'safe';
    const uiRes = await fetch(`${API_BASE}/api/ui/home-config?mode=${mode}`);
    if (!uiRes.ok) return false;
    const uiConfig = await uiRes.json();
    if (!uiConfig || !Array.isArray(uiConfig.homeRows) || !uiConfig.homeRows.length) return false;

    if (uiConfig.appName) {
      document.title = uiConfig.appName;
      const brandSpan = $('.brand-mark').nextElementSibling;
      if (brandSpan) brandSpan.textContent = uiConfig.appName;
    }
    // Applied only when the server names one. Writing `undefined` into --accent
    // is how a palette silently loses the one red every client agrees on.
    if (uiConfig.accentColor) document.documentElement.style.setProperty('--accent', uiConfig.accentColor);
    if (uiConfig.theme) document.documentElement.setAttribute('data-theme', uiConfig.theme);

    const jobs = uiConfig.homeRows.map((row) => {
      const catalogInfo = {
        id: row.id,
        type: row.type === 'cinematic_hero' ? 'movie' : 'series',
        name: row.label,
        catalogSlug: row.catalogSlug,
      };
      const section = buildRowSkeleton(catalogInfo);
      if (row.type === 'cinematic_hero') section.dataset.freshShelf = 'true';
      rowsWrap.appendChild(section);
      return loadSDUIRow(catalogInfo, section);
    });

    const rows = await Promise.all(jobs);
    const first = rows.find((metas) => metas && metas.length)?.[0];
    if (!first) return false;            // described a layout, served nothing
    if (!state.featured) setHero(first);
    applyRowFilter(state.route);
    return true;
  } catch (err) {
    console.warn('SDUI home-config unavailable — building the home from the shelves', err);
    return false;
  }
}


/**
 * The home that works today: trending, the fresh discover shelves, and every
 * catalog the addon's own manifest advertises. Recovered from 48f1be5^ — all of
 * these helpers were still in the file, just never called again.
 */
async function bootFromShelves() {
  const trendingJobs = TRENDING_ROWS.map((catalog) => {
    const section = buildRowSkeleton(catalog);
    section.dataset.softRow = 'true';
    rowsWrap.appendChild(section);
    return loadRow(catalog, section);
  });

  const freshJobs = FRESH_HOME_SHELVES.map((shelf) => {
    const section = buildRowSkeleton({ id: shelf.id, name: shelf.title, type: shelf.type });
    section.dataset.freshShelf = 'true';
    rowsWrap.appendChild(section);
    return loadFreshHomeRow(shelf, section);
  });
  const freshDone = Promise.all(freshJobs).then((rows) => {
    // Do not leave a usable catalog behind a slow fresh-feed request.
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
      const first = rows.find((metas) => metas.length)?.[0];
      if (first && !state.featured) setHero(first);
      return rows;
    })
    .catch(() => []);

  const [freshRows, catalogRows] = await Promise.all([freshDone, catalogDone, Promise.all(trendingJobs)]);
  const first = freshRows.find((metas) => metas.length)?.[0]
    || catalogRows.find((metas) => metas.length)?.[0];
  if (first) {
    if (!state.featured) setHero(first);
  } else {
    emptyHero('Nothing is available right now. Try again soon.');
  }
  applyRowFilter(state.route);
}

/* ---------------------------------------------------------------------------
   4K Upscale button.

   Contract, shared by every Blazing client:
     GET  {UPSCALE_BASE}/api/upscale/status?title=<url-encoded title>  -> {"count": N}
     POST {UPSCALE_BASE}/api/upscale/request
          {"title": ..., "media_type": "movie"|"series", "video_url": ...}
          -> {"status": "queued"|"error", "message": "...", "count": N}
   No imdb_id is ever sent.

   HONESTY RULE: a 200 is not success. The body must say status == "queued".
   The backend answers 200 with {"status":"error"} when its insert is rejected.

   MEASURED 26 Aug 2026 against the live service, so the tolerances below are not
   defensive guesswork:
     - the status route is NOT deployed yet (404), so the open-time lookup
       normally fails and the button just keeps its normal label;
     - a successful POST returns NO "count" field and its message reads
       "'<title>' has been added to the AI Queue and is awaiting Admin approval."
       -- not "Requested N times". So the count falls back to 1.
--------------------------------------------------------------------------- */
let upscaleCount = 0;
let upscaleBusy = false;
let upscaleStatusRequest = 0;

function upscaleRequestedLabel(count) {
  // Wording is fixed by the cross-client contract. Not pluralised on purpose.
  return `Requested ${count} times`;
}

/* count, then the number inside a "Requested N times" message, then 1.
   The message is matched strictly: a loose /(\d+)/ would read the "2" out of a
   title like "Dune 2" in the message the service actually returns today. */
function upscaleCountFrom(data) {
  const direct = Math.floor(Number(data && data.count));
  if (Number.isFinite(direct) && direct > 0) return direct;
  const match = /requested\s+(\d+)\s+time/i.exec(plainText(data && data.message));
  if (match) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 1;
}

// Visibly done, but still focusable so the keyboard and a TV D-pad do not skip it.
function markUpscaleSpent(count) {
  upscaleCount = count;
  detailUpscale.disabled = false;
  detailUpscale.textContent = upscaleRequestedLabel(count);
  detailUpscale.classList.add('is-spent');
  detailUpscale.setAttribute('aria-pressed', 'true');
}

function resetUpscaleButton() {
  upscaleCount = 0;
  upscaleBusy = false;
  detailUpscale.disabled = false;
  detailUpscale.textContent = UPSCALE_LABEL;
  detailUpscale.classList.remove('is-spent');
  detailUpscale.setAttribute('aria-pressed', 'false');
}

function refreshUpscaleButton(meta) {
  resetUpscaleButton();
  const title = plainText(meta && meta.name);
  // `meta` has no `title` field -- safeMeta() produces `name`. Asking for
  // meta.title sent the literal string "undefined" to the service.
  if (!title) return;
  const request = (upscaleStatusRequest += 1);
  fetchJSON(`${UPSCALE_BASE}/api/upscale/status?title=${encodeURIComponent(title)}`)
    .then((data) => {
      if (request !== upscaleStatusRequest) return; // another title was opened
      const count = Math.floor(Number(data && data.count));
      if (Number.isFinite(count) && count > 0) markUpscaleSpent(count);
    })
    .catch(() => {
      // Route not deployed, offline, or CORS-blocked: keep the normal button.
    });
}

async function requestUpscale() {
  const meta = state.selected;
  if (!meta || upscaleBusy) return;
  if (upscaleCount > 0) {
    // Already done. Re-pressing must never fire a second request.
    showToast(upscaleRequestedLabel(upscaleCount));
    return;
  }
  const title = plainText(meta.name);
  if (!title) {
    showToast('This title has no name to send.', 'error');
    return;
  }

  upscaleBusy = true;
  detailUpscale.disabled = true;
  detailUpscale.textContent = 'Requesting…';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(`${UPSCALE_BASE}/api/upscale/request`, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        media_type: meta.type === 'series' ? 'series' : 'movie',
        video_url: 'pending:no-stream-selected',
      }),
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (data && data.status === 'queued') {
      const count = upscaleCountFrom(data);
      markUpscaleSpent(count);
      showToast(plainText(data.message, upscaleRequestedLabel(count)));
      return;
    }
    // 200 with status "error", or any non-queued body: this did NOT land.
    resetUpscaleButton();
    showToast(
      plainText(data && data.message, `The upscale service did not accept this request (HTTP ${response.status}).`),
      'error'
    );
  } catch (error) {
    resetUpscaleButton();
    showToast(
      error && error.name === 'AbortError'
        ? 'The upscale service did not answer in time. Try again.'
        : 'Could not reach the upscale service. Try again.',
      'error'
    );
  } finally {
    clearTimeout(timeout);
    upscaleBusy = false;
  }
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
  
  refreshUpscaleButton(meta);

  const sourceUrl = isMwp(meta) ? meta.website : '';
  detailSourceLink.hidden = !sourceUrl;
  if (sourceUrl) detailSourceLink.href = sourceUrl;
  detailStatus.textContent = sourceOnly
    ? 'Source page only. Open MrWorldPremiere in a web browser to watch.'
    : '';
  renderRatingChips(meta);
  updateSaveLabels();
  resetQualitySelect();
  if (typeof detailDialog.showModal === 'function') detailDialog.showModal();
  else detailDialog.setAttribute('open', '');

  startDetailTrailer(meta);
  telemetry('nav_action', { action: 'open_detail', from: state.route || 'home' });

  // An Emby title is not in the addon catalog, so /stream/<type>/emby:<id>.json
  // is a guaranteed 404. Asking anyway would spin the streams panel and then
  // report "no sources" for something that plays perfectly.
  if (meta.embyId) {
    $('#detail-streams').innerHTML = '';
    detailStatus.textContent = 'On the Emby server. Press Play.';
  } else if (!sourceOnly) {
    loadStreams(meta);
  } else {
    $('#detail-streams').innerHTML = '';
  }
}

function closeDetail() {
  if (detailDialog.open && typeof detailDialog.close === 'function') detailDialog.close();
  else detailDialog.removeAttribute('open');
  stopDetailTrailer();
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
  // Emby needs no stream resolution: the fleet IS the stream, and it forwards
  // Range so the scrub bar works.
  if (meta.embyId && window.BlazingEmby) {
    // ORDER MATTERS. closeDetail() sets state.selected = null, and openPlayer
    // reads state.selected?.id to start progress sync and offer Resume. Closing
    // first silently disabled both for every Emby title.
    const url = window.BlazingEmby.streamUrl(meta.embyId);
    openPlayer(meta.name, url);
    closeDetail();
    return;
  }
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
  playerMsg.hidden = (kind !== 'error' && kind !== 'loading') || !message;
  if (kind === 'error') {
    playerMsg.textContent = message || 'Something went wrong.';
  } else if (kind === 'loading' && message) {
    playerMsg.textContent = message;
  } else {
    playerMsg.textContent = '';
  }
  video.classList.toggle('ready', kind === 'playing');
}

/* ---------------------------------------------------------------------------
   Playback, and the proxy resolver as a FALLBACK.

   The add-on now embeds GET /proxy/resolve/redirect (a 302 straight to the
   media) into the stream URL it hands out, and a <video> src follows a 302 on
   its own. So the plain server URL is the default path and is tried FIRST.
   Only when that URL fails to load -- an `error` event, or nothing at all
   within PLAYER_STALL_TIMEOUT -- is /proxy/resolve asked for a direct link.

   MEASURED 26 Aug 2026: GET https://addon.lyreosai.com/proxy/resolve -> 404
   {"error":"Not found"}, and /proxy/resolve/redirect -> 404 as well. Neither is
   deployed yet. That is exactly why this is a fallback and not the default:
   with the old code every embed-looking URL waited on a 404 before playing.

   Nothing here can strand the viewer on a spinner: the resolve fetch is
   aborted after RESOLVE_TIMEOUT, the initial load has a stall watchdog, and
   every dead end ends in a visible error message.
--------------------------------------------------------------------------- */
let playSession = 0;
let playerWatchdog = null;

function clearPlayerWatchdog() {
  if (playerWatchdog !== null) {
    clearTimeout(playerWatchdog);
    playerWatchdog = null;
  }
}

async function resolveViaProxy(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT);
  try {
    const response = await fetch(`${API_BASE}/proxy/resolve?url=${encodeURIComponent(url)}`, {
      mode: 'cors',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) return '';
    const data = await response.json();
    return safeHttpsUrl(data && data.url);
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

// Attach the one-shot outcome listeners for a single load attempt. `session`
// pins them to this openPlayer() call, so a stale listener left over from a
// closed player (closePlayer() also removes src, which fires `error`) is inert.
function watchPlayerLoad(session, originalUrl, canRetry) {
  const onReady = () => {
    if (session !== playSession) return;
    clearPlayerWatchdog();
    video.removeEventListener('error', onFail);
    setPlayerState('playing');
  };
  const onFail = () => {
    if (session !== playSession) return;
    clearPlayerWatchdog();
    video.removeEventListener('loadedmetadata', onReady);
    if (canRetry) retryViaProxy(session, originalUrl);
    else setPlayerState('error', 'This stream cannot play in this browser. Try another source.');
  };
  video.addEventListener('loadedmetadata', onReady, { once: true });
  video.addEventListener('error', onFail, { once: true });
  clearPlayerWatchdog();
  playerWatchdog = window.setTimeout(() => {
    playerWatchdog = null;
    if (session !== playSession) return;
    video.removeEventListener('loadedmetadata', onReady);
    video.removeEventListener('error', onFail);
    if (canRetry) retryViaProxy(session, originalUrl);
    else setPlayerState('error', 'This stream did not start. Try another source.');
  }, PLAYER_STALL_TIMEOUT);
}

async function retryViaProxy(session, originalUrl) {
  setPlayerState('loading', 'Finding a direct link…');
  const resolved = await resolveViaProxy(originalUrl);
  if (session !== playSession) return;
  if (!resolved || resolved === originalUrl) {
    setPlayerState('error', 'This stream cannot play in this browser. Try another source.');
    return;
  }
  setPlayerState('loading');
  watchPlayerLoad(session, resolved, false);
  video.src = resolved;
  video.load();
  const play = video.play();
  if (play && typeof play.catch === 'function') play.catch(() => {});
}


const Platform = {
  isRoku:    !!window.Roku,
  isTizen:   !!window.tizen,
  isAndroid: !!window.AndroidBridge,
  isAppleTV: !!window.webkit?.messageHandlers?.avplayer,
  isWeb:     true
};

function openPlayer(title, rawUrl) {
  const url = safeHttpsUrl(rawUrl);
  if (!url) return;
  
  if (Platform.isAppleTV) {
    window.webkit.messageHandlers.avplayer.postMessage({ url });
    return;
  }
  if (Platform.isAndroid) {
    window.AndroidBridge.postMessage(JSON.stringify({ cmd: 'play', url, title }));
    return;
  }
  if (Platform.isTizen) {
    if (window.webapis && window.webapis.avplay) {
      // Basic tizen setup
      window.webapis.avplay.open(url);
      window.webapis.avplay.play();
    }
    return;
  }
  if (Platform.isRoku) {
    window.location = `blazeos://play?url=${encodeURIComponent(url)}`;
    return;
  }

  // Fallback to web HTML5 video
  const session = (playSession += 1);
  playerTitle.textContent = title;
  player.hidden = false;
  document.body.classList.add('no-scroll');

  setPlayerState('loading');
  watchPlayerLoad(session, url, true);

  video.src = url;
  video.load();
  startSync({ id: state.selected?.id });
  const profileId = localStorage.getItem('profileId');
  if (profileId && state.selected?.id) {
    fetch(`${API_BASE}/api/sync/progress/${state.selected.id}?profileId=${profileId}`)
      .then(r => r.json())
      .then(d => {
        if (d.position && d.position > 60) {
          const b = $('#resume-btn');
          b.hidden = false;
          b.textContent = `Resume from ${Math.floor(d.position / 60)}:${Math.floor(d.position % 60).toString().padStart(2, '0')}?`;
          b.onclick = () => { video.currentTime = d.position; b.hidden = true; };
          setTimeout(() => { b.hidden = true; }, 10000);
        }
      });
  }

  const play = video.play();
  if (play && typeof play.catch === 'function') play.catch(() => {});
}
/**
 * RESTORED, both of these. The BlazeOS Phase 1 patch (48f1be5) deleted
 * loadContinueWatching() outright while leaving five calls to it standing —
 * every one inside boot(), so the moment boot() ran again it would have thrown
 * "loadContinueWatching is not defined" and taken the home screen with it. The
 * same patch removed `let syncInterval = null;`, which left startSync()
 * assigning to an undeclared name: an implicit global that works only because
 * this file is not in strict mode. Both recovered from 48f1be5^:app.js.
 *
 * loadContinueWatching PREPENDS its row, so it lands above whatever the shelves
 * have already drawn, whichever finishes first.
 */
async function loadContinueWatching() {
  const profileId = localStorage.getItem('profileId');
  if (!profileId) return;
  try {
    const res = await fetch(`${API_BASE}/api/sync/progress/recent?profileId=${profileId}`);
    const data = await res.json();
    if (data.items && data.items.length) {
      const section = buildRowSkeleton({ id: 'continue-watching', name: 'Continue Watching', type: 'mixed' });
      rowsWrap.prepend(section);
      const track = $('.row-track', section);
      const metas = data.items.map(safeDiscoverMeta).filter(Boolean);
      track.replaceChildren(...metas.map((m) => {
        const c = buildCard(m);
        if (m.progress) {
          const bar = document.createElement('div');
          bar.className = 'progress-bar';
          bar.innerHTML = `<div class="progress-fill" style="width: ${Math.min(100, (m.progress.position / m.progress.duration) * 100)}%"></div>`;
          c.appendChild(bar);
        }
        return c;
      }));
    }
  } catch (e) {}
}


let syncInterval = null;

function startSync(meta) {
  stopSync();
  syncInterval = setInterval(() => {
    if (!video.duration || video.paused) return;
    const profileId = localStorage.getItem('profileId');
    if (!profileId) return;
    fetch(`${API_BASE}/api/sync/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imdbId: meta.id, position: video.currentTime, duration: video.duration, profileId })
    }).catch(()=>{});
  }, 30000);
}
function stopSync() {
  if (syncInterval) clearInterval(syncInterval);
  syncInterval = null;
}

/* ══════════════════════════════════════════════════════════════════════════
   Trailers, Education, the quality control, and telemetry call sites.

   The markup for the first two shipped earlier today with no code behind it,
   so both tabs opened a blank page. Everything below is the missing half.
   ══════════════════════════════════════════════════════════════════════════ */

/** Fire-and-forget. telemetry.js may not have loaded; that must never throw. */
function telemetry(name, props) {
  try { window.BlazingTelemetry && window.BlazingTelemetry.log(name, props); } catch (e) {}
}

/* ── quality ─────────────────────────────────────────────────────────────── */

const qualitySelect = $('#quality-select');

/** One label per stream, from whatever the name and title happen to say. */
function qualityOf(stream) {
  const hay = `${stream.name || ''} ${stream.title || ''}`;
  if (/2160|4k|uhd/i.test(hay)) return '4K';
  if (/1080|fhd/i.test(hay)) return '1080p';
  if (/720/i.test(hay)) return '720p';
  if (/480|360|\bsd\b/i.test(hay)) return 'SD';
  return 'Other';
}

function resetQualitySelect() {
  if (!qualitySelect) return;
  qualitySelect.hidden = true;
  qualitySelect.replaceChildren(new Option('All Quality', ''));
}

/**
 * Fill the dropdown.
 *
 * `streamsByQuality` is the field the brief describes, and it does not exist on
 * any response the deployed backend returns (measured 26 Aug 2026 — it belongs
 * to the undeployed addon commit). Falling back to the qualities actually
 * present in the stream list means the control does something useful today and
 * needs no second pass when the backend lands.
 */
function fillQualitySelect(meta, streams) {
  if (!qualitySelect) return;
  const order = ['4K', '1080p', '720p', 'SD', 'Other'];
  const counts = new Map();

  const declared = meta && meta.streamsByQuality;
  if (declared && typeof declared === 'object' && Object.keys(declared).length) {
    for (const key of Object.keys(declared)) counts.set(key, counts.get(key) || 0);
  }
  for (const s of streams) {
    const q = qualityOf(s);
    counts.set(q, (counts.get(q) || 0) + 1);
  }

  const keys = [...counts.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  if (keys.length < 2) { resetQualitySelect(); return; }  // a filter with one option is furniture

  qualitySelect.replaceChildren(new Option(`All Quality (${streams.length})`, ''));
  for (const k of keys) {
    const n = counts.get(k) || 0;
    qualitySelect.appendChild(new Option(n ? `${k} (${n})` : k, k));
  }
  qualitySelect.hidden = false;
}

if (qualitySelect) {
  qualitySelect.addEventListener('change', () => {
    const want = qualitySelect.value;
    let shown = 0;
    $$('#detail-streams .stream-row').forEach((row) => {
      const match = !want || row.dataset.quality === want;
      row.hidden = !match;
      if (match) shown += 1;
    });
    detailStatus.textContent = want && !shown ? `No ${want} source for this title.` : '';
    telemetry('nav_action', { action: 'quality_filter', from: want || 'all' });
  });
}

/* ── the detail hero trailer ─────────────────────────────────────────────── */

let detailTrailerVideo = null;

/**
 * Autoplay the trailer muted behind the title, with a mute toggle.
 *
 * Muted is not a preference, it is the only way a browser will autoplay at all;
 * an unmuted autoplay is rejected and leaves a dead black box. The toggle is
 * how the user opts in to sound, which is also the gesture the browser wants.
 */
function startDetailTrailer(meta) {
  stopDetailTrailer();
  const host = $('#detail-trailer');
  if (!host || !meta || !meta.trailerUrl) return;
  const url = safeHttpsUrl(meta.trailerUrl);
  if (!url) return;

  const video = el('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.src = url;

  const toggle = el('button', 'detail-mute-btn');
  toggle.type = 'button';
  toggle.textContent = '🔇';
  toggle.setAttribute('aria-label', 'Unmute trailer');
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    video.muted = !video.muted;
    toggle.textContent = video.muted ? '🔇' : '🔊';
    toggle.setAttribute('aria-label', video.muted ? 'Unmute trailer' : 'Mute trailer');
    telemetry('nav_action', { action: video.muted ? 'trailer_mute' : 'trailer_unmute', from: 'detail' });
  });

  video.addEventListener('error', stopDetailTrailer, { once: true });
  host.replaceChildren(video, toggle);
  host.setAttribute('aria-hidden', 'false');
  host.classList.add('loaded');
  detailTrailerVideo = video;
  const played = video.play();
  if (played && played.catch) played.catch(() => {});
  telemetry('nav_action', { action: 'trailer_autoplay', from: 'detail' });
}

function stopDetailTrailer() {
  const host = $('#detail-trailer');
  if (detailTrailerVideo) {
    try { detailTrailerVideo.pause(); detailTrailerVideo.removeAttribute('src'); } catch (e) {}
    detailTrailerVideo = null;
  }
  if (host) {
    host.replaceChildren();
    host.classList.remove('loaded');
    host.setAttribute('aria-hidden', 'true');
  }
}

/* ── the Trailers tab ────────────────────────────────────────────────────── */

let trailersLoaded = false;

async function loadTrailersView() {
  const wrap = $('#trailers-rows');
  if (!wrap || trailersLoaded) return;
  trailersLoaded = true;
  wrap.replaceChildren();

  const jobs = TRAILER_ROWS.map((catalog) => {
    const section = buildRowSkeleton(catalog);
    wrap.appendChild(section);
    return loadRow(catalog, section);   // removes its own section when empty
  });
  const rows = await Promise.all(jobs);

  if (!rows.some((metas) => metas.length)) {
    // Say why, rather than showing a page that looks broken. Both routes answer
    // 200 with no items until the addon is redeployed.
    // el() takes (tag, className) only — a third argument is silently dropped,
    // which is how this shipped as an empty <p> the first time.
    const note = el('p', 'search-status');
    note.textContent = 'No trailers yet — this needs the trailer pipeline on the server, which is built but not deployed.';
    wrap.appendChild(note);
  }
}

/* ── the Education tab ───────────────────────────────────────────────────── */

const eduCache = new Map();

async function loadEducationView(slug) {
  const status = $('#edu-status');
  const results = $('#edu-results');
  if (!results) return;

  const tabs = $$('.edu-tab');
  const active = slug || (tabs.find((t) => t.classList.contains('active'))?.dataset.eduSlug) || EDU_SLUGS[0];
  tabs.forEach((tab) => {
    const on = tab.dataset.eduSlug === active;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  if (eduCache.has(active)) {
    renderEducation(eduCache.get(active), active);
    return;
  }
  if (status) status.textContent = 'Loading…';
  results.replaceChildren();
  try {
    const data = await fetchJSON(`${API_BASE}/catalog/tv/blazing-edu-${encodeURIComponent(active)}.json`);
    const metas = (Array.isArray(data.metas) ? data.metas : []).map(safeMeta).filter(Boolean);
    eduCache.set(active, metas);
    renderEducation(metas, active);
  } catch (err) {
    if (status) status.textContent = 'Could not load that category.';
    telemetry('error', { where: 'app.loadEducationView', code: 'fetch', message: String(err && err.message || err).slice(0, 200) });
  }
}

function renderEducation(metas, slug) {
  const status = $('#edu-status');
  const results = $('#edu-results');
  if (!results) return;
  results.replaceChildren(...metas.map(buildCard));
  if (status) {
    status.textContent = metas.length
      ? `${metas.length} in ${slug}`
      : 'Nothing here yet — the education catalogs are built on the server but not deployed.';
  }
}

$$('.edu-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    loadEducationView(tab.dataset.eduSlug);
    telemetry('nav_action', { action: 'edu_tab', from: tab.dataset.eduSlug || '' });
  });
});

/* ── remaining telemetry call sites ──────────────────────────────────────── */

video.addEventListener('error', () => {
  const meta = state.selected;
  telemetry('play_failed', {
    id: meta ? meta.id : '',
    source: 'web',
    code: String(video.error ? video.error.code : 'unknown'),
    message: 'html5 media error',
  });
});

video.addEventListener('ended', () => {
  telemetry('play_end', {
    id: state.selected ? state.selected.id : '',
    positionSecs: Math.floor(video.currentTime || 0),
    durationSecs: Math.floor(video.duration || 0),
    percent: video.duration ? Math.round((video.currentTime / video.duration) * 100) : 0,
    reason: 'finished',
  });
});

$('#player-close').addEventListener('click', () => {
  if (!video.duration) return;
  telemetry('play_end', {
    id: state.selected ? state.selected.id : '',
    positionSecs: Math.floor(video.currentTime || 0),
    durationSecs: Math.floor(video.duration || 0),
    percent: Math.round((video.currentTime / video.duration) * 100),
    reason: 'back',
  });
});

/** Contract: heartbeat every 15 minutes, and it is what reports app_version. */
setInterval(() => telemetry('heartbeat', {}), 15 * 60 * 1000);

/**
 * Age rating and star rating on the detail page.
 *
 * The chips row is created on demand rather than added to index.html, because
 * index.html is being edited by someone else right now and a second hand in the
 * same file is how merge damage happens. It lands right under the year line.
 */
function renderRatingChips(meta) {
  let host = $('#detail-chips');
  if (!host) {
    host = el('div', 'detail-chips');
    host.id = 'detail-chips';
    detailYear.insertAdjacentElement('afterend', host);
  }
  host.replaceChildren();
  const add = (text, cls) => {
    if (!text) return;
    const chip = el('span', cls ? `detail-chip ${cls}` : 'detail-chip');
    chip.textContent = text;
    host.appendChild(chip);
  };
  add(meta.certification, 'detail-chip-cert');
  add(meta.imdbRating ? `★ ${meta.imdbRating}` : '', 'detail-chip-star');
  add(meta.runtime);
  if (meta.genres && meta.genres.length) add(meta.genres.join(' · '));
  host.hidden = !host.childElementCount;
}

/* ---------------------------------------------------------------------------
   Emby rows, the Seerr request desk, and the Comics shelf.

   ALL THREE GO THROUGH THE FLEET. The first version of this section could not
   work on a deployed page, for reasons worth keeping written down:

     - it called `embyClient.authenticate('<user>', '<password>')` with the real
       Emby login as literals, in a file served from a public CDN;
     - it fetched `http://Killah.TV:8096` from an HTTPS page, which the browser
       blocks as mixed content, so the rows were permanently empty;
     - the Requests tab fetched `http://localhost:3030`, which is the developer's
       own Mac and is not reachable from anybody else's browser, let alone a TV;
     - it called `openPlayer(url, name)` — the arguments the wrong way round, so
       even a working stream would have been titled with a URL and asked to play
       a title;
     - and the Comics tab printed "Connected to Pullbox server. 0 comics found."
       while connected to nothing at all. There is no Pullbox. The fleet has had
       real comics routes the whole time.

   See emby.js for the client, and the fleet's emby.js for why the credentials
   live on mac2.
--------------------------------------------------------------------------- */

/** Turn a fleet Emby meta into the shape the rest of this app already draws. */
function embyMeta(raw) {
  const meta = safeMeta(raw);
  if (!meta) return null;
  // safeMeta is an ALLOW LIST, so embyId would be dropped on the way through and
  // the play button would have nothing to play. It is added to that list rather
  // than smuggled around it, so there is one place that decides what survives.
  return meta;
}

/**
 * The four-name tier ladder, and the only one this app may know.
 *
 * Duplicated in server/profiles.js, ProfileClient.kt, Profiles.brs, tvOS's
 * ProfileSession and Tizen's ui.js, and every one of them treats a name it does
 * not recognise as a BLOCK under a kids cap. A fifth name taught to nobody does
 * not narrow a kids profile, it EMPTIES one.
 */
const RATINGS = ['general', 'teen', 'mature', 'adult'];

/**
 * May the connected profile see a title rated `tier`?
 *
 * An empty or unrecognised tier is UNKNOWN, not safe: it passes for an adult cap
 * and fails for a kids one, so an unrated title never slips past a kids profile.
 *
 * NO PROFILE MEANS THE STRICTEST CAP, not "no cap". That was the hole, and it is
 * now closed at both ends: profile.js holds the screen until somebody chooses,
 * AND nothing mature is drawn while nobody has. Two independent stops, because a
 * gate is a piece of UI and UI can fail — if the profile server is unreachable
 * and the panel somehow yields, the shelves are still capped at 'general' rather
 * than showing the whole library.
 */
function ratingAllowed(tier) {
  const cap = state.profileCap || 'general';
  const capIndex = RATINGS.indexOf(String(cap).toLowerCase());
  if (capIndex < 0) return false;
  const tierIndex = RATINGS.indexOf(String(tier || '').toLowerCase());
  if (tierIndex < 0) return String(cap).toLowerCase() !== 'general';
  return tierIndex <= capIndex;
}

async function appendEmbyRow(title, type, load) {
  const metas = (await load()).map(embyMeta).filter(Boolean)
    .filter((meta) => ratingAllowed(meta.contentRating));
  // An empty row is NOT drawn. A shelf that says "Emby" over six grey rectangles
  // reads as broken; no shelf reads as "not today".
  if (!metas.length) return;
  const section = buildRowSkeleton({ id: `emby-${type}`, type, name: title });
  section.dataset.embyRow = 'true';
  $('.row-track', section).replaceChildren(...metas.map(buildCard));
  rowsWrap.appendChild(section);
  applyRowFilter(state.route);
}

/**
 * Loaded CONCURRENTLY with everything else and never awaited by boot: a slow or
 * dead Emby must not hold up the home screen. Each row appends itself when it
 * arrives, in whatever order they arrive.
 */
function loadEmbyRows() {
  if (!window.BlazingEmby) return;
  appendEmbyRow('Emby · Latest Movies', 'movie', () => window.BlazingEmby.latest('movie', 12));
  appendEmbyRow('Emby · Latest Shows', 'series', () => window.BlazingEmby.latest('series', 12));
  appendEmbyRow('Emby · Live TV', 'tv', () => window.BlazingEmby.livetv(12));
}

/**
 * Switching profile must change what is on screen.
 *
 * The rows already drawn were filtered against the OLD cap, so they are thrown
 * away and refetched rather than left standing. Dropping them first also means a
 * shelf that empties under a stricter cap disappears instead of sitting there as
 * a title over nothing — appendEmbyRow refuses to draw an empty row.
 */
document.addEventListener('blazing-profile-selected', (event) => {
  const detail = (event && event.detail) || {};
  const next = detail.maxRating || null;
  if (next === state.profileCap) return;
  state.profileCap = next;
  for (const section of document.querySelectorAll('[data-emby-row="true"]')) section.remove();
  loadEmbyRows();
});

/* ---- Comics ------------------------------------------------------------- */

async function loadComicsView() {
  const host = $('#comics-rows');
  if (!host || host.dataset.loaded === 'true') return;
  host.dataset.loaded = 'true';
  const shelf = (name, comics) => {
    if (!comics.length) return null;
    const section = buildRowSkeleton({ id: `comics-${name}`, type: 'comic', name });
    $('.row-track', section).replaceChildren(...comics.map((c) => {
      // NOT buildCard: its click opens the detail dialog, which would ask the
      // addon for streams for a comic id and then report "no sources" for
      // something that reads perfectly. A comic opens the reader.
      const id = plainText(c.id);
      const name = plainText(c.name, 'Untitled');
      const card = el('button', 'card');
      card.type = 'button';
      card.setAttribute('aria-label', `Read ${name}`);
      const poster = safeHttpsUrl(c.poster);
      const image = el('img', 'card-image');
      image.loading = 'lazy';
      image.decoding = 'async';
      image.alt = '';
      if (poster) image.src = poster;
      else card.classList.add('no-image');
      const label = el('span', 'card-label');
      label.textContent = name;
      card.append(image, label);
      card.addEventListener('click', () => {
        if (window.comicReader) window.comicReader.open(id, name);
      });
      return card;
    }));
    return section;
  };
  try {
    const data = await fetchJSON(`${FLEET_BASE}/comics/discover`);
    const sections = [
      shelf('Popular Comics', Array.isArray(data.popular) ? data.popular : []),
      shelf('Newest', Array.isArray(data.newest) ? data.newest : []),
    ].filter(Boolean);
    if (!sections.length) {
      host.replaceChildren(el('p', 'error'));
      $('.error', host).textContent = 'No comics are available right now.';
      host.dataset.loaded = 'false';
      return;
    }
    host.replaceChildren(...sections);
  } catch {
    host.replaceChildren(el('p', 'error'));
    $('.error', host).textContent = 'Could not reach the comics library.';
    // NOT sticky: a failure must be retried the next time the tab is opened.
    host.dataset.loaded = 'false';
  }
}

/* ---- Requests (Seerr) --------------------------------------------------- */

function seerrCard(result) {
  const card = el('article', 'seerr-card');
  const art = el('div', 'seerr-art');
  if (result.poster) setBackground(art, result.poster);
  const body = el('div', 'seerr-body');
  const title = el('h3', 'seerr-title');
  title.textContent = `${result.title}${result.releaseInfo ? ` (${result.releaseInfo})` : ''}`;
  const status = el('span', 'seerr-status');
  status.dataset.status = String(result.status);
  status.textContent = result.statusText;
  body.append(title, status);

  // Only a title the server does not have can be requested. Anything already
  // pending, processing or available gets no button — a button that cannot do
  // anything is worse than no button.
  if (Number(result.status) <= 1) {
    const button = el('button', 'primary-button');
    button.type = 'button';
    button.textContent = 'Request';
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Requesting…';
      try {
        const out = await window.BlazingEmby.seerrRequest(result.tmdbId, result.mediaType);
        button.textContent = out.already ? 'Already requested' : 'Requested';
        status.textContent = 'Pending';
        status.dataset.status = '2';
        showToast(`${result.title} was requested.`);
      } catch (e) {
        // HONESTY RULE: say it failed. Do not leave a button reading "Requested"
        // for something that never reached the server.
        button.disabled = false;
        button.textContent = 'Request';
        showToast(`Could not request ${result.title}.`, 'error');
        console.warn('[seerr] request', e && e.message);
      }
    });
    body.appendChild(button);
  }
  card.append(art, body);
  return card;
}

function loadRequestsView() {
  const form = $('#requests-form');
  const results = $('#requests-results');
  if (!form || !results || form.dataset.bound === 'true') return;
  form.dataset.bound = 'true';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const q = ($('#requests-input').value || '').trim();
    if (!q) return;
    if (!window.BlazingEmby) {
      // emby.js failed to load. Saying so beats a spinner that never stops.
      results.replaceChildren(el('p', 'error'));
      $('.error', results).textContent = 'The request client did not load. Reload the page.';
      return;
    }
    results.replaceChildren(el('div', 'spinner big'));
    const found = await window.BlazingEmby.seerrSearch(q);
    if (found === null) {
      // null is "the search failed", which is NOT "no results". Saying "no
      // results" for an outage sends people away thinking the film does not exist.
      results.replaceChildren(el('p', 'error'));
      $('.error', results).textContent = 'Could not reach the request server.';
      return;
    }
    if (!found.length) {
      results.replaceChildren(el('p', 'error'));
      $('.error', results).textContent = `Nothing found for “${q}”.`;
      return;
    }
    results.replaceChildren(...found.map(seerrCard));
  });
}

/**
 * The call the BlazeOS Phase 1 patch removed, and the whole reason the home
 * screen has been empty. app.js is loaded with `defer`, so the DOM is parsed
 * before this line runs and every $('#id') at the top of the file has resolved.
 */
boot();
