import { getSettings, setSettings, getPlaylistCache, onSettingsChanged } from '../storage.js';
import { parsePlaylistId, playlistUrl, isCacheComplete } from '../matcher.js';

const enabled = document.getElementById('tt-enabled');
const state = document.getElementById('tt-state');
const modes = document.getElementById('tt-modes');
const playlistSection = document.getElementById('tt-playlist-section');
const playlistInput = document.getElementById('tt-playlist');
const playlistError = document.getElementById('tt-playlist-error');
const openPlaylist = document.getElementById('tt-open');
const index = document.getElementById('tt-index');
const openOptions = document.getElementById('tt-options');
const count = document.getElementById('tt-count');

/** Paint the controls from settings. Called on open and on any external change. */
function render(settings) {
  enabled.checked = settings.enabled;
  state.textContent = settings.enabled ? 'on' : 'off';
  document.body.classList.toggle('is-on', settings.enabled);

  const active = modes.querySelector(`input[value="${settings.mode}"]`);
  if (active) active.checked = true;

  playlistSection.hidden = settings.mode !== 'playlist';
  // Don't stomp on what's being typed.
  if (document.activeElement !== playlistInput) {
    playlistInput.value = settings.playlist.id;
  }
  openPlaylist.disabled = !settings.playlist.id;
  renderIndex(settings.playlist.id);
  renderCount();
}

async function renderCount() {
  const { stats } = await chrome.storage.local.get('stats');
  const hidden = stats?.hidden ?? 0;
  count.textContent = hidden ? `hidden this session: ${hidden}` : '';
}

/**
 * How much of the playlist has been scraped. Until it's complete the lock lets
 * any video through, so it's worth saying so out loud rather than leaving the
 * user to wonder why a stray video played.
 */
async function renderIndex(playlistId) {
  if (!playlistId) {
    index.textContent = '';
    return;
  }
  const cache = await getPlaylistCache(playlistId);
  const complete = isCacheComplete(cache, playlistId);
  index.classList.toggle('is-complete', complete);
  if (!cache) {
    index.textContent = 'Not indexed yet — open the playlist and scroll to the end.';
  } else if (complete) {
    index.textContent = `Indexed ${cache.videoIds.length} videos — off-list videos are blocked.`;
  } else {
    const total = cache.count ? ` of ${cache.count}` : '';
    index.textContent = `Indexed ${cache.videoIds.length}${total} — scroll the playlist to finish.`;
  }
}

render(await getSettings());

enabled.addEventListener('change', () => {
  setSettings({ enabled: enabled.checked });
});

modes.addEventListener('change', (event) => {
  if (event.target.name !== 'tt-mode') return;
  setSettings({ mode: event.target.value });
});

/** Accept a pasted playlist URL or a bare ID; keep the title from Stage 5 intact. */
async function savePlaylist() {
  const raw = playlistInput.value.trim();
  const id = parsePlaylistId(raw);
  playlistError.hidden = !(raw && !id);
  if (raw && !id) return;

  const { playlist } = await getSettings();
  if (playlist.id === id) return;
  // The title is scraped per playlist in Stage 5, so a new ID invalidates it.
  await setSettings({ playlist: { ...playlist, id, title: '' } });
}

playlistInput.addEventListener('change', savePlaylist);
playlistInput.addEventListener('blur', savePlaylist);

openPlaylist.addEventListener('click', async () => {
  const { playlist } = await getSettings();
  if (!playlist.id) return;
  await chrome.tabs.update({ url: playlistUrl(playlist.id) });
  window.close();
});

openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// A second popup can't exist, but the options page or a future keyboard shortcut
// can change these while we're open.
onSettingsChanged(render);

// The scrape runs in the YouTube tab; refresh the count as it lands.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if ('stats' in changes) renderCount();
  if ('playlistCache' in changes) {
    const { playlist } = await getSettings();
    renderIndex(playlist.id);
  }
});
