// Runs at document_start on www.youtube.com.
//
// Declarative content scripts can't be ES modules, so this file talks to
// chrome.storage directly instead of importing src/storage.js. Keep the key
// names in step with DEFAULTS there.
//
// Its only job right now: mirror the lock state onto <html> so content.css can
// stay inert while the extension is off. Feed filtering lands in Stage 6.

const LOCK_CLASS = 'tt-playlist-lock';
const KEYS = ['enabled', 'mode', 'playlist'];

function applyLockState(settings) {
  const locked = Boolean(settings.enabled && settings.mode === 'playlist' && settings.playlist?.id);
  document.documentElement.classList.toggle(LOCK_CLASS, locked);
}

chrome.storage.sync.get(KEYS).then(applyLockState);

// Toggling from the popup must take effect without a reload, in every open tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (!KEYS.some((key) => key in changes)) return;
  chrome.storage.sync.get(KEYS).then(applyLockState);
});
