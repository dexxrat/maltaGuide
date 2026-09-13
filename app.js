// ---------- Config ----------
const STORAGE_KEYS = {
  lang: 'mg_lang',
  visited: 'mg_visited',
  radius: 'mg_radius',
  simMode: 'mg_simMode',
  voiceRu: 'mg_voice_ru',
  voiceEn: 'mg_voice_en'
};

const DEFAULT_RADIUS = 150;
const GEO_WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 };
const PROXIMITY_CHECK_MS = 3000;

// ---------- State ----------
let state = {
  lang: localStorage.getItem(STORAGE_KEYS.lang) || 'ru',
  visited: JSON.parse(localStorage.getItem(STORAGE_KEYS.visited) || '[]'),
  radius: Number(localStorage.getItem(STORAGE_KEYS.radius)) || DEFAULT_RADIUS,
  simMode: localStorage.getItem(STORAGE_KEYS.simMode) !== 'false', // default true (simulation on)
  pois: [],
  i18n: null,
  map: null,
  markers: {},
  currentPos: null, // {lat, lng}
  watchId: null,
  proximityTimer: null,
  insideRadius: new Set(), // ids currently inside radius (to avoid re-trigger spam)
  audioUnlocked: false,
  voices: [], // cached SpeechSynthesisVoice[]
  voicePrefs: {
    ru: localStorage.getItem(STORAGE_KEYS.voiceRu) || null,
    en: localStorage.getItem(STORAGE_KEYS.voiceEn) || null
  }
};

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
  document.getElementById('replayBtn').textContent = t('replayBtn');
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
      state.lang = btn.dataset.lang;
      localStorage.setItem(STORAGE_KEYS.lang, state.lang);
      document.querySelectorAll('.lang-btn').forEach(b => b.classList.toggle('active', b === btn));
      applyStaticI18n();
    });
  });

  document.getElementById('startBtn').addEventListener('click', onStart);
}

function unlockSpeech() {
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
    state.audioUnlocked = true;
  } catch (e) {
    console.warn('Speech unlock failed', e);
  }
}

function onStart() {
  unlockSpeech(); // must be called synchronously inside the click handler
  document.getElementById('startScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
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
        <div class="poi-item-status ${visited ? 'visited' : 'not-visited'}">
          ${visited ? '✅ ' + t('visitedLabel') : '⬜ ' + t('notVisitedLabel')}
        </div>
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
}

// ---------- POI Card ----------
let activePoi = null;

function showPoiCard(poi, opts = {}) {
  activePoi = poi;
  document.getElementById('poiName').textContent = poiName(poi);
  document.getElementById('poiText').textContent = poiText(poi);

  const photoEl = document.getElementById('poiPhoto');
  if (poi.photos && poi.photos.length) {
    photoEl.innerHTML = `<img src="${poi.photos[0]}" alt="${poiName(poi)}" onerror="this.parentElement.innerHTML='${poi.icon}'">`;
  } else {
    photoEl.innerHTML = poi.icon;
  }

  document.getElementById('poiCard').classList.remove('hidden');
  speak(poiText(poi));

  if (opts.markVisit !== false) {
    markVisited(poi.id);
  }
}

function hidePoiCard() {
  document.getElementById('poiCard').classList.add('hidden');
  window.speechSynthesis.cancel();
  activePoi = null;
}

function speak(text, langOverride) {
  if (!('speechSynthesis' in window) || !text) return;
  const lang = langOverride || state.lang;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang === 'ru' ? 'ru-RU' : 'en-US';
  const voice = pickVoiceFor(lang);
  if (voice) utter.voice = voice;
  window.speechSynthesis.speak(utter);
}

// ---------- Voice selection (pick the best free voice available on this device) ----------

// Names of Apple/other "novelty" voices we never want to auto-pick (fine if user picks manually).
const NOVELTY_VOICE_NAMES = [
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'good news',
  'jester', 'organ', 'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox', 'eddy',
  'flo', 'grandma', 'grandpa', 'reed', 'rocko', 'sandy', 'shelley'
];

// Names of known high-quality human-like voices across platforms.
const GOOD_VOICE_NAMES = [
  'samantha', 'daniel', 'karen', 'moira', 'tessa', 'ava', 'evan', 'nicky', 'aaron',
  'milena', 'yuri', 'irina', 'pavel', 'google us english', 'google uk english',
  'natasha', 'aria', 'guy', 'jenny'
];

function voiceScore(voice) {
  const name = voice.name.toLowerCase();
  let score = 0;

  if (NOVELTY_VOICE_NAMES.some(n => name.includes(n))) return -1000; // never auto-pick these

  if (/natural/.test(name)) score += 100;   // Windows 11 "Online (Natural)" neural voices
  if (/neural/.test(name)) score += 100;
  if (/enhanced|premium/.test(name)) score += 90; // iOS downloaded high-quality voices
  if (/online/.test(name)) score += 15;
  if (voice.localService === false) score += 10; // network voices are usually higher quality
  if (GOOD_VOICE_NAMES.some(n => name.includes(n))) score += 20;
  if (/desktop$/.test(name)) score -= 15; // old legacy SAPI voices (e.g. "Microsoft David Desktop")

  return score;
}

function votesForLang(lang) {
  const prefix = lang === 'ru' ? 'ru' : 'en';
  return state.voices
    .filter(v => v.lang && v.lang.toLowerCase().startsWith(prefix))
    .sort((a, b) => voiceScore(b) - voiceScore(a));
}

function bestVoiceFor(lang) {
  const sorted = votesForLang(lang);
  return sorted[0] || null;
}

function pickVoiceFor(lang) {
  const preferredUri = state.voicePrefs[lang];
  if (preferredUri) {
    const found = state.voices.find(v => v.voiceURI === preferredUri);
    if (found) return found;
  }
  return bestVoiceFor(lang);
}

function loadVoices() {
  return new Promise(resolve => {
    if (!('speechSynthesis' in window)) return resolve([]);
    const existing = window.speechSynthesis.getVoices();
    if (existing.length) {
      resolve(existing);
      return;
    }
    let resolved = false;
    window.speechSynthesis.onvoiceschanged = () => {
      if (resolved) return;
      resolved = true;
      resolve(window.speechSynthesis.getVoices());
    };
    // Some browsers/webviews never fire voiceschanged reliably — fall back after a short wait.
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      resolve(window.speechSynthesis.getVoices());
    }, 1500);
  });
}

