# Handoff — start Stage 0 + Stage 1

## Context
Building **TunnelTube**, a Chrome MV3 extension that locks YouTube to a single topic or a single
playlist while enabled. Full spec, settings schema, file layout and all 11 build stages are in
`INSTRUCTIONS.md` in this folder — **read it first**, it is the source of truth.

Project root: `/Users/trash/CODING/Extensions/Chrome/tunnel-tube/`

## State right now
- `INSTRUCTIONS.md` — written, complete.
- `HANDOFF.md` — this file.
- Nothing else exists. No git repo, no code, no icons.

## Task for this session: Stage 0 + Stage 1 only

**Stage 0 — Groundwork**
1. `git init` in `tunnel-tube/`; `.gitignore` with `.DS_Store`, `*.zip`, `node_modules/`.
2. Create `icons/` with `icon16.png`, `icon32.png`, `icon48.png`, `icon128.png` — flat tunnel/arrow
   glyph on a solid ground, must be legible at 16px. Generating them from a small script or an SVG
   source is fine; ask me before pulling in any dependency.

**Stage 1 — Skeleton that loads**
3. `manifest.json`:
   - `manifest_version: 3`, name `TunnelTube`, version `0.1.0`, description, all four icons
   - `action` → `src/popup/popup.html`
   - `options_page` → `src/options/options.html`
   - `background.service_worker` → `src/background.js`, `"type": "module"`
   - `content_scripts` → matches `*://www.youtube.com/*`, `run_at: document_start`,
     js `src/content/content.js`, css `src/content/content.css`
   - `permissions`: `storage`, `tabs`, `webNavigation` — **nothing else**
   - `host_permissions`: `*://*.youtube.com/*`
4. Create the stub files the manifest points at so it loads clean:
   - `src/popup/popup.html` + `popup.css` + `popup.js` — shows "TunnelTube" and a master-toggle
     checkbox that is **not wired to storage yet** (that's Stage 2)
   - `src/options/options.html` — placeholder heading only
   - `src/background.js` — empty module with a single `console.log` on install
   - `src/content/content.js` — empty module
   - `src/content/content.css` — empty (rules land in Stage 4, gated behind `html.tt-playlist-lock`)

## Constraints
- No build step, no bundler, no npm dependencies. Plain HTML/CSS/JS, ES modules.
- Do not start Stage 2 (storage plumbing) or beyond. Stop at the Stage 1 checkpoint.
- Keep `manifest.json` minimal — every extra permission costs review time later.

## Definition of done
I load the folder via `chrome://extensions` → Developer mode → Load unpacked, and:
- the extension card shows **no errors**
- the toolbar icon renders and is legible
- clicking it opens the popup with the title and a checkbox
- the service worker inspector console is clean apart from the install log

Tell me the exact click-path to load it, then wait for me to confirm the checkpoint passed before
suggesting Stage 2.
