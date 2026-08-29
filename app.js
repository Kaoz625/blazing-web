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
/**
 * The YouTube id of a title's trailer, or ''.
 *
 * Stremio's meta shape gives a bare video id, not a URL:
 *     trailers:       [{ source: 'Y1IgAEejvqM', type: 'Trailer' }, ...]
 *     trailerStreams: [{ ytId:   'Y1IgAEejvqM', title: '...' }, ...]
 * An id is 11 characters of [A-Za-z0-9_-] and nothing else is accepted here,
 * because this value is interpolated straight into an embed URL.
 */
function youtubeTrailerId(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const candidates = []
    .concat(Array.isArray(raw.trailers) ? raw.trailers : [])
    .concat(Array.isArray(raw.trailerStreams) ? raw.trailerStreams : []);
  for (const t of candidates) {
    const id = String((t && (t.source || t.ytId)) || '');
    if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
  }
  return '';
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
    trailerUrl: safeHttpsUrl(raw.trailerUrl),
    // NOTHING EVER SENDS trailerUrl. Measured 29 Aug 2026 against the live
    // addon: 0 of 300 catalog metas carry it, and /meta/ does not carry it
    // either. What the meta route DOES carry is `trailers: [{source: "<11-char
    // YouTube id>", type: "Trailer"}]` and `trailerStreams`. So every trailer
    // in this app has been dead since it was written - the card preview and
    // startDetailTrailer both return on their `!meta.trailerUrl` guard, every
    // time, for every title. This is the field that revives them.
    trailerYt: youtubeTrailerId(raw),
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
const libraryView = $('#library-view');
// showRoute() has read this on every navigation since 67776fb, but nothing ever
// declared it. Under 'use strict' that threw ReferenceError before
// updateNavigation() and closeDrawer() could run. Proven with locker.smoke.mjs
// against a pristine HEAD checkout: "ReferenceError: adminView is not defined".
const adminView = $('#admin-view');
const discoverView = $('#discover-view');
const roadmapsView = $('#roadmaps-view');
const rowsWrap = $('#rows');
// No standalone hero — the first row with content claims .row-hero on its own
// <section> (claimHeroRow, below) and every card already carries the markup
// that reveals on a row-hero ancestor. See the comment in index.html.
//
// "First with content" is not enough on its own: measured live, a Live TV
// channel-logo row (no background, no description — nothing for buildCard()
// to build a hero out of) sometimes wins that race, and a hero row with
// nothing to show on hover is worse than not having one. Requiring the
// FIRST card to carry a background image is what keeps a channel-logo grid
// from ever claiming it, without hardcoding which catalog names are "real"
// rows — a live-only manifest wouldn't otherwise get a hero at all if this
// checked description too, since live channels have never carried one.
// EVERY ROW THAT CAN DO THIS, DOES. Markus, 2026-08-29: "only the first row
// pops out, all rows should do this". It used to stop at the first qualifying
// row (`heroRowClaimed`), which made the behaviour read as a one-off banner
// rather than as how this app shows a card.
//
// The background check below STAYS, and it is the whole reason this is not
// simply `classList.add` on everything: a Live TV channel-logo row has no
// backdrop and no description, so expanding one of its cards reveals an empty
// black panel. A row with nothing to show on hover is worse than a row that
// stays a plain poster.
function claimHeroRow(section, metas) {
  if (!metas?.[0]?.background) return;
  section.classList.add('row-hero');
}
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
let searchRequest = 0;

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
  // NOT nav[aria-label="More"] — that nav also holds the static view buttons
  // (Emby Library, Education, Comics, Trailers, Requests, Admin), and this
  // function's replaceChildren() used to wipe out that entire nav, taking
  // the static buttons with it, the moment /discover/menu answered. See the
  // comment on the [data-discover-filters] wrapper in index.html.
  const filters = $('#drawer [data-discover-filters]');
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
 * Deleted in d18e9ca ("BlazeOS Phase 2") along with the functions the same
 * commit removed while leaving their callers standing (see the boot()
 * comment above and the Home-screen-empty-since-48f1be5 fix). loadFreshHomeRow
 * and loadSDUIRow both called this and neither one threw visibly — both wrap
 * the call in a try/catch, so a ReferenceError just made the row silently
 * remove itself, indistinguishable from "the catalog was empty." That's how
 * New Movies/New Shows/Top Rated and every purely-SDUI-only row (the ones
 * with no TRENDING_ROWS/manifest equivalent) went dark with nothing to see in
 * the console.
 *
 * safeMeta already carries contentRating; the fresh-shelf/SDUI response shape
 * just names the year differently (`year`, not `releaseInfo`).
 */
function safeDiscoverMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return safeMeta({ ...raw, releaseInfo: raw.year || raw.releaseInfo });
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

/* ── Search ──────────────────────────────────────────────────────────────────
 *
 * #search-form has been in index.html since 8ececa8 and nothing listened to it.
 * The submit handler went with the rest of the top-level listener block in
 * d18e9ca, so pressing Search fired the browser's own GET, reloaded the page and
 * left the results panel empty. Search has been dead in production ever since,
 * while the backend it needs was finished and deployed.
 *
 * THREE INDEXES, ALWAYS CONCURRENT. /emby/search is one hop to mac2;
 * /search/movie and /search/series each fan out to Cinemeta, TMDB and the 36
 * searchable Stremio addons behind a hard deadline (firetv/server/addon-search.js
 * explains the deadline and why adult stays opt-in server-side). Run in series
 * the fast one would wait on the slow ones for no reason at all.
 *
 * EMBY ROWS COME FIRST, and that is not a preference. An Emby hit plays straight
 * off /emby/stream/<id> — no debrid resolve, no torrent, no source list — so it
 * is the fastest thing this app can put in front of somebody. Movies next, then
 * series.
 */
// The full result set behind whatever the facet rail is currently narrowing.
// Facet clicks filter and re-render from THIS, never re-fetch — the network
// round trip already happened once for this query.
let searchAllCards = [];
let searchActiveGenre = null;

function bindSearch() {
  const form = $('#search-form');
  // Same guard loadRequestsView() uses, for the same reason: showRoute() calls
  // this on every visit to the search screen and a second handler would fire
  // every query twice.
  if (!form || form.dataset.bound === 'true') return;
  form.dataset.bound = 'true';
  form.addEventListener('submit', runSearch);

  $('#search-chip').addEventListener('click', () => {
    $('#search-input').value = '';
    clearSearchResults();
    $('#search-input').focus();
  });

  bindSearchMic();
}

/**
 * Voice search (DebridStream reference: a mic button leads the field).
 * SpeechRecognition has no Promise API and no feature-detect that isn't
 * "does the constructor exist" — Safari/Firefox on desktop still don't ship
 * it as of this session. The button stays hidden (index.html's default)
 * rather than existing to apologise for not working; a mic icon that sits
 * there doing nothing on an unsupported browser is exactly the kind of
 * button this whole redesign exists to get rid of.
 */
function bindSearchMic() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $('#search-mic');
  if (!Recognition || !mic) return;
  mic.hidden = false;
  const recognition = new Recognition();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  let listening = false;

  recognition.addEventListener('result', (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript;
    if (!transcript) return;
    $('#search-input').value = transcript;
    runSearch();
  });
  const stop = () => { listening = false; mic.classList.remove('listening'); };
  recognition.addEventListener('end', stop);
  recognition.addEventListener('error', stop);

  mic.addEventListener('click', () => {
    if (listening) { recognition.stop(); return; }
    listening = true;
    mic.classList.add('listening');
    try { recognition.start(); } catch { stop(); }
  });
}

