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
  header: 'ytd-playlist-header-renderer, ytd-playlist-sidebar-primary-info-renderer, yt-page-header-renderer',
};

let scrapeTimer = null;
let observer = null;

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

/** Every video ID linked on this page that belongs to the playlist, with titles. */
function scrapeRendered(playlistId) {
  const videoIds = [];
  const titles = {};
  for (const anchor of document.querySelectorAll(SELECTORS.watchLinks)) {
    let url;
    try {
      url = new URL(anchor.href, location.origin);
    } catch {
      continue;
    }
    if (url.searchParams.get('list') !== playlistId) continue;
    const id = url.searchParams.get('v');
    if (!id || titles[id] !== undefined) continue;
    videoIds.push(id);
    titles[id] = (anchor.getAttribute('title') || anchor.textContent || '').trim();
  }
  return { videoIds, titles };
}

/**
 * Merge what's on screen into the cache. YouTube paginates the playlist ~100 at
 * a time, so this runs on every scroll batch and unions the results rather than
 * replacing them — a cache older than the TTL starts over, to drop removed videos.
 */
async function refreshCache(playlistId) {
  const { videoIds, titles } = scrapeRendered(playlistId);
  if (!videoIds.length) return;

  const { playlistCache } = await chrome.storage.local.get('playlistCache');
  const stale = !playlistCache
    || playlistCache.id !== playlistId
    || Date.now() - (playlistCache.fetchedAt ?? 0) > CACHE_TTL_MS;
  const base = stale ? { videoIds: [], titles: {} } : playlistCache;

  const merged = [...new Set([...base.videoIds, ...videoIds])];
  const next = {
    id: playlistId,
    fetchedAt: stale ? Date.now() : (playlistCache.fetchedAt ?? Date.now()),
    count: statedVideoCount() ?? playlistCache?.count ?? null,
    videoIds: merged,
    titles: { ...base.titles, ...titles },
  };

  if (!stale && merged.length === base.videoIds.length && next.count === playlistCache.count) return;
  await chrome.storage.local.set({ playlistCache: next });
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
  const settings = await chrome.storage.sync.get(KEYS);
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
