# MaltaGuide

Offline-first PWA audio guide for a Gozo/Comino/Malta trip (12–16 Sep 2026). Vanilla HTML/JS/CSS, Leaflet + OSM tiles, browser Web Speech API for narration, geolocation-triggered POI cards. No backend, no build step, no API keys. Deployed via GitHub Pages at https://dexxrat.github.io/maltaGuide/ (push to `main` auto-publishes in ~1–2 min).

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
- Don't worry about parentheses or quote marks in the text — `sanitizeForSpeech()` in app.js already strips those from what actually gets spoken; write the display text naturally.

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
- `sw.js` — **nothing to do here**: it reads `data/pois.json` at install time and precaches whatever's in every `photos[]` array automatically. Just bump `CACHE_NAME` (e.g. v11 → v12) so already-cached devices actually pick up the change.
- Run the verify script — must be 0 failures before committing.
- Commit, push to `main`, then poll `curl -s https://dexxrat.github.io/maltaGuide/sw.js | grep CACHE_NAME` until the new version string shows up before telling the user it's live.

## Testing / dev mode

The GPS simulator panel only appears when the URL has `?dev=1` (e.g. `http://localhost:8765/?dev=1` or `https://dexxrat.github.io/maltaGuide/?dev=1`). Without that flag, the panel is hidden and simulation mode is force-disabled regardless of what's saved in localStorage — the end user (the brother, on his iPhone) should never be able to see or accidentally toggle it. Don't remove this gate; it exists because simulation-mode-on-by-default was a real bug once that made real GPS silently not work.

For local testing before pushing: any static file server works (`python -m http.server`, `npx serve .`) — but iOS Safari requires a secure context (HTTPS or `localhost`) for Geolocation and Service Worker, so testing over a LAN IP from a phone needs an HTTPS tunnel (e.g. `npx localtunnel --port <port>`), not a bare `http://192.168.x.x`.

## Known limitations (platform, not budget)

- No background operation: iOS Safari/PWA cannot run geolocation callbacks while the screen is off or the app is backgrounded — this is an iOS platform restriction, not something fixable by more engineering. The phone must stay unlocked with the app in the foreground while walking.
- No Vibration API on iOS Safari at all — the proximity chime (Web Audio API beep) is the cross-platform substitute, not a fallback for a "better" haptic option.
- Seeking within narration is word-granular, not time-granular — Web Speech API has no decoded audio buffer to seek within, only a live synthesis stream. `speakFrom()` in app.js re-synthesizes from the nearest word boundary; that's the ceiling of what's possible here, not a shortcut.
