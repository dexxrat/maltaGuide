const CACHE_NAME = 'malta-guide-v15';

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

async function getPoisData() {
  try {
    const res = await fetch('./data/pois.json');
    const data = await res.json();
    return data.pois || [];
  } catch (err) {
    console.warn('Could not read pois.json for precaching', err);
    return [];
  }
}

function getPhotoUrls(pois) {
  const urls = [];
  pois.forEach(poi => (poi.photos || []).forEach(p => urls.push('./' + p)));
  return urls;
}

// Offline map tiles: rather than only caching whatever the user happens to
// scroll past, pre-seed a zoomed-in area around every POI (they cluster on
// Gozo/Comino plus a couple of spots on Malta, so this stays well short of
// tiling the whole archipelago). Zoom 12-16 with a 1.5km buffer per POI
// works out to a few hundred tiles / ~10MB — enough to actually navigate by
// on foot, not just see a thumbnail.
const TILE_ZOOM_MIN = 12;
const TILE_ZOOM_MAX = 16;
const TILE_BUFFER_KM = 1.5;
const TILE_SUBDOMAINS = ['a', 'b', 'c']; // must match the {s} subdomains Leaflet uses in app.js

function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}
function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z)
  );
}
// Mirrors Leaflet's own TileLayer._getSubdomain, so the URL we precache is
// the exact one Leaflet will actually request at runtime (same cache key).
function subdomainFor(x, y) {
  return TILE_SUBDOMAINS[Math.abs(x + y) % TILE_SUBDOMAINS.length];
}

function getMapTileUrls(pois) {
  const tiles = new Set();
  const bufferDeg = TILE_BUFFER_KM / 111; // ~111km per degree of latitude
  pois.forEach(poi => {
    for (let z = TILE_ZOOM_MIN; z <= TILE_ZOOM_MAX; z++) {
      const x1 = lonToTileX(poi.lng - bufferDeg, z);
      const x2 = lonToTileX(poi.lng + bufferDeg, z);
      const y1 = latToTileY(poi.lat + bufferDeg, z);
      const y2 = latToTileY(poi.lat - bufferDeg, z);
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
          tiles.add(`${z}/${x}/${y}`);
        }
      }
    }
  });
  return Array.from(tiles).map(key => {
    const [z, x, y] = key.split('/');
    return `https://${subdomainFor(Number(x), Number(y))}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
  });
}

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const pois = await getPoisData();
      const photoUrls = getPhotoUrls(pois);
      const tileUrls = getMapTileUrls(pois);
      const allUrls = PRECACHE_URLS.concat(photoUrls, tileUrls);
      // Tiles are many small requests to a third-party server — cap how many
      // are in flight at once instead of firing everything simultaneously.
      const CONCURRENCY = 12;
      let i = 0;
      async function worker() {
        while (i < allUrls.length) {
          const url = allUrls[i++];
          await cache.add(url).catch(err => console.warn('Precache failed for', url, err));
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
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

// Cache-first everywhere, including map tiles now that a chunk of them are
// precached above — no reason to hit the network for a tile we already
// have. Anything not precached (a tile outside the buffered area, say) is
// fetched once and cached opportunistically, same as before.
self.addEventListener('fetch', event => {
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
