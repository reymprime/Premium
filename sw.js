// Sonata Service Worker
// Strategy:
//  - App shell (HTML/CSS/JS/icons) -> precached on install, served cache-first,
//    refreshed in the background on every navigation (stale-while-revalidate).
//  - Track thumbnails (img.youtube.com) -> stale-while-revalidate, so cover art
//    still shows up once a track has been viewed, even offline.
//  - YouTube iframe API + Google APIs (googleapis.com) -> always network-only.
//    These are live playback/data calls; caching them would risk stale quota
//    state, broken embeds, or serving someone else's API response.

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `sonata-shell-${CACHE_VERSION}`;
const THUMB_CACHE = `sonata-thumbs-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

const NETWORK_ONLY_HOSTS = [
  'www.googleapis.com',
  'www.youtube.com',
  's.ytimg.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== THUMB_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

function isNetworkOnly(url) {
  return NETWORK_ONLY_HOSTS.some((host) => url.hostname === host);
}

function isThumbnail(url) {
  return url.hostname === 'img.youtube.com';
}

// Stale-while-revalidate: serve from cache immediately if present, and
// refresh the cache in the background for next time.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || (await networkFetch) || Response.error();
}

// Network-first with cache fallback: try the network for the freshest shell,
// fall back to cache when offline.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept live YouTube/Google API calls.
  if (isNetworkOnly(url)) {
    return;
  }

  // Track thumbnails: cache for offline cover art.
  if (isThumbnail(url)) {
    event.respondWith(staleWhileRevalidate(request, THUMB_CACHE));
    return;
  }

  // Same-origin navigation and app-shell assets.
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});