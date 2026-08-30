// Single source of truth for settings. Every context (popup, options, service
// worker) reads and writes through here so nobody hand-rolls a chrome.storage
// call and drifts from the schema.
//
// Settings live as separate top-level keys in chrome.storage.sync — sync caps
// each item at 8 KB, so splitting them keeps a long keyword list from crowding
// out everything else. The playlist video-ID cache is far too big for sync and
// lives in chrome.storage.local (Stage 5).

export const DEFAULTS = {
  version: 1,
  enabled: false,
  mode: 'topic', // "topic" | "playlist"
  topic: {
    label: '',
    keywords: [],
    channels: [],
    blockShorts: true,
    scopeSearch: true,
    hideComments: false,
  },
  playlist: {
    id: '',
    title: '',
    strict: true,
  },
  guard: {
    minSessionMinutes: 0,
    lockedUntil: null, // epoch ms
  },
};

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fill in anything the stored copy is missing, including keys added by a later schema version. */
function withDefaults(stored) {
  const out = structuredClone(DEFAULTS);
  for (const key of Object.keys(DEFAULTS)) {
    const value = stored[key];
    if (value === undefined) continue;
    out[key] = isPlainObject(out[key]) && isPlainObject(value) ? { ...out[key], ...value } : value;
  }
  return out;
}

/** Read the full settings object, defaults applied. */
export async function getSettings() {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  return withDefaults(stored);
}

/**
 * Write a patch of top-level keys and return the resulting settings.
 * The merge is shallow: passing `{ topic: {...} }` replaces the whole topic
 * object, so read-modify-write it if you only mean to change one field.
 */
export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
  return getSettings();
}

/**
 * Subscribe to settings changes. Fires in every context that's alive, which is
 * how two YouTube tabs stay in agreement. Returns an unsubscribe function.
 */
export function onSettingsChanged(callback) {
  const listener = async (changes, area) => {
    if (area !== 'sync') return;
    if (!Object.keys(changes).some((key) => key in DEFAULTS)) return;
    callback(await getSettings(), changes);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
