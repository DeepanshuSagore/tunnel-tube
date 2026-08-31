// Runs at document_start on www.youtube.com.
//
// Declarative content scripts can't be ES modules, so this file talks to
// chrome.storage directly instead of importing src/storage.js. matcher.js is
// pulled in by dynamic import (it's web-accessible) rather than copied, so the
// matching rules have exactly one tested implementation.
//
// Three jobs:
//  1. Mirror the lock state onto <html> so content.css can stay inert while the
//     extension is off.
//  2. On your playlist page, scrape video IDs into chrome.storage.local so the
//     navigation gate can tell a real playlist entry from a hand-edited v=.
//  3. In topic mode, hide feed items that miss the profile and cover an
//     out-of-tunnel video with an interstitial.

const KEYS = ['enabled', 'mode', 'topic', 'playlist'];
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SCRAPE_DEBOUNCE_MS = 400;
const FILTER_DEBOUNCE_MS = 150;
const HIDDEN_ATTR = 'data-tt-hidden';
const STATS_FLUSH_MS = 2000;

// YouTube renames its custom elements regularly. This is the one place to fix
// when the lock stops catching something — treat a breakage as a 5-minute job.
const SELECTORS = {
  watchLinks: 'a[href*="watch?v="]',
  rows: 'ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, yt-lockup-view-model, ytd-video-renderer',
  rowTitle: '#video-title, .yt-lockup-metadata-view-model__title, h3',
  header: 'ytd-playlist-header-renderer, ytd-playlist-sidebar-primary-info-renderer, yt-page-header-renderer',
  // Feed surfaces: home grid, search results, sidebar / up-next.
  feedItems: [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-channel-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'yt-lockup-view-model',
  ].join(', '),
  itemTitle: '#video-title, .yt-lockup-metadata-view-model__title, h3 a, h3',
  itemChannel: 'ytd-channel-name, #channel-name, .yt-content-metadata-view-model__metadata-row',
  watchTitle: '#title h1, h1.ytd-watch-metadata, h1.title',
  watchChannel: '#owner #channel-name, ytd-video-owner-renderer #channel-name, #upload-info #channel-name',
  player: 'video',
};

const CLASSES = {
  playlist: 'tt-playlist-lock',
  topic: 'tt-topic-lock',
  comments: 'tt-hide-comments',
  shorts: 'tt-block-shorts',
};

let settings = null;
let matcher = null;
let observer = null;
let scrapeTimer = null;
let filterTimer = null;
let interstitial = null;
let pauseHandler = null;
let emptyState = null;
let statsTimer = null;
let pendingHidden = 0;
// Titles already counted in this tab, so the virtual scroller recycling a node
// can't inflate the tally.
const countedTitles = new Set();

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
  clearTimeout(filterTimer);
  clearTimeout(statsTimer);
  window.removeEventListener('yt-navigate-finish', sync);
}

// matcher.js is an ES module and this file isn't, so it arrives asynchronously.
// Everything that needs it checks for it first; the observer re-runs once it lands.
const matcherReady = import(chrome.runtime.getURL('src/matcher.js'))
  .then((module) => { matcher = module; })
  .catch((error) => console.warn('[TunnelTube] matcher unavailable:', error.message));

const text = (node) => (node?.getAttribute?.('title') || node?.textContent || '').trim();
const path = () => location.pathname.replace(/\/+$/, '') || '/';
const topicActive = () => Boolean(settings?.enabled && settings.mode === 'topic');

function applyLockState() {
  const root = document.documentElement;
  const playlistLock = Boolean(settings?.enabled && settings.mode === 'playlist' && settings.playlist?.id);
  const topic = settings?.topic ?? {};
  root.classList.toggle(CLASSES.playlist, playlistLock);
  root.classList.toggle(CLASSES.topic, topicActive());
  root.classList.toggle(CLASSES.comments, topicActive() && Boolean(topic.hideComments));
  root.classList.toggle(CLASSES.shorts, topicActive() && Boolean(topic.blockShorts));
}

// --- topic filtering ------------------------------------------------------

/**
 * Hide, don't remove: YouTube's virtual scroller reuses feed nodes, and pulling
 * them out from under it wedges the feed. A recycled node gets re-judged on the
 * next pass, which is why every run sets the state either way rather than only
 * hiding.
 */
