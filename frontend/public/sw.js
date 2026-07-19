// v2 flushed responses cached before the COOP/COEP headers existed — a shell served
// from the old cache lacks them, silently downgrading the page to non-isolated.
// v3 flushes engine files the service worker briefly cached; they are no longer
// intercepted at all (see below).
const CACHE_NAME = 'endgame-nirvana-v3'
const CORE_ASSETS = ['/', '/manifest.webmanifest', '/favicon.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

// Network-first for navigations (so a redeploy is picked up immediately when online),
// falling back to the cached shell when offline; cache-first for everything else, since
// Vite's hashed build assets never change under a given filename.
self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  // Only the app's own assets belong in the shell cache. Cross-origin requests
  // (tablebase, Supabase, browser-extension resources) pass through untouched —
  // intercepting them broke pages when such a fetch failed with nothing cached.
  if (!request.url.startsWith(self.location.origin)) return
  // The engine files are immutable and cached by the plain HTTP cache; serving the
  // multi-threaded engine's worker scripts through the service worker hung its thread
  // bootstrap in the field, so they are deliberately not intercepted at all.
  if (new URL(request.url).pathname.startsWith('/engines/')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone()
          return caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, clone))
            .then(() => response)
        })
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached ?? caches.match('/'))
            .then((cached) => cached ?? Response.error()),
        ),
    )
    return
  }

  // Stale-while-revalidate: serve the cached copy instantly if there is one (this is
  // what makes the app usable offline), while always re-fetching in the background so
  // unhashed files that change between deploys (e.g. exercises-manifest.json) don't
  // stay stale forever just because they were cached once.
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (!response.ok) return response
          const clone = response.clone()
          return caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, clone))
            .then(() => response)
        })
        .catch(() => Response.error())
      return cached ?? networkFetch
    }),
  )
})
