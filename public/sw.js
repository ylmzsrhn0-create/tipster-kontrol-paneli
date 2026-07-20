const CACHE_NAME = "tipster-panel-v29-account-menu";
const APP_SHELL = [
  "/",
  "/index.html",
  "/maintenance.html",
  "/style.css?v=account-menu-20260720a",
  "/app.js?v=account-menu-20260720a",
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

self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = {
      title: "Tipster Kontrol Paneli",
      body: event.data?.text() || "Yeni bildirim var."
    };
  }

  const title = data.title || "Tipster Kontrol Paneli";
  const options = {
    body: data.body || "Yeni bildirim var.",
    icon: data.icon || "/icon.svg",
    badge: data.badge || "/icon.svg",
    data: { url: data.url || "/" }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then(clients => {
        for (const client of clients) {
          if (client.url.startsWith(self.location.origin) && "focus" in client) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
        return self.clients.openWindow(targetUrl);
      })
  );
});
