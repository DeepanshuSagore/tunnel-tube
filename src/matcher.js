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

// --- topic profile --------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'you', 'your', 'how',
  'what', 'why', 'when', 'part', 'full', 'video', 'tutorial', 'episode', 'ep',
  'series', 'complete', 'best', 'top', 'new', 'using', 'guide', 'all', 'into',
]);

/** Lowercase and reduce punctuation to spaces, so "C++ (part 2)!" and "c++ part 2" agree. */
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Split a comma- or newline-separated field into a trimmed, de-duplicated list. */
export function parseList(text) {
  const seen = new Set();
  for (const item of String(text ?? '').split(/[,\n]/)) {
    const trimmed = item.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Does this video belong in the topic tunnel?
 *
 * Deliberately dumb: any keyword appearing in the title, or any allowed channel
 * matching the video's channel, is a pass. Scoring would be harder to debug and
 * no more accurate. An empty profile passes everything — a tunnel with no topic
 * configured should look broken in the options page, not blank out the feed.
 */
export function matchesTopic({ title = '', channel = '' } = {}, topic = {}) {
  const keywords = (topic.keywords ?? []).map(normalizeText).filter(Boolean);
  const channels = (topic.channels ?? []).map(normalizeText).filter(Boolean);
  if (!keywords.length && !channels.length) return true;

  const haystack = normalizeText(title);
  if (keywords.some((keyword) => haystack.includes(keyword))) return true;

  const source = normalizeText(channel);
  return Boolean(source) && channels.some((allowed) => source.includes(allowed));
}

/**
 * Seed keywords from a playlist's video titles — the "import from playlist"
 * shortcut, so a 200-video course doesn't have to be described by hand.
 * Frequency ranked, stopwords and one/two-letter noise dropped.
 */
export function suggestKeywords(titles, limit = 10) {
  const counts = new Map();
  for (const title of Object.values(titles ?? {})) {
    for (const word of new Set(normalizeText(title).split(' '))) {
      if (word.length < 3 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}
