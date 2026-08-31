# TunnelTube

**Tunnel vision for YouTube.** Flip it on and YouTube collapses to one topic — or one
playlist — and nothing else. Built for when you already know what you're supposed to be
watching and you want YouTube to stop offering you anything better.

No account, no server, no analytics. Every setting lives in your own browser.

## What it does

**Playlist lock (hard tunnel).** Any YouTube URL that isn't part of your playlist redirects
to the playlist. Home, Shorts, Subscriptions, search, channel pages — all bounced. The guide
sidebar, search box and account controls are hidden, and on `/watch` the sidebar keeps the
playlist queue and nothing else. A hand-edited `?v=` with a valid `list=` gets bounced too,
once the playlist has been indexed.

**Topic lock (soft tunnel).** YouTube stays usable, but the home feed, search results and
the up-next sidebar only keep videos whose title matches one of your keywords or whose
channel is on your allowlist. Off-topic videos get a full-page interstitial and stay paused.
Shorts redirect to home, searches get your topic label appended, and Mixes — infinite
algorithmic queues with one generic title — are dropped wholesale.

Either way, in-player end screens and pause overlays are hidden: those are painted inside
the player, where no DOM filter reaches.

## Install

No build step, no dependencies. Plain HTML/CSS/JS.

1. `chrome://extensions` → turn on **Developer mode** (top right)
2. **Load unpacked** → pick this folder (the one holding `manifest.json`)
3. Pin TunnelTube from the puzzle-piece menu

After changing any code: hit reload ↻ on the extension card, **then** hard-reload the
YouTube tab (⌘⇧R / Ctrl+Shift+R). Content scripts don't re-inject on their own.

## Using it

Click the icon for the master toggle, the mode switch, and a playlist field. `Alt+Shift+Y`
toggles it without opening the popup. The badge reads **ON** in green while the tunnel holds.

**Playlist mode:** paste a playlist URL (or a bare ID) into the popup or the options page,
then open the playlist once and scroll to the end. That indexes the video IDs into
`chrome.storage.local`. Until the index is complete the lock still redirects everything
else, it just can't tell one `/watch?v=` from another — the popup says how far along it is.

**Topic mode:** open the options page and fill in keywords (comma or newline separated) and
allowed channels. Matching is deliberately dumb — a keyword appearing anywhere in the title,
or an allowed channel, is a pass. The **Test the profile** box takes a title and channel and
shows PASS/BLOCK against what's currently in the form, which is the fastest way to debug a
keyword list. **Suggest keywords** seeds it from the titles of an indexed playlist; treat the
result as a starting point to prune.

An empty profile passes everything, on purpose — a lock with nothing configured should look
misconfigured, not blank your feed.

## Known breakage

- **YouTube renames its elements regularly.** When the lock stops catching something, the
  fix is almost always one line in the `SELECTORS` const at the top of
  [`src/content/content.js`](src/content/content.js) or a selector in
  [`src/content/content.css`](src/content/content.css). Treat it as a 5-minute fix.
- **This is self-discipline, not enforcement.** Anyone can open `chrome://extensions` and
  switch it off. It's friction against an impulse, nothing more.
- **A playlist over a few hundred videos** needs one scroll to the end before the `/watch`
  membership check arms. Until then a hand-edited video ID with a valid `list=` passes.
- **The first paint on a slow load** can flash the guide sidebar before the CSS class lands.
- **Live streams and premieres** are matched on title like anything else, so they pass or
  fail by whatever the title happens to say.

## Development

```sh
node --test test/matcher.test.mjs   # pure logic: gating, matching, parsing
node tools/make-icons.mjs           # regenerate the icons (Node built-ins only)
```

`src/matcher.js` stays pure — no `chrome.*`, no DOM. That's the part that's worth testing and
the part that actually has bugs. Everything else reads settings through `src/storage.js`.

Three consoles to check when something misbehaves, because an error in one is invisible in
the others: the YouTube tab (content script), the **service worker** link on the extension
card (background), and right-click → Inspect on the popup or options page. A red **Errors**
button on the card catches all three.
