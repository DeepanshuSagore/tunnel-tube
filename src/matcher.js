// Pure decision logic — no chrome.*, no DOM. Everything here is unit-testable
// (test/matcher.test.mjs, Stage 8), which matters because this is the part that
// will actually have bugs.

const YOUTUBE_HOST = /(^|\.)youtube\.com$/i;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,}$/;

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
 * Where this URL should be sent instead, or null to let it through.
 *
 * Allowed under a playlist lock: the playlist page itself, and /watch carrying
 * the right list=. Stage 5 tightens the /watch case with the cached video-ID
 * set — a hand-edited v= with a valid list= still passes today.
 */
export function shouldRedirect(rawUrl, settings) {
  if (!settings?.enabled || settings.mode !== 'playlist') return null;

  const id = settings.playlist?.id;
  if (!id) return null;
  if (!isYouTubeUrl(rawUrl)) return null;

  const url = new URL(rawUrl);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const list = url.searchParams.get('list');

  if (path === '/playlist' && list === id) return null;
  if (path === '/watch' && list === id) return null;

  // strict: false gates /watch only and leaves the rest of YouTube alone.
  if (settings.playlist.strict === false && path !== '/watch') return null;

  const target = playlistUrl(id);
  return rawUrl === target ? null : target; // never bounce a page to itself
}
