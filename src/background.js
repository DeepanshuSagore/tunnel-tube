// Service worker. MV3 kills it after ~30s idle, so never keep state in a
// module-level variable here — always read chrome.storage.

import { getSettings, onSettingsChanged } from './storage.js';

const BADGE_ON = 'ON';
const BADGE_COLOR = '#1f9d55';

/** Reflect the master toggle on the toolbar icon. */
async function paintBadge(settings = null) {
  const { enabled } = settings ?? (await getSettings());
  await chrome.action.setBadgeText({ text: enabled ? BADGE_ON : '' });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeTextColor({ color: '#ffffff' });
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log('[TunnelTube] installed:', reason);
  paintBadge();
});

// The badge survives a worker restart, but a sync change that landed while the
// worker was asleep would not have been painted — so repaint on every wake-up.
chrome.runtime.onStartup.addListener(() => paintBadge());
paintBadge();

onSettingsChanged((settings) => paintBadge(settings));
