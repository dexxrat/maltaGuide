const CACHE_NAME = 'malta-guide-v7';

const POI_IDS = [
  'ramla_bay', 'san_blas', 'hondoq', 'wied_ilghasri', 'dwejra', 'mgarr_ixxini',
  'xlendi', 'marsalforn', 'ggantija', 'cittadella', 'qala_belvedere',
  'comino_lagoons', 'st_peters_pool', 'marsaxlokk',
  'calypso_cave', 'roman_villa', 'belancourt_battery',
  'fungus_rock', 'azure_window', 'wolseley_battery', 'tas_salvatur',
  'marsalforn_tower'
];

const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './data/pois.json',
  './data/i18n.json',
  './assets/icon.svg',
  './assets/icon-180.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  ...POI_IDS.map(id => `./assets/photos/${id}.jpg`),
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.all(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(err => console.warn('Precache failed for', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first for app shell/data, network-first fallback for map tiles (not precached)
self.addEventListener('fetch', event => {
  const url = event.request.url;
  const isTile = url.includes('tile.openstreetmap.org');

  if (isTile) {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return res;
      }).catch(() => cached);
    })
  );
});
