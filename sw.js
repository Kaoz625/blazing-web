/* Blazing service worker — caches the app shell so the app is installable
   and opens instantly. Backend API calls are always fetched live. */
'use strict';

// Bump when a cached shell file changes. Without this, installed PWAs can keep
// an older Home implementation even after GitHub Pages publishes the new app.js.
// v8: upscale button popup + pressed state (app.js, styles.css) and the
// proxy resolver moved to a playback fallback (app.js).
// v9: Trailers + Education tabs wired up, hover and detail trailer autoplay,
// the quality control, rating chips (app.js, styles.css), and the new
// telemetry.js. Without this bump an installed PWA keeps serving v8's app.js
// and every one of those looks broken on a device that already has the app.
// v10: the app moved to blazingstream.lyreosai.com/app/, where fleet calls go
// through a same-origin /fleet path. An installed PWA holding v9's app.js would
// keep calling fleet.lyreosai.com directly and be refused by its CORS allow-list.
// v11: the kids gate (app.js) and the mandatory profile gate (profile.js). This
// bump is a SAFETY bump, not a cosmetic one — an installed PWA still holding
// v10 would keep serving the app.js with no rating filter and the profile.js
// that lets anyone browse without answering, so a child on a device that already
// had the app would see the whole library.
// v12: Discover became real (app.js) and the owner-recovery PIN reached the gate
// (profile.js). Bumped because the worker being REPLACED is a cache-first one from
// v11 — the network-first rule below only applies once THIS worker is in control,
// and until then the old one keeps answering app.js from its cache. Measured
// 2026-08-27: profile.js updated while app.js did not, on the same reload.
const CACHE = 'blazing-shell-v15';

/** How long the code fetch may take before the cached copy is served instead. */
const NETWORK_TIMEOUT_MS = 3000;
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './telemetry.js',
  './profile.js',
  // emby.js was never in this list, although index.html has loaded it since the
  // Emby rows were added. It was reaching devices through the HTTP cache alone.
  './emby.js',
  './watch-party.js',
  './locker.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  // `cache: 'reload'` is not decoration. addAll() goes through the browser's own
  // HTTP cache, so a bumped CACHE name could install a brand new cache full of
  // STALE files — which is exactly what happened on blazingstream: a fresh
  // index.html sat above a four-hour-old app.js and the app went on calling the
  // wrong host. Cloudflare Pages ignores Cache-Control set in _headers for static
  // assets, so this is the only place the staleness can be cut off.
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(
        SHELL.map((u) => fetch(new Request(u, { cache: 'reload' }))
          .then((res) => (res && res.ok ? c.put(u, res) : null)))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache backend/API or any cross-origin media — always go to network.
  if (url.origin !== self.location.origin) return;

  // A service worker intercepts every request the page makes, not only the ones
  // under its scope path. On blazingstream the add-on and the fleet answer on
  // SAME-ORIGIN paths (/addon/*, /fleet/*), so without this guard the cache-first
  // branch below would store a Discover shelf or a locker listing and serve that
  // same copy for ever. Only the shell this worker was registered for is cacheable.
  const home = new URL('./', self.location.href).pathname;
  if (!url.pathname.startsWith(home)) return;

  /**
   * CODE IS NETWORK-FIRST. ASSETS ARE CACHE-FIRST.
   *
   * This split exists because cache-first for everything is how a shipped fix can
   * fail to reach anybody. It bit on 2026-08-27: the kids rating filter went out in
   * app.js with no CACHE bump, and every device that already had the app would have
   * gone on serving the OLD app.js — with no filter — for ever. The bump was the
   * only thing standing between a child and the whole library, and a bump is a line
   * a person has to remember to edit.
   *
   * So the guarantee no longer depends on remembering. HTML, JS and CSS go to the
   * network first and only fall back to the cache when the network does not answer.
   * A safety fix now lands on the next load, bump or no bump.
   *
   * The cost is one network round trip for the code on each load, bounded by
   * NETWORK_TIMEOUT_MS below, and offline still works because the fallback is the
   * same cache as before. Icons, the manifest and images stay cache-first: they are
   * content-addressed in practice and never carry a safety decision.
   *
   * Bump CACHE anyway when the shell changes. It is now cache HYGIENE — it evicts
   * the old copies — rather than the thing that makes a fix reach a device.
   */
  const isCode = req.mode === 'navigate' ||
    ['document', 'script', 'style'].includes(req.destination) ||
    /\.(html|js|css)$/.test(url.pathname);

  const putCopy = (res) => {
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  };

  const fromCache = () => caches.match(req)
    .then((cached) => cached || (req.mode === 'navigate' ? caches.match('./index.html') : null))
    .then((cached) => cached || Response.error());

  if (isCode) {
    // A network that hangs must not hang the app. Losing the race falls back to
    // the cache, which is exactly the old behaviour, so a dead connection is no
    // worse off than before.
    const network = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
      fetch(req)
        .then((res) => { clearTimeout(timer); resolve(putCopy(res)); })
        .catch(() => { clearTimeout(timer); resolve(null); });
    });
    event.respondWith(network.then((res) => res || fromCache()));
    return;
  }

  // Everything else: cache-first, as before.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then(putCopy).catch(fromCache))
  );
});
