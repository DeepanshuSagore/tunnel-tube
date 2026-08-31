// Runs at document_start on www.youtube.com.
//
// Declarative content scripts can't be ES modules, so this file talks to
// chrome.storage directly instead of importing src/storage.js. Keep the key
// names in step with DEFAULTS there.
//
// Two jobs:
//  1. Mirror the lock state onto <html> so content.css can stay inert while the
//     extension is off. Feed filtering lands in Stage 6.
//  2. While you're on your playlist page, scrape the video IDs into
//     chrome.storage.local so the navigation gate can tell a real playlist entry
//     from a hand-edited v=.

const LOCK_CLASS = 'tt-playlist-lock';
const KEYS = ['enabled', 'mode', 'playlist'];
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SCRAPE_DEBOUNCE_MS = 400;

// YouTube renames its custom elements regularly, so the scrape leans on hrefs —
// those are stable — and only uses element names to find the header text.
const SELECTORS = {
  watchLinks: 'a[href*="watch?v="]',
  rows: 'ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, yt-lockup-view-model, ytd-video-renderer',
  rowTitle: '#video-title, .yt-lockup-metadata-view-model__title, h3',
  header: 'ytd-playlist-header-renderer, ytd-playlist-sidebar-primary-info-renderer, yt-page-header-renderer',
};

let scrapeTimer = null;
let observer = null;

/**
 * Reloading the extension orphans the copy of this script already running in an
 * open tab: chrome.* is still there but its context is dead, and every call
 * throws "Extension context invalidated". The observer would keep firing and
 * spray that error across the console forever, so detect it and go quiet — the
 * tab picks up the new script on its next reload.
 */
function isOrphaned() {
  return !chrome.runtime?.id;
}

function shutDown() {
  observer?.disconnect();
  observer = null;
  clearTimeout(scrapeTimer);
  window.removeEventListener('yt-navigate-finish', sync);
}

function applyLockState(settings) {
  const locked = Boolean(settings.enabled && settings.mode === 'playlist' && settings.playlist?.id);
  document.documentElement.classList.toggle(LOCK_CLASS, locked);
}

/** The playlist ID this page is showing, if it's a /playlist page. */
function currentPlaylistId() {
  if (location.pathname.replace(/\/+$/, '') !== '/playlist') return '';
  return new URLSearchParams(location.search).get('list') ?? '';
}

