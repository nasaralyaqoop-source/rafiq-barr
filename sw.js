'use strict';
// عامل الخدمة: يحفظ ملفات التطبيق للتشغيل بدون نت، ويخزّن قطع الخريطة اللي انعرضت أو انحمّلت.
const CACHE_PREFIX = 'rafiq-barr-';
const SHELL = `${CACHE_PREFIX}shell-v2`;
const TILES = `${CACHE_PREFIX}tiles-v2`;
const TILE_HOSTS = ['server.arcgisonline.com', 'tile.openstreetmap.org'];
const MAX_TILES = 1500;
const APP_SHELL = ['./', './index.html', './app.css', './app.js', './icon.svg'].map(
  (u) => new URL(u, self.registration.scope).href,
);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((n) => n.startsWith(CACHE_PREFIX) && n !== SHELL && n !== TILES)
          .map((n) => caches.delete(n)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(tileFirst(req));
    return;
  }
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

// الشبكة أولًا عشان التحديثات توصل، ومع مهلة قصيرة لأن النت في البر ضعيف
async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match(APP_SHELL[0]);
      if (shell) return shell;
    }
    throw err;
  }
}

let putsSinceTrim = 0;

// قطع الخريطة: يحتفظ فقط باللي انعرض فعلًا، ولا ينزّل مناطق مسبقًا (شروط Esri وOpenStreetMap)
async function tileFirst(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    if (++putsSinceTrim >= 50) {
      putsSinceTrim = 0;
      trimTiles(cache);
    }
  }
  return res;
}

async function trimTiles(cache) {
  const keys = await cache.keys();
  const extra = keys.length - MAX_TILES;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}
