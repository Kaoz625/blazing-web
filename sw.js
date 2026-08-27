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
const CACHE = 'blazing-shell-v10';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './telemetry.js',
  './profile.js',
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

  // App shell: cache-first, fall back to network, then to cached index for navigations.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          if (req.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        });
    })
  );
});