function clearSearchResults() {
  searchAllCards = [];
  searchActiveGenre = null;
  $('#search-chip-row').hidden = true;
  $('#search-facets').hidden = true;
  $('#search-facets').replaceChildren();
  $('#search-status').textContent = '';
  $('#search-results').replaceChildren();
}

// Emby and the TMDB/Cinemeta-backed catalog spell some genres differently —
// measured live, "Sci-Fi" and "Science Fiction" both showed up as separate
// facets for the same movies. Canonicalized here, in the one place both the
// facet LIST and the facet FILTER read from, rather than fixed on one side
// and silently reappearing on the other.
const GENRE_ALIASES = { 'science fiction': 'Sci-Fi', 'sci fi': 'Sci-Fi' };
const canonicalGenre = (g) => GENRE_ALIASES[String(g).trim().toLowerCase()] || g;

/** The genre rail: built from what THIS result set actually contains, not a
 *  fixed taxonomy — a facet for a genre with zero matches is a dead end
 *  dressed up as a choice. */
function renderSearchFacets() {
  const facets = $('#search-facets');
  const genres = [...new Set(searchAllCards.flatMap((c) => (c.genres || []).map(canonicalGenre)))].sort();
  if (!genres.length) {
    facets.hidden = true;
    facets.replaceChildren();
    return;
  }
  facets.hidden = false;
  const makeButton = (label, genre) => {
    const button = el('button', 'search-facet');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-pressed', String(searchActiveGenre === genre));
    if (searchActiveGenre === genre) button.classList.add('active');
    button.addEventListener('click', () => {
      searchActiveGenre = searchActiveGenre === genre ? null : genre;
      renderSearchFacets();
      renderSearchCards();
    });
    return button;
  };
  facets.replaceChildren(makeButton('All', null), ...genres.map((g) => makeButton(g, g)));
}

function renderSearchCards() {
  const cards = searchActiveGenre
    ? searchAllCards.filter((c) => (c.genres || []).map(canonicalGenre).includes(searchActiveGenre))
    : searchAllCards;
  const status = $('#search-status');
  status.textContent = searchActiveGenre
    ? `${cards.length} result${cards.length === 1 ? '' : 's'} in ${searchActiveGenre}.`
    : `${cards.length} result${cards.length === 1 ? '' : 's'}.`;
  // buildCard, the same builder #discover-results uses, and the cards land in
  // #search-results in merge order. dpad.js walks real focusable elements in DOM
  // order, so that order is what the remote follows on a television.
  $('#search-results').replaceChildren(...cards.map(buildCard));
}

/**
 * EVERY key a row can be recognised by, not just its best one.
 *
 * MEASURED 27 Aug 2026, q=oppenheimer: /search/movie answers
 * {id:"tt15398776", imdb_id:"tt15398776"} and /emby/search answers
 * {id:"emby:10071266", embyId:"10071266"} — no imdb id, no tmdb id, nothing the
 * two rows share but the name and the year.
 *
 * So a function returning ONE key per row cannot merge them, and the first
 * version of this did exactly that: the Emby row keyed on name+year, the
 * Cinemeta row keyed on imdb, the keys never met and the browser drew
 * Oppenheimer twice. A row is a duplicate when ANY of its keys is already
 * claimed, and claiming a row claims all of them.
 *
 * name+year carries the type, because a film and a series can share a title and
 * a year and are not the same thing.
 */
function searchKeys(raw, meta) {
  const keys = [];
  const imdb = String((raw && (raw.imdb_id || raw.imdbId)) || meta.id || '').match(/^tt\d+/i);
  if (imdb) keys.push(`imdb:${imdb[0].toLowerCase()}`);
  const tmdb = (raw && (raw.tmdb_id || raw.tmdbId)) || '';
  if (tmdb) keys.push(`tmdb:${String(tmdb)}`);
  const name = String(meta.name || '').trim().toLowerCase();
  const year = String(meta.releaseInfo || '').match(/\d{4}/);
  if (name) keys.push(`name:${meta.type}|${name}|${year ? year[0] : ''}`);
  return keys;
}

/** metas out of whatever allSettled handed back; a rejection is no rows, not a throw. */
function searchMetasOf(settled) {
  if (settled.status !== 'fulfilled') return [];
  const value = settled.value;
  if (Array.isArray(value)) return value;
  return Array.isArray(value && value.metas) ? value.metas : [];
}

