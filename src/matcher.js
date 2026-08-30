// Pure decision logic — no chrome.*, no DOM. Everything here is unit-testable
// (test/matcher.test.mjs, Stage 8), which matters because this is the part that
// will actually have bugs.

const YOUTUBE_HOST = /(^|\.)youtube\.com$/i;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,}$/;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Canonical URL of a playlist page. */
export function playlistUrl(id) {
  return `https://www.youtube.com/playlist?list=${id}`;
}

/**
 * Pull a playlist ID out of whatever the user pasted: a full watch or playlist
 * URL, or a bare ID. Returns '' if there's nothing usable in there.
 */
export function parsePlaylistId(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';
  const fromUrl = text.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (fromUrl) return fromUrl[1];
  return PLAYLIST_ID.test(text) ? text : '';
}

/** True for any http(s) URL on a youtube.com host. */
export function isYouTubeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /^https?:$/.test(url.protocol) && YOUTUBE_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * True when the cache covers the whole playlist and can be trusted to bounce a
 * video. A partial scrape (you've only loaded the first 100 rows) must not gate
 * anything, or the lock would bounce videos that really are in the playlist.
 */
export function isCacheComplete(cache, id) {
  if (!cache || cache.id !== id) return false;
  if (!Array.isArray(cache.videoIds) || cache.videoIds.length === 0) return false;
  return typeof cache.count === 'number' ? cache.videoIds.length >= cache.count : false;
}

/** Cache older than a day; the content script refreshes it on the next playlist visit. */
export function isCacheStale(cache, now = Date.now()) {
  return !cache || now - (cache.fetchedAt ?? 0) > CACHE_TTL_MS;
}

/**
 * Where this URL should be sent instead, or null to let it through.
 *
 * Allowed under a playlist lock: the playlist page itself, and /watch carrying
 * the right list= — plus, once the cache is complete, a v= that's actually in
 * the playlist.
 */
export function shouldRedirect(rawUrl, settings, cache = null) {
  if (!settings?.enabled || settings.mode !== 'playlist') return null;

  const id = settings.playlist?.id;
  if (!id) return null;
  if (!isYouTubeUrl(rawUrl)) return null;

  const url = new URL(rawUrl);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const list = url.searchParams.get('list');

  const target = playlistUrl(id);

  if (path === '/playlist' && list === id) return null;
  if (path === '/watch' && list === id) {
    if (!isCacheComplete(cache, id)) return null; // unproven cache never bounces
    const video = url.searchParams.get('v');
    return video && cache.videoIds.includes(video) ? null : target;
  }

  // strict: false gates /watch only and leaves the rest of YouTube alone.
  if (settings.playlist.strict === false && path !== '/watch') return null;

  return rawUrl === target ? null : target; // never bounce a page to itself
}
