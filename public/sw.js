// Minimal service worker — just enough for "Add to Home Screen" / installable-PWA
// criteria and a basic offline shell fallback. Deliberately network-first and
// never touches /api/* or non-GET requests, so live data is never served stale.
const CACHE_NAME = "mfbase-shell-v1";
const SHELL_ASSETS = ["/", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) { return cache.addAll(SHELL_ASSETS); }).catch(function () {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept POST/PUT (login, /api/db saves)
  const reqUrl = new URL(req.url);
  if (reqUrl.pathname.indexOf("/api/") === 0) return; // API responses are always live, never cached

  event.respondWith(
    fetch(req)
      .then(function (res) {
        if (res.ok && (SHELL_ASSETS.indexOf(reqUrl.pathname) >= 0 || reqUrl.pathname.indexOf("/icons/") === 0)) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, clone); });
        }
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (cached) { return cached || caches.match("/"); });
      })
  );
});
