import { getSettings, setSettings, onSettingsChanged } from '../storage.js';
import { parsePlaylistId, playlistUrl } from '../matcher.js';

const enabled = document.getElementById('tt-enabled');
const state = document.getElementById('tt-state');
const modes = document.getElementById('tt-modes');
const playlistSection = document.getElementById('tt-playlist-section');
const playlistInput = document.getElementById('tt-playlist');
const playlistError = document.getElementById('tt-playlist-error');
const openPlaylist = document.getElementById('tt-open');
const openOptions = document.getElementById('tt-options');

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