function setHidden(node, hidden) {
  if (hidden) {
    if (node.hasAttribute(HIDDEN_ATTR)) return;
    node.setAttribute(HIDDEN_ATTR, '1');
    node.style.display = 'none';
  } else if (node.hasAttribute(HIDDEN_ATTR)) {
    node.removeAttribute(HIDDEN_ATTR);
    node.style.display = '';
  }
}

/** Put everything back. Turning the lock off must not need a reload. */
function restoreAll() {
  for (const node of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) setHidden(node, false);
  emptyState?.remove();
  emptyState = null;
  removeInterstitial();
}

function filterFeed() {
  const topic = settings.topic ?? {};
  let hidden = 0;
  let visible = 0;
  let anchor = null;

  for (const node of document.querySelectorAll(SELECTORS.feedItems)) {
    const title = text(node.querySelector(SELECTORS.itemTitle));
    // No title yet means the node is still a placeholder — judging it now would
    // hide a video that hasn't rendered.
    if (!title) continue;
    const channel = text(node.querySelector(SELECTORS.itemChannel));
    const pass = matcher.matchesTopic({ title, channel }, topic);
    setHidden(node, !pass);

    anchor ??= node.parentElement;
    if (pass) {
      visible += 1;
    } else {
      hidden += 1;
      if (!countedTitles.has(title)) {
        countedTitles.add(title);
        pendingHidden += 1;
      }
    }
  }

  flushStatsSoon();
  renderEmptyState({ hidden, visible, anchor });
}

/**
 * A feed filtered down to nothing just looks broken, so say what happened.
 * Only when something was actually hidden — an empty page is YouTube's problem.
 */
function renderEmptyState({ hidden, visible, anchor }) {
  if (!hidden || visible || !anchor) {
    emptyState?.remove();
    emptyState = null;
    return;
  }

  const label = (settings.topic?.label || '').trim();
  const message = `TunnelTube hid ${hidden} ${hidden === 1 ? 'video' : 'videos'}`
    + (label ? ` — nothing here matches ${label}.` : ' — nothing here matches your topic profile.');

  if (!emptyState) {
    emptyState = document.createElement('div');
    emptyState.className = 'tt-empty';
  }
  emptyState.textContent = message;
  if (emptyState.parentElement !== anchor) anchor.prepend(emptyState);
}

/**
 * Batch the "hidden this session" tally. Writing on every pass would hammer
 * storage during infinite scroll for a number nobody reads that fast.
 */
function flushStatsSoon() {
  if (!pendingHidden || statsTimer) return;
  statsTimer = setTimeout(async () => {
    statsTimer = null;
    const delta = pendingHidden;
    pendingHidden = 0;
    if (isOrphaned()) return shutDown();
    try {
      const { stats } = await chrome.storage.local.get('stats');
      await chrome.storage.local.set({
        stats: { hidden: (stats?.hidden ?? 0) + delta, startedAt: stats?.startedAt ?? Date.now() },
      });
    } catch {
      shutDown();
    }
  }, STATS_FLUSH_MS);
}

// --- out-of-tunnel interstitial -------------------------------------------

function removeInterstitial() {
  if (!interstitial) return;
  interstitial.remove();
  interstitial = null;
  const video = document.querySelector(SELECTORS.player);
  if (video && pauseHandler) video.removeEventListener('play', pauseHandler);
  pauseHandler = null;
}

function showInterstitial(title) {
  const video = document.querySelector(SELECTORS.player);
  video?.pause();

  if (interstitial) return;

  const label = (settings.topic?.label || '').trim();
  interstitial = document.createElement('div');
  interstitial.className = 'tt-interstitial';
  interstitial.innerHTML = `
    <div class="tt-interstitial__card">
      <p class="tt-interstitial__eyebrow">TunnelTube</p>
      <h2 class="tt-interstitial__title">Not part of your tunnel</h2>
      <p class="tt-interstitial__body"></p>
      <div class="tt-interstitial__actions">
        <button type="button" data-tt-action="back">Go back</button>
        <button type="button" data-tt-action="home">My feed</button>
      </div>
      <p class="tt-interstitial__hint">Turn TunnelTube off from the toolbar if you meant to watch this.</p>
    </div>`;
  // textContent, not innerHTML — a video title is untrusted markup.
  interstitial.querySelector('.tt-interstitial__body').textContent = label
    ? `"${title}" doesn't match ${label}.`
    : `"${title}" doesn't match your topic profile.`;

  interstitial.addEventListener('click', (event) => {
    const action = event.target.closest('[data-tt-action]')?.dataset.ttAction;
    if (action === 'back') history.back();
    if (action === 'home') location.href = '/';
  });

  document.documentElement.append(interstitial);

  // YouTube's autoplay will happily start it again behind the overlay.
  pauseHandler = () => video?.pause();
  video?.addEventListener('play', pauseHandler);
}

