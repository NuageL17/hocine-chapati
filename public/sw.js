const CACHE_NAME = 'hocine-chapati-v1';
const ASSETS = ['/passe.html', '/affichage.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/socket.io')) return;
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});