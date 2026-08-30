// Stage 1 stub. The toggle is intentionally local-only; Stage 2 wires it to
// chrome.storage.sync through src/storage.js.

const toggle = document.getElementById('tt-enabled');

toggle.addEventListener('change', () => {
  console.log('[TunnelTube] toggle ->', toggle.checked, '(not persisted yet)');
});
