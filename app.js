// ---------- Config ----------
const STORAGE_KEYS = {
  lang: 'mg_lang',
  visited: 'mg_visited',
  radius: 'mg_radius',
  simMode: 'mg_simMode',
  voiceRu: 'mg_voice_ru',
  voiceEn: 'mg_voice_en',
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
  voices: [], // cached SpeechSynthesisVoice[]
  voicePrefs: {
    ru: localStorage.getItem(STORAGE_KEYS.voiceRu) || null,
    en: localStorage.getItem(STORAGE_KEYS.voiceEn) || null
  },
  rate: Number(localStorage.getItem(STORAGE_KEYS.rate)) || 1,
  // Web Speech API has no real seekable timeline (it's synthesized live, not
  // a decoded audio file), so "seeking" means: remember roughly how far into
  // the sanitized text we've gotten (via onboundary word events) and, to
  // seek/resume/change rate, cancel and re-speak from that character offset.
  playback: { fullText: '', lang: 'ru', charIndex: 0, playing: false }
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
  document.getElementById('voiceSettingsLabel').textContent = t('voiceSettings');
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
  }
}

function updateLangToggleLabel() {
  const btn = document.getElementById('langToggleBtn');
  if (btn) btn.textContent = state.lang.toUpperCase();
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
  unlockSpeech(); // must be called synchronously inside the click handler
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
    <img src="${photos[activePhotoIndex]}" alt="${poiName(poi)}" onerror="this.parentElement.innerHTML='${poi.icon}'">
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
  speak(poiText(poi));

  if (opts.markVisit !== false) {
    markVisited(poi.id);
  }
}

function hidePoiCard() {
  document.getElementById('poiCard').classList.add('hidden');
  window.speechSynthesis.cancel();
  activePoi = null;
  state.playback.fullText = '';
  state.playback.charIndex = 0;
  state.playback.playing = false;
}

