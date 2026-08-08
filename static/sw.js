const CACHE = 'varekil-stenungson-v1';
const ASSETS = ['/', '/static/styles.css', '/static/app.js', '/manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.url.includes('/api/')) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