async function runSearch(event) {
  if (event) event.preventDefault();
  const query = plainText($('#search-input').value).trim();
  const status = $('#search-status');
  const results = $('#search-results');
  if (!query) {
    status.textContent = 'Type a title first.';
    clearSearchResults();
    return;
  }
  // The chip mirrors the field rather than replacing it (DebridStream keeps
  // the field AND shows the live query as a removable chip beneath it, not
  // one or the other) — clicking it clears via the same path an empty submit
  // already takes.
  const chip = $('#search-chip');
  chip.textContent = `${query} ✕`;
  $('#search-chip-row').hidden = false;
  // A newer query must never be overwritten by an older one finishing late —
  // the same rule openDiscover() follows.
  const request = ++searchRequest;
  searchActiveGenre = null;
  status.textContent = `Searching for “${query}”…`;
  results.replaceChildren(el('div', 'spinner big'));
  $('#search-facets').hidden = true;
  telemetry('nav_action', { action: 'search', from: state.route || 'search' });

  const fleetSearch = (type) =>
    fetchJSON(`${FLEET_BASE}/search/${type}?q=${encodeURIComponent(query)}&limit=20`);

  const [emby, movies, series] = await Promise.allSettled([
    window.BlazingEmby ? window.BlazingEmby.search(query) : Promise.resolve([]),
    fleetSearch('movie'),
    fleetSearch('series'),
  ]);
  if (request !== searchRequest) return;

  // The cap appendEmbyRow() applies, applied here for the same reason: search
  // must not be the way around a kids profile. It is put on the EMBY rows only,
  // because they are the only ones that carry a contentRating. The fleet's
  // /search routes gate the adult catalogs server-side and default them off, and
  // their rows have no contentRating at all — feeding those to ratingAllowed()
  // would read "absent" as "unknown", which fails a 'general' cap, and empty
  // search for everyone.
  const embyRows = [];
  for (const raw of searchMetasOf(emby)) {
    const meta = embyMeta(raw);
    if (meta && ratingAllowed(meta.contentRating)) embyRows.push([raw, meta]);
  }
  const catalogRows = [];
  for (const settled of [movies, series]) {
    for (const raw of searchMetasOf(settled)) {
      const meta = safeMeta(raw);
      if (meta) catalogRows.push([raw, meta]);
    }
  }

  // FIRST writer wins, and the Emby rows go in first, so the card that survives a
  // collapse keeps its embyId and still plays off the server. safeMeta() is an
  // allow list that drops embyId, which is why the Emby side goes through
  // embyMeta() — that has broken Emby playback here once already.
  const claimed = new Set();
  const cards = [];
  for (const [raw, meta] of [...embyRows, ...catalogRows]) {
    const keys = searchKeys(raw, meta);
    if (keys.some((key) => claimed.has(key))) continue;
    for (const key of keys) claimed.add(key);
    cards.push(meta);
  }

  // THREE STATES, AND THEY MUST STAY THREE. "Nothing found" for an outage sends
  // somebody away believing the film does not exist; loadRequestsView() makes
  // exactly this distinction for the Seerr desk. BlazingEmby.search() answers []
  // on failure by design, so it can prove reachability and never disprove it —
  // only the two fleet calls can report that they failed.
  if (!cards.length) {
    results.replaceChildren();
    const reachable = movies.status === 'fulfilled' || series.status === 'fulfilled'
      || embyRows.length > 0;
    status.textContent = reachable
      ? `Nothing found for “${query}”.`
      : 'Could not reach search. Try again in a moment.';
    return;
  }
  searchAllCards = cards;
  renderSearchFacets();
  renderSearchCards();
}

/**
 * RESTORED with runSearch: d18e9ca deleted this and renderLibrary() below it,
 * leaving two live calls to renderLibrary() standing — in toggleMyList() and in
 * showRoute(). Pressing Library threw "renderLibrary is not defined" and took the
 * rest of showRoute() with it, so the tab never even highlighted.
 *
 * .result-row and .result-grid are still in styles.css, untouched.
 */
