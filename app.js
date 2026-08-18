/* Blazing — phone-first streaming front-end over a Stremio-protocol backend.
   No frameworks, no CDN. Everything runs from these static files. */
'use strict';

const API_BASE = 'https://addon.lyreosai.com';
const FETCH_TIMEOUT = 20000; // ms

/* ---------- tiny helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

async function fetchJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal, mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/* ---------- app state ---------- */

const home = $('#home');
const rowsWrap = $('#rows');
const player = $('#player');
const video = $('#video');
const playerSpinner = $('#player-spinner');
const playerMsg = $('#player-msg');
const playerTitle = $('#player-title');

/* ---------- boot ---------- */

async function boot() {
  showGlobal('loading');
  let manifest;
  try {
    manifest = await fetchJSON(API_BASE + '/manifest.json');
  } catch (e) {
    showGlobal('error', 'Could not reach the library. Check your connection and try again.');
    return;
  }

  const rawCatalogs = Array.isArray(manifest.catalogs) ? manifest.catalogs : [];
  // This is a PUBLIC web build with no PIN gate, so the 18+ catalogue is never
  // shown here. Adult stays on the PIN-gated TV app only.
  const ADULT_RE = /adult|nsfw|jav|hentai|porn|xxx|18\+/i;
  const catalogs = rawCatalogs.filter(function (c) {
    return !ADULT_RE.test(String(c.id || '') + ' ' + String(c.type || '') + ' ' + String(c.name || ''));
  });
  if (!catalogs.length) {
    showGlobal('empty', 'No catalogues available yet.');
    return;
  }

  clearGlobal();
  rowsWrap.innerHTML = '';

  // Build ordered placeholders first, then fill each row as its data lands.
  const jobs = catalogs.map((cat) => {
    const section = buildRowSkeleton(cat.name || cat.id);
    rowsWrap.appendChild(section);
    return loadRow(cat, section);
  });

  await Promise.allSettled(jobs);

  // If every row ended up empty, surface a friendly empty state.
  if (!rowsWrap.querySelector('.card')) {
    showGlobal('empty', 'Nothing to watch right now.');
  }
}

async function loadRow(cat, section) {
  const track = $('.row-track', section);
  try {
    const data = await fetchJSON(
      `${API_BASE}/catalog/${encodeURIComponent(cat.type)}/${encodeURIComponent(cat.id)}.json`
    );
    const metas = Array.isArray(data.metas) ? data.metas : [];
    if (!metas.length) {
      section.remove();
      return;
    }
    track.innerHTML = '';
    metas.forEach((m) => track.appendChild(buildCard(m)));
  } catch (e) {
    section.remove(); // a broken catalogue should not block the rest of home
  }
}

/* ---------- render ---------- */

function buildRowSkeleton(title) {
  const section = el('section', 'row');
  const h = el('h2', 'row-title');
  h.textContent = title;
  const track = el('div', 'row-track');
  for (let i = 0; i < 6; i++) track.appendChild(el('div', 'card skeleton'));
  section.appendChild(h);
  section.appendChild(track);
  return section;
}

function buildCard(meta) {
  const card = el('button', 'card');
  card.type = 'button';
  card.setAttribute('aria-label', meta.name || 'Untitled');

  const img = el('img', 'card-img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';
  if (meta.poster) {
    img.src = meta.poster;
    img.addEventListener('error', () => card.classList.add('noimg'), { once: true });
  } else {
    card.classList.add('noimg');
  }

  const label = el('span', 'card-label');
  label.textContent = meta.name || 'Untitled';

  card.appendChild(img);
  card.appendChild(label);
  card.addEventListener('click', () => openTitle(meta));
  return card;
}

/* ---------- playback ---------- */

async function openTitle(meta) {
  openPlayer(meta.name || '');
  setPlayerState('loading');

  let streams;
  try {
    streams = await resolveStreams(meta);
  } catch (e) {
    setPlayerState('error', 'Could not load streams for this title.');
    return;
  }

  const playable = (streams || []).find((s) => s && typeof s.url === 'string' && s.url);
  if (!playable) {
    setPlayerState('error', 'No playable stream found for this title.');
    return;
  }

  playVideo(playable.url);
}

async function resolveStreams(meta) {
  const data = await fetchJSON(
    `${API_BASE}/stream/${encodeURIComponent(meta.type)}/${encodeURIComponent(meta.id)}.json`
  );
  return Array.isArray(data.streams) ? data.streams : [];
}

function playVideo(url) {
  const done = () => setPlayerState('playing');
  video.addEventListener('loadedmetadata', done, { once: true });
  video.addEventListener(
    'error',
    () =>
      setPlayerState(
        'error',
        'This stream could not be played on this device. Some sources use HLS, which only plays natively in Safari / iOS.'
      ),
    { once: true }
  );
  video.src = url;
  video.load();
  const p = video.play();
  if (p && typeof p.catch === 'function') {
    // Autoplay may be blocked; controls let the user start it manually.
    p.catch(() => setPlayerState('playing'));
  }
}

/* ---------- player UI ---------- */

function openPlayer(title) {
  playerTitle.textContent = title;
  player.hidden = false;
  document.body.classList.add('no-scroll');
}

function closePlayer() {
  video.pause();
  video.removeAttribute('src');
  video.load();
  player.hidden = true;
  playerMsg.hidden = true;
  document.body.classList.remove('no-scroll');
}

function setPlayerState(state, msg) {
  if (state === 'loading') {
    playerSpinner.hidden = false;
    playerMsg.hidden = true;
    video.classList.remove('ready');
  } else if (state === 'playing') {
    playerSpinner.hidden = true;
    playerMsg.hidden = true;
    video.classList.add('ready');
  } else if (state === 'error') {
    playerSpinner.hidden = true;
    playerMsg.textContent = msg || 'Something went wrong.';
    playerMsg.hidden = false;
    video.classList.remove('ready');
  }
}

/* ---------- global states (loading / empty / error) ---------- */

function showGlobal(kind, msg) {
  clearGlobal();
  const box = el('div', 'state state-' + kind);
  box.id = 'global-state';
  if (kind === 'loading') {
    box.innerHTML = '<div class="spinner"></div><p>Loading your library…</p>';
  } else {
    const icon = kind === 'error' ? '⚠️' : '🍿';
    const p = el('p');
    p.textContent = msg || (kind === 'error' ? 'Something went wrong.' : 'Nothing here yet.');
    box.innerHTML = '<div class="state-icon">' + icon + '</div>';
    box.appendChild(p);
    if (kind === 'error') {
      const btn = el('button', 'retry-btn');
      btn.type = 'button';
      btn.textContent = 'Try again';
      btn.addEventListener('click', boot);
      box.appendChild(btn);
    }
  }
  home.appendChild(box);
}

function clearGlobal() {
  const g = $('#global-state');
  if (g) g.remove();
}

/* ---------- wiring ---------- */

$('#player-close').addEventListener('click', closePlayer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !player.hidden) closePlayer();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

boot();
