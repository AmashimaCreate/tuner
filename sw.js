// Network-first service worker: online behaviour is identical to having no
// service worker at all (every request goes to the network and refreshes the
// cache), and offline the last successfully fetched copy of each asset is
// served. Nothing version-critical is pinned, so a deploy is picked up on the
// next online load without a cache-version bump.
const CACHE = "tuner-v1";

const PRECACHE = [
  "./",
  "./app.js",
  "./pitch-processing.js",
  "./pitchy.js",
  "./tunings.js",
  "./manifest.webmanifest",
  "./assets/headstock-ebony-no-strings.webp",
  "./assets/headstock-six-inline.webp",
  "./samples/guitar/E2.mp3",
  "./samples/guitar/A2.mp3",
  "./samples/guitar/D3.mp3",
  "./samples/guitar/G3.mp3",
  "./samples/guitar/B3.mp3",
  "./samples/guitar/E4.mp3",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Seed one by one so a single failed asset does not abort the install.
      Promise.allSettled(PRECACHE.map((url) => cache.add(url))),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || !request.url.startsWith(self.location.origin)) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const hit = await caches.match(request, { ignoreSearch: true });
        if (hit) return hit;
        if (request.mode === "navigate") return caches.match("./");
        return Response.error();
      }),
  );
});
