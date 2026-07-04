const CACHE_NAME = 'endgame-nirvana-v1'
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
        .catch(() => caches.match(request).then((cached) => cached ?? caches.match('/'))),
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
        .catch(() => undefined)
      return cached ?? networkFetch
    }),
  )
})
