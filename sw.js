// Lets the site open with no signal (at a field), so scoring can carry on from what's saved on the phone.
// Online it always fetches the latest files first, so updates show right away; the saved copy is only used offline.
const CACHE = "team-stats-v23";
const SHELL = ["./", "index.html", "config.js", "engine.js", "book.js", "scorer.js", "app.js", "styles.css",
  "apple-touch-icon.png", "favicon.png", "manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  // Only this site's own files; the database, sign-in and maps always go straight to the network.
  if (req.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Files are saved without their ?v= cache-busting stamp; pages are saved as the site's start page.
    const key = req.mode === "navigate" ? new URL("index.html", self.registration.scope).href : url.origin + url.pathname;
    try {
      const res = await fetch(req, { cache: "no-store" });
      if (res.ok) cache.put(key, res.clone());
      return res;
    } catch (err) {
      const saved = await cache.match(key);
      if (saved) return saved;
      throw err;
    }
  })());
});
