const CACHE_NAME = 'malta-guide-v10';

// Static app-shell files. Photo paths are no longer hardcoded here — they're
// read straight out of data/pois.json at install time, so adding a photo (or
// a second/third photo for a POI) to pois.json is enough; nothing here needs
// to be kept in sync by hand.
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
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

async function getPhotoUrls() {
  try {
    const res = await fetch('./data/pois.json');
    const data = await res.json();
    const urls = [];
    (data.pois || []).forEach(poi => {
      (poi.photos || []).forEach(p => urls.push('./' + p));
    });
    return urls;
  } catch (err) {
    console.warn('Could not read pois.json for photo precaching', err);
    return [];
  }
}

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const photoUrls = await getPhotoUrls();
      const allUrls = PRECACHE_URLS.concat(photoUrls);
      await Promise.all(
        allUrls.map(url =>
          cache.add(url).catch(err => console.warn('Precache failed for', url, err))
        )
      );
      self.skipWaiting();
    })()
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