function buildResultRow(title, metas) {
  const section = el('section', 'result-row');
  const heading = el('h2', 'row-title');
  heading.textContent = title;
  const grid = el('div', 'result-grid');
  grid.append(...metas.map(buildCard));
  section.append(heading, grid);
  return section;
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
  const embyView = $('#emby-view');
  if (trailersView) trailersView.hidden = route !== 'trailers';
  if (educationView) educationView.hidden = route !== 'education';
  if (comicsView) comicsView.hidden = route !== 'comics';
  if (requestsView) requestsView.hidden = route !== 'requests';
  if (embyView) embyView.hidden = route !== 'emby';

  // The 'stories', 'podcasts' and 'family' routes were here and are gone. They
  // were the only callers of window.mountStorybook / mountPodcastStudio /
  // mountFamilyTree, which are the only three globals brightminds.js defines, so
  // index.html no longer loads that file or delight.js. Nothing else in this repo
  // references any of them: grep for the three mount names now finds nothing.
  //
  // Two of these lines were also a crash waiting to happen — `storiesView` was
  // read as `!storiesView.innerHTML` right under an `if (storiesView)` guard, so a
  // route named 'stories' with the section absent threw TypeError and took the
  // rest of showRoute() with it.

  if (route === 'trailers') loadTrailersView();
  if (route === 'education') loadEducationView();
  if (route === 'comics') loadComicsView();
  if (route === 'requests') loadRequestsView();
  if (route === 'emby') loadEmbyView();
  telemetry('screen_view', { screen: route });
  if (browseRoute) applyRowFilter(route);
  if (route === 'library') renderLibrary();
  if (route === 'search') {
    bindSearch();
    setTimeout(() => $('#search-input').focus(), 0);
  }
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


/**
 * On dwell, fill the expanded card in: the synopsis, the meta line, the trailer.
 *
 * WHY THIS HAS TO FETCH. Markus, 2026-08-29: "wheres the descriptions and the
 * movie trailers playing with the pop out?" The markup was always built - see
 * buildCard - and it was always mostly empty, because a CATALOG meta does not
 * carry the fields it needs. Measured against the live addon, over the 300
 * metas of blazing-movies:
 *
 *     description     129 / 300
 *     imdbRating       39 / 300
 *     runtime           0 / 300
 *     certification     0 / 300
 *     trailerUrl        0 / 300      <- and /meta/ has no such field either
 *
 * /meta/<type>/<id>.json has every one of them, plus `trailers`. So the panel
 * is not broken, it was never given anything to show. One fetch per card, only
 * on dwell, only inside a .row-hero where the panel can actually be seen, and
 * cached - a mouse crossing a row of 20 must not pull 20 payloads.
 */
const DWELL_MS = 550;                 // fill the text in early
const HOVER_TRAILER_MS = 1400;        // the video comes later, after real intent
const fullMetaCache = new Map();

async function fetchFullMeta(meta) {
  const key = `${meta.type}:${meta.id}`;
  if (fullMetaCache.has(key)) return fullMetaCache.get(key);
  // Emby titles are not in the addon catalog, so /meta/ is a guaranteed 404 for
  // them - the same reason openDetail skips /stream/ for an embyId.
  if (meta.embyId || !/^tt\d+$/.test(String(meta.id))) {
    fullMetaCache.set(key, null);
    return null;
  }
  const job = fetchJSON(`${API_BASE}/meta/${encodeURIComponent(meta.type)}/${encodeURIComponent(meta.id)}.json`)
    .then((data) => safeMeta({ ...(data && data.meta), type: meta.type }) || null)
    .catch(() => null);
  fullMetaCache.set(key, job);
  return job;
}

/** Fold anything the catalog was missing into the meta the card already holds. */
function mergeFullMeta(meta, full) {
  if (!full) return meta;
  for (const k of ['description', 'imdbRating', 'runtime', 'certification', 'background', 'trailerYt', 'trailerUrl']) {
    if (!meta[k] && full[k]) meta[k] = full[k];
  }
  if ((!meta.genres || !meta.genres.length) && full.genres && full.genres.length) meta.genres = full.genres;
  return meta;
}

/** The hero panel's text, rebuilt from whatever the meta knows right now. */
function fillCardHeroContent(card, meta) {
  const content = card.querySelector('.card-hero-content');
  if (!content) return;
  const metaLine = [
    meta.imdbRating ? `★ ${meta.imdbRating}` : '',
    (meta.releaseInfo || '').match(/\d{4}/)?.[0] || '',
    (meta.genres || [])[0] || '',
    meta.certification || '',
    meta.runtime || '',
  ].filter(Boolean).join(' · ');

  let metaEl = content.querySelector('.card-meta-line');
  if (metaLine) {
    if (!metaEl) {
      metaEl = el('p', 'card-meta-line');
      content.insertBefore(metaEl, content.querySelector('.card-synopsis') || content.querySelector('.card-cta'));
    }
    metaEl.textContent = metaLine;
  }

  let synopsis = content.querySelector('.card-synopsis');
  if (meta.description) {
    if (!synopsis) {
      synopsis = el('p', 'card-synopsis');
      content.insertBefore(synopsis, content.querySelector('.card-cta'));
    }
    synopsis.textContent = meta.description;
  }
}

/**
 * A muted trailer node, or null.
 *
 * A YouTube id CANNOT go in a <video> - that is the trap that would make this
 * look implemented and play nothing. It needs an iframe embed. A direct file
 * URL still gets a <video>, which is what trailerUrl was written for even
 * though nothing has ever sent one.
 */
function makeTrailerNode(meta) {
  if (meta.trailerYt) {
    const frame = el('iframe');
    const id = encodeURIComponent(meta.trailerYt);
    // loop needs `playlist` set to the same id; a single video will not loop
    // without it. mute=1 is not a preference - an unmuted autoplay is refused
    // by every browser and leaves a dead black box.
    frame.src = `https://www.youtube-nocookie.com/embed/${id}`
      + `?autoplay=1&mute=1&controls=0&loop=1&playlist=${id}`
      + '&modestbranding=1&rel=0&playsinline=1&iv_load_policy=3&disablekb=1';
    frame.allow = 'autoplay; encrypted-media';
    frame.setAttribute('frameborder', '0');
    frame.setAttribute('tabindex', '-1');
    frame.setAttribute('aria-hidden', 'true');
    return frame;
  }
  const url = safeHttpsUrl(meta.trailerUrl);
  if (!url) return null;
  const video = el('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.src = url;
  return video;
}

function attachHoverTrailer(card, meta) {
  let textTimer = null;
  let videoTimer = null;
  let wrap = null;

  const stop = () => {
    clearTimeout(textTimer); clearTimeout(videoTimer);
    textTimer = null; videoTimer = null;
    if (wrap) { wrap.remove(); wrap = null; }
    card.classList.remove('card-previewing');
  };

  const begin = () => {
    // Only where the panel is visible. Outside a .row-hero this would fetch a
    // payload and start a video behind a poster nobody can see through.
    if (!card.closest('.row-hero')) return;
    clearTimeout(textTimer); clearTimeout(videoTimer);

    textTimer = setTimeout(async () => {
      const full = await fetchFullMeta(meta);
      mergeFullMeta(meta, full);
      fillCardHeroContent(card, meta);
    }, DWELL_MS);

    videoTimer = setTimeout(async () => {
      const full = await fetchFullMeta(meta);
      mergeFullMeta(meta, full);
      // The pointer may have left while that was in flight.
      if (!videoTimer || !card.matches(':hover, :focus-within')) return;
      const node = makeTrailerNode(meta);
      if (!node) return;
      wrap = el('div', 'card-trailer-wrap');
      wrap.appendChild(node);
      card.appendChild(wrap);
      card.classList.add('card-previewing');
      requestAnimationFrame(() => wrap && wrap.classList.add('visible'));
      if (node.play) { const p = node.play(); if (p && p.catch) p.catch(() => {}); }
    }, HOVER_TRAILER_MS);
  };

  card.addEventListener('mouseenter', begin);
  card.addEventListener('focus', begin);
  card.addEventListener('mouseleave', stop);
  card.addEventListener('focusout', stop);
}

/**
 * Every card carries the hero-expansion markup, always — buildCard() never
 * branches on which row it's headed for. A .row-hero ancestor is what makes
 * .card-hero-content visible on hover/focus (see styles.css); everywhere
 * else it just sits there, unreachable, at zero cost until then. This is
 * what let claimHeroRow() (app.js, near rowsWrap) stay a one-line CSS-class
 * decision made independently of card construction, instead of two parallel
 * card-building code paths that would drift from each other.
 *
 * The backdrop image is the one thing NOT built eagerly: 200 cards on a
 * home screen would mean 200 unwatched background-image downloads if it had
 * a real src from the start. It carries the URL in a data attribute instead,
 * and hydrates on the card's first hover/focus — which in practice is only
 * ever a row-hero card, since that is the only place the image is visible.
 */
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

  const backdropUrl = safeHttpsUrl(meta.background) || safeHttpsUrl(meta.poster);
  if (backdropUrl) {
    const backdrop = el('img', 'card-backdrop');
    backdrop.dataset.src = backdropUrl;
    backdrop.alt = '';
    backdrop.loading = 'lazy';
    card.appendChild(backdrop);

    const content = el('div', 'card-hero-content');
    // A logo-art still is what the reference actually burns into the
    // backdrop; there is no logo asset in this data, so the title stays as
    // real text instead of vanishing along with it.
    const heroTitleEl = el('p', 'card-hero-title');
    heroTitleEl.textContent = meta.name;
    content.appendChild(heroTitleEl);
    const metaLine = [
      meta.imdbRating ? `★ ${meta.imdbRating}` : '',
      (meta.releaseInfo || '').match(/\d{4}/)?.[0] || '',
      (meta.genres || [])[0] || '',
      meta.certification || '',
      meta.runtime || '',
    ].filter(Boolean).join(' · ');
    if (metaLine) {
      const metaEl = el('p', 'card-meta-line');
      metaEl.textContent = metaLine;
      content.appendChild(metaEl);
    }
    if (meta.description) {
      const synopsis = el('p', 'card-synopsis');
      synopsis.textContent = meta.description;
      content.appendChild(synopsis);
    }
    const cta = el('span', 'card-cta');
    cta.textContent = 'View Details';
    content.appendChild(cta);
    card.appendChild(content);

    // Runs on every card, but the .row-hero check means it only ever loads
    // an image for the one row where that image can be seen.
    card.addEventListener('mouseenter', hydrateCardBackdrop, { once: true });
    card.addEventListener('focus', hydrateCardBackdrop, { once: true });
  }

  attachHoverTrailer(card, meta);
  card.addEventListener('click', () => openDetail(meta));
  return card;
}

function hydrateCardBackdrop(event) {
  const card = event.currentTarget;
  if (!card.closest('.row-hero')) return;
  const backdrop = $('.card-backdrop', card);
  if (backdrop && backdrop.dataset.src) backdrop.src = backdrop.dataset.src;
}

async function loadRow(catalog, section) {
  const track = $('.row-track', section);
  try {
    const data = await fetchJSON(
      `${API_BASE}/catalog/${encodeURIComponent(catalog.type)}/${encodeURIComponent(catalog.id)}.json`
    );
    // The same cap Emby's rows already respect (appendEmbyRow). This is the
    // ordinary catalog path — Trending Now/Trending Shows and every manifest
    // catalog go through here — and it had NO rating check at all: a Kids
    // profile saw whatever the catalog carried, unrated and mature included.
    const metas = (Array.isArray(data.metas) ? data.metas : [])
      .map(safeMeta).filter(Boolean).filter((meta) => ratingAllowed(meta.contentRating));
    if (!metas.length) {
      section.remove();
      return [];
    }
    track.replaceChildren(...metas.map(buildCard));
    claimHeroRow(section, metas);
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
      .filter(Boolean).filter((meta) => ratingAllowed(meta.contentRating));
    if (!metas.length) {
      section.remove();
      return [];
    }
    track.replaceChildren(...metas.map(buildCard));
    claimHeroRow(section, metas);
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
      .filter(Boolean).filter((meta) => ratingAllowed(meta.contentRating));

    if (!metas.length) {
      section.remove();
      return [];
    }
    track.replaceChildren(...metas.map(buildCard));
    claimHeroRow(section, metas);
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
    // BrightMinds Kids ('safe') is the real, intentional public face of this
    // domain — not a bug, not a placeholder. The bug was HOW a device left
    // that mode: this checked 'validInviteCode' in localStorage, and nothing
    // in this codebase has ever written that key (grepped: this line is the
    // only reference to it, anywhere). So every browser, this one included on
    // its very first visit, was permanently stuck on the public BrightMinds
    // shell with no path out — Markus's own approved household devices were
    // seeing the wrong brand's gold theme and edu-only catalog forever, which
    // is most of what read as "this looks wrong" tonight. See
    // switchToBlazingMode() below for how a device actually earns 'blazing'
    // now: once it is an approved household member (proven by picking a real
    // profile — a pending/public device never reaches that point), not by a
    // flag nobody ever sets.
    const mode = localStorage.getItem('blazing-household-approved') ? 'blazing' : 'safe';
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

    // Never reachable before tonight — 'blazing' mode required
    // localStorage.validInviteCode, which nothing ever set (see the comment on
    // the mode line above), so this .map() has been mapping only 'safe' mode's
    // rows in practice. 'blazing' mode's payload names "hero" (cinematic_hero)
    // and "trending_m" with the SAME catalogSlug (blazing-trending-movies) —
    // measured live the moment this path first actually ran — so without this
    // filter the very first blazing-mode Home draws that shelf twice. Roku,
    // Fire TV and Samsung all got this same filter earlier tonight for the
    // same reason; this client just never got to find out it needed it too.
    const seenSlugs = new Set();
    const rowsToLoad = uiConfig.homeRows.filter((row) => {
      if (row.type === 'cinematic_hero') return false;
      if (row.catalogSlug && seenSlugs.has(row.catalogSlug)) return false;
      if (row.catalogSlug) seenSlugs.add(row.catalogSlug);
      return true;
    });
    const jobs = rowsToLoad.map((row) => {
        const catalogInfo = {
          id: row.id,
          type: row.type === 'cinematic_hero' ? 'movie' : 'series',
          name: row.label,
          catalogSlug: row.catalogSlug,
        };
        const section = buildRowSkeleton(catalogInfo);
        rowsWrap.appendChild(section);
        return loadSDUIRow(catalogInfo, section);
      });

    const rows = await Promise.all(jobs);
    const first = rows.find((metas) => metas && metas.length)?.[0];
    if (!first) return false;            // described a layout, served nothing
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
  const freshDone = Promise.all(freshJobs);

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
    .catch(() => []);

  const [freshRows, catalogRows] = await Promise.all([freshDone, catalogDone, Promise.all(trendingJobs)]);
  const gotAnything = freshRows.some((metas) => metas.length) || catalogRows.some((metas) => metas.length);
  // Every row loader removes its own empty section, so a totally quiet home
  // reaches here with #rows literally empty — no separate hero to fall back
  // on to say so. One honest line beats a blank screen with nothing wrong
  // visibly reported.
  if (!gotAnything && !rowsWrap.children.length) {
    const message = el('p', 'empty-copy');
    message.textContent = 'Nothing is available right now. Try again soon.';
    rowsWrap.appendChild(message);
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
  // A CATALOG META IS NOT ENOUGH TO FILL THIS PANEL. Only 129 of 300 carry a
  // description and none carries a trailer, so a title opened straight from a
  // poster - without dwelling on it first - showed "Open this title to check
  // available streams." and no trailer. Same cached fetch the card uses; if the
  // dialog moved on in the meantime the result is dropped.
  fetchFullMeta(meta).then((full) => {
    if (!full || state.selected !== meta) return;
    const hadTrailer = Boolean(meta.trailerYt || meta.trailerUrl);
    mergeFullMeta(meta, full);
    if (meta.description) detailCopy.textContent = meta.description;
    setBackground(detailArt, meta.background || meta.poster);
    renderRatingChips(meta);
    if (!hadTrailer) startDetailTrailer(meta);
  });
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

const EDU_ID_PREFIX = 'yt:edu:';

function isEduId(id) {
  return typeof id === 'string' && id.indexOf(EDU_ID_PREFIX) === 0 &&
    id.length > EDU_ID_PREFIX.length;
}

/**
 * Resolve one education card to a playable URL AND its container.
 *
 * `&json=1` is the point. Without it the route answers 302 and the browser
 * follows it into a signed manifest URL whose format has to be guessed — and
 * YouTube no longer serves a combined progressive format, so the only playable
 * link is an HLS manifest and the guess is wrong. Returns null on any failure;
 * the caller shows the message.
 */
async function resolveEduStream(id) {
  const videoId = id.slice(EDU_ID_PREFIX.length);
  const controller = new AbortController();
  // yt-dlp has to solve YouTube's player JS server-side, which is slow on a cold
  // cache. RESOLVE_TIMEOUT is tuned for a redirect lookup and is far too short.
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    // via=proxy, because this is a BROWSER. Google serves the signed HLS manifest
    // with no Access-Control-Allow-Origin, so a page cannot fetch it at all —
    // measured in real Chrome as hls.js networkError/manifestLoadError, with the
    // element left at 0x0 and no error event of its own. The addon re-serves the
    // manifest and its segments with a CORS header. Televisions do NOT pass this
    // flag: they are not browsers, and the direct URL is faster.
    const res = await fetch(
      `${API_BASE}/proxy/yt-resolve?id=${encodeURIComponent(videoId)}&json=1&via=proxy`,
      { mode: 'cors', credentials: 'omit', signal: controller.signal }
    );
    if (!res.ok) return null;
    const data = await res.json();
    // The proxied form comes back as a path, not an absolute URL, so that the
    // addon does not have to know which hostname it is being served under.
    const raw = data && data.url;
    const absolute = (typeof raw === 'string' && raw.startsWith('/'))
      ? `${API_BASE}${raw}`
      : raw;
    const url = safeHttpsUrl(absolute);
    if (!url) return null;
    return { url, streamFormat: (data && data.streamFormat) || '' };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * RESTORED. d18e9ca deleted this and left openDetail()'s call to it standing, so
 * opening ANY catalog title threw "loadStreams is not defined" — caught in a
 * browser, not by node --check, and it is why the detail sheet has been showing
 * no sources at all. Emby titles were the only ones that escaped it, because
 * openDetail() skips this call when a meta carries an embyId.
 *
 * Recovered from d18e9ca^:app.js. One change: the row is built from DOM nodes and
 * textContent instead of the innerHTML template it used to use. `s.title` is a
 * string an arbitrary third-party Stremio addon supplied, and this file strips
 * every other value it takes from the network (safeMeta, safeHttpsUrl, plainText)
 * — writing that one straight into innerHTML was the one place that did not.
 */
async function loadStreams(meta) {
  const container = $('#detail-streams');
  container.innerHTML = '';
  if (isMwp(meta)) return;

  detailStatus.textContent = 'Loading streams...';
  try {
    const streams = await resolveStreams(meta);
    if (!streams.length) {
      detailStatus.textContent = 'No compatible stream available.';
      return;
    }

    // A link marked dead by a long-press sinks to the bottom, and so does a
    // dub in a language nobody here reads.
    const deadLinks = JSON.parse(localStorage.getItem('dead_links') || '[]');
    const penaltyOf = (s) => {
      if (deadLinks.includes(s.url)) return 1000;
      const blob = `${s.name || ''} ${s.title || ''}`.toLowerCase();
      return /rus|russian|ita|italian|latino|french/.test(blob) ? 100 : 0;
    };
    streams.sort((a, b) => penaltyOf(a) - penaltyOf(b));

    detailStatus.textContent = '';
    // The dropdown is filled from the meta's streamsByQuality when the backend
    // supplies one, and otherwise from the qualities actually present in this
    // list. Deriving it is what makes the control work today: streamsByQuality
    // is part of the undeployed addon commit and is absent from every response.
    fillQualitySelect(meta, streams);

    for (const s of streams) {
      const row = el('div', 'stream-row');
      row.dataset.quality = qualityOf(s);
      if (deadLinks.includes(s.url)) row.classList.add('dead');

      const label = plainText(s.name, 'SD');
      const title = plainText(s.title);
      let badgeClass = 'badge-sd';
      if (/4k|2160/i.test(label)) badgeClass = 'badge-4k';
      else if (/1080/i.test(label)) badgeClass = 'badge-1080';
      else if (/720/i.test(label)) badgeClass = 'badge-720';

      const sizeMatch = title.match(/\b\d+(?:\.\d+)?\s*(?:GB|MB)\b/i);
      const seedMatch = title.match(/(?:👤|👥|S:|Seeders?:?)\s*(\d+)/i);

      const info = el('div', 'stream-info');
      const qualityLine = el('div', 'stream-q');
      const badge = el('span', `badge ${badgeClass}`);
      badge.textContent = label;
      qualityLine.appendChild(badge);
      const titleLine = el('div', 'stream-title');
      titleLine.textContent = title;
      const metaLine = el('div', 'stream-meta');
      const size = el('span');
      size.textContent = sizeMatch ? sizeMatch[0] : '';
      const seeders = el('span');
      seeders.textContent = seedMatch ? `👤 ${seedMatch[1]}` : '';
      metaLine.append(size, seeders);
      info.append(qualityLine, titleLine, metaLine);
      row.appendChild(info);

      row.addEventListener('click', () => {
        // No URL here — rule 6. The host and the resolution are what make
        // v_source_health useful; the link itself is exactly what must not go.
        telemetry('play_start', {
          id: meta.id, title: meta.name, type: meta.type,
          source: String(s._from || '').replace(/^site:/, ''),
          res: Number((qualityOf(s).match(/\d+/) || [0])[0]) || 0,
        });
        closeDetail();
        openPlayer(meta.name, s.url);
      });

      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        if (!deadLinks.includes(s.url)) deadLinks.push(s.url);
        localStorage.setItem('dead_links', JSON.stringify(deadLinks));
        row.classList.add('dead');
        container.appendChild(row); // move to bottom
      });

      container.appendChild(row);
    }
  } catch (err) {
    detailStatus.textContent = 'Failed to load streams.';
    telemetry('error', { where: 'app.loadStreams', code: 'fetch', message: String((err && err.message) || err).slice(0, 200) });
  }
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
  // Education cards carry a "yt:edu:<videoId>" id. There is no /stream route for
  // them — the catalog's own stream entry is a youtube.com/watch PAGE, which no
  // <video> element can open. One resolver call is the entire path.
  if (isEduId(meta.id)) {
    detailStatus.textContent = 'Getting the video…';
    const edu = await resolveEduStream(meta.id);
    if (!edu) {
      detailStatus.textContent = 'This lesson could not be opened. The video ' +
        'resolver on the server did not answer.';
      return;
    }
    closeDetail();
    openPlayer(meta.name, edu.url, { streamFormat: edu.streamFormat });
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
  // destroyHls() first: a live hls.js instance keeps writing into the same
  // element through its MediaSource, so a bare src= assignment would fight it.
  destroyHls();
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

/* ---------------------------------------------------------------------------
   HLS, and why this browser needs a library to do what every TV does natively.

   The one playable YouTube URL is an HLS variant manifest. Safari and every
   webOS/Tizen TV play `application/vnd.apple.mpegurl` from a plain <video src>.
   Chrome, Edge and Firefox do NOT, and they fail the way that costs the most
   time to diagnose: the `error` event fires with no message and the viewer sees
   a black box. So hls.js is vendored (hls.min.js, self-hosted — no CDN, because
   sw.js precaches it and a third-party script would break offline start).

   Order is: hls.js FIRST wherever MSE exists, native only as the fallback.
   That looks backwards — native decoding is cheaper and hardware-accelerated —
   and the first version of this code did prefer native. It was wrong, and
   edu-play.smoke.mjs caught it: canPlayType() CANNOT tell these browsers apart.

       Chrome for Testing 1208, measured 27 Aug 2026:
         canPlayType('application/vnd.apple.mpegurl')  ->  'maybe'
         canPlayType('application/x-mpegURL')          ->  'maybe'
         canPlayType('video/mp4')                      ->  'maybe'

   'maybe' is truthy, so a truthiness check said "Chrome plays HLS natively",
   the manifest went to a bare <video src>, and playback stopped at 0x0 with
   readyState 0 and no error event. There is no return value that separates
   Chrome from Safari, so the capability question has to be asked of something
   that does not lie: Hls.isSupported(), which tests MediaSource for real.

   Native is therefore the branch for browsers with NO MSE — iPhone Safari,
   where hls.js cannot run and native HLS genuinely is the only path.
--------------------------------------------------------------------------- */

/** The live hls.js instance, or null. Exactly one at a time. */
let hlsInstance = null;

function destroyHls() {
  if (!hlsInstance) return;
  try { hlsInstance.destroy(); } catch (e) {}
  hlsInstance = null;
}

/**
 * Whether a bare <video src> is the ONLY way to play HLS here.
 *
 * Not "can this browser play HLS" — canPlayType cannot answer that (see above).
 * This is the narrow question the fallback branch needs: the element claims some
 * HLS support AND there is no MediaSource, so hls.js could not run even if it
 * were loaded. True on iPhone Safari; false in every desktop browser.
 */
function nativeHlsOnly() {
  if (!video || typeof video.canPlayType !== 'function') return false;
  if (typeof window.MediaSource !== 'undefined') return false;
  return !!(video.canPlayType('application/vnd.apple.mpegurl') ||
            video.canPlayType('application/x-mpegURL'));
}

/**
 * True when this URL should be treated as HLS.
 *
 * `declared` is what the SERVER said (`streamFormat` from ?json=1) and it wins.
 * The path sniff is only a floor: signed googlevideo manifest URLs sometimes
 * carry no recognisable extension, which is the whole reason the server was
 * taught to declare the format in the first place.
 */
function looksLikeHls(url, declared) {
  if (String(declared || '').toLowerCase() === 'hls') return true;
  return /\.m3u8(\?|$)/i.test(url) ||
    /manifest\.googlevideo\.com/i.test(url) ||
    // The proxied form: /proxy/hls?u=… carries neither the googlevideo host nor
    // an .m3u8 path, so neither sniff above would catch it.
    /\/proxy\/hls\?/i.test(url);
}

/**
 * Point the <video> at one URL, choosing the right mechanism.
 * Returns '' on success, or a viewer-facing reason it cannot play.
 */
function attachSource(url, declared) {
  destroyHls();
  if (!looksLikeHls(url, declared)) {
    video.src = url;
    video.load();
    return '';
  }
  if (window.Hls && window.Hls.isSupported()) {
    return attachViaHlsJs(url);
  }
  if (nativeHlsOnly()) {
    video.src = url;
    video.load();
    return '';
  }
  // Say which piece is missing. "Cannot play" alone sent people hunting for a
  // dead stream when the stream was fine and the script tag was the fault.
  return 'This browser needs hls.min.js to play this video, and it did not load.';
}

/** The hls.js branch of [attachSource]. Returns '' — it cannot fail here. */
function attachViaHlsJs(url) {
  const hls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
  hlsInstance = hls;
  hls.on(window.Hls.Events.ERROR, (_evt, data) => {
    // Only fatal errors are failures. hls.js reports recoverable segment gaps
    // constantly on a live manifest, and treating those as death made playback
    // give up seconds after it correctly started.
    if (!data || !data.fatal) return;
    if (hlsInstance !== hls) return;
    video.dispatchEvent(new Event('error'));
  });
  hls.loadSource(url);
  hls.attachMedia(video);
  return '';
}

function openPlayer(title, rawUrl, opts) {
  const url = safeHttpsUrl(rawUrl);
  if (!url) return;
  // What the server said the container is. Native shells get it forwarded so
  // their own players can stop guessing too.
  const declared = (opts && opts.streamFormat) || '';
  
  if (Platform.isAppleTV) {
    window.webkit.messageHandlers.avplayer.postMessage({ url, streamFormat: declared });
    return;
  }
  if (Platform.isAndroid) {
    window.AndroidBridge.postMessage(JSON.stringify({
      cmd: 'play', url, title, streamFormat: declared,
    }));
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
    window.location = `blazeos://play?url=${encodeURIComponent(url)}` +
      (declared ? `&format=${encodeURIComponent(declared)}` : '');
    return;
  }

  // Fallback to web HTML5 video
  const session = (playSession += 1);
  playerTitle.textContent = title;
  player.hidden = false;
  document.body.classList.add('no-scroll');

  setPlayerState('loading');
  const isHls = looksLikeHls(url, declared);
  // canRetry=false for HLS: retryViaProxy asks /proxy/resolve for a direct media
  // file, and handing a manifest URL to that route cannot help — it would only
  // replace a real error message with a slower one.
  watchPlayerLoad(session, url, !isHls);

  const attachError = attachSource(url, declared);
  if (attachError) {
    setPlayerState('error', attachError);
    return;
  }
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
 * RESTORED. d18e9ca deleted this, and openPlayer() above is the only thing that
 * sets `player.hidden = false` and adds `no-scroll` to the body. With no
 * closePlayer() there was nothing that ever set them back: the Back button ran
 * its telemetry line and left the player on screen over a page that could not
 * scroll. The one reference left in the tree was the comment at watchPlayerLoad.
 */
function closePlayer() {
  video.pause();
  video.removeAttribute('src');
  video.load();
  player.hidden = true;
  document.body.classList.remove('no-scroll');
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
  if (!host || !meta) return;
  // Was `!meta.trailerUrl`, which nothing has ever set, so this returned on
  // every title ever opened and the detail trailer has never once played.
  const video = makeTrailerNode(meta);
  if (!video) return;

  const toggle = el('button', 'detail-mute-btn');
  toggle.type = 'button';
  toggle.textContent = '🔇';
  toggle.setAttribute('aria-label', 'Unmute trailer');
  let muted = true;
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    muted = !muted;
    if (video.tagName === 'IFRAME') {
      // An iframe has no .muted. Reloading the embed with the flag flipped is
      // the only way to change it without pulling in the YouTube IFrame API.
      video.src = video.src.replace(/([?&])mute=[01]/, `$1mute=${muted ? 1 : 0}`);
    } else {
      video.muted = muted;
    }
    toggle.textContent = muted ? '🔇' : '🔊';
    toggle.setAttribute('aria-label', muted ? 'Unmute trailer' : 'Mute trailer');
    telemetry('nav_action', { action: muted ? 'trailer_mute' : 'trailer_unmute', from: 'detail' });
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
    note.textContent = 'No trailers yet. This needs the trailer pipeline on the server, which is built but not deployed.';
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
      : 'Nothing here yet. The education catalogs are built on the server but not deployed.';
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
  // The Emby shelves never called this, so they could not expand on hover no
  // matter what the rest of the home did — and on a browser that is still
  // waiting for fleet approval they are the ONLY rows on screen, which is
  // exactly the "only one row pops out" Markus was looking at.
  claimHeroRow(section, metas);
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
 * The rest of the Emby server — Home's three rows above are a "what's new"
 * teaser (12 items, no paging). This is the real library: 1,139 movies and
 * 693 series measured live against Killah.TV, reachable nowhere else in this
 * client until tonight.
 */
const embyBrowseState = { type: 'movie', sort: 'added', skip: 0, total: 0, loading: false };

async function loadEmbyPage(reset) {
  if (!window.BlazingEmby || embyBrowseState.loading) return;
  const results = $('#emby-results');
  const status = $('#emby-status');
  const loadMore = $('#emby-load-more');
  if (reset) {
    embyBrowseState.skip = 0;
    results.replaceChildren();
  }
  embyBrowseState.loading = true;
  loadMore.hidden = true;
  status.textContent = reset ? 'Loading…' : status.textContent;
  const { metas, total, hasMore } = await window.BlazingEmby.browse(embyBrowseState.type, {
    skip: embyBrowseState.skip, limit: 48, sort: embyBrowseState.sort,
  });
  embyBrowseState.loading = false;
  embyBrowseState.total = total;
  // SAME filter appendEmbyRow applies to the Home teaser rows — this is still
  // Emby content, and a Kids profile must not see more of it just because it
  // came from a paged library view instead of a Home row.
  const cards = metas.map(embyMeta).filter(Boolean).filter((meta) => ratingAllowed(meta.contentRating));
  results.append(...cards.map(buildCard));
  embyBrowseState.skip += metas.length;
  if (!results.children.length) {
    status.textContent = window.BlazingEmby.base
      ? 'Nothing here. Emby may be unreachable, or this library is empty.'
      : 'Emby is not configured.';
  } else {
    status.textContent = `${embyBrowseState.skip} of ${total}`;
  }
  loadMore.hidden = !hasMore;
}

function loadEmbyView() {
  if ($('#emby-view').dataset.loaded === 'true') return;
  $('#emby-view').dataset.loaded = 'true';
  document.querySelectorAll('.emby-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.dataset.embyType === embyBrowseState.type) return;
      document.querySelectorAll('.emby-tab').forEach((t) => t.setAttribute('aria-selected', 'false'));
      tab.setAttribute('aria-selected', 'true');
      embyBrowseState.type = tab.dataset.embyType;
      loadEmbyPage(true);
    });
  });
  $('#emby-sort').addEventListener('change', (event) => {
    embyBrowseState.sort = event.target.value;
    loadEmbyPage(true);
  });
  $('#emby-load-more').addEventListener('click', () => loadEmbyPage(false));
  loadEmbyPage(true);
}

// A profile switch changes the rating cap — the same reason Emby's Home rows
// reload on 'blazing-profile-selected' (see the listener near loadEmbyRows).
// Re-fetches from the top rather than trying to re-filter what's on screen:
// simpler, and this is a library browse, not a scroll position worth
// preserving across a profile change.
document.addEventListener('blazing-profile-selected', () => {
  if ($('#emby-view').dataset.loaded !== 'true') return;
  loadEmbyPage(true);
});

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

/**
 * Picking a real profile is only reachable once profile.js's own gate has
 * confirmed this device is approved — a pending or public device never gets
 * past "waiting for approval" to a profile list at all. So the moment this
 * fires, the device has earned 'blazing' mode: the household's own Blazing
 * Stream, not the public BrightMinds shell. Persisted, so a RETURNING
 * approved device renders 'blazing' from the very first paint next time
 * instead of flashing BrightMinds first.
 */
document.addEventListener('blazing-profile-selected', () => {
  if (localStorage.getItem('blazing-household-approved')) return;
  localStorage.setItem('blazing-household-approved', '1');
  // Only the catalog/SDUI rows (buildRowSkeleton's plain <section class="row">,
  // built by loadRow/loadFreshHomeRow/loadSDUIRow) — NOT [data-emby-row="true"]
  // sections, which are the OTHER 'blazing-profile-selected' listener's job
  // (see loadEmbyRows() above). Both listeners fire for the same event; a
  // blanket rowsWrap.replaceChildren() here raced that listener's own
  // clear-then-refetch and duplicated every Emby row (appendEmbyRow's fetch is
  // async, so "clear" and "the row lands" are never in the same tick).
  for (const section of rowsWrap.querySelectorAll('section:not([data-emby-row="true"])')) {
    section.remove();
  }
  (async () => {
    if (!(await bootFromSDUI())) await bootFromShelves();
  })();
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

/* ── The top-level listeners ─────────────────────────────────────────────────
 *
 * RESTORED. d18e9ca (BlazeOS Phase 2) deleted this block whole, along with
 * closePlayer(), renderLibrary(), buildResultRow() and runSearch(). At HEAD,
 * `grep -n addEventListener app.js` found no handler for [data-view],
 * #menu-button, #drawer-backdrop, #hero-open, #hero-save, #detail-close,
 * #detail-play, #detail-save, #detail-upscale or #search-form. So EVERY menu
 * button did nothing when pressed, the drawer could not be opened, the detail
 * sheet could not be closed, Play did nothing and the 4K Upscale button had no
 * handler at all. Nothing threw — there was no error to find, the same way the
 * empty home screen threw nothing in 7be3c51. locker.js still carries a comment
 * reading "app.js swaps routes on these", which it had stopped doing.
 *
 * It sits immediately above boot() because boot() at the end of this file is
 * PROVEN to run: 7be3c51 measured the home going from 0 rows to 4 by adding it
 * back here.
 */
$$('[data-view]').forEach((button) => {
  button.addEventListener('click', () => showRoute(button.dataset.view || 'home'));
});
$('#menu-button').addEventListener('click', openDrawer);
$('#drawer-backdrop').addEventListener('click', closeDrawer);
$('#detail-close').addEventListener('click', closeDetail);
$('#detail-play').addEventListener('click', playSelected);
$('#detail-save').addEventListener('click', () => state.selected && toggleMyList(state.selected));
$('#detail-upscale').addEventListener('click', requestUpscale);
// A SECOND listener on #player-close rather than an edit to the telemetry one a
// few hundred lines up: that one has to read video.currentTime before the source
// is dropped, and it is registered first, so it still runs first.
$('#player-close').addEventListener('click', closePlayer);
bindSearch();
detailDialog.addEventListener('click', (event) => {
  if (event.target === detailDialog) closeDetail();
});
detailDialog.addEventListener('cancel', () => {
  state.selected = null;
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!player.hidden) closePlayer();
  else if (!drawerLayer.hidden) closeDrawer();
});

/**
 * The call the BlazeOS Phase 1 patch removed, and the whole reason the home
 * screen has been empty. app.js is loaded with `defer`, so the DOM is parsed
 * before this line runs and every $('#id') at the top of the file has resolved.
 */
boot();
