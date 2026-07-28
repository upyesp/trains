/* Trains service worker.
 *
 * Deliberately minimal and SAFE for live data:
 *   - NEVER caches the live board API. Every request to the Worker
 *     (trains-api.upyesp.workers.dev) — and any same-origin /board or /api path
 *     — is passed straight to the network, so departures never go stale.
 *   - Caches only the static app shell: hashed /_astro assets + stations.json
 *     (stale-while-revalidate) and page navigations (network-first, with a
 *     cached fallback so the shell still opens briefly offline).
 *   - Everything else (fonts, cross-origin) is passed through to the network.
 *
 * The board's own 30s refresh (board-client.ts) is unchanged and keeps running
 * in an installed PWA exactly as it does in a browser tab; it pauses when the
 * app is backgrounded and resumes on focus. Installing the site as an app does
 * not change any of that. */
const SHELL = 'trains-shell-v1';

self.addEventListener('install', () => {
  // Take control right away so the SW governs this load without a reload.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept non-GET (POST etc.)

  const url = new URL(req.url);

  // 1. Live data + cross-origin (API host, fonts): always the network. Never cached.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/board/') || url.pathname.startsWith('/api/')) return;

  // 2. Hashed static assets + station list: stale-while-revalidate.
  if (url.pathname.startsWith('/_astro/') || url.pathname === '/stations.json') {
    event.respondWith(swr(req));
    return;
  }

  // 3. Page navigations: network-first, fall back to the cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNav(req));
    return;
  }

  // 4. Anything else same-origin: straight to the network (no caching).
});

async function swr(req) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

async function networkFirstNav(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    const home = await cache.match('/');
    if (home) return home;
    return new Response('Offline and no cached page is available.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
