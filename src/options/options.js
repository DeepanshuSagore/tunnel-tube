import { getSettings, setSettings, getPlaylistCache, onSettingsChanged } from '../storage.js';
import {
  parsePlaylistId,
  parseList,
  matchesTopic,
  suggestKeywords,
  isCacheComplete,
} from '../matcher.js';

const el = (id) => document.getElementById(id);

const modes = el('tt-modes');
const playlistInput = el('tt-playlist');
const playlistError = el('tt-playlist-error');
const indexNote = el('tt-index');
const strict = el('tt-strict');
const label = el('tt-label');
const keywords = el('tt-keywords');
const channels = el('tt-channels');
const blockShorts = el('tt-blockShorts');
const scopeSearch = el('tt-scopeSearch');
const hideComments = el('tt-hideComments');
const importButton = el('tt-import');
const testTitle = el('tt-test-title');
const testChannel = el('tt-test-channel');
const verdict = el('tt-verdict');
const save = el('tt-save');
const status = el('tt-status');

const selectedMode = () => modes.querySelector('input:checked')?.value ?? 'topic';

function render(settings) {
  const active = modes.querySelector(`input[value="${settings.mode}"]`);
  if (active) active.checked = true;

  playlistInput.value = settings.playlist.id;
  strict.checked = settings.playlist.strict;

  label.value = settings.topic.label;
  keywords.value = settings.topic.keywords.join(', ');
  channels.value = settings.topic.channels.join(', ');
  blockShorts.checked = settings.topic.blockShorts;
  scopeSearch.checked = settings.topic.scopeSearch;
  hideComments.checked = settings.topic.hideComments;

  renderIndex(settings.playlist.id);
  renderVerdict();
}

/** How much of the playlist is indexed — the /watch gate only bites once it's complete. */
async function renderIndex(playlistId) {
  if (!playlistId) {
    indexNote.textContent = 'No playlist set. Paste a playlist URL to arm the playlist lock.';
    importButton.disabled = true;
    return;
  }
  const cache = await getPlaylistCache(playlistId);
  importButton.disabled = !cache;
  if (!cache) {
    indexNote.textContent = 'Not indexed yet — open the playlist and scroll to the end.';
  } else if (isCacheComplete(cache, playlistId)) {
    indexNote.textContent = `Indexed ${cache.videoIds.length} videos — off-list videos are blocked.`;
  } else {
    const total = cache.count ? ` of ${cache.count}` : '';
    indexNote.textContent = `Indexed ${cache.videoIds.length}${total} — scroll the playlist to finish.`;
  }
}

/**
 * Live PASS/BLOCK against the form's current values, not the saved ones — the
 * point is to debug a keyword list before committing to it.
 */
function renderVerdict() {
  const title = testTitle.value.trim();
  const channel = testChannel.value.trim();
  if (!title && !channel) {
    verdict.dataset.state = 'idle';
    verdict.textContent = 'Waiting for input';
    return;
  }
  const topic = { keywords: parseList(keywords.value), channels: parseList(channels.value) };
  const pass = matchesTopic({ title, channel }, topic);
  verdict.dataset.state = pass ? 'pass' : 'block';
  verdict.textContent = pass
    ? 'PASS — this stays in the feed'
    : 'BLOCK — this gets hidden while the topic lock is on';
  if (pass && !topic.keywords.length && !topic.channels.length) {
    verdict.textContent = 'PASS — the profile is empty, so everything passes';
  }
}

function setStatus(message, state = 'ok') {
  status.textContent = message;
  status.dataset.state = state;
  if (message) setTimeout(() => { if (status.textContent === message) status.textContent = ''; }, 2400);
}

async function handleSave() {
  const mode = selectedMode();
  const raw = playlistInput.value.trim();
  const playlistId = parsePlaylistId(raw);

  // Two ways to be wrong: unusable text in the field, or playlist mode with nothing to lock to.
  let error = '';
  if (raw && !playlistId) error = "That doesn't contain a playlist ID.";
  else if (mode === 'playlist' && !playlistId) error = 'Playlist mode needs a playlist — paste its URL above.';

  playlistError.textContent = error;
  playlistError.hidden = !error;
  playlistInput.setAttribute('aria-invalid', String(Boolean(error)));
  if (error) {
    playlistInput.focus();
    setStatus('Not saved', 'error');
    return;
  }

  const current = await getSettings();
  await setSettings({
    mode,
    playlist: {
      ...current.playlist,
      id: playlistId,
      title: playlistId === current.playlist.id ? current.playlist.title : '',
      strict: strict.checked,
    },
    topic: {
      ...current.topic,
      label: label.value.trim(),
      keywords: parseList(keywords.value),
      channels: parseList(channels.value),
      blockShorts: blockShorts.checked,
      scopeSearch: scopeSearch.checked,
      hideComments: hideComments.checked,
    },
  });
  setStatus('Saved');
}

/** Seed the keyword box from the titles already scraped off the playlist. */
async function handleImport() {
  const cache = await getPlaylistCache(parsePlaylistId(playlistInput.value.trim()));
  const suggested = suggestKeywords(cache?.titles);
  if (!suggested.length) {
    setStatus('Nothing to suggest from those titles', 'error');
    return;
  }
  const existing = parseList(keywords.value);
  const merged = [...new Set([...existing, ...suggested])];
  keywords.value = merged.join(', ');
  renderVerdict();
  setStatus(`Added ${merged.length - existing.length} keywords — review, then Save`);
}

render(await getSettings());

save.addEventListener('click', handleSave);
importButton.addEventListener('click', handleImport);
for (const input of [keywords, channels, testTitle, testChannel]) {
  input.addEventListener('input', renderVerdict);
}
playlistInput.addEventListener('input', () => {
  playlistError.hidden = true;
  playlistInput.setAttribute('aria-invalid', 'false');
});

// The popup writes the same keys; don't let the two views disagree.
onSettingsChanged((settings) => {
  if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
  render(settings);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'playlistCache' in changes) renderIndex(parsePlaylistId(playlistInput.value.trim()));
});
