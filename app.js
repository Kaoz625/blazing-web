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
const LIST_KEY = 'blazing-my-list-v2:';
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

/**
 * `headers` is optional and additive — every existing caller passes nothing and
 * behaves exactly as before. It exists for the ONE route in this file that is
 * authenticated: the fleet's per-profile progress, which wants the device token
 * in X-Device-Token. `credentials: 'omit'` stays, because that token is a
 * header, never a cookie.
 */
async function fetchJSON(url, { headers } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(url, {
      signal: controller.signal, mode: 'cors', credentials: 'omit',
      headers: { Accept: 'application/json', ...(headers || {}) },
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
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

/**
 * A transient message that offers ONE thing to do about itself.
 *
 * showToast() above is a <p> that says something happened. This is the same
 * widget with a button in it, and it exists for exactly one reason: a gesture
 * that changes stored state must be undoable in the moment it happens, not
 * hours later in a settings screen.
 *
 * It is a real <button> in the DOM, inside the same host, which is parked in
 * #detail-dialog's card while that dialog is open — so Tab reaches it from the
 * source list without leaving the modal. It is NOT auto-focused: stealing focus
 * from the row somebody is working through to put it on a button they may not
 * want costs more than it saves.
 */
const UNDO_TOAST_MS = 9000;

function showActionToast(message, actionLabel, onAction, lifetime = UNDO_TOAST_MS) {
  const text = plainText(message);
  const label = plainText(actionLabel);
  if (!text || !label) return null;
  const host = ensureToastHost();
  const node = el('div', 'toast toast-action');
  const copy = el('span', 'toast-action-copy');
  copy.textContent = text;
  const action = el('button', 'toast-action-button');
  action.type = 'button';
  action.textContent = label;
  node.append(copy, action);
  host.appendChild(node);

  let timer = 0;
  let spent = false;
  const dismiss = () => {
    if (spent) return;
    spent = true;
    window.clearTimeout(timer);
    node.classList.add('toast-out');
    window.setTimeout(() => node.remove(), 220);
  };
  action.addEventListener('click', () => {
    dismiss();
    try { onAction(); } catch (e) { /* an undo must never take the page with it */ }
  });
  timer = window.setTimeout(dismiss, lifetime);
  return node;
}

/* ── Sources the viewer marked "wrong film" ──────────────────────────────────
 *
 * Markus, 5 Sep 2026: "i removrd a lot of llinks by pressing the wrong button
 * i found working streams that played and now its gone"
 *
 * Right-clicking a source row marks it. That gesture had no confirmation, no
 * undo and no expiry, and what it wrote was a JSON ARRAY of raw URLs that was
 * appended to on every right-click and emptied by nothing in the whole app.
 *
 * IT ONLY EVER DEMOTED, which is why the streams are recoverable at all:
 * caps.js:733-737 subtracts 100000 from the score and styles.css:1042 draws the
 * row at 0.4 opacity. Nothing was hidden and nothing was deleted. That rule does
 * not change here — demote, never hide, never delete.
 *
 * THE STORE IS THE ROKU'S, PORTED, not a second scheme invented for the web:
 * source/lib/Store.brs DeadLinkMap / MarkDeadLink, same 86400-second window,
 * same 80-entry cap, same evict-the-oldest-one-per-write, same key. The key
 * matters as much as the numbers. A raw URL is not a stable identity for our own
 * signed links — https://addon.lyreosai.com/dl/<base64url(JSON)>.<signature>
 * carries an expiry stamped fresh on every request, so the same release is a
 * different string on every fetch and a mark on it could never be found again.
 * Roku fixed that by keying on the 40-hex info hash inside the token; this reads
 * the same field out of the same token, so a source the television remembers and
 * a source this browser remembers are the same source.
 *
 * THE OLD ARRAY IS DROPPED THE FIRST TIME IT IS READ. Its entries carry no
 * timestamp, so there is no honest age to give them and no way to expire them
 * later — and Roku's DeadLinkMap already discards any entry whose value is not
 * a positive integer, which is that same rule. It is also the answer to the
 * sentence at the top of this comment: the marks he did not mean to make are
 * gone on his next load, without him touching anything.
 */
const DEAD_LINK_TTL_SECONDS = 86400;
const DEAD_LINK_CAP = 80;
const DEAD_LINKS_STORE = 'dead_links';

/** base64url -> text, or '' when it is not valid base64url. */
function decodeBase64Url(value) {
  let text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = text.length % 4;
  // 1 is not a length base64 can produce; bail rather than decode rubbish.
  if (pad === 1) return '';
  if (pad === 2) text += '==';
  else if (pad === 3) text += '=';
  try {
    return atob(text);
  } catch {
    return '';
  }
}

/**
 * The info hash inside one of our own signed /dl/<token> URLs, or ''.
 *
 * Mirrors Roku's HashFromDlUrl and blazing-addon lib/verified.js. It reads the
 * payload and does NOT verify the signature, deliberately: identity is all that
 * is wanted here, and the signature is checked where the link is redeemed.
 */
function hashFromDlUrl(url) {
  const value = String(url == null ? '' : url);
  const at = value.indexOf('/dl/');
  if (at < 0) return '';
  const rest = value.slice(at + 4);
  const dot = rest.indexOf('.');
  if (dot < 1) return '';
  const json = decodeBase64Url(rest.slice(0, dot));
  if (!json) return '';
  let parsed = null;
  try {
    parsed = JSON.parse(json);
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object') return '';
  const hash = String(parsed.h || '').toLowerCase();
  // 40 hex characters and nothing else. Anything else is not a torrent hash,
  // and keying on it would merge unrelated streams under one mark.
  return /^[0-9a-f]{40}$/.test(hash) ? hash : '';
}

/** A stable fingerprint for one source row. Roku's DeadLinkKey, in JS. */
function deadLinkKey(url) {
  const value = String(url == null ? '' : url).trim();
  if (!value) return '';
  const hash = hashFromDlUrl(value);
  if (hash) return `h~${hash}`;
  const tail = value.length > 28 ? value.slice(-28) : value;
  return `${value.length}~${tail}`;
}

/** The live marks: key -> epoch seconds, with everything expired left out. */
function readDeadLinks() {
  const out = Object.create(null);
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(DEAD_LINKS_STORE) || 'null');
  } catch {
    raw = null;
  }
  // An Array is the legacy shape and it has no timestamps, so it drops whole —
  // see the block comment above.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const now = Math.floor(Date.now() / 1000);
  for (const key of Object.keys(raw)) {
    const at = raw[key];
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
    if (now - at >= DEAD_LINK_TTL_SECONDS) continue;
    out[key] = at;
  }
  return out;
}

function writeDeadLinks(map) {
  try {
    localStorage.setItem(DEAD_LINKS_STORE, JSON.stringify(map));
  } catch (e) {
    // A full or blocked localStorage costs a preference, never the player.
  }
}

/** Mark one source. Returns the key that was written, for the undo. */
function markDeadLink(url) {
  const key = deadLinkKey(url);
  if (!key) return '';
  const map = readDeadLinks();
  map[key] = Math.floor(Date.now() / 1000);
  // Bounded, because localStorage is not a database. Oldest out first, one per
  // write — Roku's exact rule, so neither client remembers more than the other.
  const keys = Object.keys(map);
  if (keys.length > DEAD_LINK_CAP) {
    let oldestKey = '';
    let oldestAt = 0;
    for (const candidate of keys) {
      if (!oldestAt || map[candidate] < oldestAt) {
        oldestAt = map[candidate];
        oldestKey = candidate;
      }
    }
    if (oldestKey) delete map[oldestKey];
  }
  writeDeadLinks(map);
  return key;
}

function unmarkDeadLink(key) {
  if (!key) return false;
  const map = readDeadLinks();
  if (map[key] === undefined) return false;
  delete map[key];
  writeDeadLinks(map);
  return true;
}

/** Empty the whole list. Returns how many marks were dropped. */
function clearDeadLinks() {
  const count = Object.keys(readDeadLinks()).length;
  writeDeadLinks({});
  return count;
}

/**
 * One snapshot for a whole render pass, plus the test that reads it.
 *
 * Taken once and reused, because the alternative is parsing localStorage and
 * base64-decoding a token for every one of up to 1200 rows.
 */
function deadLinkProbe() {
  const keys = new Set(Object.keys(readDeadLinks()));
  const test = (url) => keys.size > 0 && keys.has(deadLinkKey(url));
  test.size = keys.size;
  return test;
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

/**
 * SEASON 0 IS SPECIALS, AND IT USED TO BE SILENTLY RENAMED SEASON 1.
 *
 * `Math.max(1, Math.floor(Number(video.season || fallbackSeason) || 1))` folded
 * three separate things into the number 1: a real season 1, a missing season,
 * and season 0. Zero is falsy twice over on that line — `video.season || …`
 * skips it, and `Number('0') || 1` turns the id's own "0" segment into 1 — so
 * every special came out labelled S1, sorted in among the real first season, and
 * (because the list is sorted and the old default was episodes[0]) a show with
 * specials OPENED PRE-SELECTED ON ONE. That mislabelled episode id is what the
 * Play button and the source search then used, so the wrong thing played.
 *
 * The id is never touched — it is `tt0096697:0:5` on the wire and it stays
 * `tt0096697:0:5`, because that is what /stream/ is asked for. Only the season
 * NUMBER is now honest, so seasonLabel() can say "Specials" and
 * firstRealEpisode() can skip past them.
 *
 * A season this cannot read at all is 1, not 0: an unreadable season is a
 * missing field, and calling it Specials would be a worse lie than the old one.
 */
function safeEpisodes(raw) {
  const list = raw && Array.isArray(raw.videos) ? raw.videos : [];
  return list.map((video, index) => {
    if (!video || !video.id) return null;
    const id = plainText(video.id).slice(0, 160);
    const parts = id.split(':');
    // kitsu:100:3 has no season segment at all — its middle part is the SHOW id
    // — so a kitsu episode is season 1 unless the meta says otherwise.
    const stated = video.season === undefined || video.season === null || video.season === ''
      ? (/^kitsu:\d+:\d+$/.test(id) ? 1 : parts[parts.length - 2])
      : video.season;
    const parsed = Math.floor(Number(stated));
    const season = Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
    const episode = Math.floor(Number(video.episode || parts[parts.length - 1]) || 0);
    if (!id || episode < 1) return null;
    return {
      id,
      season,
      episode,
      absoluteEpisode: Math.max(1, Math.floor(Number(video.absoluteEpisode || video.number) || index + 1)),
      title: plainText(video.title || video.name).slice(0, 180),
    };
  }).filter(Boolean).sort((a, b) =>
    a.season - b.season || a.episode - b.episode || a.absoluteEpisode - b.absoluteEpisode);
}

/** Season 0 is where Cinemeta, TMDB and Kitsu all keep the specials. */
function seasonLabel(season) {
  return season === 0 ? 'Specials' : `Season ${season}`;
}

/** The short form, for a chip that has to sit in a row of twenty-eight of them. */
function seasonChipLabel(season) {
  return season === 0 ? 'Specials' : `S${season}`;
}

/**
 * PLAY ON A SERIES MEANS THE FIRST REAL EPISODE. The list is sorted, so season 0
 * sits at the front of it and episodes[0] is a special for every show that has
 * any — which is exactly what used to be pre-selected and played.
 *
 * A show that has NOTHING but specials still has to open on something, so the
 * fallback is the first of those.
 */
function firstRealEpisode(episodes) {
  return episodes.find((episode) => episode.season >= 1) || episodes[0] || null;
}

/** The sorted list, cut into contiguous per-season blocks. */
function episodeSeasons(episodes) {
  const seasons = [];
  for (const episode of episodes) {
    const last = seasons[seasons.length - 1];
    if (!last || last.season !== episode.season) seasons.push({ season: episode.season, episodes: [episode] });
    else last.episodes.push(episode);
  }
  return seasons;
}

function safeMeta(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  const genres = Array.isArray(raw.genres) ? raw.genres.slice(0, 4).map((g) => plainText(g).slice(0, 24)).filter(Boolean) : [];
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
    genres,
    videos: safeEpisodes(raw),
    isAnime: raw.isAnime === true || raw._isAnime === true
      || /^(?:kitsu:|mal-|al-)/i.test(String(raw.id || ''))
      || genres.some((genre) => /anime/i.test(genre)),
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

function readList(profileId) {
  if (!profileId) return [];
  try {
    const stored = JSON.parse(localStorage.getItem(LIST_KEY + encodeURIComponent(profileId)) || '[]');
    return Array.isArray(stored) ? stored.map(safeMeta).filter(Boolean).slice(0, 100) : [];
  } catch {
    return [];
  }
}

const state = {
  catalogs: [],
  selected: null,
  selectedEpisode: null,
  route: 'home',
  profileId: null,
  mediaProfile: null,
  myList: [],
  // The rating cap of the connected profile, or null when nobody has connected
  // one. profile.js has broadcast this on blazing-profile-selected since it was
  // written; until now NOTHING listened, so every Emby row reached every viewer
  // and the Kids profile on the web saw the whole library.
  profileCap: null,
  // The Kids flag, kept BESIDE the cap because they are two different things
  // and the Roku gates Manga on both: mangaAllowedNow() (MainScene.brs:5155) is
  // `not isKids AND rating allows mature`. profile.js carries isKids and
  // maxRating independently, so a Kids profile with a mature cap passes a
  // cap-only check and fails the Roku's — the web was the loose one.
  // false with nobody connected is safe: profileCap is null then, so
  // ratingAllowed('mature') already refuses.
  profileIsKids: false,
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
let homeRequest = 0;
let homeCatalogs = new Set();
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
  // The band at the top of the home screen gets a candidate from every row that
  // qualifies for the row-hero treatment, at the lowest priority. Continue
  // Watching outranks all of them — see seedHomeHero.
  seedHomeHero(metas[0], { priority: 1, eyebrow: 'Featured' });
}

/* ══════════════════════════════════════════════════════════════════════════
   THE FULL-BLEED HOME HERO

   Markus, 3 Sep 2026: "i absolutly love how on the home page the continue
   watching fills the whole screen. all devices should look like this and do
   this."

   He is describing the Roku, whose hero is now a 1920x1080 Video node at
   translation [0,0]. This is the web's copy of it. The band, its scrims and the
   reason it overrides the "no separate hero banner" decision are in styles.css;
   this is the half that decides WHAT is in it and WHEN it moves.

   THE TRAILER COMES FROM OUR FLEET AS A PLAIN VIDEO URL. Not a YouTube iframe,
   not the YouTube API. An iframe cannot run on Roku, Apple TV, Fire TV, LG webOS,
   Samsung Tizen or VegaOS, and every feature has to work on all six — so the
   browser is held to what a television can do, which is: open a URL.

   Verified live against the fleet, 3 Sep 2026:
       GET /trailer/movie/tt1517268            200  {"ytId":"Y1IgAEejvqM"}
       GET /trailer/play/<yt>?muxed=1&c=mp4&h=480   206  video/mp4  11,829,048 B
       GET /trailer/play/<yt>?muxed=1&c=mp4&h=1080  206  video/mp4  84,426,489 B
       ...with access-control-allow-origin: https://kaoz625.github.io on the
       range response, so the page really is allowed to read it.
   The tier is chosen by caps.js from what this device and this link can take —
   see BlazingCaps.trailerHeight, and the note there about why an unattended
   preview stops at 1080 even on a machine that would take 2160 for a film.

   THREE WAYS IT DEGRADES, all of them back to the artwork:
     - prefers-reduced-motion: the fleet is never called at all.
     - the fleet holds no ytId for this title, or the request fails: no video.
     - the <video> errors, stalls or has autoplay refused: `.playing` is never
       added, so the element stays at opacity 0 over the still.
   ══════════════════════════════════════════════════════════════════════════ */

const homeHero = $('#home-hero');
const homeHeroArt = $('#home-hero-art');
const homeHeroVideo = $('#home-hero-video');
const homeHeroMute = $('#home-hero-mute');

/** How long the still sits before the trailer is even asked for. */
const HERO_TRAILER_DELAY_MS = 1800;

/* `priority` is what stops the last row that finishes loading from winning.
   Continue Watching is prepended by loadContinueWatching() whenever it finishes,
   which is a race against every catalog row — and Markus asked for CONTINUE
   WATCHING in the band by name, so it takes 2 and a plain featured row takes 1.
   A higher number never loses to a lower one, whatever the order they arrive
   in. */
let homeHeroPriority = 0;
let homeHeroMeta = null;
let homeHeroTimer = null;

function seedHomeHero(meta, opts) {
  if (!homeHero || !meta) return;
  const priority = (opts && opts.priority) || 1;
  if (priority <= homeHeroPriority) return;
  // A band with no artwork is a black rectangle with text on it. Same guard as
  // claimHeroRow's, and for the same reason: a Live TV channel-logo row has
  // nothing to fill a hero with.
  const art = safeHttpsUrl(meta.background) || safeHttpsUrl(meta.poster);
  if (!art) return;

  homeHeroPriority = priority;
  homeHeroMeta = meta;
  stopHomeHeroTrailer();

  homeHeroArt.src = art;
  $('#home-hero-eyebrow').textContent = (opts && opts.eyebrow) || 'Featured';
  $('#home-hero-title').textContent = meta.name || '';
  $('#home-hero-meta').textContent = [meta.releaseInfo, meta.type === 'series' ? 'Series' : 'Film']
    .filter(Boolean).join('  ·  ');
  $('#home-hero-synopsis').textContent = meta.description || '';

  // A PERCENTAGE, already settled by the caller. It used to be a
  // {position, duration} pair divided here, but the two history stores disagree
  // on that shape — the fleet keeps a 0-100 integer and no duration at all,
  // the add-on keeps seconds — so the division moved to the one place that
  // knows which store answered (progressRowEntry). null, never 0, means the
  // store does not know: a bar of NaN width renders as a FULL one.
  const percent = opts && typeof opts.percent === 'number' ? opts.percent : null;
  const bar = $('#home-hero-progress');
  if (percent !== null && percent > 0) {
    $('#home-hero-progress-fill').style.width = `${Math.max(0, Math.min(100, percent))}%`;
    bar.hidden = false;
  } else {
    bar.hidden = true;
  }

  syncHomeHeroVisibility();

  // The synopsis is usually missing from a catalog meta — 171 of the live
  // catalog's 300 carry none — so fill the band in the same way a dwelt-on card
  // fills its panel, from /meta/. Dropped if the band moved on meanwhile.
  fetchFullMeta(meta).then((full) => {
    if (!full || homeHeroMeta !== meta) return;
    mergeFullMeta(meta, full);
    if (meta.description) $('#home-hero-synopsis').textContent = meta.description;
    const better = safeHttpsUrl(meta.background);
    if (better) homeHeroArt.src = better;
  }).catch(() => {});

  clearTimeout(homeHeroTimer);
  homeHeroTimer = setTimeout(() => startHomeHeroTrailer(meta), HERO_TRAILER_DELAY_MS);
}

/** Only on 'home'. Movies, Shows and Anime are the SAME section with the rows
    filtered (applyRowFilter), and a Continue Watching band over a filtered
    Anime shelf is showing the wrong thing on purpose. */
function syncHomeHeroVisibility() {
  if (!homeHero) return;
  const show = state.route === 'home' && !!homeHeroMeta;
  homeHero.hidden = !show;
  if (!show) { stopHomeHeroTrailer(); return; }

  // COMING BACK TO HOME HAS TO RE-ARM IT, and nothing else does. The branch
  // above tears the <video> right down on the way out — src removed, timer
  // cleared — and the only other place a trailer is ever started is
  // seedHomeHero(), which will not run again for a title that is already
  // seated. So without this the band plays its trailer exactly ONCE per page
  // load: one tap on the 12-tab nav and one tap back, which is seconds, and the
  // hero is a still picture for the rest of the session.
  //
  // Guarded on "nothing is running", for two callers: seedHomeHero() calls this
  // and then arms its own timer a few lines later (that one clears whatever is
  // set here, so they cannot double up), and a route change that leaves a
  // trailer already playing or already failed must not restart it.
  if (!homeHeroTimer && homeHeroVideo && !homeHeroVideo.getAttribute('src')) {
    const meta = homeHeroMeta;
    homeHeroTimer = setTimeout(() => startHomeHeroTrailer(meta), HERO_TRAILER_DELAY_MS);
  }
}

/**
 * Forget whoever the band was showing.
 *
 * THE PRIORITY LATCH NEVER EXPIRES, and that turned it into the exact bug the
 * Continue Watching ROW was written to avoid. seedHomeHero() refuses anything
 * whose priority is not HIGHER than the one already seated — that is what stops
 * a catalog shelf that finishes late from stealing the band. But Continue
 * Watching seats itself at 2, so the SECOND call at 2 is refused as well, and
 * the second call at 2 is the one the blazing-profile-selected listener makes on
 * every profile switch. The row swapped and the band did not: the previous
 * profile's title, artwork, synopsis and resume percentage stayed on screen
 * under the new name. The comment on that listener says in as many words that
 * switching profile must not leave "the previous profile's history on screen
 * under a new name"; the band it did not know about was doing precisely that.
 *
 * Clearing rather than overwriting, because the new profile may have nothing to
 * continue at all — in which case an empty band is right and the old profile's
 * film is not.
 */
function resetHomeHero() {
  stopHomeHeroTrailer();
  homeHeroPriority = 0;
  homeHeroMeta = null;
  if (homeHeroArt) homeHeroArt.removeAttribute('src');
  syncHomeHeroVisibility();
}

function stopHomeHeroTrailer() {
  clearTimeout(homeHeroTimer);
  homeHeroTimer = null;
  if (!homeHeroVideo) return;
  homeHeroVideo.classList.remove('playing');
  try { homeHeroVideo.pause(); } catch (e) {}
  // removeAttribute then load(), not src = '': assigning the empty string makes
  // the browser resolve it against the page URL and fetch the DOCUMENT as media,
  // which is a guaranteed decode error in the console on every route change.
  homeHeroVideo.removeAttribute('src');
  try { homeHeroVideo.load(); } catch (e) {}
  if (homeHeroMute) homeHeroMute.hidden = true;
}

/**
 * Ask the fleet which YouTube id belongs to this title.
 *
 * The card-hover preview goes through the ADDON's /proxy/yt-resolve instead, and
 * that is not an inconsistency to tidy up: it returns an HLS manifest, which is
 * right for a 132px poster that may be replaced a second later, and rowhero
 * .smoke.mjs asserts that path is taken. The hero wants one progressive file it
 * can seek and loop, which is the fleet's /trailer route and needs no resolve
 * round trip on the media itself.
 */
async function fleetTrailerYtId(meta) {
  if (!meta || !meta.id) return '';
  // The fleet indexes anime under its series metadata, exactly as Trailer.brs
  // does on the Roku.
  let type = meta.type === 'anime' ? 'series' : (meta.type || 'movie');
  if (type === 'tv') type = 'series';
  try {
    const res = await fetch(`${FLEET_BASE}/trailer/${encodeURIComponent(type)}/${encodeURIComponent(meta.id)}`,
      { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return '';
    const data = await res.json();
    return (data && typeof data.ytId === 'string') ? data.ytId : '';
  } catch (e) {
    return '';
  }
}

async function startHomeHeroTrailer(meta) {
  if (!homeHeroVideo || homeHeroMeta !== meta) return;
  // Asked before anything is fetched. Under `reduce` the fleet is never called:
  // respecting the preference by downloading 12 MB and then not showing it is
  // not respecting it.
  if (window.BlazingCaps && window.BlazingCaps.prefersReducedMotion()) return;

  const ytId = meta.trailerYt || await fleetTrailerYtId(meta);
  if (!ytId || homeHeroMeta !== meta) return;

  const caps = window.BlazingCaps ? await window.BlazingCaps.probe() : null;
  if (homeHeroMeta !== meta) return;
  const url = window.BlazingCaps
    ? window.BlazingCaps.trailerUrl(FLEET_BASE, ytId, caps)
    : `${FLEET_BASE}/trailer/play/${encodeURIComponent(ytId)}?muxed=1&c=mp4&h=480`;

  homeHeroVideo.muted = true;
  homeHeroVideo.src = url;
  // `once`, so a hero that is reseeded five times does not end up with five
  // listeners each un-hiding a video the others already tore down.
  homeHeroVideo.addEventListener('playing', () => {
    if (homeHeroMeta !== meta) return;
    homeHeroVideo.classList.add('playing');
    if (homeHeroMute) homeHeroMute.hidden = false;
    telemetry('nav_action', { action: 'hero_trailer_autoplay', from: 'home' });
  }, { once: true });
  homeHeroVideo.addEventListener('error', () => {
    // Back to the artwork, silently. A hero that announces a failed trailer is
    // telling the viewer about a problem they cannot act on.
    homeHeroVideo.classList.remove('playing');
    if (homeHeroMute) homeHeroMute.hidden = true;
  }, { once: true });

  const p = homeHeroVideo.play();
  // Autoplay refused (some engines refuse even muted under strict settings).
  // Nothing to do about it and nothing to say: the still is already correct.
  if (p && p.catch) p.catch(() => {});
}

if (homeHeroMute) {
  homeHeroMute.addEventListener('click', () => {
    // Muted is not a preference, it is the only way a browser will autoplay at
    // all. This button is how the viewer opts in to sound, which is also the
    // gesture the browser wants before it will allow it.
    const nowMuted = !homeHeroVideo.muted;
    homeHeroVideo.muted = nowMuted;
    homeHeroMute.textContent = nowMuted ? 'Unmute' : 'Mute';
    homeHeroMute.setAttribute('aria-label', nowMuted ? 'Unmute trailer' : 'Mute trailer');
    telemetry('nav_action', { action: nowMuted ? 'hero_mute' : 'hero_unmute', from: 'home' });
  });
}

if ($('#home-hero-play')) {
  $('#home-hero-play').addEventListener('click', () => {
    if (!homeHeroMeta) return;
    // openDetail is synchronous and sets state.selected, which playSelected
    // reads. Going straight to playSelected without it would find no selection
    // and return without a word.
    openDetail(homeHeroMeta);
    playSelected();
  });
}
if ($('#home-hero-info')) {
  $('#home-hero-info').addEventListener('click', () => {
    if (homeHeroMeta) openDetail(homeHeroMeta);
  });
}

/* The scrollbar width the full-bleed rule needs. See the --scrollbar note in
   styles.css: 100vw counts the classic scrollbar and the containing block does
   not, so without this the band overhangs by 7-17px on Windows and the page
   grows a horizontal scrollbar. 0 on overlay-scrollbar platforms, and 0 if this
   never runs, which is the ordinary trick's ordinary behaviour rather than a
   broken layout. */
function measureScrollbar() {
  const w = window.innerWidth - document.documentElement.clientWidth;
  document.documentElement.style.setProperty('--scrollbar', `${w > 0 ? w : 0}px`);
}
measureScrollbar();
window.addEventListener('resize', measureScrollbar);
function measureMediaPlayer() {
  const host = $('#media-player-host');
  const height = host?.hidden ? 0 : host?.getBoundingClientRect().height || 0;
  document.body.classList.toggle('has-audio-player', height > 0);
  document.documentElement.style.setProperty('--media-player-height', `${Math.ceil(height)}px`);
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measureMediaPlayer).observe($('#media-player-host'));
window.addEventListener('resize', measureMediaPlayer);
// Home arrives after the gate, so a classic scrollbar can appear without a
// window resize. Keep the full-width hero aligned as the document changes.
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(measureScrollbar).observe(document.documentElement);
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
  if (!state.profileId) return;
  try {
    localStorage.setItem(LIST_KEY + encodeURIComponent(state.profileId), JSON.stringify(state.myList));
  } catch {
    showToast('This browser could not save your list.', 'error');
  }
}

function listHas(meta) {
  return state.myList.some((item) => item.id === meta.id && item.type === meta.type);
}

function toggleMyList(meta) {
  if (!meta || !state.profileId) return;
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
    const active = button.dataset.view === route || (button.dataset.view === 'anime' && ['manga', 'comics', 'anime-search'].includes(route))
      || (button.closest('.topnav') && button.dataset.view === 'books' && ['music', 'podcasts'].includes(route));
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
  const cards = items.map(embyMetaSafe).filter(Boolean)
    .filter((meta) => ratingAllowed(meta.contentRating));
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
let mediaSearchAbort = null;

async function loadMediaSearch(query, request) {
  mediaSearchAbort?.abort();
  mediaSearchAbort = new AbortController();
  const signal = mediaSearchAbort.signal, profileId = state.profileId;
  const host = $('#search-media-results');
  host.replaceChildren();
  host.hidden = !ratingAllowed('mature') || !profileId;
  if (host.hidden) return;
  const isCurrent = () => !signal.aborted && request === searchRequest && profileId === state.profileId;
  await Promise.all(['books', 'music', 'podcasts'].map(async (kind) => {
    const section = el('section', 'media-search-section');
    const heading = el('h2'); heading.textContent = kind[0].toUpperCase() + kind.slice(1);
    const status = el('p', 'media-library-status'); status.setAttribute('role', 'status'); status.textContent = 'Searching…';
    const grid = el('div', 'media-search-grid'); section.append(heading, status, grid); host.append(section);
    try {
      const data = await window.BlazingProfile.mediaRequest(`/media/${kind}?q=${encodeURIComponent(query)}&limit=8`, { signal });
      if (!isCurrent()) return;
      if (!Array.isArray(data?.items)) throw new Error('Library unavailable');
      const items = data.items.filter((item) => typeof item?.id === 'string' && typeof item.title === 'string').slice(0, 8);
      status.textContent = items.length ? '' : 'No matches in this library.';
      for (const item of items) {
        const card = el('button', 'media-search-card'); card.type = 'button';
        card.setAttribute('aria-label', `${kind === 'books' ? 'Read' : 'Open'} ${plainText(item.title)}`);
        const poster = safeHttpsUrl(item.poster);
        if (poster) { const image = el('img'); image.src = poster; image.alt = ''; image.loading = 'lazy'; card.append(image); }
        const title = el('span'); title.textContent = plainText(item.title); card.append(title);
        card.addEventListener('click', () => { if (isCurrent()) showRoute(kind, { initialItem: item }); });
        grid.append(card);
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (error?.status === 401 || error?.status === 403) {
        status.textContent = 'Choose your profile to open this library. ';
        const choose = el('button', 'secondary-button'); choose.type = 'button'; choose.textContent = 'Choose profile';
        choose.addEventListener('click', () => window.BlazingProfile.open()); status.append(choose);
        return;
      }
      status.textContent = `${heading.textContent} could not be reached. `;
      const retry = el('button', 'secondary-button'); retry.type = 'button'; retry.textContent = 'Retry';
      retry.addEventListener('click', () => { if (isCurrent()) loadMediaSearch(query, request); }); status.append(retry);
    }
  }));
}

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
  ++searchRequest;
  mediaSearchAbort?.abort();
  $('#search-media-results').replaceChildren();
  $('#search-media-results').hidden = true;
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
    : `${cards.length} result${cards.length === 1 ? '' : 's'} in movies and TV.`;
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
    clearSearchResults();
    status.textContent = 'Type a title first.';
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
  loadMediaSearch(query, request);
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
  const visible = state.myList.filter((meta) => ratingAllowed(meta.contentRating));
  if (!visible.length) {
    const message = el('p', 'empty-copy');
    message.textContent = 'Open a title and use My list to save it here.';
    target.appendChild(message);
    return;
  }
  target.appendChild(buildResultRow('Saved titles', visible));
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

/**
 * Home, Movies, Shows and Anime are ONE section with the rows filtered, so the
 * heading is the only thing on screen that tells them apart. Same eyebrow +
 * title + line the other ten views carry; see the comment on .page-heading in
 * index.html for why all four were missing it.
 */
const BROWSE_HEADINGS = Object.freeze({
  home: ['Browse', 'Home', 'Everything on the household’s shelves.'],
  movies: ['Browse', 'Movies', 'Every film across the catalogues.'],
  shows: ['Browse', 'TV Shows', 'Series from the catalogues and the Emby library.'],
  anime: ['Browse', 'Anime', 'The anime shelves, subbed and dubbed.'],
});

function showRoute(route, mediaOptions = {}) {
  const browseRoute = ['home', 'movies', 'shows'].includes(route);
  state.route = route;
  const mediaRoute = ['books', 'music', 'podcasts'].includes(route);
  $('#media-view').hidden = !mediaRoute;
  $('#media-view').dataset.kind = route;
  if (mediaRoute) window.BlazingMediaLibrary?.mount(route, {
    host: $('#media-library-host'), playerHost: $('#media-player-host'), navigate: showRoute,
    initialQuery: mediaOptions.initialQuery, initialItem: mediaOptions.initialItem,
    profile: state.mediaProfile,
    request: (path, options) => window.BlazingProfile.mediaRequest(path, options),
    pauseVideo: () => { if (!player.hidden) closePlayer(); },
  });
  else window.BlazingMediaLibrary?.leave();
  const roomRoute = ['anime', 'manga', 'comics', 'anime-search'].includes(route);
  $('#anime-room-header').hidden = !roomRoute;
  $('#anime-room-view').hidden = route !== 'anime' && route !== 'anime-search';
  window.BlazingAnimeRoom?.mount(route, { navigate: showRoute, safeMeta: safeDiscoverMeta, buildCard, openDetail, ratingAllowed, fetchFullMeta });
  homeView.hidden = !browseRoute;
  if (browseRoute) {
    const [eyebrow, title, blurb] = BROWSE_HEADINGS[route] || BROWSE_HEADINGS.home;
    $('#browse-eyebrow').textContent = eyebrow;
    $('#browse-title').textContent = title;
    $('#browse-blurb').textContent = blurb;
  }
  // The full-bleed band belongs to 'home' alone, and it has to be told: Movies,
  // Shows and Anime are this SAME section with the rows filtered, so hiding
  // homeView is not enough — leave it and a Continue Watching hero sits over a
  // filtered Anime shelf. It also stops the trailer, so a route change is not a
  // video quietly downloading behind a screen nobody is looking at.
  syncHomeHeroVisibility();
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
  // Games and Manga (FLT-2): both live entirely in games.js/manga.js, the
  // same self-contained-module shape as locker.js/watch-party.js. This
  // router only flips visibility and calls mount() — each module guards its
  // own first-load work and, for Manga, re-checks the profile gate on every
  // mount so switching into the tab always reflects the current profile.
  const mangaView = $('#manga-view');
  const gamesView = $('#games-view');
  if (trailersView) trailersView.hidden = route !== 'trailers';
  if (educationView) educationView.hidden = route !== 'education';
  if (comicsView) comicsView.hidden = route !== 'comics';
  if (requestsView) requestsView.hidden = route !== 'requests';
  if (embyView) embyView.hidden = route !== 'emby';
  if (mangaView) mangaView.hidden = route !== 'manga';
  if (gamesView) gamesView.hidden = route !== 'games';

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
  if (route === 'comics') window.BlazingAnimeRoom?.loadComics();
  if (route === 'requests') loadRequestsView();
  if (route === 'emby') loadEmbyView();
  if (route === 'manga') window.BlazingManga && window.BlazingManga.mount();
  if (route === 'games') window.BlazingGames && window.BlazingGames.mount();
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
  // No emoji. DESIGN.md specifies section headings as plain 16px/600 text, and
  // the Roku, Apple TV and Fire TV all draw them that way -- "Latest Releases",
  // "Trending Movies". A flame on the web only was the loudest single tell that
  // this client was designed apart from the others.
  { id: 'blazing-trending-movies', type: 'movie', name: 'Trending Movies' },
  { id: 'blazing-trending-series', type: 'series', name: 'Trending Shows' },
]);

const TRAILER_ROWS = Object.freeze([
  { id: 'blazing-trailers-new', type: 'movie', name: 'New in Theaters' },
  { id: 'blazing-trailers-upcoming', type: 'movie', name: 'Coming Soon' },
]);

const EDU_SLUGS = Object.freeze(['science', 'history', 'stem', 'kids', 'languages']);

/**
 * The media type each catalog slug lives under, because /api/ui/home-config
 * does not carry one.
 *
 * AN SDUI ROW'S `type` IS A WIDGET, NOT A MEDIA TYPE. The live payload names
 * `card_row`, `audio_row`, `storybook_row`, `heritage_row`, `progress_row` and
 * `cinematic_hero` — never movie/series/tv. There is no content type anywhere
 * in that response, so a client that wants to build /catalog/<type>/<slug>.json
 * has to supply the type itself. Samsung (KNOWN_CATALOG_TYPES in
 * js/screens/home.js) and Fire TV (knownTypes in Catalogs.kt) already each keep
 * a map exactly like this one; this client was the last without it.
 *
 * AND THE TYPE SEGMENT IS NOT DECORATIVE. The addon's generic
 * /catalog/:type/:id.json handler does ignore it — it looks the row up by id —
 * but it first hands a whole family of ids off to their OWN routes
 * (CATALOG_IDS_WITH_OWN_ROUTE: books, anime-airing, anime-top, manga-trending,
 * sports, trailers-*, trending-*, edu-*, kids-*, family-*) and those are
 * registered under ONE type each. Ask under any other type and Express matches
 * nothing: HTTP 404, fetchJSON throws, loadSDUIRow removes the shelf. Measured
 * against addon.lyreosai.com, 29 Aug 2026:
 *
 *     /catalog/movie/blazing-kids-movies.json     200   20 metas
 *     /catalog/tv/blazing-kids-movies.json        404    0
 *     /catalog/series/blazing-kids-series.json    200   19 metas
 *     /catalog/tv/blazing-kids-series.json        404    0
 *     /catalog/movie/blazing-family-movies.json   200   18 metas
 *     /catalog/tv/blazing-family-movies.json      404    0
 *     /catalog/movie/blazing-trailers-new.json    200   20 metas
 *     /catalog/tv/blazing-trailers-new.json       404    0
 *     /catalog/tv/blazing-sports.json             200    3 metas
 *     /catalog/movie/blazing-sports.json          404    0
 *     /catalog/tv/blazing-edu-kids.json           200   22 metas
 *     /catalog/movie/blazing-edu-kids.json        404    0
 *
 * So 'tv' is right for sports/edu/family-tree and fatal for kids and trailers,
 * and 'movie' is the reverse. Only blazing-trending-* (its route takes :type)
 * and the ids that fall through to the generic handler are type-agnostic.
 *
 * The order below matters: exact slug, then the open-ended prefixes the addon's
 * own regex allows to grow (edu-*, kids-*, family-*), then 'movie' — the same
 * default Samsung and Fire TV use. The default is only ever reached for a slug
 * with no route of its own, which is precisely where the segment is ignored.
 */
const CATALOG_TYPES = Object.freeze({
  ...Object.fromEntries([...TRENDING_ROWS, ...TRAILER_ROWS].map((r) => [r.id, r.type])),
  'blazing-movies': 'movie',
  'blazing-series': 'series',
  'blazing-livetv': 'tv',
  'blazing-music': 'tv',
  'blazing-anime': 'series',
  'blazing-anime-airing': 'series',
  'blazing-anime-top': 'series',
  'blazing-asian': 'series',
  'blazing-bollywood': 'movie',
  'blazing-meta-movies': 'movie',
  'blazing-adult': 'movie',
  'blazing-books': 'book',
  'blazing-manga-trending': 'book',
  'blazing-sports': 'tv',
  'blazing-family-tree': 'tv',
  'blazing-kids-movies': 'movie',
  'blazing-kids-series': 'series',
  'blazing-family-movies': 'movie',
});

function catalogTypeFor(slug) {
  const id = String(slug || '');
  if (CATALOG_TYPES[id]) return CATALOG_TYPES[id];
  // Every blazing-edu-* catalog is served from `/catalog/tv/blazing-edu-<cat>.json`
  // and from nowhere else — one loop in the addon registers all twenty of them,
  // so a new education category added server-side needs no change here.
  if (id.startsWith('blazing-edu-')) return 'tv';
  // kids-* and family-* are open-ended in the addon's route regex too. Their
  // naming is consistent enough to read: -movies is a movie catalog, -series
  // and -shows are series ones.
  if (/-movies$/.test(id)) return 'movie';
  if (/-(series|shows)$/.test(id)) return 'series';
  return 'movie';
}


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

async function fetchFullMeta(meta, forDetail = false) {
  const key = `${forDetail ? 'detail' : 'preview'}:${meta.type}:${meta.id}`;
  if (fullMetaCache.has(key)) return fullMetaCache.get(key);
  const kitsuId = /^kitsu:\d+$/.test(String(meta.id));
  // Emby titles are not in the addon catalog, so /meta/ is a guaranteed 404 for
  // them - the same reason openDetail skips /stream/ for an embyId.
  if (meta.embyId || (!forDetail && !kitsuId && !/^tt\d+$/.test(String(meta.id)))) {
    fullMetaCache.set(key, null);
    return null;
  }
  // Kitsu has its own episode IDs. Cinemeta cannot return metadata for them.
  const url = kitsuId
    ? `https://anime-kitsu.strem.fun/meta/anime/${encodeURIComponent(meta.id)}.json`
    : `${API_BASE}/meta/${encodeURIComponent(meta.type)}/${encodeURIComponent(meta.id)}.json`;
  const job = fetchJSON(url)
    .then((data) => safeMeta({ ...(data && data.meta), type: meta.type }) || null)
    .catch(() => null);
  fullMetaCache.set(key, job);
  return job;
}

/** Fold anything the catalog was missing into the meta the card already holds. */
function mergeFullMeta(meta, full) {
  if (!full) return meta;
  if (RATINGS.includes(full.contentRating)) meta.contentRating = full.contentRating;
  for (const k of ['description', 'imdbRating', 'runtime', 'certification', 'background', 'trailerYt', 'trailerUrl']) {
    if (!meta[k] && full[k]) meta[k] = full[k];
  }
  if ((!meta.genres || !meta.genres.length) && full.genres && full.genres.length) meta.genres = full.genres;
  if ((!meta.videos || !meta.videos.length) && full.videos && full.videos.length) meta.videos = full.videos;
  if (full.isAnime) meta.isAnime = true;
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
 * Resolve a trailer to a URL WE serve, and return a <video> playing it.
 *
 * NOT A YOUTUBE IFRAME. Markus, 2026-08-29: "you do not need to make youtube api
 * calls when we have real debrid and torbox apis ... it should work on roku
 * apple tv and firestick and lg tv and samsung tv and vegaOS". An iframe cannot
 * run on any of those six. Whatever the browser does here has to be something a
 * television can do too, and a television plays a video URL.
 *
 * WHAT WAS ACTUALLY CHECKED, rather than assumed, on 29 Aug 2026:
 *   - Real-Debrid  youtube.com is `status: down, supported: 0`, and an
 *                  unrestrict call answers {"error":"hoster_unavailable"}.
 *   - TorBox       lists YouTube as up, accepts the job, and then fails it:
 *                  "unable to download video data: HTTP Error 403: Forbidden".
 *   - OUR OWN FLEET works. /proxy/yt-resolve has been in the addon all along,
 *                  serving the education player. It runs yt-dlp server-side and
 *                  hands back an HLS manifest.
 *
 * So the trailer comes from our own backend on our own domain. No client ever
 * talks to YouTube, and no API key is involved.
 *
 *   &via=proxy   for a BROWSER. Google serves the signed manifest with no
 *                Access-Control-Allow-Origin, so a page cannot fetch it at all.
 *                The addon re-serves it and its segments with a CORS header.
 *                Televisions omit this flag - they are not browsers, and the
 *                direct URL is faster. Same rule as resolveEduStream().
 */
async function resolveTrailerUrl(meta) {
  if (safeHttpsUrl(meta.trailerUrl)) return safeHttpsUrl(meta.trailerUrl);
  if (!meta.trailerYt) return '';
  try {
    const res = await fetch(
      `${API_BASE}/proxy/yt-resolve?id=${encodeURIComponent(meta.trailerYt)}&json=1&via=proxy`,
      { mode: 'cors', credentials: 'omit' }
    );
    if (!res.ok) return '';
    const data = await res.json();
    const raw = data && data.url;
    // The proxied form comes back as a PATH, so the addon need not know which
    // hostname it is being served under.
    return (typeof raw === 'string' && raw.startsWith('/')) ? `${API_BASE}${raw}` : safeHttpsUrl(raw);
  } catch {
    return '';
  }
}

/**
 * A muted <video> for one trailer URL, plus the teardown it needs.
 *
 * Its own hls.js instance, NOT the shared one attachSource() drives - that is
 * bound to the single full-screen player element, and pointing it at a card
 * would tear down whatever the viewer was watching.
 */
function makeTrailerVideo(url) {
  const video = el('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.setAttribute('tabindex', '-1');
  video.setAttribute('aria-hidden', 'true');

  let hls = null;
  if (looksLikeHls(url, '') && window.Hls && window.Hls.isSupported()) {
    hls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
    hls.on(window.Hls.Events.ERROR, (_evt, data) => { if (data && data.fatal) video.dispatchEvent(new Event('error')); });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else {
    // Safari and every television play HLS natively; nothing to load.
    video.src = url;
    video.load();
  }
  return { video, destroy: () => { if (hls) { try { hls.destroy(); } catch {} hls = null; } } };
}

function attachHoverTrailer(card, meta) {
  let textTimer = null;
  let videoTimer = null;
  let wrap = null;
  let player = null;

  const stop = () => {
    clearTimeout(textTimer); clearTimeout(videoTimer);
    textTimer = null; videoTimer = null;
    // Destroy the hls.js instance, not just the element. A detached one keeps
    // fetching segments for ever, and a row of 20 cards would leave 20 running.
    if (player) { player.destroy(); player = null; }
    if (wrap) { wrap.remove(); wrap = null; }
    card.classList.remove('card-previewing');
  };

  const begin = () => {
    // Where the preview can actually be SEEN. Two places qualify, and they show
    // different amounts of it:
    //
    //   .row-hero       — the card widens to 16/10 and the text panel opens too.
    //   .search-results — the poster GRID (search, Emby, Discover, Requests).
    //                     The card cannot widen here without breaking a 5-across
    //                     grid, and DebridStream's own search is a plain poster
    //                     grid for the same reason. So the trailer plays in place
    //                     and the text panel stays shut: .card-trailer-wrap is
    //                     `position:absolute; inset:0` over an opaque black, so it
    //                     needs no room of its own, and .card-hero-content is only
    //                     revealed by the `.row-hero .card:hover` rule, which a
    //                     grid card never matches.
    //
    // Markus, 2026-08-30: "even when you search for the movie."
    if (!card.closest('.row-hero, .search-results')) return;
    clearTimeout(textTimer); clearTimeout(videoTimer);

    textTimer = setTimeout(async () => {
      const full = await fetchFullMeta(meta);
      mergeFullMeta(meta, full);
      if (!ratingAllowed(meta.contentRating)) { stop(); card.remove(); return; }
      fillCardHeroContent(card, meta);
    }, DWELL_MS);

    videoTimer = setTimeout(async () => {
      const full = await fetchFullMeta(meta);
      mergeFullMeta(meta, full);
      if (!ratingAllowed(meta.contentRating)) { stop(); card.remove(); return; }
      const url = await resolveTrailerUrl(meta);
      // The pointer may have left while that was in flight - resolving runs
      // yt-dlp server-side and is not instant on a cold cache.
      if (!url || !videoTimer || !card.matches(':hover, :focus-within')) return;
      const made = makeTrailerVideo(url);
      player = made;
      wrap = el('div', 'card-trailer-wrap');
      wrap.appendChild(made.video);
      card.appendChild(wrap);
      card.classList.add('card-previewing');
      // FORCE THE STYLE, DO NOT WAIT FOR A FRAME. `.card-trailer-wrap` is
      // opacity 0 with a 400ms transition and `.visible` is what turns it on;
      // adding that class in the same task as the append would give the engine
      // no `before` value to transition FROM, so it would snap. The old cure was
      // requestAnimationFrame, and it made the fade depend on a frame actually
      // being produced — which is not guaranteed. Reading offsetWidth flushes
      // the pending style and layout right here, so opacity:0 is computed, and
      // the class flip on the next line then transitions exactly as before with
      // nothing to wait for.
      //
      // MEASURED: rowhero.smoke.mjs's "it is faded in, not left at opacity 0"
      // went red once inside a back-to-back run of all 18 harnesses and green on
      // three consecutive solo runs of the same file. The wrap was built (the
      // <video> assertions beside it passed) and simply never got `.visible` —
      // the rAF callback had not run yet. A viewer whose machine is that busy
      // gets the same thing: a trailer playing at opacity 0 behind the poster,
      // audible and invisible, for as long as the browser skips frames.
      void wrap.offsetWidth;
      wrap.classList.add('visible');
      const p = made.video.play();
      if (p && p.catch) p.catch(() => {});
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
  card.addEventListener('click', () => {
    if (state.route === 'anime') meta.isAnime = true;
    openDetail(meta);
  });
  return card;
}

function hydrateCardBackdrop(event) {
  const card = event.currentTarget;
  if (!card.closest('.row-hero')) return;
  const backdrop = $('.card-backdrop', card);
  if (backdrop && backdrop.dataset.src) backdrop.src = backdrop.dataset.src;
}

async function loadRow(catalog, section, request = homeRequest) {
  const track = $('.row-track', section);
  try {
    const data = await fetchJSON(
      `${API_BASE}/catalog/${encodeURIComponent(catalog.type)}/${encodeURIComponent(catalog.id)}.json`
    );
    if (request !== homeRequest || !section.isConnected) return [];
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

async function loadFreshHomeRow(shelf, section, request = homeRequest) {
  const track = $('.row-track', section);
  try {
    const data = await fetchJSON(`${FLEET_BASE}${shelf.path}`);
    if (request !== homeRequest || !section.isConnected) return [];
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


async function loadSDUIRow(catalogInfo, section, request = homeRequest) {
  const track = $('.row-track', section);
  if (!catalogInfo.catalogSlug) {
    // The profile lifecycle loads history once, separately from catalog rows.
    section.remove();
    return [];
  }
  
  // WAS `/catalog/tv/${slug}.json`, hardcoded, for EVERY row whatever it held.
  // 'tv' is the correct segment for the education and sports shelves and a 404
  // for the kids, family and trailer ones — see catalogTypeFor() for the twelve
  // live measurements. A 404 makes fetchJSON throw, the catch below removes the
  // section, and the shelf simply is not there: no error, no empty row, nothing
  // to see. On the live blazing-mode home that silently cost four of thirteen
  // rows (🎬 New in Theaters, Kids Movies, Kids Shows, Family Movies), and the
  // three it cost the BrightMinds home are the only three the addon says are
  // reliably populated at all right now — every blazing-edu-* catalog returns
  // zero items while its YouTube quota is exhausted. Same shape as loadRow().
  const fetchUrl =
    `${API_BASE}/catalog/${encodeURIComponent(catalogInfo.type)}/${encodeURIComponent(catalogInfo.catalogSlug)}.json`;

  try {
    const data = await fetchJSON(fetchUrl);
    if (request !== homeRequest || !section.isConnected) return [];
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

/**
 * Rebuild Home after a profile is selected, including on a returning browser.
 *
 * IT NOW BUILDS WHILE THE GATE IS STILL UP — for a viewer this browser already
 * knows. That is the whole reason the web home was empty: state.profileId is
 * null on every single page load, so this returned before its first line of
 * work and the deployed app drew ZERO rows and made exactly ONE network call,
 * while the 55" Roku drew 39. restoreProfileSession() (bottom of this file)
 * hands the returning viewer's id and cap back before this runs, so the home
 * behind the gate is now that viewer's real home, built with their real cap,
 * exactly the way the Roku's HomeScreen builds during its own gate.
 *
 * WHAT IT STILL WILL NOT DO IS BUILD FOR A STRANGER, and that is deliberate:
 * a browser with no remembered viewer draws nothing until somebody says who
 * they are. Two measurements settle it, and both point the same way.
 *
 *  1. The most restrictive cap really is empty. With no profile connected the
 *     cap is 'general', and ratingAllowed() correctly treats an unknown tier as
 *     unknown-not-safe. Live catalog metas carry NO contentRating at all
 *     (measured 2026-09-06: 1 of 1 on blazing-trending-movies), so a strictly
 *     capped pre-profile home has nothing it is allowed to draw. Relaxing that
 *     — letting an unrated title through because its shelf looked safe — is the
 *     one thing this app must not do to an unidentified viewer.
 *  2. home-profile.smoke.mjs:91 and :93 already pin exactly this, by name:
 *     "No old personal Home behind the gate" and "Home waits for a selection".
 *
 * See notesForOwner: the audit asked for shared shelves behind the gate, and
 * that is a server change (a curated shelf set with real contentRating on its
 * items), not a client one.
 */
async function boot() {
  if (!state.profileId) {
    if (window.BlazingProfile && !window.BlazingProfile.isOpen()) window.BlazingProfile.open();
    return;
  }
  const request = ++homeRequest;
  homeCatalogs = new Set();
  rowsWrap.replaceChildren();
  resetHomeHero();
  loadContinueWatching(state.profileId, request);
  loadEmbyRows(request);
  const described = await bootFromSDUI(request);
  if (request !== homeRequest) return;
  if (!described) await bootFromShelves(request);
}

function claimHomeCatalog(type, id) {
  const key = `${type}/${id}`;
  if (homeCatalogs.has(key)) return false;
  homeCatalogs.add(key);
  return true;
}

/** Load the server's preferred row order; local shelves fill out the Home below. */
async function bootFromSDUI(request = homeRequest) {
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
    const uiConfig = await fetchJSON(`${API_BASE}/api/ui/home-config?mode=${mode}`);
    if (request !== homeRequest) return false;
    if (!uiConfig || !Array.isArray(uiConfig.homeRows) || !uiConfig.homeRows.length) return false;

    if (uiConfig.appName) {
      document.title = uiConfig.appName;
      const brandSpan = $('.brand-mark').nextElementSibling;
      if (brandSpan) brandSpan.textContent = uiConfig.appName;
    }
    // Applied only when the server names one. Writing `undefined` into --accent
    // is how a palette silently loses the one red every client agrees on.
    //
    // ALL THREE, not just --accent. The SDUI payload names one colour, and the
    // stylesheet has three tokens: --accent, --accent-strong (the dark end of
    // every gradient) and --accent-glow (every focus ring's halo). Setting only
    // the first left --accent-strong at Blazing's #E11D2B on the kids_warm
    // shell, so `linear-gradient(var(--accent), var(--accent-strong))` painted
    // gold fading into red on every primary button, and the focus glow stayed
    // red around a gold ring. [data-theme="kids_warm"] in styles.css redefines
    // --accent-glow and it did NOT redefine --accent-strong, which is how the
    // mismatch survived: the theme block looked complete.
    //
    // Derived rather than asked for, because the payload has one field. srgb
    // color-mix is the same maths the two static palettes already encode:
    // #FF3D47 mixed 78% with black is within a shade of #E11D2B.
    if (uiConfig.accentColor) {
      const root = document.documentElement.style;
      root.setProperty('--accent', uiConfig.accentColor);
      root.setProperty('--accent-strong', `color-mix(in srgb, ${uiConfig.accentColor} 78%, #000)`);
      root.setProperty('--accent-glow', `color-mix(in srgb, ${uiConfig.accentColor} 35%, transparent)`);
    }
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
          // WAS `row.type === 'cinematic_hero' ? 'movie' : 'series'`, and that
          // is a category error twice over: row.type is a WIDGET name, so it is
          // never 'cinematic_hero' by the time it gets here (the filter above
          // already dropped those), and the branch that always won handed every
          // shelf on the home the type 'series'. loadSDUIRow feeds this to
          // safeDiscoverMeta as the per-item fallback type, which is what
          // openDetail then asks /meta/<type>/ and /stream/<type>/ for — so a
          // film would have been looked up as a show. That damage stayed
          // hypothetical only because every live catalog meta happens to carry
          // its own type (measured 29 Aug 2026: 365/365 metas across five
          // catalogs — kids-movies, trailers-new, sports, edu-kids and anime —
          // so the `item.type ||` fallback never fires today). Now it is the
          // catalog's real type, which is also what builds the URL.
          type: catalogTypeFor(row.catalogSlug),
          name: row.label,
          catalogSlug: row.catalogSlug,
        };
        if (catalogInfo.catalogSlug && !claimHomeCatalog(catalogInfo.type, catalogInfo.catalogSlug)) return [];
        const section = buildRowSkeleton(catalogInfo);
        rowsWrap.appendChild(section);
        return loadSDUIRow(catalogInfo, section, request);
      });

    // Once the layout has reserved its catalog IDs, start other shelves too.
    // One slow or empty SDUI source must not hold up the rest of Home.
    await Promise.all([Promise.all(jobs), bootFromShelves(request)]);
    if (request !== homeRequest) return false;
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
async function bootFromShelves(request = homeRequest) {
  const trendingJobs = TRENDING_ROWS.map((catalog) => {
    if (!claimHomeCatalog(catalog.type, catalog.id)) return Promise.resolve([]);
    const section = buildRowSkeleton(catalog);
    section.dataset.softRow = 'true';
    rowsWrap.appendChild(section);
    return loadRow(catalog, section, request);
  });

  const freshJobs = FRESH_HOME_SHELVES.map((shelf) => {
    const section = buildRowSkeleton({ id: shelf.id, name: shelf.title, type: shelf.type });
    section.dataset.freshShelf = 'true';
    rowsWrap.appendChild(section);
    return loadFreshHomeRow(shelf, section, request);
  });
  const freshDone = Promise.all(freshJobs);

  const catalogDone = fetchJSON(`${API_BASE}/manifest.json`)
    .then((manifest) => {
      if (request !== homeRequest) return [];
      state.catalogs = activeCatalogs(Array.isArray(manifest.catalogs) ? manifest.catalogs : []);
      const jobs = state.catalogs.map((catalog) => {
        if (!claimHomeCatalog(catalog.type, catalog.id)) return Promise.resolve([]);
        const section = buildRowSkeleton(catalog);
        rowsWrap.appendChild(section);
        return loadRow(catalog, section, request);
      });
      return Promise.all(jobs);
    })
    .catch(() => []);

  const [freshRows, catalogRows, trendingRows] = await Promise.all([freshDone, catalogDone, Promise.all(trendingJobs)]);
  if (request !== homeRequest) return;
  // trendingRows was AWAITED and then thrown away by a two-name destructure, so
  // a home whose only populated rows were Trending Now and Trending Shows -- the
  // ordinary case when the discover shelves are quiet -- counted as "nothing"
  // and printed the empty line above two full rows of posters.
  const gotAnything = freshRows.some((metas) => metas.length)
    || catalogRows.some((metas) => metas.length)
    || trendingRows.some((metas) => metas && metas.length);
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

function clearEpisodeControls() {
  const picker = $('#detail-episodes');
  const select = $('#detail-episode-select');
  const mangaButton = $('#detail-manga');
  if (picker) picker.remove();
  if (select) select.remove();
  if (mangaButton) mangaButton.remove();
}

function episodeContext(meta) {
  const episode = state.selectedEpisode;
  if (!meta || !episode) return null;
  return {
    title: meta.name,
    animeId: meta.id,
    season: episode.season,
    episode: episode.episode,
    absoluteEpisode: episode.absoluteEpisode,
    episodeTitle: episode.title,
    episodeCount: Array.isArray(meta.videos) ? meta.videos.length : 0,
  };
}

/**
 * ONE FLAT LIST OF EVERY EPISODE OF EVERY SEASON WAS THE WHOLE CONTROL.
 * Measured on the deployed app: The Simpsons rendered 876 <option> elements in
 * a single <select> with no grouping of any kind, Grey's Anatomy 476, Breaking
 * Bad 67. Nobody finds season 19 in that.
 *
 * The Roku already solves this and this copies its interaction: a season chip
 * strip, a "Jump to newest" chip, and a per-season episode rail.
 *
 * WHY THE <select> IS STILL HERE. A native select cannot be driven by a remote
 * — dpad.js moves focus by geometry and cannot open or walk a popup — so the
 * chips and the rail are the real control and both are plain buttons. The
 * select stays as the quick jump for a mouse, and it is now scoped to ONE
 * season, which is what takes it from 876 options to about twenty. It is also
 * the surface three shipped tests drive by id (anime-room.smoke.mjs:113,
 * episode-manga.smoke.mjs:103, source-error.smoke.mjs:136), so it keeps its id,
 * stays visible, and stays a real <select>.
 */
function renderEpisodeControls(meta) {
  clearEpisodeControls();
  const episodes = Array.isArray(meta && meta.videos) ? meta.videos : [];
  if (meta.type !== 'series' || !episodes.length) {
    state.selectedEpisode = null;
    return;
  }
  if (!state.selectedEpisode || !episodes.some((episode) => episode.id === state.selectedEpisode.id)) {
    state.selectedEpisode = firstRealEpisode(episodes);
  }

  const seasons = episodeSeasons(episodes);
  // The season being BROWSED, which is not always the season being played: a
  // viewer can look through season 4 without committing to it until they pick
  // an episode, exactly as the Roku's strip behaves.
  let openSeason = state.selectedEpisode.season;

  const picker = el('div', 'episode-picker');
  picker.id = 'detail-episodes';
  const strip = el('div', 'season-strip');
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', 'Season');
  const rail = el('div', 'episode-rail');
  rail.setAttribute('aria-label', 'Episodes');

  const select = document.createElement('select');
  select.id = 'detail-episode-select';
  select.className = 'quality-select episode-jump';
  select.setAttribute('aria-label', 'Episode');

  function choose(episode) {
    if (!episode || episode.id === state.selectedEpisode.id) return;
    state.selectedEpisode = episode;
    openSeason = episode.season;
    paint();
    detailStatus.textContent = `Finding sources for ${seasonLabel(episode.season)}, episode ${episode.episode}…`;
    loadStreams(meta);
  }

  function paint() {
    const current = seasons.find((group) => group.season === openSeason) || seasons[0];
    openSeason = current.season;

    strip.replaceChildren(...seasons.map((group) => {
      const chip = el('button', 'season-chip');
      chip.type = 'button';
      chip.setAttribute('role', 'tab');
      chip.textContent = seasonChipLabel(group.season);
      // The chip says "S19"; the label a screen reader and a TV remote's
      // announcement need is the whole phrase.
      chip.setAttribute('aria-label', `${seasonLabel(group.season)}, ${group.episodes.length} episodes`);
      const open = group.season === current.season;
      chip.setAttribute('aria-selected', String(open));
      chip.classList.toggle('active', open);
      chip.addEventListener('click', () => { openSeason = group.season; paint(); });
      return chip;
    }));

    // NEWEST IS THE LAST REAL EPISODE, never a special. Specials sort to the
    // front of the list and are usually years old, so "newest" pointing at one
    // would be wrong twice.
    const real = episodes.filter((episode) => episode.season >= 1);
    const newest = real[real.length - 1];
    if (newest && seasons.length > 1) {
      const jump = el('button', 'season-chip season-chip-jump');
      jump.type = 'button';
      jump.textContent = 'Jump to newest';
      jump.setAttribute('aria-label', `Jump to the newest episode, ${seasonLabel(newest.season)} episode ${newest.episode}`);
      jump.addEventListener('click', () => choose(newest));
      strip.appendChild(jump);
    }

    rail.replaceChildren(...current.episodes.map((episode) => {
      const button = el('button', 'episode-chip');
      button.type = 'button';
      button.dataset.episodeId = episode.id;
      const number = el('span', 'episode-chip-number');
      number.textContent = `E${episode.episode}`;
      const title = el('span', 'episode-chip-title');
      title.textContent = episode.title || `${seasonLabel(episode.season)}, episode ${episode.episode}`;
      button.append(number, title);
      const playing = episode.id === state.selectedEpisode.id;
      button.classList.toggle('active', playing);
      if (playing) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => choose(episode));
      return button;
    }));

    select.replaceChildren(...current.episodes.map((episode) => {
      const option = document.createElement('option');
      option.value = episode.id;
      option.textContent = `S${episode.season} E${episode.episode}${episode.title ? ` · ${episode.title}` : ''}`;
      option.selected = episode.id === state.selectedEpisode.id;
      return option;
    }));

    // BOTH STRIPS HAVE TO MOVE THEMSELVES. A remote cannot drag a scrollbar,
    // and The Simpsons draws 39 season chips of which about six fit — so
    // resuming season 19 would otherwise leave the strip parked on Specials with
    // the active chip somewhere off-screen to the right. 'nearest' on the block
    // axis so this scrolls the strip and never the dialog behind it.
    const openChip = strip.querySelector('.season-chip.active');
    if (openChip) openChip.scrollIntoView({ block: 'nearest', inline: 'center' });
    const playing = rail.querySelector('.episode-chip.active');
    if (playing) playing.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  select.addEventListener('change', () => {
    choose(episodes.find((episode) => episode.id === select.value));
  });

  paint();
  picker.append(strip, rail, select);
  detailPlay.insertAdjacentElement('afterend', picker);

  // Manga is a Mature section everywhere, and the Roku gates it on TWO things
  // (mangaAllowedNow, MainScene.brs:5155): not a Kids profile, AND a cap that
  // reaches 'mature'. The web checked only the cap, so a Kids profile carrying a
  // mature cap could open the reader here and not on the television. Hide the
  // action entirely when this profile cannot enter, and never make an
  // episode-map request.
  if (meta.isAnime && !state.profileIsKids && ratingAllowed('mature') && window.BlazingManga) {
    const button = document.createElement('button');
    button.id = 'detail-manga';
    button.className = 'secondary-button';
    button.type = 'button';
    button.textContent = 'Read manga';
    button.addEventListener('click', () => {
      const context = episodeContext(meta);
      if (!context) return showToast('Choose an episode first.', 'error');
      closeDetail();
      window.BlazingManga.openEpisode(context);
    });
    // After the whole picker, not after the <select> — the select now lives
    // inside it, so an "afterend" there would drop the button between the
    // episode rail and the dropdown.
    picker.insertAdjacentElement('afterend', button);
  }
}

function setDetailCopy(text) {
  detailCopy.textContent = text;
  detailCopy.classList.toggle('is-collapsed', text.length > 280);
  const toggle = $('#detail-copy-toggle');
  toggle.hidden = text.length <= 280;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = 'Show more';
}

function openDetail(meta) {
  if (!ratingAllowed(meta.contentRating)) return showToast('This title is not available for this profile.', 'error');
  state.selected = meta;
  $('#detail-verification')?.replaceChildren();
  state.selectedEpisode = null;
  clearEpisodeControls();
  detailTitle.textContent = meta.name;
  detailYear.textContent = meta.releaseInfo;
  setDetailCopy(meta.description || 'Open this title to check available streams.');
  setBackground(detailArt, meta.background || meta.poster);
  const source = sourceLabel(meta);
  detailSource.hidden = !source;
  detailSource.textContent = source;
  const sourceOnly = isMwp(meta);
  detailPlay.hidden = sourceOnly;
  detailPlay.disabled = true;
  $('#detail-streams').replaceChildren();
  
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

  // A CATALOG META IS NOT ENOUGH TO FILL THIS PANEL. Only 129 of 300 carry a
  // description and none carries a trailer, so a title opened straight from a
  // poster - without dwelling on it first - showed "Open this title to check
  // available streams." and no trailer. Same cached fetch the card uses; if the
  // dialog moved on in the meantime the result is dropped.
  const fullMeta = fetchFullMeta(meta, true).then((full) => {
    if (!full || state.selected !== meta) return;
    mergeFullMeta(meta, full);
    if (!ratingAllowed(meta.contentRating)) {
      closeDetail();
      showToast('This title is not available for this profile.', 'error');
      return;
    }
    if (meta.description) setDetailCopy(meta.description);
    setBackground(detailArt, meta.background || meta.poster);
    renderRatingChips(meta);
    renderEpisodeControls(meta);
    return full;
  });
  telemetry('nav_action', { action: 'open_detail', from: state.route || 'home' });

  // An Emby title is not in the addon catalog, so /stream/<type>/emby:<id>.json
  // is a guaranteed 404. Asking anyway would spin the streams panel and then
  // report "no sources" for something that plays perfectly.
  fullMeta.finally(() => {
    if (state.selected !== meta || !ratingAllowed(meta.contentRating)) return;
    detailPlay.disabled = false;
    startDetailTrailer(meta);
    if (meta.embyId) {
    $('#detail-streams').innerHTML = '';
    detailStatus.textContent = 'On the Emby server. Press Play.';
    } else if (!sourceOnly) {
      renderEpisodeControls(meta);
      loadStreams(meta);
    } else {
    $('#detail-streams').innerHTML = '';
    }
  });
  if (!sourceOnly) detailStatus.textContent = meta.type === 'series' ? 'Loading episodes…' : 'Loading title…';
}

function closeDetail() {
  if (detailDialog.open && typeof detailDialog.close === 'function') detailDialog.close();
  else detailDialog.removeAttribute('open');
  stopDetailTrailer();
  state.selected = null;
  state.selectedEpisode = null;
  clearEpisodeControls();
  $('#detail-streams').innerHTML = '';
  $('#detail-verification')?.replaceChildren();
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

/**
 * A dub in a language nobody in this house reads — the FALLBACK test, used only
 * when caps.js did not load. caps.js has the real one (see marker() there).
 *
 * IT USED TO BE A BARE SUBSTRING and that was a live bug, not a tidy-up:
 * `/rus|russian|ita|italian|latino|french/` is TRUE of any title containing
 * "DIGITAL" — d-i-g-**ita**-l — because "ita" is in it. AMZN and iTunes WEB-DL
 * releases say DIGITAL constantly, so a large slice of the best English rows in
 * every list were being pushed to the bottom as foreign dubs. `/rus/` does the
 * same to "Rust" and "Crusade".
 *
 * The delimiter class is spelled out rather than using `\b`, for the reason
 * caps.js's marker() gives at length: `_` is a word character, so `\b` finds no
 * boundary in `Some_Film_2026_ITA_1080p` and matches nothing at all there.
 * Anything that is not a letter or a digit is a delimiter; a letter or a digit
 * is not.
 */
const FOREIGN_DUB = /(?:^|[^a-z0-9])(?:rus|russian|ita|italian|latino|french|dublado|hindi|tamil|telugu)(?:[^a-z0-9]|$)/i;

let streamsRequest = 0;
const sampledStreams = new WeakSet();
function rememberSampledStreams(result) {
  for (const stream of result.streams) {
    if (window.BlazingStreamEvidence?.inspected(stream, result.verification, result.preferences)) sampledStreams.add(stream);
  }
}

async function loadStreams(meta) {
  const request = ++streamsRequest;
  const contentId = state.selected === meta && state.selectedEpisode
    ? state.selectedEpisode.id : meta.id;
  const isCurrent = () => request === streamsRequest && state.selected === meta
    && (state.selectedEpisode?.id || meta.id) === contentId && detailDialog.open;
  const container = $('#detail-streams');
  container.innerHTML = '';
  $('#detail-verification')?.replaceChildren();
  resetQualitySelect();
  if (isMwp(meta)) return;

  detailStatus.textContent = 'Loading streams...';
  try {
    // `let`, because the capability filter below replaces this list with the
    // rows this device can actually decode.
    const result = await resolveStreams(meta, contentId);
    let streams = result.streams;
    if (!isCurrent()) return;
    window.BlazingStreamEvidence?.render($('#detail-verification'), result.verification, result.preferences);
    rememberSampledStreams(result);
    if (!streams.length) {
      detailStatus.textContent = 'No compatible stream available.';
      return;
    }

    // A link marked dead by a long-press sinks to the bottom, and so does a
    // dub in a language nobody here reads.
    const isDead = deadLinkProbe();
    const deadLinks = streams.filter((stream) => isDead(stream.url)).map((stream) => stream.url);

    // WHAT THIS DEVICE CAN ACTUALLY DECODE, asked at runtime, then used to
    // filter and to order. Markus, letter C: "based on the device and what that
    // device can handle will the selected sources play. the souce lists gets
    // filtered based on audio/video quality mainly. always the best for that
    // specfic device."
    //
    // The three lines this replaces were the entire ranking this client had:
    // a 1000-point penalty for a dead link, a 100-point one for a foreign dub,
    // and nothing else. So a 4K HEVC remux led the list on every browser
    // including the ones with no HEVC decoder in them at all — measured today,
    // headless Chromium 147 answers `supported:false` for HEVC at BOTH 1080p and
    // 2160p — and clicking it produced a spinner that never resolved, with no
    // error, because a <video> given a codec it cannot decode simply never
    // reaches readyState 1. That row is now gone rather than first.
    //
    // BlazingCaps is a separate probe file for the same reason DeviceCaps.brs
    // and StreamRanker.brs are separate from the Roku's screens: the rules are
    // the same rules on all six clients, and they are easier to keep in step
    // when each client's copy is one readable file rather than an inline sort.
    //
    // It degrades. caps.js may not have loaded (the service worker's SHELL list
    // has been wrong before — see sw.js), so a missing window.BlazingCaps keeps
    // the old dead-link/dub ordering and shows every row. A capability filter
    // that takes the source list down when it fails is worse than no filter.
    let ranked = null;
    if (window.BlazingCaps) {
      const caps = await window.BlazingCaps.probe();
      if (!isCurrent()) return;
      ranked = window.BlazingCaps.rankStreams(streams, caps, { deadLinks, inspected: (stream) => sampledStreams.has(stream) });
      streams = ranked.streams.map((info) => info.raw);
      if (!streams.length) {
        // Every row was rejected. Say WHICH ceiling did it, because "no
        // compatible stream" on a screen full of results is the message that
        // makes someone reinstall the app.
        detailStatus.textContent = describeAllRejected(ranked, caps);
        return;
      }
    } else {
      const penaltyOf = (s) => {
        if (deadLinks.includes(s.url)) return 1000;
        const blob = `${s.name || ''} ${s.title || ''}`.toLowerCase();
        return FOREIGN_DUB.test(blob) ? 100 : 0;
      };
      streams.sort((a, b) => penaltyOf(a) - penaltyOf(b));
    }

    detailStatus.textContent = '';
    // The dropdown is filled from the meta's streamsByQuality when the backend
    // supplies one, and otherwise from the qualities actually present in this
    // list. Deriving it is what makes the control work today: streamsByQuality
    // is part of the undeployed addon commit and is absent from every response.
    fillQualitySelect(meta, streams);

    // The count, and what the device threw away. Not decoration: the list used
    // to be the raw addon response, so a viewer who counted 400 results
    // yesterday and 260 today needs to know a probe did that on purpose.
    if (ranked && ranked.dropped.total) container.appendChild(buildFilterNote(ranked));

    for (const s of streams) {
      const row = el('div', 'stream-row');
      row.dataset.quality = qualityOf(s);
      if (deadLinks.includes(s.url)) row.classList.add('dead');

      const label = sampledStreams.has(s) ? qualityOf(s) : plainText(s.name, 'SD').replace(/[✓✔✅]\s*/g, '');
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
      // A word, not a person emoji: emoji render at a different size and weight
      // per operating system, so this line jumped around between machines while
      // the size beside it did not.
      seeders.textContent = seedMatch ? `${seedMatch[1]} seeders` : '';
      metaLine.append(size, seeders);
      info.append(qualityLine, titleLine, metaLine);
      const sample = window.BlazingStreamEvidence?.description(s, result.verification, result.preferences);
      if (sample) {
        const proof = el('p', 'stream-sample-proof'); proof.textContent = sample; info.append(proof);
      }
      row.appendChild(info);

      row.addEventListener('click', () => {
        // No URL here — rule 6. The host and the resolution are what make
        // v_source_health useful; the link itself is exactly what must not go.
        telemetry('play_start', {
          id: meta.id, title: meta.name, type: meta.type,
          source: String(s._from || '').replace(/^site:/, ''),
          res: Number((qualityOf(s).match(/\d+/) || [0])[0]) || 0,
        });
        openPlayer(meta.name, s.url);
        closeDetail();
      });

      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        if (!deadLinks.includes(s.url)) deadLinks.push(s.url);
        markDeadLink(s.url);
        row.classList.add('dead');
        container.appendChild(row); // move to bottom
      });

      container.appendChild(row);
    }
  } catch (err) {
    if (!isCurrent()) return;
    const retryable = !err.status || err.status === 408 || err.status === 429 || err.status >= 500;
    detailStatus.textContent = retryable
      ? 'Sources did not load. Try again.'
      : 'Sources are not available for this title.';
    if (retryable) {
      const retry = el('button', 'secondary-button');
      retry.type = 'button';
      retry.textContent = 'Retry sources';
      retry.addEventListener('click', () => {
        if (!isCurrent()) return;
        retry.disabled = true;
        loadStreams(meta);
      });
      container.replaceChildren(retry);
    }
    telemetry('error', { where: 'app.loadStreams', code: 'fetch', message: String((err && err.message) || err).slice(0, 200) });
  }
}

async function resolveStreams(meta, contentId = meta.id) {
  const preferences = window.BlazingStreamPreferences?.current()
    || { profileId: state.profileId, audio: 'english', subtitles: 'english' };
  if (!state.profileId || preferences.profileId !== state.profileId) throw new Error('Choose a profile first.');
  const query = window.BlazingStreamPreferences?.query() || 'audio=en&sub=en';
  const data = await fetchJSON(
    `${API_BASE}/stream/${encodeURIComponent(meta.type)}/${encodeURIComponent(contentId)}.json?${query}`
  );
  return { streams: Array.isArray(data.streams) ? data.streams : [], verification: data.verification, preferences };
}

/**
 * The one line under the source list saying what the probe removed.
 *
 * WHY IT IS VISIBLE AT ALL. The list was the raw addon response until today, so
 * the number of rows is something people have already learned to read. Cutting
 * it silently — even cutting it correctly — looks like the app got worse. The
 * Roku picker prints the same thing ("n hidden by your filters") for the same
 * reason, and this is the browser's copy of it.
 *
 * Built from nodes and textContent, never innerHTML. Nothing here is
 * attacker-controlled today, but every other row in this panel is built that
 * way because `s.title` comes from an arbitrary third-party Stremio addon, and
 * a sibling that does it differently is how the exception gets copied.
 */
function buildFilterNote(ranked) {
  const d = ranked.dropped;
  const parts = [];
  if (d.nourl) parts.push(`${d.nourl} with no direct link`);
  if (d.res) parts.push(`${d.res} above this screen`);
  if (d.codec || d.codec4k) parts.push(`${d.codec + d.codec4k} this browser cannot decode`);
  // SOUND, said out loud. caps.js removes any source whose only audio track is
  // Dolby or DTS, because this browser has no decoder for those and the row
  // plays a perfect picture in total silence — readyState 4, no error event,
  // nothing downstream able to catch it. That gate removed 111 of 324 rows on a
  // real title the day it landed, and without this line the panel said "165 of
  // 324 match" and explained only 48 of the 159 it had cut. Hiding something
  // without naming it is the exact failure this whole function exists to
  // prevent, so a new gate has to arrive here in the same commit or the note
  // starts lying by omission.
  if (d.audio) parts.push(`${d.audio} with sound this browser cannot play`);
  if (d.size) parts.push(`${d.size} too large for this connection`);
  const note = el('div', 'stream-note');
  note.textContent = `${ranked.streams.length} of ${ranked.total} sources match this device’s format limits` +
    (parts.length ? ` — hidden: ${parts.join(', ')}.` : '.');
  return note;
}

/**
 * Everything was rejected. Name the ceiling that did it.
 *
 * "No compatible stream available" was the old message and it is the one that
 * makes somebody reinstall the app, because it reads as "there are no sources"
 * when what happened is "there are 400 sources and every one of them is 4K HEVC
 * and this browser has no HEVC decoder". That is a real shape, not a
 * hypothetical: it is exactly what headless Chromium 147 reports, and Firefox on
 * Linux answers the same.
 */
function describeAllRejected(ranked, caps) {
  const d = ranked.dropped;
  if (d.codec || d.codec4k) {
    return `All ${ranked.total} sources for this title use a codec this browser ` +
      `cannot decode. Safari and Edge open HEVC; Chrome and Firefox often do not.`;
  }
  // Reachable only if the safe fallback in rankStreams did NOT fire — it
  // readmits silent rows, marked, when removing them would leave nothing. So if
  // this branch is ever hit, something else also rejected the readmitted rows.
  if (d.audio) {
    return `All ${ranked.total} sources for this title carry only Dolby or DTS sound, ` +
      `which this browser cannot decode. Safari on a Mac or an Apple TV plays these; ` +
      `Chrome and Firefox do not.`;
  }
  if (d.res) return `All ${ranked.total} sources are above this screen's ${caps.maxHeight}p.`;
  if (d.size) return `All ${ranked.total} sources are too large for this connection.`;
  if (d.nourl) return `None of the ${ranked.total} sources carry a direct link a browser can open.`;
  return 'No compatible stream available.';
}

let playRequest = 0;
async function playSelected() {
  const meta = state.selected;
  if (!meta) return;
  const request = ++playRequest;
  const profileId = state.profileId;
  let contentId = null;
  const isCurrent = () => request === playRequest && state.selected === meta && profileId === state.profileId
    && (!contentId || (state.selectedEpisode?.id || meta.id) === contentId) && detailDialog.open;
  await fetchFullMeta(meta, true);
  if (!isCurrent() || !ratingAllowed(meta.contentRating)) return;
  contentId = state.selectedEpisode?.id || meta.id;
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
    if (!isCurrent()) return;
    if (!edu) {
      detailStatus.textContent = 'This lesson could not be opened. The video ' +
        'resolver on the server did not answer.';
      return;
    }
    openPlayer(meta.name, edu.url, { streamFormat: edu.streamFormat });
    closeDetail();
    return;
  }
  detailStatus.textContent = 'Checking direct streams…';
  try {
    const result = await resolveStreams(meta, contentId);
    let streams = result.streams;
    if (!isCurrent()) return;
    rememberSampledStreams(result);
    const isDead = deadLinkProbe();
    const deadLinks = streams.filter((stream) => isDead(stream.url)).map((stream) => stream.url);

    // THE SAME RANKING THE LIST USES, and that is the whole point of the change.
    // Play and the source list were two separate sorts before this: the list
    // ordered by dead-link and dub penalty, Play took the first row with an
    // https url. So the row shown at the top and the row Play started could be
    // different files, and neither was chosen for what this device can decode.
    // StreamRanker.brs records the same bug on the Roku from the other side —
    // 4K passed the filter on the 4K set and still ranked below 1080p, "so
    // auto-play never chose it" — which is why the filter and the scoring have
    // to be one function with one caller here too.
    if (window.BlazingCaps) {
      const caps = await window.BlazingCaps.probe();
      if (!isCurrent()) return;
      streams = window.BlazingCaps.rankStreams(streams, caps, { deadLinks, inspected: (stream) => sampledStreams.has(stream) }).streams.map((i) => i.raw);
    } else {
      const getPenalty = (s) => {
        if (deadLinks.includes(s.url)) return 1000;
        let p = 0;
        const b = (s.name + ' ' + (s.title || '')).toLowerCase();
        if (FOREIGN_DUB.test(b)) p += 100;
        return p;
      };
      streams.sort((a, b) => getPenalty(a) - getPenalty(b));
    }
    const playable = streams.find((stream) => stream && safeHttpsUrl(stream.url) && !deadLinks.includes(stream.url)) || streams.find((stream) => stream && safeHttpsUrl(stream.url));
    if (!playable) {
      detailStatus.textContent = isMwp(meta)
        ? 'This source page has no verified direct stream for this device yet.'
        : 'No compatible direct stream is available right now.';
      return;
    }
    openPlayer(meta.name, playable.url);
    closeDetail();
  } catch {
    if (!isCurrent()) return;
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
  window.BlazingStreamPreferences?.resetPlayer();
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
    window.BlazingStreamPreferences?.bindPlayer(video);
    return '';
  }
  if (window.Hls && window.Hls.isSupported()) {
    return attachViaHlsJs(url);
  }
  if (nativeHlsOnly()) {
    video.src = url;
    video.load();
    window.BlazingStreamPreferences?.bindPlayer(video);
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
  window.BlazingStreamPreferences?.bindPlayer(video, hls);
  return '';
}

function openPlayer(title, rawUrl, opts) {
  window.BlazingMediaLibrary?.pause();
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
  const profileId = state.profileId;
  if (profileId && state.selected?.id) {
    fetch(`${API_BASE}/api/sync/progress/${state.selected.id}?profileId=${profileId}`)
      .then(r => r.json())
      .then(d => {
        if (session !== playSession || profileId !== state.profileId) return;
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
  ++playSession;
  clearPlayerWatchdog();
  stopSync();
  destroyHls();
  $('#resume-btn').hidden = true;
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
/* THREE INDEPENDENT BUGS KEPT THIS ROW OFF THE SCREEN, and it has never once
   drawn. All three are fixed below; each on its own was enough.

   1. THE WRONG BACKEND. This asked the ADD-ON
      (addon.lyreosai.com/api/sync/progress/recent). The real history lives on
      the FLEET at GET /profiles/:id/progress — that is what the Roku reads and
      writes, and it is the store with the posters and the resume points in it.
      The add-on's store holds metadata-free rows: saveProgress (blazing-addon
      lib/sync_store.js:22) persists {imdbId, position, duration, profileId,
      deviceId, updatedAt} and nothing else — no name, no poster, no type.
   2. THE WRONG KEY. It read `data.items`. The add-on answers `{entries: [...]}`
      (blazing-addon server.js:2417) and the fleet answers
      `{progress: {items: [...]}}` (blazing-fleet server.js:1072). `data.items`
      is undefined on both, so the `if` was never once true. Measured live
      2026-09-06: GET /api/sync/progress/recent?profileId=test -> {"entries":[]}.
   3. THE WRONG ID FIELD. An add-on entry carries `imdbId`, and safeMeta() drops
      any object with no `id`. So even past bug 2 the row would have built zero
      cards.

   The fleet is asked first and the add-on is the fallback, because their
   payloads are not equal: a fleet item already carries name, poster, background
   and a 0-100 percentage (sanitizeProgressPayload, blazing-fleet
   profiles.js:552), while an add-on entry carries an id and two numbers and has
   to be filled in from /meta/ one title at a time — which is exactly what the
   Roku does with the same rows (AddonTask.brs:176 GetMeta per entry). */
const PROFILE_DEVICE_KEY = 'blazing-web-profile-device-v1';

/**
 * The fleet's own device credential, written by profile.js on registration.
 *
 * Read straight out of localStorage rather than through BlazingProfile: that
 * module exposes only open()/isOpen()/mediaRequest(), and mediaRequest is
 * hard-restricted to /media/* paths, so there is no way to ask it for
 * /profiles/:id/progress today. See notesForOwner — a BlazingProfile.fleetGet()
 * would be the cleaner home for this.
 */
function storedDeviceCredentials() {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILE_DEVICE_KEY) || 'null');
    if (!value || typeof value !== 'object') return null;
    const id = plainText(value.id);
    const token = plainText(value.token);
    return id && token ? { id, token } : null;
  } catch {
    return null;
  }
}

/**
 * One history row, in the one shape this file draws: a meta buildCard()
 * understands, plus the percentage the bar needs.
 *
 * `percent` is null, never 0, when the store does not know — a NaN or missing
 * width renders as a FULL bar, which is the same trap the old row bar and the
 * hero band both carry a comment about.
 */
function progressRowEntry(meta, percent, updatedAt) {
  if (!meta) return null;
  const pct = Number(percent);
  return {
    meta,
    percent: Number.isFinite(pct) && pct > 0 ? Math.max(0, Math.min(100, pct)) : null,
    updatedAt: Number(updatedAt) || 0,
  };
}

/** `tt0903747:5:14` is an episode of `tt0903747`, and it is a series. */
function progressTitleId(rawId, rawType) {
  const id = plainText(rawId);
  if (!id) return null;
  const parts = id.split(':');
  // kitsu:41370:12 is the same shape but its ROOT is two segments, not one.
  if (/^kitsu:\d+:\d+$/.test(id)) return { id: parts.slice(0, 2).join(':'), type: 'series' };
  if (parts.length >= 3) return { id: parts[0], type: 'series' };
  const type = plainText(rawType).toLowerCase();
  return { id, type: type === 'series' || type === 'tv' ? 'series' : 'movie' };
}

/**
 * THREE payload shapes, one reader. Same call profile.js's progressItems()
 * makes, and for the same reason — these stores have never agreed:
 *
 *   {progress: {items: [...]}}   the fleet   (blazing-fleet server.js:1072)
 *   {entries: [...]}             the add-on  (blazing-addon server.js:2417)
 *   {items: [...]}               the first fleet contract, still answered by
 *                                older builds and by the repo's own fixtures
 *
 * A bare array is accepted too, because that is what sanitizeProgressPayload
 * itself takes as input and one day something will hand it straight back.
 */
function progressItemsOf(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (body.progress && Array.isArray(body.progress.items)) return body.progress.items;
  if (Array.isArray(body.entries)) return body.entries;
  if (Array.isArray(body.items)) return body.items;
  return [];
}

/**
 * One stored row -> one drawable entry, whichever store it came from.
 *
 * `id` OR `imdbId`: the add-on writes imdbId (lib/sync_store.js:25) and
 * safeMeta() drops any object with no `id`, which is bug 3 above.
 *
 * The percentage is read from whichever of the THREE forms the store keeps, and
 * they are genuinely all in use:
 *
 *   progress: 62                    the fleet's own 0-100 integer, with no
 *                                   duration anywhere in the record
 *                                   (blazing-fleet profiles.js:557)
 *   position / duration             seconds, flat on the row — what the add-on
 *                                   persists (blazing-addon sync_store.js:25)
 *                                   and what THIS file POSTs in startSync()
 *   progress: {position, duration}  seconds, nested; the shape the older TV
 *                                   clients wrote and the shape this repo's own
 *                                   fixtures still send
 *
 * A zero or missing duration is the store saying it does not know how long the
 * title is, not "0% watched" — a bar of NaN width renders as a FULL one.
 */
function progressPercentOf(raw) {
  const nested = raw.progress && typeof raw.progress === 'object' ? raw.progress : null;
  const seconds = nested || raw;
  const duration = Number(seconds.duration);
  if (duration > 0) return (Number(seconds.position) / duration) * 100;
  const stated = Number(raw.progress);
  return Number.isFinite(stated) && stated > 0 ? stated : null;
}

function progressEntryOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const root = progressTitleId(raw.id || raw.imdbId, raw.type);
  if (!root) return null;
  const percent = progressPercentOf(raw);
  const entry = progressRowEntry(
    safeDiscoverMeta({ ...raw, id: root.id, type: root.type }),
    percent,
    raw.updatedAt,
  );
  // An add-on row is nothing but an id and two numbers, so it has no name and
  // no poster and cannot be drawn as it stands. The Roku fills exactly these in
  // the same way, one GetMeta per entry (AddonTask.brs:176).
  if (entry && (!entry.meta.poster || !entry.meta.name || entry.meta.name === 'Untitled')) entry.needsMeta = true;
  return entry;
}

async function progressFrom(url, options) {
  const entries = progressItemsOf(await fetchJSON(url, options)).map(progressEntryOf).filter(Boolean);
  // Only the rows that arrived bare cost a lookup, and fetchFullMeta caches.
  // A title it cannot resolve is dropped rather than drawn as a grey rectangle
  // with no name on it.
  const filled = await Promise.all(entries.map(async (entry) => {
    if (!entry.needsMeta) return entry;
    const full = await fetchFullMeta({ id: entry.meta.id, type: entry.meta.type });
    return full ? { ...entry, meta: full } : null;
  }));
  return filled.filter(Boolean);
}

function fleetProgressEntries(profileId) {
  const credentials = storedDeviceCredentials();
  if (!credentials) return Promise.resolve([]);
  return progressFrom(
    `${FLEET_BASE}/profiles/${encodeURIComponent(profileId)}/progress`
      + `?deviceId=${encodeURIComponent(credentials.id)}`,
    { headers: { 'X-Device-Token': credentials.token } },
  );
}

function addonProgressEntries(profileId) {
  return progressFrom(`${API_BASE}/api/sync/progress/recent?profileId=${encodeURIComponent(profileId)}`);
}

async function loadContinueWatching(explicitProfileId, request = homeRequest) {
  const profileId = explicitProfileId || state.profileId;
  if (!profileId) return;
  try {
    // Settled, not raced: the fleet is the source of truth, and the add-on only
    // gets to fill an EMPTY row. Merging the two would double every title the
    // Roku has written to both.
    let entries = await fleetProgressEntries(profileId).catch(() => []);
    if (!entries.length) entries = await addonProgressEntries(profileId).catch(() => []);
    if (request !== homeRequest || profileId !== state.profileId) return;
    // Newest first. The fleet stores insertion order and does not sort (its own
    // getProgress comment says so), so recency is this client's decision — the
    // same call profile.js makes for the gate artwork.
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    if (entries.length) {
      const section = buildRowSkeleton({ id: 'continue-watching', name: 'Continue Watching', type: 'mixed' });
      section.dataset.rowId = 'continue-watching';
      // Exactly ONE of these, ever. boot() and the profile-selected listener can
      // both reach here in a single session, and a second prepend would stack a
      // second Continue Watching on top of the first.
      const stale = rowsWrap.querySelector('[data-row-id="continue-watching"]');
      if (stale) stale.remove();
      rowsWrap.prepend(section);
      const track = $('.row-track', section);
      // The percentage travels BESIDE the meta, not inside it. safeMeta() is an
      // allow list and no progress field is on it, so anything folded into the
      // meta is silently dropped — which is how the row whose whole job is to
      // show how far you got once showed no position at all. Widening the allow
      // list would change every other caller's shape; this does not.
      const pairs = entries.filter((pair) => pair.meta && ratingAllowed(pair.meta.contentRating));
      if (!pairs.length) { section.remove(); return; }
      const metas = pairs.map((pair) => pair.meta);
      track.replaceChildren(...pairs.map(({ meta, percent }) => {
        const c = buildCard(meta);
        // null, not 0, when the store does not know — see progressRowEntry.
        if (percent !== null) {
          const bar = document.createElement('div');
          bar.className = 'progress-bar';
          bar.innerHTML = `<div class="progress-fill" style="width: ${percent}%"></div>`;
          c.appendChild(bar);
        }
        return c;
      }));
      // Continue Watching was the ONE card-building path in this file that never
      // called this, so the row could never carry .row-hero and its posters never
      // expanded or played a trailer — while the identical titles one row down,
      // in Trending, did. Markus, 2026-08-30: "embry continue watching all the
      // posters. even when you search for the movie."
      claimHeroRow(section, metas);

      // AND IT IS WHAT THE BAND AT THE TOP SHOWS. Markus, 2026-09-03: "i
      // absolutly love how on the home page the continue watching fills the
      // whole screen." Priority 2 beats the 1 claimHeroRow hands out, so the
      // title you were part-way through wins the band however the race between
      // this call and the catalog shelves happens to finish — and it carries the
      // resume position with it, which is the one thing a Featured row cannot.
      const first = pairs[0];
      if (first) {
        seedHomeHero(first.meta, {
          priority: 2,
          eyebrow: 'Continue watching',
          percent: first.percent,
        });
      }
    }
  } catch (e) {}
}


let syncInterval = null;

function startSync(meta) {
  stopSync();
  syncInterval = setInterval(() => {
    if (!video.duration || video.paused) return;
    const profileId = state.profileId;
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
  if (sampledStreams.has(stream)) {
    return ({ '2160p': '4K', '1080p': '1080p', '720p': '720p', '480p': 'SD' })[stream._verified.quality] || 'Other';
  }
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
let detailTrailerDestroy = null;

/**
 * Autoplay the trailer muted behind the title, with a mute toggle.
 *
 * Muted is not a preference, it is the only way a browser will autoplay at all;
 * an unmuted autoplay is rejected and leaves a dead black box. The toggle is
 * how the user opts in to sound, which is also the gesture the browser wants.
 */
async function startDetailTrailer(meta) {
  stopDetailTrailer();
  const host = $('#detail-trailer');
  if (!host || !meta) return;
  // Was `!meta.trailerUrl`, which nothing has ever set, so this returned on
  // every title ever opened and the detail trailer has never once played.
  // Same resolve the cards use: our own /proxy/yt-resolve, never a YouTube embed.
  const url = await resolveTrailerUrl(meta);
  if (!url) return;
  // The dialog may have been closed, or moved to another title, while yt-dlp ran.
  if (state.selected !== meta) return;
  const made = makeTrailerVideo(url);
  const video = made.video;
  detailTrailerDestroy = made.destroy;

  const toggle = el('button', 'detail-mute-btn');
  toggle.type = 'button';
  // Inline SVG, not 🔇/🔊. This app already draws every other control with an
  // inline svg under .icon-button; an emoji here inherited the platform's
  // colour font, so it stayed blue-and-white on the accent and could not be
  // themed at all.
  const SPEAKER = '<path d="M4 9v6h4l5 4V5L8 9H4z"/>';
  const MUTED_MARK = '<path d="M16 9l5 5m0-5l-5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>';
  const WAVES = '<path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>';
  const speakerIcon = (isMuted) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">${SPEAKER}${isMuted ? MUTED_MARK : WAVES}</svg>`;
  toggle.innerHTML = speakerIcon(true);
  toggle.setAttribute('aria-label', 'Unmute trailer');
  let muted = true;
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    muted = !muted;
    video.muted = muted;
    toggle.innerHTML = speakerIcon(muted);
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
  // The hls.js instance goes too, not just the element - a detached one keeps
  // pulling segments for as long as the tab is open.
  if (detailTrailerDestroy) { try { detailTrailerDestroy(); } catch (e) {} detailTrailerDestroy = null; }
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

async function appendEmbyRow(title, type, load, request = homeRequest) {
  let items;
  try { items = await load(); } catch { return; }
  if (request !== homeRequest) return;
  const metas = items.map(embyMeta).filter(Boolean)
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
function loadEmbyRows(request = homeRequest) {
  if (!window.BlazingEmby) return;
  appendEmbyRow('Emby · Latest Movies', 'movie', () => window.BlazingEmby.latest('movie', 12), request);
  appendEmbyRow('Emby · Latest Shows', 'series', () => window.BlazingEmby.latest('series', 12), request);
  appendEmbyRow('Emby · Live TV', 'tv', () => window.BlazingEmby.livetv(12), request);
}

/**
 * The rest of the Emby server — Home's three rows above are a "what's new"
 * teaser (12 items, no paging). This is the real library: 1,139 movies and
 * 693 series measured live against Killah.TV, reachable nowhere else in this
 * client until tonight.
 */
const embyBrowseState = { type: 'movie', sort: 'added', skip: 0, total: 0, loading: false };
let embyRequest = 0;

async function loadEmbyPage(reset) {
  if (!window.BlazingEmby || (embyBrowseState.loading && !reset)) return;
  const request = ++embyRequest;
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
  if (request !== embyRequest) return;
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

/* ---- The returning viewer -------------------------------------------------

   `localStorage.profileId` has been written on every profile pick since this
   listener was written, and NOTHING HAS EVER READ IT BACK. profile.js only ever
   removes it (twice, on sign-out). So an approved household browser re-picked a
   profile on every single page load, and every load started with no cap, no
   list and no history.

   What is restored, and what deliberately is not:

     RESTORED  the id, the rating cap, and My List — enough to draw the right
               home for the right viewer at first paint.
     NOT       `unlocked`, and never an unlockable profile. A PIN is answered by
               a person, not by localStorage; `detail.unlocked` is true only
               when a PIN was actually entered (profile.js builds it from a live
               unlock token), so it is exactly the flag that says "this one must
               be asked again".
     NOT       an adult-enabled profile. The Roku's adultAllowedNow() refuses to
               act on anything but a live, unexpired, same-profile unlock token;
               a stored snapshot is none of those things.
     NOT       state.mediaProfile. Books/Music/Podcasts and the manga reader go
               through BlazingProfile.mediaRequest(), which needs the live
               device credentials and unlock token that only profile.js holds.
               Leaving it null is what keeps a restored session from *looking*
               connected to a subsystem that would then 403.

   profile.js still opens its gate on every load — that is its own deliberate
   rule and its file is not ours to change. The difference this makes is that
   the home behind the gate is already the returning viewer's home, and a
   profile that has since been deleted or PIN-locked simply never restores: the
   pick that follows overwrites all of it anyway. */
const PROFILE_SESSION_KEY = 'blazing-web-profile-session-v1';
// A month. Long enough that a household TV-like browser never re-picks in
// normal use, short enough that a shared or borrowed machine forgets.
const PROFILE_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function rememberProfileSession(detail) {
  try {
    localStorage.setItem(PROFILE_SESSION_KEY, JSON.stringify({
      id: String(detail.id),
      maxRating: String(detail.maxRating || 'general').toLowerCase(),
      isKids: detail.isKids === true,
      // Recorded so the restore can refuse. See the note above: true here means
      // a human answered a PIN for this profile, so a human has to answer again.
      neededPin: detail.unlocked === true,
      allowAdult: detail.allowAdult === true,
      savedAt: Date.now(),
    }));
  } catch {
    // Storage can be blocked or full. A browser that cannot remember simply
    // picks again, which is exactly today's behaviour.
  }
}

function forgetProfileSession() {
  try {
    localStorage.removeItem(PROFILE_SESSION_KEY);
    localStorage.removeItem('profileId');
  } catch {
    // Nothing useful to remove from a blocked storage area.
  }
}

function restoreProfileSession() {
  let stored = null;
  try {
    if (localStorage.getItem('blazing-signed-out-v1') === '1') return false;
    if (!localStorage.getItem('blazing-household-approved')) return false;
    stored = JSON.parse(localStorage.getItem(PROFILE_SESSION_KEY) || 'null');
  } catch {
    return false;
  }
  if (!stored || typeof stored !== 'object') return false;
  const id = plainText(stored.id);
  if (!id) return false;
  // A CAP OF 'adult' IS REFUSED FOR THE SAME REASON allowAdult IS. Measured on
  // this restore before the check existed: a snapshot of {maxRating: 'adult',
  // allowAdult: false} drew an adult-rated catalog card onto the home behind
  // the gate, with nobody yet identified — 1 card, which is exactly the shape
  // home-profile.smoke.mjs:91 exists to keep off that screen. The two fields
  // are not one flag: allowAdult opens the adult SECTIONS, while maxRating
  // 'adult' is what ratingAllowed() reads to let an adult-rated item through
  // any ordinary shelf, and only the first was being refused. profile.js
  // already treats them as equals for the same reason it hides the artwork
  // (`artRestricted`, profile.js:185, is `allowAdult === true || maxRating
  // === 'adult'`); this now matches it.
  if (stored.neededPin === true || stored.allowAdult === true) return false;
  if (String(stored.maxRating || '').toLowerCase() === 'adult') return false;
  const age = Date.now() - Number(stored.savedAt || 0);
  if (!Number.isFinite(age) || age < 0 || age > PROFILE_SESSION_MAX_AGE_MS) return false;
  // An unrecognised tier is not a reason to guess upward. RATINGS is the whole
  // vocabulary; anything else caps at 'general', which is what a null cap does.
  const cap = String(stored.maxRating || '').toLowerCase();
  state.profileCap = RATINGS.includes(cap) ? cap : 'general';
  state.profileIsKids = stored.isKids === true;
  state.profileId = id;
  state.myList = readList(id);
  updateSaveLabels();
  renderLibrary();
  return true;
}

// One profile change owns the list, cap, history and all Home shelves. Persisted
// approval says which brand to show; it is never a reason to skip this refresh.
document.addEventListener('blazing-profile-selected', (event) => {
  const detail = (event && event.detail) || {};
  if (!detail.id) return;
  stopSync();
  if (!player.hidden) closePlayer();
  if (detailDialog.open) closeDetail();
  state.profileId = String(detail.id);
  state.mediaProfile = { ...detail };
  state.profileCap = detail.maxRating || 'general';
  state.profileIsKids = detail.isKids === true;
  state.myList = readList(state.profileId);
  state.selected = null;
  state.selectedEpisode = null;
  localStorage.setItem('profileId', state.profileId);
  localStorage.setItem('blazing-household-approved', '1');
  rememberProfileSession(detail);
  updateSaveLabels();
  renderLibrary();
  // Search and discovery were filtered for the previous viewer.
  ++searchRequest;
  ++discoverRequest;
  clearSearchResults();
  discoverResults.replaceChildren();
  if ($('#emby-view').dataset.loaded === 'true') loadEmbyPage(true);
  boot();
});

document.addEventListener('blazing-profile-unlock-expired', () => {
  state.mediaProfile = null;
  clearSearchResults();
});

document.addEventListener('blazing-profile-signed-out', () => {
  ++homeRequest;
  ++searchRequest;
  ++discoverRequest;
  ++embyRequest;
  embyBrowseState.loading = false;
  stopSync();
  closePlayer();
  closeDetail();
  resetHomeHero();
  state.profileId = null;
  state.mediaProfile = null;
  state.profileCap = null;
  state.profileIsKids = false;
  state.myList = [];
  state.selected = null;
  state.selectedEpisode = null;
  state.catalogs = [];
  // Signing out has to take the remembered session with it, or the very next
  // load restores the viewer who just left.
  forgetProfileSession();
  rowsWrap.replaceChildren();
  clearSearchResults();
  discoverResults.replaceChildren();
  $('#emby-results').replaceChildren();
  renderLibrary();
  updateSaveLabels();
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
  // An <img>, like every other card builder here — buildCard(), the comics
  // shelf and manga.js all use one. This was the ONE builder that painted its
  // poster as a CSS background, so it got none of what an <img> brings: lazy
  // loading, async decode, and above all an `error` event. A dead poster URL
  // left a blank grey rectangle with nothing to catch it; it now falls back to
  // the same .no-image mark every other poster in the app shows.
  const image = el('img', 'card-image');
  image.loading = 'lazy';
  image.decoding = 'async';
  image.alt = '';
  if (result.poster) {
    image.src = result.poster;
    image.addEventListener('error', () => art.classList.add('no-image'), { once: true });
  } else {
    art.classList.add('no-image');
  }
  art.appendChild(image);
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
$('#detail-copy-toggle').addEventListener('click', (event) => {
  const expanded = event.currentTarget.getAttribute('aria-expanded') !== 'true';
  event.currentTarget.setAttribute('aria-expanded', String(expanded));
  event.currentTarget.textContent = expanded ? 'Show less' : 'Show more';
  detailCopy.classList.toggle('is-collapsed', !expanded);
});
$('#detail-play').addEventListener('click', playSelected);
window.BlazingStreamPreferences?.mountDetail($('#detail-stream-preferences'));
document.addEventListener('blazing-stream-preferences-changed', () => {
  ++playRequest;
  if (state.selected && detailDialog.open) loadStreams(state.selected);
});
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
  // A desktop keyboard sends Escape. A webOS TV remote's physical Back button
  // does not — it is keyCode 461 (key is 'Back' on most firmwares, sometimes
  // reported as 'GoBack'). The native <dialog> auto-closes detail-dialog on a
  // real Escape (browser default for showModal()), which is why this looked
  // like it worked in every desktop test; measured with a real webOS-shaped
  // key event, nothing closed it, and nothing closed the player or drawer
  // either. Without this, a remote user who opens a title has no way back.
  const isBack = event.key === 'Escape' || event.key === 'Back' || event.key === 'GoBack' || event.keyCode === 461;
  if (!isBack) return;
  if (detailDialog.open) closeDetail();
  else if (!player.hidden) closePlayer();
  else if (!drawerLayer.hidden) closeDrawer();
});

/**
 * The call the BlazeOS Phase 1 patch removed, and the whole reason the home
 * screen has been empty. app.js is loaded with `defer`, so the DOM is parsed
 * before this line runs and every $('#id') at the top of the file has resolved.
 *
 * The restore runs FIRST so boot() sees the returning viewer's id and cap on
 * its very first pass, rather than building the pre-profile home and then
 * throwing it away a moment later.
 */
restoreProfileSession();
boot();
