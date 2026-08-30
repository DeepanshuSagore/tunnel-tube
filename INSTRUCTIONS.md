# TunnelTube

**Tunnel vision for YouTube.** A Chrome extension that, when toggled on, collapses all of
YouTube down to one topic — or one single playlist — and nothing else.

Built for the case where you already know what you're supposed to be watching (e.g. a DSA
interview-prep playlist from one channel) and you want YouTube to stop offering you anything
else.

---

## 1. What it does

The extension has a master toggle and two mutually exclusive lock modes.

### Mode A — Topic Lock (soft tunnel)

YouTube stays usable, but only shows content matching your topic profile.

| Surface | Behaviour when locked |
|---|---|
| Home feed (`/`) | Only videos matching the topic profile survive; everything else is removed from the DOM |
| Sidebar / "Up next" (`/watch`) | Filtered the same way |
| Search results | Filtered; the query itself may also be auto-scoped (append topic keywords) |
| Shorts (`/shorts/*`) | Blocked entirely — redirect to the allowed home |
| Watching a non-matching video | Interstitial overlay: "Not part of your tunnel" + Back / Go to playlist |
| End screens, "Related", comments (optional) | Hidden via CSS |

A "topic profile" is: a list of **keywords** + a list of **allowed channels** + optionally a
**seed playlist** whose video titles/channel are auto-imported as keywords.

### Mode B — Playlist Lock (hard tunnel)

The strict one. When enabled, *any* YouTube URL that isn't part of the chosen playlist is
redirected to the playlist itself.

- Opening `youtube.com` → immediately lands on `youtube.com/playlist?list=<ID>`.
- `/watch?v=X` is allowed **only** if `list=<ID>` is in the URL *and* `X` is in the playlist's
  cached video-ID set.
- Home, Shorts, Explore, Subscriptions, Search, channel pages → all redirect back to the playlist.
- The rest of the YouTube chrome (guide sidebar, notification bell, avatar menu) is hidden with CSS
  so there's nothing to click away to.

### Cross-cutting

- **Master toggle** in the popup — one click, no page reload needed.
- **Session/allowance rules** (optional, Stage 7): a "5 minute escape hatch" that requires typing
  a confirmation phrase, plus an optional lock timer that prevents disabling until N minutes pass.
- **Badge**: `ON` (green) / off (grey) on the toolbar icon.

### Explicit non-goals

- This is a *self-discipline* tool, not parental control or DRM. Anyone with access to
  `chrome://extensions` can disable it. Do not pretend otherwise in the store listing.
- No account, no server, no analytics. All state lives in `chrome.storage.sync`.
- No YouTube Data API key required for the core product (see Stage 5 for the two options).

---

## 2. Tech decisions (decide these before writing code)

| Question | Decision | Why |
|---|---|---|
| Manifest version | **MV3** | MV2 is dead in Chrome; the Web Store won't accept it. |
| Build step | **None.** Plain HTML/CSS/JS, ES modules. | Keeps `load unpacked` instant, no bundler to debug. Add Vite later only if you outgrow it. |
| Background | Service worker (`background.js`) | MV3 has no persistent page. Assume it can be killed at any time → never keep state in a module-level variable, always read `chrome.storage`. |
| Redirects | `chrome.webNavigation` + `chrome.tabs.update` (Stage 4), *not* `declarativeNetRequest` | YouTube is an SPA — most navigation is `history.pushState`, which DNR never sees. `onHistoryStateUpdated` does. |
| Filtering | Content script + `MutationObserver` | Feed items are injected lazily as you scroll. |
| Storage | `chrome.storage.sync` for settings, `chrome.storage.local` for the playlist video-ID cache | `sync` has an 8 KB per-item limit; a 300-video playlist cache won't fit. |
| Permissions | `storage`, `tabs`, `webNavigation`, host permission for `*://*.youtube.com/*` | Ask for nothing else — every extra permission slows down store review. |

---

## 3. Target file layout

