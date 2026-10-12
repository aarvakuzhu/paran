// Offline shell: cache the app files, never cache Google API calls (data stays in Drive + local cache).
const VERSION = `stash-v6`;
const SHELL = [
  `./`, `./index.html`, `./css/app.css`, `./manifest.webmanifest`,
  `./js/app.js`, `./js/config.js`, `./js/google.js`, `./js/store.js`, `./js/search.js`, `./js/image.js`, `./js/ui.js`, `./js/idb.js`, `./js/ai.js`,
  `./icons/icon-192.png`, `./icons/icon-512.png`,
];

self.addEventListener(`install`, (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener(`activate`, (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener(`fetch`, (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== `GET` || url.origin !== location.origin) return; // Google APIs go straight to the network
  // Network first so updates show up; fall back to cache when offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match(`./index.html`))),
  );
});
