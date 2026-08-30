import { getSettings, setSettings, onSettingsChanged } from '../storage.js';

const enabled = document.getElementById('tt-enabled');
const state = document.getElementById('tt-state');
const modes = document.getElementById('tt-modes');
const openOptions = document.getElementById('tt-options');

/** Paint the controls from settings. Called on open and on any external change. */
function render(settings) {
  enabled.checked = settings.enabled;
  state.textContent = settings.enabled ? 'on' : 'off';
  document.body.classList.toggle('is-on', settings.enabled);
  const active = modes.querySelector(`input[value="${settings.mode}"]`);
  if (active) active.checked = true;
}

render(await getSettings());

enabled.addEventListener('change', () => {
  setSettings({ enabled: enabled.checked });
});

modes.addEventListener('change', (event) => {
  if (event.target.name !== 'tt-mode') return;
  setSettings({ mode: event.target.value });
});

openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// A second popup can't exist, but the options page or a future keyboard shortcut
// can change these while we're open.
onSettingsChanged(render);
