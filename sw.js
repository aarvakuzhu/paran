// App shell served from the device instantly (cache first). Google API calls are never cached here.
// Updating: bump VERSION. The new version is downloaded in the background as one complete set,
// then the page offers "Reload" (or picks it up on the next open). Files are never mixed across versions.
const VERSION = `stash-v12`;
const SHELL = [
  `./`, `./index.html`, `./css/app.css`, `./manifest.webmanifest`,
  `./js/app.js`, `./js/config.js`, `./js/google.js`, `./js/store.js`, `./js/search.js`, `./js/image.js`, `./js/ui.js`, `./js/idb.js`, `./js/ai.js`,
  `./icons/icon-192.png`, `./icons/icon-512.png`,
];

self.addEventListener(`install`, (e) => {
  // cache: 'reload' bypasses the browser's HTTP cache so the new set is really new
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: `reload` })))).then(() => self.skipWaiting()));
});

self.addEventListener(`activate`, (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener(`fetch`, (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== `GET` || url.origin !== location.origin) return; // Google APIs go straight to the network
  const isPage = e.request.mode === `navigate`;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(isPage ? `./index.html` : e.request, { ignoreSearch: isPage });
    if (hit) return hit;                       // instant, no network wait
    try {
      const res = await fetch(e.request);      // not in the shell (e.g. a new file): network, then keep it
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(`./index.html`)) || Response.error();
    }
  })());
});
