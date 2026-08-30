// Service worker. MV3 kills it after ~30s idle, so never keep state in a
// module-level variable here — always read chrome.storage.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log('[TunnelTube] installed:', reason);
});