/** How many videos YouTube says the playlist holds — used to know when a scrape is complete. */
function statedVideoCount() {
  const text = document.querySelector(SELECTORS.header)?.textContent ?? '';
  const match = text.match(/([\d,]+)\s*videos?/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

/** The video ID an href points at, or '' if it isn't a /watch link. */
function videoIdFrom(href) {
  try {
    const url = new URL(href, location.origin);
    if (url.pathname.replace(/\/+$/, '') !== '/watch') return '';
    return url.searchParams.get('v') ?? '';
  } catch {
    return '';
  }
}

/**
 * Every video ID on this page that belongs to the playlist, with titles.
 *
 * Two passes, because IDs and titles don't come from the same place:
 *  - IDs come only from links carrying our list=, so a stray recommendation
 *    can never be smuggled into the allow-list.
 *  - Titles come from the surrounding row, since the link that carries list=
 *    is often the thumbnail — no text — and the title link doesn't always
 *    repeat the list parameter. Titles are only filled in for IDs the first
 *    pass already accepted.
 */
function scrapeRendered(playlistId) {
  const videoIds = [];
  const titles = {};

  const record = (id, title) => {
    if (!id) return;
    if (titles[id] === undefined) {
      videoIds.push(id);
      titles[id] = title;
    } else if (!titles[id] && title) {
      titles[id] = title;
    }
  };

  const textOf = (node) =>
    (node?.getAttribute?.('title') || node?.textContent || node?.getAttribute?.('aria-label') || '').trim();

  for (const anchor of document.querySelectorAll(SELECTORS.watchLinks)) {
    let list;
    try {
      list = new URL(anchor.href, location.origin).searchParams.get('list');
    } catch {
      continue;
    }
    if (list !== playlistId) continue;
    record(videoIdFrom(anchor.href), textOf(anchor));
  }

  for (const row of document.querySelectorAll(SELECTORS.rows)) {
    let id = '';
    for (const anchor of row.querySelectorAll(SELECTORS.watchLinks)) {
      id = videoIdFrom(anchor.href);
      if (id) break;
    }
    if (!id || titles[id] === undefined || titles[id]) continue; // unknown, or already titled
    const title = textOf(row.querySelector(SELECTORS.rowTitle)) || textOf(row);
    if (title) titles[id] = title;
  }

  return { videoIds, titles };
}

/**
 * Merge what's on screen into the cache. YouTube paginates the playlist ~100 at
 * a time, so this runs on every scroll batch and unions the results rather than
 * replacing them — a cache older than the TTL starts over, to drop removed videos.
 */
async function refreshCache(playlistId) {
  if (isOrphaned()) return shutDown();

  const { videoIds, titles } = scrapeRendered(playlistId);
  if (!videoIds.length) return;

  let playlistCache;
  try {
    ({ playlistCache } = await chrome.storage.local.get('playlistCache'));
  } catch {
    return shutDown();
  }
  const stale = !playlistCache
    || playlistCache.id !== playlistId
    || Date.now() - (playlistCache.fetchedAt ?? 0) > CACHE_TTL_MS;
  const base = stale ? { videoIds: [], titles: {} } : playlistCache;

  const merged = [...new Set([...base.videoIds, ...videoIds])];
  const mergedTitles = { ...base.titles };
  let titlesChanged = false;
  for (const [id, title] of Object.entries(titles)) {
    if (!title || mergedTitles[id] === title) continue;
    mergedTitles[id] = title;
    titlesChanged = true;
  }

  const next = {
    id: playlistId,
    fetchedAt: stale ? Date.now() : (playlistCache.fetchedAt ?? Date.now()),
    count: statedVideoCount() ?? playlistCache?.count ?? null,
    videoIds: merged,
    titles: mergedTitles,
  };

  // Nothing new to store — bail before writing, or the observer would loop.
  const unchanged = !stale
    && merged.length === base.videoIds.length
    && !titlesChanged
    && next.count === playlistCache.count;
  if (unchanged) return;

  try {
    await chrome.storage.local.set({ playlistCache: next });
  } catch {
    shutDown();
  }
}

function scheduleScrape(playlistId) {
  clearTimeout(scrapeTimer);
  scrapeTimer = setTimeout(() => refreshCache(playlistId), SCRAPE_DEBOUNCE_MS);
}

/** Watch the playlist page while it lazy-loads more rows; stop watching elsewhere. */
function watchPlaylistPage(settings) {
  const configured = settings.playlist?.id ?? '';
  const onPlaylist = configured && currentPlaylistId() === configured;

  observer?.disconnect();
  observer = null;
  if (!onPlaylist) return;

  scheduleScrape(configured);
  const root = document.querySelector('ytd-app') ?? document.documentElement;
  observer = new MutationObserver(() => scheduleScrape(configured));
  observer.observe(root, { childList: true, subtree: true });
}

async function sync() {
  if (isOrphaned()) return shutDown();

  let settings;
  try {
    settings = await chrome.storage.sync.get(KEYS);
  } catch {
    return shutDown();
  }
  applyLockState(settings);
  watchPlaylistPage(settings);
}

sync();

// Toggling from the popup must take effect without a reload, in every open tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (!KEYS.some((key) => key in changes)) return;
  sync();
});

// YouTube is an SPA: pathname changes without a page load, and DOMContentLoaded
// never fires again. This is YouTube's own post-navigation event.
window.addEventListener('yt-navigate-finish', sync);
