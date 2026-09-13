# MaltaGuide

Offline-first PWA audio guide for a Gozo/Comino/Malta trip (12–16 Sep 2026). Vanilla HTML/JS/CSS, Leaflet + OSM tiles, pre-rendered `<audio>` narration (see "Narration audio" below) with geolocation-triggered POI cards. No backend, no build step, no API keys. Deployed via GitHub Pages at https://dexxrat.github.io/maltaGuide/ (push to `main` auto-publishes in ~1–2 min).

## Adding new POIs

This is the recurring task on this project — a fixed process, not a fresh decision each time.

**1. Find real candidates near an anchor point**, free, no key, via OpenStreetMap Overpass:
```
[out:json][timeout:25];
(
  node(around:700,LAT,LNG)["historic"];
  node(around:700,LAT,LNG)["tourism"~"viewpoint|attraction|artwork"];
  node(around:700,LAT,LNG)["amenity"="place_of_worship"];
  node(around:700,LAT,LNG)["man_made"="tower"];
  node(around:700,LAT,LNG)["natural"="cave_entrance"];
);
out body 40;
```
POST as `data=<query>` to `https://overpass-api.de/api/interpreter`. Widen the radius (900–1200m) if nothing interesting turns up. Only add a POI when there's a real name/story behind it — a bare unnamed `tourism=viewpoint` dot isn't worth a card.

**2. Verify every fact against at least two independent sources before writing a word.** This is the step that actually catches errors — in this project it caught: a coordinate that needed Wikidata cross-checking, a whole extra chapter of history (the 1733 corsair raid on Ta' Mixta) that wasn't in the first source found, and a duplicated/garbled artist name from a scraped credit field. Use:
- Wikipedia REST summary (`/api/rest_v1/page/summary/<Title>`) for a quick check, then `action=query&prop=extracts&explaintext` for the full article — summaries routinely omit the specific dates/numbers/names worth including.
- Wikidata (`Special:EntityData/<QID>.json`, claim `P625` for coordinates) — more precise than OSM node coordinates when both exist; prefer Wikidata's.
- A second independent web source (WebSearch/WebFetch) for anything load-bearing (a specific date, a body count, a name) that only appeared once — don't repeat a number you've only seen in one place.
- Never invent a date, name, or number. If the sourcing is thin, write shorter and more modest rather than filling the gap with something invented.

**3. Coordinates and radius:**
- Prefer Wikidata P625 > OSM node > Nominatim geocoding, in that order of trust.
- Mark `coordsVerified: true/false` and a `coordsNote` explaining exactly where the number came from and any caveat.
- Default trigger radius is 150m (`_meta.defaultRadiusMeters`, checkProximity in app.js falls back to it). If a new POI sits within ~150m of an existing one, either that's a real-world fact worth noting (a big beach anchor legitimately contains a small ruin inside its zone — document it, don't fight it) or, for two similarly-sized nearby POIs, give both a smaller custom `radius` override in pois.json so they don't compete. Run `scratchpad/verify_all_pois.js` (or wherever it currently lives — recreate it from this description if it's gone) to check self-distance and cross-POI overlaps before committing.

**4. Writing the text (RU + EN, written separately in each language, not translated):**
- Length: 150–250 words for a routine/secondary stop, 250–350 words for a "headline" stop (the main reason someone is walking to this cluster at all) — matches izi.TRAVEL's own published guidance.
- Structure: hook tied to what the listener sees right now → concrete fact with real specifics (dates, names, numbers) → one surprising/human detail → soft close, ideally pointing toward whatever's physically next nearby.
- Conversational, spoken-aloud tone, addressing the listener directly (ты/you). No bullet lists, no dry fact-dumps, no subheadings inside the text — it's one continuous thing to be read aloud.
- Don't worry about parentheses or quote marks in the text — the sanitize step in `scratchpad/generate_audio.py` strips those from what actually gets narrated (same character set `sanitizeForSpeech()` used to strip client-side, before the switch to pre-rendered audio); write the display text naturally.
- **After editing or adding text in `i18n.json`, regenerate that POI's audio** — see "Narration audio" below. The display text and the spoken audio are two separate artifacts now; editing one does not update the other automatically.