```
tunnel-tube/
├── INSTRUCTIONS.md          # this file
├── README.md                # written at Stage 9
├── manifest.json
├── src/
│   ├── background.js        # service worker: navigation gate, badge, messaging
│   ├── storage.js           # single source of truth for settings read/write (ES module)
│   ├── matcher.js           # pure functions: does this video/URL pass the tunnel?
│   ├── content/
│   │   ├── content.js       # DOM filtering, observer, interstitial overlay
│   │   └── content.css      # hiding rules for chrome/shelves/shorts
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js         # master toggle + mode switch + "open my playlist"
│   └── options/
│       ├── options.html
│       ├── options.css
│       └── options.js       # keywords, channels, playlist ID, import-from-playlist
├── icons/
│   ├── icon16.png  icon32.png  icon48.png  icon128.png
└── test/
    └── matcher.test.mjs     # node --test, pure logic only
```

**Rule:** `matcher.js` must stay pure (no `chrome.*`, no DOM). That's the only part worth unit
testing, and it's the part that will actually have bugs.

---

## 4. Settings schema

Freeze this early; everything else keys off it.

```js
// chrome.storage.sync
{
  version: 1,
  enabled: false,                  // master toggle
  mode: "topic",                   // "topic" | "playlist"
  topic: {
    label: "DSA",
    keywords: ["dsa", "leetcode", "binary search", "dynamic programming"],
    channels: ["takeUforward", "NeetCode"],   // matched case-insensitively, substring
    blockShorts: true,
    scopeSearch: true,             // append topic label to search queries
    hideComments: false
  },
  playlist: {
    id: "PLxxxxxxxxxxxx",          // the list= value
    title: "Striver A2Z DSA",
    strict: true                   // true = redirect everything, false = just gate /watch
  },
  guard: {
    minSessionMinutes: 0,          // 0 = can disable any time
    lockedUntil: null              // epoch ms; popup refuses to disable before this
  }
}

// chrome.storage.local
{ playlistCache: { id, fetchedAt, videoIds: ["abc123", ...], titles: {...} } }
```

---

## 5. Build stages

Do them in order. Each stage ends in something you can load into Chrome and see working — don't
batch two stages before testing.

### Stage 0 — Groundwork *(~15 min)*
1. `cd tunnel-tube`, `git init`, add a `.gitignore` (`.DS_Store`, `*.zip`, `node_modules/`).
2. Generate the four icon PNGs (16/32/48/128). A flat tunnel/arrow glyph on a solid ground is
   plenty; make sure it's legible at 16px.
3. Write `manifest.json` (Stage 1) and confirm `chrome://extensions` loads it with zero errors.

### Stage 1 — Skeleton that loads *(~30 min)*
- `manifest.json` with `manifest_version: 3`, name, version `0.1.0`, icons, `action` (popup),
  `options_page`, `background.service_worker` (type: module), `content_scripts` matching
  `*://www.youtube.com/*` at `document_start`, and the permissions from §2.
- Stub `popup.html` showing "TunnelTube" and a checkbox that does nothing yet.
- **Checkpoint:** load unpacked → icon appears → popup opens → no console errors in the service
  worker inspector.

### Stage 2 — Settings plumbing *(~1 h)*
- `storage.js`: `getSettings()`, `setSettings(patch)` (shallow-merge + write), `onSettingsChanged(cb)`
  wrapping `chrome.storage.onChanged`, and a `DEFAULTS` object matching §4.
- Popup: master toggle + mode radio, both wired to storage, state restored on open.
- Background: on `chrome.storage.onChanged`, update `chrome.action.setBadgeText` / `setBadgeBackgroundColor`.
- **Checkpoint:** toggle in the popup → badge flips → close & reopen the popup → state persisted.

