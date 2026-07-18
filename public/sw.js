const CACHE_NAME = "tipster-panel-v19-floating-calculator-panels";
const APP_SHELL = [
  "/",
  "/index.html",
  "/maintenance.html",
  "/style.css?v=floating-calculator-panels-20260719a",
  "/app.js?v=floating-calculator-panels-20260719a",
  "/manifest.webmanifest",
  "/icon.svg",
  "/logo-watermark.png",
  "/watermark.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  const isNavigation = event.request.mode === "navigate" || event.request.headers.get("accept")?.includes("text/html");
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (isNavigation && response.status >= 500) {
          return caches.match("/index.html")
            .then(cached => cached || caches.match("/"))
            .then(cached => cached || caches.match("/maintenance.html"))
            .then(cached => cached || response);
        }
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => {
        if (isNavigation) {
          return caches.match("/index.html")
            .then(cached => cached || caches.match("/"))
            .then(cached => cached || caches.match("/maintenance.html"));
        }
        return caches.match(event.request);
      })
  );
});
