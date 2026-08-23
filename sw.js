/* Blazing service worker — caches the app shell so the app is installable
   and opens instantly. Backend API calls are always fetched live. */
'use strict';

// Bump when a cached shell file changes. Without this, installed PWAs can keep
// an older Home implementation even after GitHub Pages publishes the new app.js.
const CACHE = 'blazing-shell-v7';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
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
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
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