### Stage 3 — Options page *(~1–2 h)*
- Form for topic label, keywords (comma or newline separated → array), allowed channels,
  playlist URL (accept a full URL and extract `list=` with a regex, don't make yourself paste IDs).
- Validate: playlist mode with no playlist ID must show an inline error and refuse to save.
- "Test" area: paste a video title + channel, show PASS/BLOCK using `matcher.js` — this makes the
  keyword list debuggable without scrolling YouTube.
- **Checkpoint:** save settings, reload the options page, everything's still there.

### Stage 4 — Playlist Lock (do this before topic lock — it's simpler and it's your core use case) *(~2–3 h)*
- `background.js`:
  - Listen to `chrome.webNavigation.onBeforeNavigate` **and** `onHistoryStateUpdated`, filtered to
    YouTube hosts.
  - `shouldRedirect(url, settings)` in `matcher.js` decides. Allowed when: path is `/playlist` with
    the right `list`, **or** path is `/watch` with `list=<ID>` (and, once Stage 5 lands, a `v` in the
    cached ID set). Everything else → `chrome.tabs.update(tabId, { url: playlistUrl })`.
  - Guard against redirect loops: if the current URL already equals the target, do nothing.
- `content.css`: hide the guide sidebar, the mini-guide, the masthead search box, notifications and
  the "YouTube" home logo link when playlist-lock is active (gate the CSS behind a
  `html.tt-playlist-lock` class the content script adds, so the CSS file can ship inert).
- **Checkpoint:** enable playlist mode → open `youtube.com` → land on the playlist. Click the logo →
  bounced back. Click a video in the playlist → it plays.

### Stage 5 — Playlist membership (choose one) *(~1–2 h)*
The URL check alone lets a hand-edited `v=` through with a valid `list=`. Tighten it:

- **Option A (no API key, recommended):** when the user is on the playlist page, the content script
  scrapes `ytd-playlist-video-renderer a#video-title` hrefs, extracts video IDs, and writes them to
  `playlistCache`. Refresh whenever the playlist page is visited and the cache is >24 h old.
  Costs nothing, needs no key, works for private playlists the user can see.
- **Option B:** YouTube Data API v3 `playlistItems.list` with an API key. Cleaner, but you'd ship a
  key in the extension (visible to anyone) and it breaks for private playlists. Only do this if A
  proves flaky.
- **Checkpoint:** cache populates after visiting the playlist; a `/watch?v=<random>&list=<ID>` URL
  gets bounced.

### Stage 6 — Topic Lock *(~3–4 h — the fiddly one)*
- `matcher.js`: `matchesTopic({ title, channel }, topic)` → lowercase, strip punctuation, return true
  if any keyword is a substring of the title **or** the channel is in the allowlist. Keep it dumb;
  fancy scoring is not worth it.
- `content.js`:
  - Selector map per surface (YouTube renames these — keep them in one `SELECTORS` const at the top
    of the file so there's exactly one place to fix when it breaks):
    - home grid: `ytd-rich-item-renderer`
    - search results: `ytd-video-renderer`, `ytd-channel-renderer`
    - sidebar: `yt-lockup-view-model`, `ytd-compact-video-renderer`
    - shelves to nuke wholesale: `ytd-rich-shelf-renderer` (Shorts shelf), `ytd-reel-shelf-renderer`
  - For each node: pull the title (`#video-title`) and channel (`ytd-channel-name`), run the matcher,
    set `node.style.display = 'none'` on a miss (hide, don't `remove()` — removal fights YouTube's
    virtual scroller and can wedge the feed).
  - Wrap it all in a `MutationObserver` on `ytd-app`, **debounced ~150 ms** with `requestAnimationFrame`,
    or you'll melt the CPU on infinite scroll.
  - Re-run on `yt-navigate-finish` (YouTube's own SPA event) — `DOMContentLoaded` fires once and never again.
  - On `/watch`, if the current video fails the match, inject a full-page overlay (pause the video via
    `document.querySelector('video').pause()`).
  - `blockShorts` → redirect `/shorts/*` from the background.
  - `scopeSearch` → on `onHistoryStateUpdated` for `/results`, if `search_query` lacks the topic label,
    rewrite the URL with it appended.
- **Checkpoint:** home feed shows only DSA content; scroll 5 screens and confirm it keeps holding and
  the tab doesn't heat up.

### Stage 7 — Guard rails & polish *(~1–2 h)*
- Empty-state message when filtering removes *everything* ("TunnelTube hid 24 videos — nothing here
  matches DSA"), otherwise a blank feed just looks broken.
- Counter in the popup: "hidden this session: N".
- Optional `guard.lockedUntil`: popup disables the off-switch until the timer expires; requires typing
  the topic label to unlock early.
- Keyboard shortcut via `manifest.commands` (e.g. `Alt+Shift+Y` to toggle).
- Light/dark styling for popup + options so it doesn't glare next to YouTube's dark mode.

### Stage 8 — Testing *(~1 h)*
- `node --test test/matcher.test.mjs` over `matcher.js`: keyword hit, channel hit, both miss, casing,
  empty keyword list, playlist URL parsing, redirect-loop guard.
- Manual matrix, run with the extension ON in each mode:
  `/` · `/watch?v=` (in-tunnel) · `/watch?v=` (out-of-tunnel) · `/results?search_query=` ·
  `/shorts/x` · `/feed/subscriptions` · `/@channel` · `/playlist?list=` · direct URL paste ·
  back/forward buttons · a second YouTube tab · toggle OFF mid-session (everything must come back
  without a reload).
- Check the service-worker console for unhandled errors after 10 minutes of idle (SW gets suspended
  and revived — a crash there is silent).

### Stage 9 — Ship locally *(~15 min)*
1. `chrome://extensions` → Developer mode ON → **Load unpacked** → pick `tunnel-tube/`.
2. Pin the icon to the toolbar.
3. After each code change: hit the reload ↻ on the extension card, **then** hard-reload the YouTube
   tab (content scripts don't re-inject on their own).
4. Write `README.md`: what it does, install steps, how to edit the topic list, known breakage.

### Stage 10 — Publish to the Chrome Web Store *(optional, ~2–3 h + review wait)*
1. **Developer account:** register at the [Chrome Web Store Developer Dashboard], pay the one-time
   **$5** registration fee. Verify your email/publisher name.
2. **Prep the package:** bump `version`, remove `console.log`s, zip the *contents* of `tunnel-tube/`
   (`zip -r tunneltube-1.0.0.zip . -x '*.git*' 'test/*' 'INSTRUCTIONS.md'`) — the manifest must be at
   the zip root, not inside a nested folder.
3. **Listing assets:** 128×128 store icon, at least one 1280×800 screenshot (make 3–5: popup, options,
   before/after feed), short description (≤132 chars), a full description, and a category
   (*Productivity*).
4. **Privacy:** you must declare a single purpose and justify every permission in the dashboard
   ("`webNavigation` — to redirect off-topic YouTube pages while the lock is active"). Tick
   "does not collect user data". Host a privacy policy (a GitHub Pages page or a gist URL is fine)
   stating that nothing leaves the device.
5. **Compliance watch-outs:** don't use "YouTube" as the first word of the extension name or put the
   YouTube logo in the icon — trademark rejections are the #1 cause of review failures for this
   category. "TunnelTube — focus mode for YouTube" as the *description* is fine.
6. **Submit.** First review typically takes a few days; extensions with host permissions can take
   longer. Expect one rejection round and budget for it.
7. **Alternative for personal/small use:** skip the store entirely — push the repo to GitHub and let
   people load it unpacked, or distribute a `.crx`. Fine for a handful of users; the store is only
   worth it if you want discoverability.

---

## 6. Gotchas worth knowing before you start

- **YouTube is an SPA.** Page loads happen once. Everything after that is `pushState`. If a feature
  "works on refresh but not on navigation", that's this.
- **Selectors are not stable.** YouTube ships DOM changes regularly. Keep every selector in the one
  `SELECTORS` const and treat a breakage as a 5-minute fix, not a rewrite.
- **The service worker dies.** ~30 s of idle and it's gone. Never hold state in memory there.
- **Race at `document_start`.** Inject CSS early (so the guide never flashes), but wait for
  `ytd-app` to exist before querying the DOM.
- **Don't `remove()` feed nodes** — YouTube's virtual scroller reuses them; hiding is safer.
- **Two tabs, one setting.** Broadcast changes via `chrome.storage.onChanged`, which every context
  receives, rather than messaging tabs individually.
- **Test the OFF path.** Turning the extension off must restore the page fully — if you've hidden
  nodes inline, you need to walk them back or force a reload.

---

## 7. Suggested order of attack

Stage 0 → 1 → 2 → **4 (Playlist Lock)** → 9 (load it, use it for a day) → 5 → 3 → 6 → 7 → 8 → 10.

Playlist Lock is the feature you actually asked for and it's the smallest — get it working and
living on your machine before touching topic filtering.
