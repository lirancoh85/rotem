// רותם עדני — service worker.
// Caches ONLY the app's own static files (shell, hashed assets, icons, splash, fonts).
// Never caches Supabase/API traffic, so customer data is never stored by the worker.
const VERSION = 'rotem-v3';
const SHELL = ['./', './offline.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // web fonts: cache-first (public, not personal)
  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      const copy = r.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
      return r;
    })));
    return;
  }

  // everything else on other origins (Supabase API, auth, realtime) goes straight to the network
  if (url.origin !== self.location.origin) return;

  // pages: network first, fall back to the cached app shell, then to the offline page
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(VERSION).then((c) => c.put('./', copy));
          }
          return r;
        })
        .catch(() => caches.match('./').then((hit) => hit || caches.match('./offline.html'))),
    );
    return;
  }

  // built assets are content-hashed: cache first
  if (/\/(assets|icons|splash)\//.test(url.pathname) || url.pathname.endsWith('.webmanifest')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok) {
        const copy = r.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return r;
    })));
  }
});