**5. Photos:**
- Wikimedia Commons only, free license (CC0 / CC BY / CC BY-SA / PD) — check the `LicenseShortName` in `extmetadata`, don't guess from the filename.
- `scratchpad/fetch_photos.py` (recreate if missing) has `search_candidates(term)` and `download_and_normalize(url, out_path, max_width=1600)` helpers — search Commons, then **visually inspect the downloaded image with Read before committing to it**. Titles and search relevance lie; a "battery" search has returned a cathedral interior and a random rock formation in this project before.
- 1600px max width, quality ~85, is the established size/quality budget (check current total in `assets/photos/` — keep it reasonable for an offline PWA download, currently ~9MB for 24 POIs and ~30 photos).
- A POI can carry more than one photo (`photos: [...]` array) — the card renders a carousel automatically. A second/third photo is worth the extra search time for a headline POI: a different angle, a historical photo/map/engraving from when the thing still existed, or (for myth-based POIs) a relevant public-domain painting/artwork depicting the story itself.
- Every photo needs a `photo_credits.json` entry (array of `{title, artist, license, source}` per POI id, in `photos[]` order) and a `CREDITS.md` line — required by the CC BY/CC BY-SA terms, not optional bookkeeping.

**6. Wiring it in, in this order:**
- `data/pois.json` — new entry (id, name, category, icon, lat, lng, radius?, coordsVerified, coordsNote, photos[]).
- `data/i18n.json` — `ru.pois.<id>.text` and `en.pois.<id>.text`.
- `data/photo_credits.json` + regenerate `CREDITS.md`.
- Run `scratchpad/generate_audio.py` (recreate from the "Narration audio" section below if it's gone) to render `assets/audio/<id>_ru.mp3` and `assets/audio/<id>_en.mp3` for the new POI — it skips files that already exist, so it's safe to re-run for the whole project any time.
- `sw.js` — **nothing to do here**: it reads `data/pois.json` at install time and precaches whatever's in every `photos[]` array and every POI's two audio files automatically. Just bump `CACHE_NAME` (e.g. v16 → v17) so already-cached devices actually pick up the change.
- Run the verify script — must be 0 failures before committing.
- Commit, push to `main`, then poll `curl -s https://dexxrat.github.io/maltaGuide/sw.js | grep CACHE_NAME` until the new version string shows up before telling the user it's live.

## Testing / dev mode

The GPS simulator panel only appears when the URL has `?dev=1` (e.g. `http://localhost:8765/?dev=1` or `https://dexxrat.github.io/maltaGuide/?dev=1`). Without that flag, the panel is hidden and simulation mode is force-disabled regardless of what's saved in localStorage — the end user (the brother, on his iPhone) should never be able to see or accidentally toggle it. Don't remove this gate; it exists because simulation-mode-on-by-default was a real bug once that made real GPS silently not work.

For local testing before pushing: any static file server works (`python -m http.server`, `npx serve .`) — but iOS Safari requires a secure context (HTTPS or `localhost`) for Geolocation and Service Worker, so testing over a LAN IP from a phone needs an HTTPS tunnel (e.g. `npx localtunnel --port <port>`), not a bare `http://192.168.x.x`.

## Narration audio (pre-rendered, not live TTS)

Narration used to be spoken live by the browser's Web Speech API (`speechSynthesis`), which had two real ceilings: no true seekable timeline (only word-granular position from `onboundary` events) and — the bigger one — it cannot speak at all with the screen locked or the app backgrounded on either iOS or Android, a browser policy, not a bug. Both are fixed by pre-rendering real audio files instead:

- **Generation**: `scratchpad/generate_audio.py` (recreate from this description if it's gone) reads `data/pois.json` + `data/i18n.json`, applies the same sanitize step `sanitizeForSpeech()` used to do client-side (strip `(parentheticals)`, `[brackets]`, and quote marks), and calls `edge-tts` (free, unofficial, no API key — taps Microsoft Edge's "Read Aloud" neural TTS backend via `pip install edge-tts`) to render `assets/audio/<id>_ru.mp3` and `assets/audio/<id>_en.mp3` for every POI. It's idempotent (skips files that already exist), so re-run it any time after adding/editing text — nothing needs deleting first, just remove the specific `<id>_<lang>.mp3` file(s) you want regenerated.
- **Voices**: one fixed voice per language, chosen by listening to samples (not the old per-visitor picker) — `ru-RU-SvetlanaNeural` for Russian, `en-US-AriaNeural` for English. Both hardcoded in the `VOICES` dict at the top of `generate_audio.py`. Swapping either is a one-line change + delete the affected `assets/audio/*_<lang>.mp3` files + re-run.
- **Playback engine** (`app.js`): one shared `const audioEl = new Audio()`. `prepareNarration(poi, lang)` sets `audioEl.src` to the right file and resets to paused/0:00 — opening a card, or walking up to one, never auto-plays. Play/pause/restart/±5s-skip/seek-slider are now thin wrappers over `audioEl.play()/.pause()/.currentTime` — real, accurate, no estimation. Speed changes (`setRate`) set `audioEl.playbackRate` live, no restart needed (unlike `speechSynthesis`, which had to restart the utterance to change rate).
- **Background/lock-screen playback**: `initMediaSessionHandlers()` wires `navigator.mediaSession` play/pause/seekbackward/seekforward/seekto action handlers, and `updateMediaSessionMetadata()` sets title/artwork per POI — this is what actually makes narration keep playing with the screen locked, and shows proper lock-screen transport controls. Geolocation-triggered auto-opening of the *next* card still requires the app in the foreground (see below) — this only fixes continuing to listen to the *current* one after locking the phone.
- **Size**: ~18MB total for 34 POIs × 2 languages (mp3, one fixed voice each) — precached by `sw.js` (`getAudioUrls()`) alongside photos and map tiles, same "derive from pois.json, nothing hand-maintained" pattern.
- **Unlocking `<audio>` on iOS**: `unlockAudio()` plays a silent embedded WAV through the *same* shared `audioEl` synchronously inside the start button's click handler — iOS Safari only requires the *first* play of a given media element to originate from a user gesture; every later programmatic `.play()` on that same element (even from a Media Session handler with the screen locked) then works.

## Known limitations (platform, not budget)

- No background operation for *new* geo-triggers: iOS Safari/PWA cannot run geolocation callbacks while the screen is off or the app is backgrounded — this is an iOS platform restriction, not something fixable by more engineering. The phone must stay unlocked with the app in the foreground for a POI card to auto-open on arrival. (Audio already playing when the screen locks is a separate matter — see "Narration audio" above — that part does now keep working.)
- No Vibration API on iOS Safari at all — the proximity chime (Web Audio API beep) is the cross-platform substitute, not a fallback for a "better" haptic option.

## Offline map tiles

`sw.js` precaches OpenStreetMap tiles for a ~1.5km buffer around every POI in `pois.json`, at zoom 12–16 (`TILE_ZOOM_MIN`/`TILE_ZOOM_MAX`/`TILE_BUFFER_KM` constants) — computed from POI coordinates at install time, not a hand-maintained list, so it grows automatically as POIs are added. Currently ~676 tiles / ~11MB. The subdomain each tile URL uses (`a`/`b`/`c`) must match Leaflet's own `_getSubdomain` selection (`Math.abs(x+y) % 3`) — `subdomainFor()` in sw.js mirrors that formula on purpose, so the precached URL is the exact one Leaflet requests at runtime and actually hits the cache. If the buffer/zoom range ever needs revisiting (bigger area, more detail), re-run the estimate first — tile count roughly doubles per extra zoom level.
