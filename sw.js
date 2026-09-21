/**
 * Plus Ultra Puppet — offline cache.
 * Caches the app shell only. AI gateway calls are cross-origin POSTs and are
 * never intercepted, never cached, never stored.
 */
const CACHE = 'pip-shell-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/reset.css',
  './css/app.css',
  './css/puppet.css',
  './css/panel.css',
  './js/main.js',
  './js/core/bus.js',
  './js/core/util.js',
  './js/core/store.js',
  './js/gateways.js',
  './js/nlu.js',
  './js/tools.js',
  './js/personality.js',
  './js/memory.js',
  './js/habits.js',
  './js/perception.js',
  './js/speech.js',
  './js/brain.js',
  './js/puppet.js',
  './js/puppet-art.js',
  './js/scheduler.js',
  './assets/icons/icon.svg',
  './assets/puppet/pip.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch((err) => console.warn('[sw] some shell files missing', err))).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never touch gateway POSTs
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never proxy other people's APIs
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => hit || caches.match('./index.html'));
      return hit || network;
    }),
  );
});
