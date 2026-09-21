/**
 * Plus Ultra Puppet — offline cache.
 *
 * Strategy, and why:
 *   • navigations (index.html)  → NETWORK FIRST. A shipped fix must reach the
 *     phone on the very next reload; the cache is only the offline fallback.
 *     (Cache-first here is how you get stuck staring at a broken build forever.)
 *   • scripts & styles          → network first, cache fallback, and the fresh
 *     copy is written back so the next offline boot is current.
 *   • icons / art / manifest    → cache first (they change rarely, and a fast
 *     icon is what makes the home-screen install feel instant).
 *   • anything cross-origin     → never touched: gateway POSTs and free public
 *     APIs are not cached, not proxied, not stored.
 */
const VERSION = 'v2';
const CACHE = `pip-shell-${VERSION}`;
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

const isCode = (path) => /\.(?:js|mjs|css|html|webmanifest)$/.test(path) || path === '/' || path.endsWith('/');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL).catch((err) => console.warn('[sw] some shell files missing', err)))
      .then(() => self.skipWaiting()),
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

/** Fresh copy if the network answers, cached copy if it does not. */
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./index.html'));
    if (hit) return hit;
    return new Response('offline', { status: 503, statusText: 'offline' });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never touch gateway POSTs
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never proxy other people's APIs
  event.respondWith(isCode(url.pathname) ? networkFirst(req) : cacheFirst(req));
});

/** The page can ask the new worker to take over immediately (used after updates). */
self.addEventListener('message', (event) => {
  if (event.data === 'pip:skip-waiting') self.skipWaiting();
});