function guardWatchPage() {
  if (path() !== '/watch') return removeInterstitial();

  const title = text(document.querySelector(SELECTORS.watchTitle));
  if (!title) return; // metadata hasn't landed; don't flash the overlay

  const channel = text(document.querySelector(SELECTORS.watchChannel));
  if (matcher.matchesTopic({ title, channel }, settings.topic ?? {})) return removeInterstitial();
  showInterstitial(title);
}

/** One debounced pass over everything topic mode cares about. */
function runFilters() {
  if (!matcher || !topicActive()) return;
  filterFeed();
  guardWatchPage();
}

function scheduleFilter() {
  clearTimeout(filterTimer);
  // Debounce, then wait for a frame: infinite scroll fires mutations by the
  // hundred and this would otherwise melt the CPU.
  filterTimer = setTimeout(() => requestAnimationFrame(runFilters), FILTER_DEBOUNCE_MS);
}

// --- playlist scraping ----------------------------------------------------

/** The playlist ID this page is showing, if it's a /playlist page. */
function currentPlaylistId() {
  if (path() !== '/playlist') return '';
  return new URLSearchParams(location.search).get('list') ?? '';
}

/** How many videos YouTube says the playlist holds — used to know when a scrape is complete. */
function statedVideoCount() {
  const header = document.querySelector(SELECTORS.header)?.textContent ?? '';
  const match = header.match(/([\d,]+)\s*videos?/i);
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

  for (const anchor of document.querySelectorAll(SELECTORS.watchLinks)) {
    let list;
    try {
      list = new URL(anchor.href, location.origin).searchParams.get('list');
    } catch {
      continue;
    }
    if (list !== playlistId) continue;
    record(videoIdFrom(anchor.href), text(anchor) || anchor.getAttribute('aria-label') || '');
  }

  for (const row of document.querySelectorAll(SELECTORS.rows)) {
    let id = '';
    for (const anchor of row.querySelectorAll(SELECTORS.watchLinks)) {
      id = videoIdFrom(anchor.href);
      if (id) break;
    }
    if (!id || titles[id] === undefined || titles[id]) continue; // unknown, or already titled
    const title = text(row.querySelector(SELECTORS.rowTitle)) || text(row);
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

function scheduleScrape() {
  const playlistId = settings?.playlist?.id ?? '';
  if (!playlistId || currentPlaylistId() !== playlistId) return;
  clearTimeout(scrapeTimer);
  scrapeTimer = setTimeout(() => refreshCache(playlistId), SCRAPE_DEBOUNCE_MS);
}

// --- wiring ---------------------------------------------------------------

/** One observer for both jobs: feed items and playlist rows arrive the same way. */
function ensureObserver() {
  const wanted = topicActive() || Boolean(currentPlaylistId() && currentPlaylistId() === settings?.playlist?.id);

  if (!wanted) {
    observer?.disconnect();
    observer = null;
    return;
  }
  if (observer) return;

  const root = document.querySelector('ytd-app') ?? document.documentElement;
  observer = new MutationObserver(() => {
    scheduleScrape();
    scheduleFilter();
  });
  observer.observe(root, { childList: true, subtree: true });
}

async function sync() {
  if (isOrphaned()) return shutDown();

  try {
    settings = await chrome.storage.sync.get(KEYS);
  } catch {
    return shutDown();
  }

  applyLockState();
  if (!topicActive()) restoreAll();
  ensureObserver();
  scheduleScrape();
  scheduleFilter();
}

sync();
matcherReady.then(scheduleFilter);

// Toggling from the popup must take effect without a reload, in every open tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (!KEYS.some((key) => key in changes)) return;
  restoreAll(); // re-judge from scratch; the profile may have narrowed or widened
  sync();
});

// YouTube is an SPA: pathname changes without a page load, and DOMContentLoaded
// never fires again. This is YouTube's own post-navigation event.
window.addEventListener('yt-navigate-finish', sync);
