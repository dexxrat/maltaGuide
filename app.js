// ---------- Config ----------
const STORAGE_KEYS = {
  lang: 'mg_lang',
  visited: 'mg_visited',
  radius: 'mg_radius',
  simMode: 'mg_simMode',
  rate: 'mg_rate'
};

const DEFAULT_RADIUS = 150;
const GEO_WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 };
const PROXIMITY_CHECK_MS = 3000;

// ---------- State ----------
let state = {
  lang: localStorage.getItem(STORAGE_KEYS.lang) || 'ru',
  visited: JSON.parse(localStorage.getItem(STORAGE_KEYS.visited) || '[]'),
  radius: Number(localStorage.getItem(STORAGE_KEYS.radius)) || DEFAULT_RADIUS,
  simMode: localStorage.getItem(STORAGE_KEYS.simMode) === 'true', // default false (real GPS) — simulation is an opt-in testing tool
  pois: [],
  i18n: null,
  map: null,
  markers: {},
  userMarker: null,
  currentPos: null, // {lat, lng}
  watchId: null,
  proximityTimer: null,
  insideRadius: new Set(), // ids currently inside radius (to avoid re-trigger spam)
  audioUnlocked: false,
  rate: Number(localStorage.getItem(STORAGE_KEYS.rate)) || 1
};

// Narration is pre-rendered per POI/language (via edge-tts, see
// scratchpad/generate_audio.py) into assets/audio/<id>_<lang>.mp3, and played
// through one shared <audio> element. This gives a real decoded timeline
// (accurate currentTime/duration for seeking — no more estimating "characters
// per second"), and — critically — lets narration keep playing with the
// screen locked or the app backgrounded via the Media Session API, which
// speechSynthesis could never do on iOS/Android.
const audioEl = new Audio();
audioEl.preload = 'auto';
// A ~0 length silent WAV, played+paused synchronously inside the start
// button's click handler, to unlock this <audio> element for later
// programmatic .play() calls on iOS Safari (which otherwise requires every
// play() to originate from a user gesture).
const SILENT_AUDIO_SRC = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

// ---------- Persistence helpers ----------
function saveVisited() {
  localStorage.setItem(STORAGE_KEYS.visited, JSON.stringify(state.visited));
}
function markVisited(id) {
  if (!state.visited.includes(id)) {
    state.visited.push(id);
    saveVisited();
    renderList();
    updateMarkerStyles();
  }
}

// Lets the user correct the automatic "visited" tracking by hand — e.g. mark
// something visited without triggering the geo-fence, or clear a mistaken tick.
function toggleVisited(id) {
  const i = state.visited.indexOf(id);
  if (i === -1) state.visited.push(id);
  else state.visited.splice(i, 1);
  saveVisited();
  renderList();
  updateMarkerStyles();
}

// ---------- Data loading ----------
async function loadData() {
  const [poisRes, i18nRes] = await Promise.all([
    fetch('data/pois.json'),
    fetch('data/i18n.json')
  ]);
  const poisJson = await poisRes.json();
  state.pois = poisJson.pois;
  state.i18n = await i18nRes.json();
}

function t(key) {
  return (state.i18n[state.lang] && state.i18n[state.lang].ui[key]) || key;
}
function poiName(poi) {
  return poi.name;
}
function poiText(poi) {
  const entry = state.i18n[state.lang].pois[poi.id];
  return entry ? entry.text : '';
}

// ---------- i18n rendering ----------
function applyStaticI18n() {
  document.getElementById('appTitle').textContent = t('appTitle');
  document.getElementById('appSubtitle').textContent = t('appSubtitle');
  document.getElementById('chooseLanguageLabel').textContent = t('chooseLanguage');
  document.getElementById('startBtn').textContent = t('startGuide');
  document.getElementById('startHint').textContent = t('startHint');
  document.getElementById('tabMapBtn').textContent = t('tabMap');
  document.getElementById('tabListBtn').textContent = t('tabList');
  document.getElementById('simulateLabel').textContent = t('simulateLabel');
  document.getElementById('teleportBtn').textContent = t('teleportBtn');
  document.getElementById('nextBtn').textContent = t('nextBtn');
  document.getElementById('radiusLabel').textContent = t('radiusLabel');
  document.getElementById('resetProgressBtn').textContent = t('resetProgressBtn');
  document.getElementById('devPanelToggle').textContent = '🛠 ' + t('devPanelTitle');
  updateStatusLine();
  document.documentElement.lang = state.lang;
}