// Strips anything that reads awkwardly out loud (parenthetical asides, quote
// marks) from the TEXT-TO-SPEECH input only — the visible card text is untouched.
function sanitizeForSpeech(text) {
  return text
    .replace(/\([^)]*\)/g, ' ')   // (asides) — drop the whole aside
    .replace(/\[[^\]]*\]/g, ' ')  // [asides]
    .replace(/[«»""„"]/g, '')     // quote marks — keep the words, drop the marks
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Starts (or restarts) narration from scratch — used for POI text and for
// the short voice-preview samples in the settings screen.
function speak(text, langOverride) {
  if (!('speechSynthesis' in window) || !text) return;
  const lang = langOverride || state.lang;
  state.playback.fullText = sanitizeForSpeech(text);
  state.playback.lang = lang;
  state.playback.charIndex = 0;
  speakFrom(state.playback.fullText, lang, 0);
}

// The actual engine: speaks fullText starting at charOffset. Re-called
// whenever the user seeks, changes rate, or resumes after a pause that the
// browser didn't handle natively (iOS Safari's speechSynthesis.resume() is
// unreliable, so this is also the fallback path for that).
function speakFrom(fullText, lang, charOffset) {
  if (!('speechSynthesis' in window) || !fullText) return;
  window.speechSynthesis.cancel();
  const remaining = fullText.slice(charOffset);
  if (!remaining) {
    state.playback.playing = false;
    updatePlaybackUI();
    return;
  }
  const utter = new SpeechSynthesisUtterance(remaining);
  utter.lang = lang === 'ru' ? 'ru-RU' : 'en-US';
  const voice = pickVoiceFor(lang);
  if (voice) utter.voice = voice;
  utter.rate = state.rate;
  utter.onstart = () => {
    state.playback.playing = true;
    updatePlaybackUI();
  };
  utter.onboundary = e => {
    state.playback.charIndex = charOffset + e.charIndex;
    updatePlaybackUI();
  };
  utter.onend = () => {
    // onend also fires when we cancel() to seek/restart elsewhere — only
    // treat it as "finished" if we actually reached the end of the text.
    if (state.playback.charIndex >= fullText.length - 1) {
      state.playback.playing = false;
      updatePlaybackUI();
    }
  };
  utter.onerror = () => {
    state.playback.playing = false;
    updatePlaybackUI();
  };
  window.speechSynthesis.speak(utter);
}

// Snaps a raw character offset to the start of the nearest word, so seeking
// never begins mid-word.
function nearestWordStart(text, targetIndex) {
  const re = /\S+/g;
  let match;
  let best = 0;
  while ((match = re.exec(text))) {
    if (match.index <= targetIndex) best = match.index;
    else break;
  }
  return best;
}

function togglePlayPause() {
  const pb = state.playback;
  if (!pb.fullText) return;

  if (pb.playing) {
    try { window.speechSynthesis.pause(); } catch (e) {}
    pb.playing = false;
    updatePlaybackUI();
    return;
  }

  if (window.speechSynthesis.paused) {
    window.speechSynthesis.resume();
    pb.playing = true;
    updatePlaybackUI();
    // Safety net: iOS Safari sometimes silently fails to resume. If speech
    // still isn't flowing shortly after, rebuild the utterance manually.
    setTimeout(() => {
      if (pb.playing && !window.speechSynthesis.speaking) {
        speakFrom(pb.fullText, pb.lang, pb.charIndex);
      }
    }, 300);
  } else {
    speakFrom(pb.fullText, pb.lang, pb.charIndex);
  }
}

function seekToFraction(fraction) {
  const pb = state.playback;
  if (!pb.fullText) return;
  const target = Math.floor(fraction * pb.fullText.length);
  const snapped = nearestWordStart(pb.fullText, target);
  pb.charIndex = snapped;
  speakFrom(pb.fullText, pb.lang, snapped);
}

function restartPlayback() {
  const pb = state.playback;
  if (!pb.fullText) return;
  pb.charIndex = 0;
  speakFrom(pb.fullText, pb.lang, 0);
}

function updatePlaybackUI() {
  const playPauseBtn = document.getElementById('playPauseBtn');
  const slider = document.getElementById('progressSlider');
  if (!playPauseBtn || !slider) return; // card isn't open
  playPauseBtn.textContent = state.playback.playing ? '⏸' : '▶';
  const total = state.playback.fullText.length || 1;
  const frac = Math.min(1, state.playback.charIndex / total);
  slider.value = String(Math.round(frac * 1000));
}

function setRate(newRate) {
  state.rate = newRate;
  localStorage.setItem(STORAGE_KEYS.rate, String(newRate));
  const display = newRate.toFixed(2).replace(/0$/, '') + '×';
  const s1 = document.getElementById('rateSlider');
  const s2 = document.getElementById('rateSliderCard');
  const v1 = document.getElementById('rateValue');
  const v2 = document.getElementById('rateValueCard');
  if (s1) s1.value = String(newRate);
  if (s2) s2.value = String(newRate);
  if (v1) v1.textContent = display;
  if (v2) v2.textContent = display;
  // Rate can't change mid-utterance — restart from the current spot at the new rate.
  if (state.playback.playing) {
    speakFrom(state.playback.fullText, state.playback.lang, state.playback.charIndex);
  }
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

  setRate(state.rate); // sync both sliders + labels to the stored value

  const rateSlider = document.getElementById('rateSlider');
  if (rateSlider) {
    rateSlider.addEventListener('input', () => setRate(Number(rateSlider.value)));
  }
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

  const slider = document.getElementById('progressSlider');
  slider.addEventListener('change', () => {
    seekToFraction(Number(slider.value) / 1000);
  });

  initLightbox();
}

// ---------- Fullscreen photo viewer ----------
function initLightbox() {
  const lightbox = document.getElementById('photoLightbox');
  const img = document.getElementById('lightboxImg');
  document.getElementById('poiPhoto').addEventListener('click', e => {
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
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
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