function populateVoicePickers() {
  ['ru', 'en'].forEach(lang => {
    const select = document.getElementById(lang === 'ru' ? 'voiceSelectRu' : 'voiceSelectEn');
    if (!select) return;
    const options = votesForLang(lang);
    if (!options.length) {
      select.innerHTML = `<option value="">—</option>`;
      select.disabled = true;
      return;
    }
    select.disabled = false;
    select.innerHTML = options
      .map(v => `<option value="${v.voiceURI}">${v.name}${v.localService ? '' : ' 🌐'}</option>`)
      .join('');
    const preferred = state.voicePrefs[lang];
    const hasPreferred = preferred && options.some(v => v.voiceURI === preferred);
    select.value = hasPreferred ? preferred : options[0].voiceURI;
    if (!hasPreferred) {
      state.voicePrefs[lang] = options[0].voiceURI;
      localStorage.setItem(lang === 'ru' ? STORAGE_KEYS.voiceRu : STORAGE_KEYS.voiceEn, options[0].voiceURI);
    }
  });
}

function initVoicePickers() {
  ['ru', 'en'].forEach(lang => {
    const select = document.getElementById(lang === 'ru' ? 'voiceSelectRu' : 'voiceSelectEn');
    const testBtn = document.getElementById(lang === 'ru' ? 'testVoiceRuBtn' : 'testVoiceEnBtn');
    if (select) {
      select.addEventListener('change', () => {
        state.voicePrefs[lang] = select.value;
        localStorage.setItem(lang === 'ru' ? STORAGE_KEYS.voiceRu : STORAGE_KEYS.voiceEn, select.value);
      });
    }
    if (testBtn) {
      testBtn.addEventListener('click', () => {
        state.audioUnlocked = true;
        const sample = lang === 'ru'
          ? 'Привет! Это пример голоса для гида.'
          : 'Hello! This is a sample of the guide voice.';
        speak(sample, lang);
      });
    }
  });
}

function initPoiCardControls() {
  document.getElementById('closeCardBtn').addEventListener('click', hidePoiCard);
  document.getElementById('nextBtn').addEventListener('click', hidePoiCard);
  document.getElementById('replayBtn').addEventListener('click', () => {
    if (activePoi) speak(poiText(activePoi));
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
    const isInside = dist <= state.radius;
    const wasInside = state.insideRadius.has(poi.id);
    if (isInside && !wasInside) {
      state.insideRadius.add(poi.id);
      const cardHidden = document.getElementById('poiCard').classList.contains('hidden');
      if (cardHidden) {
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

  if (!state.simMode) startRealGps();
}

// ---------- Service worker ----------
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('SW registration failed', err);
    });
  }
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
  initVoicePickers();
  applyStaticI18n();
  registerServiceWorker();

  // Voice list can load asynchronously (especially in Chrome) — wait for it,
  // then fill in the RU/EN voice pickers and re-populate whenever the OS
  // reports new/changed voices (e.g. after downloading a language pack).
  if ('speechSynthesis' in window) {
    state.voices = await loadVoices();
    populateVoicePickers();
    window.speechSynthesis.onvoiceschanged = () => {
      state.voices = window.speechSynthesis.getVoices();
      populateVoicePickers();
    };
  }
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