// ---------- Start screen ----------
function initStartScreen() {
  document.querySelectorAll('.lang-btn').forEach(btn => {
    if (btn.dataset.lang === state.lang) btn.classList.add('active');
    else btn.classList.remove('active');
    btn.addEventListener('click', () => {
      setLanguage(btn.dataset.lang);
      document.querySelectorAll('.lang-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  document.getElementById('startBtn').addEventListener('click', onStart);
}

// Switching language works both on the start screen and later, from inside
// the app (topbar toggle) — it re-renders whatever's currently visible
// without touching audio that may already be playing.
function setLanguage(lang) {
  state.lang = lang;
  localStorage.setItem(STORAGE_KEYS.lang, lang);
  applyStaticI18n();
  updateLangToggleLabel();
  renderList();
  if (activePoi) {
    document.getElementById('poiName').textContent = poiName(activePoi);
    document.getElementById('poiText').textContent = poiText(activePoi);
    prepareNarration(activePoi, lang);
  }
}

function updateLangToggleLabel() {
  const btn = document.getElementById('langToggleBtn');
  if (btn) btn.textContent = state.lang.toUpperCase();
}

function unlockAudio() {
  try {
    audioEl.muted = true;
    audioEl.src = SILENT_AUDIO_SRC;
    const p = audioEl.play();
    const finish = () => { audioEl.pause(); audioEl.muted = false; };
    if (p && typeof p.then === 'function') p.then(finish).catch(finish);
    else finish();
    state.audioUnlocked = true;
  } catch (e) {
    console.warn('Audio unlock failed', e);
  }
}

// The GPS simulator is a testing tool, not something a real user should ever
// see or accidentally toggle — it's only reachable via a URL flag, e.g.
// https://.../?dev=1. Without that flag the whole panel is hidden and
// simulation mode is forced off, no matter what got saved to localStorage
// during earlier testing.
function isDevMode() {
  try {
    return new URLSearchParams(window.location.search).get('dev') === '1';
  } catch (e) {
    return false;
  }
}

function onStart() {
  unlockAudio(); // must be called synchronously inside the click handler
  document.getElementById('startScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  if (!isDevMode()) {
    state.simMode = false;
    document.getElementById('devPanel').classList.add('dev-hidden');
  }

  applyStaticI18n();
  initMap();
  renderList();
  initDevPanel();
  startPositioning();
}

// ---------- Tabs ----------
function initTabs() {
  document.getElementById('tabMapBtn').addEventListener('click', () => switchTab('map'));
  document.getElementById('tabListBtn').addEventListener('click', () => switchTab('list'));
  document.getElementById('centerMeBtn').addEventListener('click', () => {
    if (state.currentPos && state.map) {
      state.map.panTo([state.currentPos.lat, state.currentPos.lng]);
    }
  });
  document.getElementById('langToggleBtn').addEventListener('click', () => {
    setLanguage(state.lang === 'ru' ? 'en' : 'ru');
  });
  document.getElementById('checkUpdateBtn').addEventListener('click', checkForUpdates);
  updateLangToggleLabel();
}
function switchTab(tab) {
  document.getElementById('mapView').classList.toggle('hidden', tab !== 'map');
  document.getElementById('listView').classList.toggle('hidden', tab !== 'list');
  document.getElementById('tabMapBtn').classList.toggle('active', tab === 'map');
  document.getElementById('tabListBtn').classList.toggle('active', tab === 'list');
  if (tab === 'map' && state.map) setTimeout(() => state.map.invalidateSize(), 50);
}

// ---------- Map ----------
function initMap() {
  state.map = L.map('map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(state.map);

  const latLngs = state.pois.map(p => [p.lat, p.lng]);
  state.map.fitBounds(latLngs, { padding: [30, 30] });

  state.pois.forEach(poi => {
    const icon = L.divIcon({
      className: 'poi-marker-wrap',
      html: `<div class="poi-marker">${poi.icon}</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
    const marker = L.marker([poi.lat, poi.lng], { icon }).addTo(state.map);
    marker.bindPopup(`<strong>${poiName(poi)}</strong>`);
    marker.on('click', () => showPoiCard(poi, { markVisit: false }));
    state.markers[poi.id] = marker;
  });

  updateMarkerStyles();
}

// ---------- Live "you are here" marker ----------
function userDotIcon() {
  return L.divIcon({
    className: 'user-marker-wrap',
    html: `<div class="user-dot"></div><div class="user-dot-pulse"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });
}

function userArrowIcon(headingDeg) {
  return L.divIcon({
    className: 'user-marker-wrap',
    html: `<div class="user-arrow" style="transform: rotate(${headingDeg}deg)"></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13]
  });
}

// pos: {lat, lng}; headingDeg: number|null|undefined (compass heading, 0=north, only
// available from real GPS while moving — the simulator has no heading, so we fall
// back to a plain dot rather than show a misleading direction).
function updateUserMarker(pos, headingDeg) {
  if (!state.map) return;
  const hasHeading = typeof headingDeg === 'number' && !Number.isNaN(headingDeg);
  const icon = hasHeading ? userArrowIcon(headingDeg) : userDotIcon();

  if (!state.userMarker) {
    state.userMarker = L.marker([pos.lat, pos.lng], { icon, zIndexOffset: 1000 }).addTo(state.map);
    state.map.panTo([pos.lat, pos.lng]);
  } else {
    state.userMarker.setLatLng([pos.lat, pos.lng]);
    state.userMarker.setIcon(icon);
  }
}

function updateMarkerStyles() {
  state.pois.forEach(poi => {
    const marker = state.markers[poi.id];
    if (!marker) return;
    const el = marker.getElement();
    if (el) {
      const inner = el.querySelector('.poi-marker');
      if (inner) inner.classList.toggle('visited', state.visited.includes(poi.id));
    }
  });
}

// ---------- List view ----------
function renderList() {
  const ul = document.getElementById('poiList');
  ul.innerHTML = '';
  state.pois.forEach(poi => {
    const visited = state.visited.includes(poi.id);
    const li = document.createElement('li');
    li.className = 'poi-item';
    li.innerHTML = `
      <div class="poi-item-icon">${poi.icon}</div>
      <div class="poi-item-body">
        <div class="poi-item-name">${poiName(poi)}</div>
        <button class="poi-item-status ${visited ? 'visited' : 'not-visited'}" data-id="${poi.id}">
          ${visited ? '✅ ' + t('visitedLabel') : '⬜ ' + t('notVisitedLabel')}
        </button>
      </div>
      <button class="poi-item-play" data-id="${poi.id}">${t('manualPlayBtn')}</button>
    `;
    ul.appendChild(li);
  });
  ul.querySelectorAll('.poi-item-play').forEach(btn => {
    btn.addEventListener('click', () => {
      const poi = state.pois.find(p => p.id === btn.dataset.id);
      if (poi) showPoiCard(poi, { markVisit: false });
    });
  });
  ul.querySelectorAll('.poi-item-status').forEach(btn => {
    btn.addEventListener('click', () => toggleVisited(btn.dataset.id));
  });
}

// ---------- POI Card ----------
let activePoi = null;
let activePhotoIndex = 0;

function renderPhotoCarousel(poi) {
  const photoEl = document.getElementById('poiPhoto');
  const photos = poi.photos && poi.photos.length ? poi.photos : null;

  if (!photos) {
    photoEl.innerHTML = poi.icon;
    return;
  }

  if (activePhotoIndex >= photos.length) activePhotoIndex = 0;
  if (activePhotoIndex < 0) activePhotoIndex = photos.length - 1;

  const dots = photos.length > 1
    ? `<div class="photo-dots">${photos.map((_, i) =>
        `<button class="photo-dot${i === activePhotoIndex ? ' active' : ''}" data-index="${i}" aria-label="photo ${i + 1}"></button>`
      ).join('')}</div>`
    : '';
  const arrows = photos.length > 1
    ? `<button class="photo-nav photo-nav-prev" aria-label="previous photo">‹</button>
       <button class="photo-nav photo-nav-next" aria-label="next photo">›</button>`
    : '';

  photoEl.innerHTML = `
    <img src="${photos[activePhotoIndex]}" alt="${poiName(poi)}" draggable="false" onerror="this.parentElement.innerHTML='${poi.icon}'">
    ${arrows}
    ${dots}
  `;

  if (photos.length > 1) {
    photoEl.querySelector('.photo-nav-prev').addEventListener('click', e => {
      e.stopPropagation();
      activePhotoIndex--;
      renderPhotoCarousel(poi);
    });
    photoEl.querySelector('.photo-nav-next').addEventListener('click', e => {
      e.stopPropagation();
      activePhotoIndex++;
      renderPhotoCarousel(poi);
    });
    photoEl.querySelectorAll('.photo-dot').forEach(dot => {
      dot.addEventListener('click', e => {
        e.stopPropagation();
        activePhotoIndex = Number(dot.dataset.index);
        renderPhotoCarousel(poi);
      });
    });
  }
}

function showPoiCard(poi, opts = {}) {
  activePoi = poi;
  activePhotoIndex = 0;
  document.getElementById('poiName').textContent = poiName(poi);
  document.getElementById('poiText').textContent = poiText(poi);

  renderPhotoCarousel(poi);

  document.getElementById('poiCard').classList.remove('hidden');
  prepareNarration(poi, state.lang);

  if (opts.markVisit !== false) {
    markVisited(poi.id);
  }
}

function hidePoiCard() {
  document.getElementById('poiCard').classList.add('hidden');
  audioEl.pause();
  activePoi = null;
}

// Loads a POI's pre-rendered narration track and resets the transport UI to
// a paused, start-of-story position — but doesn't play a sound until the
// user presses play. Opening a card (by walking up to it or tapping the
// list) should never start talking on its own.
function prepareNarration(poi, lang) {
  audioEl.pause();
  audioEl.src = `assets/audio/${poi.id}_${lang}.mp3`;
  audioEl.currentTime = 0;
  audioEl.playbackRate = state.rate;
  updatePlaybackUI();
  updateMediaSessionMetadata(poi);
}

function togglePlayPause() {
  if (!audioEl.src) return;
  if (audioEl.paused) {
    const p = audioEl.play();
    if (p && p.catch) p.catch(e => console.warn('Playback failed', e));
  } else {
    audioEl.pause();
  }
}

function seekToFraction(fraction) {
  if (!audioEl.src || !isFinite(audioEl.duration)) return;
  audioEl.currentTime = fraction * audioEl.duration;
}

function restartPlayback() {
  if (!audioEl.src) return;
  audioEl.currentTime = 0;
  const p = audioEl.play();
  if (p && p.catch) p.catch(() => {});
}

function skipBy(deltaSeconds) {
  if (!audioEl.src || !isFinite(audioEl.duration)) return;
  audioEl.currentTime = Math.max(0, Math.min(audioEl.duration, audioEl.currentTime + deltaSeconds));
}

// While the user is dragging the seek slider, ignore the audio element's own
// timeupdate events so they don't fight the drag and snap the handle back.
let isScrubbing = false;

function updatePlaybackUI() {
  const playPauseBtn = document.getElementById('playPauseBtn');
  const slider = document.getElementById('progressSlider');
  if (!playPauseBtn || !slider) return; // card isn't open
  playPauseBtn.textContent = (!audioEl.paused && !audioEl.ended) ? '⏸' : '▶';
  if (isScrubbing) return;
  const duration = audioEl.duration;
  const frac = duration && isFinite(duration) ? Math.min(1, audioEl.currentTime / duration) : 0;
  slider.value = String(Math.round(frac * 1000));
}

function initAudioElement() {
  audioEl.addEventListener('play', () => {
    updatePlaybackUI();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  audioEl.addEventListener('pause', () => {
    updatePlaybackUI();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });
  audioEl.addEventListener('timeupdate', updatePlaybackUI);
  audioEl.addEventListener('ended', updatePlaybackUI);
  audioEl.addEventListener('loadedmetadata', updatePlaybackUI);
  audioEl.addEventListener('error', () => console.warn('Audio playback error', audioEl.error));
}

// Lets the phone's lock screen / notification shade show what's playing and
// offer real play/pause/seek controls — this is what actually makes
// narration survive a locked screen (speechSynthesis never could).
function updateMediaSessionMetadata(poi) {
  if (!('mediaSession' in navigator)) return;
  const artwork = poi.photos && poi.photos[0]
    ? [{ src: poi.photos[0], sizes: '512x512', type: 'image/jpeg' }]
    : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: poiName(poi),
    artist: t('appTitle'),
    album: 'Gozo · Comino · Malta',
    artwork
  });
}

function initMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play', () => {
    const p = audioEl.play();
    if (p && p.catch) p.catch(() => {});
  });
  navigator.mediaSession.setActionHandler('pause', () => audioEl.pause());
  navigator.mediaSession.setActionHandler('seekbackward', details => skipBy(-(details.seekOffset || 5)));
  navigator.mediaSession.setActionHandler('seekforward', details => skipBy(details.seekOffset || 5));
  navigator.mediaSession.setActionHandler('seekto', details => {
    if (details.seekTime != null) audioEl.currentTime = details.seekTime;
  });
}

function setRate(newRate) {
  state.rate = newRate;
  localStorage.setItem(STORAGE_KEYS.rate, String(newRate));
  const display = newRate.toFixed(2).replace(/0$/, '') + '×';
  const slider = document.getElementById('rateSliderCard');
  const value = document.getElementById('rateValueCard');
  if (slider) slider.value = String(newRate);
  if (value) value.textContent = display;
  // A real <audio> element's playbackRate can change live, mid-playback —
  // unlike speechSynthesis, no restart needed.
  audioEl.playbackRate = newRate;
}

// A short two-tone chime so a proximity trigger is noticeable even with the
// phone in a pocket. Synthesized on the spot — no audio file to precache.
function playChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = now + i * 0.14;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.02);
      gain.gain.linearRampToValueAtTime(0, start + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.16);
    });
    setTimeout(() => ctx.close(), 500);
  } catch (e) {
    console.warn('Chime failed', e);
  }
}

// ---------- Playback rate control ----------
function initRateControl() {
  setRate(state.rate); // sync the slider + label to the stored value
  const rateSliderCard = document.getElementById('rateSliderCard');
  if (rateSliderCard) {
    rateSliderCard.addEventListener('input', () => setRate(Number(rateSliderCard.value)));
  }
}

function initPoiCardControls() {
  document.getElementById('closeCardBtn').addEventListener('click', hidePoiCard);
  document.getElementById('backBtn').addEventListener('click', hidePoiCard);
  document.getElementById('nextBtn').addEventListener('click', hidePoiCard);
  document.getElementById('restartBtn').addEventListener('click', restartPlayback);
  document.getElementById('playPauseBtn').addEventListener('click', togglePlayPause);
  document.getElementById('skipBackBtn').addEventListener('click', () => skipBy(-5));
  document.getElementById('skipFwdBtn').addEventListener('click', () => skipBy(5));

  const slider = document.getElementById('progressSlider');
  slider.addEventListener('pointerdown', () => { isScrubbing = true; });
  slider.addEventListener('input', () => {
    seekToFraction(Number(slider.value) / 1000);
  });
  slider.addEventListener('pointerup', () => { isScrubbing = false; });

  initLightbox();
  initCarouselSwipe();
}

// ---------- Fullscreen photo viewer ----------
function initLightbox() {
  const lightbox = document.getElementById('photoLightbox');
  const img = document.getElementById('lightboxImg');
  document.getElementById('poiPhoto').addEventListener('click', e => {
    if (justSwiped) { justSwiped = false; return; } // a swipe shouldn't also open the lightbox
    const clickedImg = e.target.closest('img');
    if (!clickedImg) return; // clicks on nav arrows/dots shouldn't open the lightbox
    img.src = clickedImg.src;
    img.alt = clickedImg.alt;
    lightbox.classList.remove('hidden');
  });
  document.getElementById('lightboxCloseBtn').addEventListener('click', () => {
    lightbox.classList.add('hidden');
    img.src = '';
  });
  lightbox.addEventListener('click', e => {
    if (e.target === lightbox) {
      lightbox.classList.add('hidden');
      img.src = '';
    }
  });
}

// ---------- Carousel swipe gesture ----------
// Attached once to the (stable) #poiPhoto container — its children get
// replaced on every renderPhotoCarousel() call, so listeners live on the
// parent and read `activePoi` fresh each time instead of closing over it.
let swipeStartX = null;
let swipeStartY = null;
let justSwiped = false;

function initCarouselSwipe() {
  const photoEl = document.getElementById('poiPhoto');
  photoEl.addEventListener('pointerdown', e => {
    swipeStartX = e.clientX;
    swipeStartY = e.clientY;
  });
  photoEl.addEventListener('pointerup', e => {
    if (swipeStartX === null || !activePoi) return;
    const dx = e.clientX - swipeStartX;
    const dy = e.clientY - swipeStartY;
    swipeStartX = null;
    const photos = activePoi.photos || [];
    if (photos.length > 1 && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      justSwiped = true;
      activePhotoIndex += dx < 0 ? 1 : -1;
      renderPhotoCarousel(activePoi);
    }
  });
}

// ---------- Geolocation / Positioning ----------
function startPositioning() {
  if (state.simMode) {
    updateStatusLine();
  } else {
    startRealGps();
  }
  if (state.proximityTimer) clearInterval(state.proximityTimer);
  state.proximityTimer = setInterval(checkProximity, PROXIMITY_CHECK_MS);
}

function startRealGps() {
  if (!('geolocation' in navigator)) {
    updateStatusLine(t('statusRealGpsOff'));
    return;
  }
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = navigator.geolocation.watchPosition(
    pos => {
      state.currentPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      updateUserMarker(state.currentPos, pos.coords.heading);
      checkProximity();
    },
    err => {
      console.warn('Geolocation error', err);
      updateStatusLine(t('statusRealGpsOff'));
    },
    GEO_WATCH_OPTIONS
  );
}

function stopRealGps() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function checkProximity() {
  if (!state.currentPos) {
    updateStatusLine();
    return;
  }
  let nearest = null;
  let nearestDist = Infinity;

  state.pois.forEach(poi => {
    const dist = haversineMeters(state.currentPos.lat, state.currentPos.lng, poi.lat, poi.lng);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = poi;
    }
    const isInside = dist <= (poi.radius || state.radius);
    const wasInside = state.insideRadius.has(poi.id);
    if (isInside && !wasInside) {
      state.insideRadius.add(poi.id);
      const cardHidden = document.getElementById('poiCard').classList.contains('hidden');
      if (cardHidden) {
        playChime();
        showPoiCard(poi, { markVisit: true });
      }
    } else if (!isInside && wasInside) {
      state.insideRadius.delete(poi.id);
    }
  });

  if (nearest) {
    updateStatusLine(`${t('statusNear')} ${poiName(nearest)} (${Math.round(nearestDist)} ${t('distanceUnit')})`);
  } else {
    updateStatusLine();
  }
}

function updateStatusLine(customText) {
  const el = document.getElementById('statusLine');
  if (!el) return;
  el.textContent = customText || t('statusIdle');
}

// ---------- Dev / Simulation panel ----------
function initDevPanel() {
  const toggle = document.getElementById('devPanelToggle');
  const panel = document.getElementById('devPanel');
  toggle.addEventListener('click', () => panel.classList.toggle('collapsed'));

  const select = document.getElementById('simPoiSelect');
  select.innerHTML = state.pois
    .map(p => `<option value="${p.id}">${p.icon} ${poiName(p)}</option>`)
    .join('');

  const simCheckbox = document.getElementById('simModeCheckbox');
  simCheckbox.checked = state.simMode;
  simCheckbox.addEventListener('change', () => {
    state.simMode = simCheckbox.checked;
    localStorage.setItem(STORAGE_KEYS.simMode, String(state.simMode));
    if (state.simMode) {
      stopRealGps();
    } else {
      startRealGps();
    }
  });

  document.getElementById('teleportBtn').addEventListener('click', () => {
    const poi = state.pois.find(p => p.id === select.value);
    if (!poi) return;
    state.currentPos = { lat: poi.lat, lng: poi.lng };
    updateUserMarker(state.currentPos, null);
    checkProximity();
  });

  const radiusInput = document.getElementById('radiusInput');
  radiusInput.value = state.radius;
  radiusInput.addEventListener('change', () => {
    const val = Number(radiusInput.value) || DEFAULT_RADIUS;
    state.radius = val;
    localStorage.setItem(STORAGE_KEYS.radius, String(val));
    state.insideRadius.clear();
    checkProximity();
  });

  document.getElementById('resetProgressBtn').addEventListener('click', () => {
    state.visited = [];
    saveVisited();
    renderList();
    updateMarkerStyles();
  });
}

// ---------- Service worker ----------
let swRegistration = null;

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('sw.js').then(reg => {
    swRegistration = reg;
  }).catch(err => {
    console.warn('SW registration failed', err);
  });

  // Whenever a new service worker takes control (it calls skipWaiting() +
  // clients.claim() on its own), reload once so the page actually runs the
  // new app.js/index.html/css instead of silently staying on the old one —
  // this is what "update without having to force-quit the PWA" means here.
  //
  // clients.claim() also fires this same event the very FIRST time a page
  // gets a controller at all (a brand-new install, nothing to "update"
  // from) — skip that one, or every first-ever visit would reload itself
  // right back to the start screen mid-load.
  let hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

// Manual "check for updates" button: ask the browser to re-fetch sw.js right
// now instead of waiting for its normal (much less frequent) background
// check. If a new version installs, the controllerchange listener above
// reloads the page automatically.
async function checkForUpdates() {
  const btn = document.getElementById('checkUpdateBtn');
  if (btn) btn.classList.add('spinning');
  try {
    const reg = swRegistration || (await navigator.serviceWorker.getRegistration());
    if (reg) await reg.update();
  } catch (e) {
    console.warn('Update check failed', e);
  }
  setTimeout(() => { if (btn) btn.classList.remove('spinning'); }, 600);
}

// ---------- Boot ----------
(async function init() {
  try {
    await loadData();
  } catch (err) {
    console.error('Failed to load data/*.json', err);
    showFatalError();
    return;
  }
  initStartScreen();
  initTabs();
  initPoiCardControls();
  initRateControl();
  initAudioElement();
  initMediaSessionHandlers();
  applyStaticI18n();
  registerServiceWorker();
})();

function showFatalError() {
  const card = document.querySelector('.start-card');
  if (!card) return;
  const box = document.createElement('div');
  box.style.cssText = 'margin-top:16px;padding:12px;border-radius:10px;background:#fdecea;color:#c0392b;font-size:0.85rem;text-align:left;';
  box.innerHTML = `<strong>Не удалось загрузить данные (data/pois.json, data/i18n.json).</strong><br>
    Похоже, страница открыта напрямую из файла (file://), а браузер блокирует такие запросы.<br><br>
    Запусти локальный сервер из папки проекта, например:<br>
    <code>npx serve .</code> или <code>python -m http.server 8765</code><br>
    и открой предложенный им адрес (http://localhost:...).`;
  card.appendChild(box);
}
