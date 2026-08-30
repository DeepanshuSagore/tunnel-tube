// Service worker: navigation gate + badge. MV3 kills it after ~30s idle, so
// never keep state in a module-level variable here — always read chrome.storage.

import { getSettings, onSettingsChanged } from './storage.js';
import { shouldRedirect } from './matcher.js';

const BADGE_ON = 'ON';
const BADGE_COLOR = '#1f9d55';
const YOUTUBE_FILTER = { url: [{ hostSuffix: 'youtube.com' }] };

/** Reflect the master toggle on the toolbar icon. */
async function paintBadge(settings = null) {
  const { enabled } = settings ?? (await getSettings());
  await chrome.action.setBadgeText({ text: enabled ? BADGE_ON : '' });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeTextColor({ color: '#ffffff' });
}

/**
 * Bounce a navigation that falls outside the tunnel.
 *
 * Fires for real page loads (onBeforeNavigate) and for YouTube's own SPA
 * navigations (onHistoryStateUpdated) — most clicks on YouTube are pushState,
 * which declarativeNetRequest would never see.
 */
async function gateNavigation({ tabId, frameId, url }) {
  if (frameId !== 0) return; // main frame only; embeds and ads live in subframes
  const target = shouldRedirect(url, await getSettings());
  if (!target) return;
  try {
    await chrome.tabs.update(tabId, { url: target });
  } catch (error) {
    // Tab closed mid-navigation, or Chrome took it over. Nothing to recover.
    console.debug('[TunnelTube] redirect skipped:', error.message);
  }
}

chrome.webNavigation.onBeforeNavigate.addListener(gateNavigation, YOUTUBE_FILTER);
chrome.webNavigation.onHistoryStateUpdated.addListener(gateNavigation, YOUTUBE_FILTER);

/** Pull every open YouTube tab back into the tunnel — used when the lock is switched on. */
async function sweepOpenTabs(settings) {
  const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
  for (const tab of tabs) {
    const target = shouldRedirect(tab.url ?? '', settings);
    if (target) chrome.tabs.update(tab.id, { url: target }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log('[TunnelTube] installed:', reason);
  paintBadge();
});

// The badge survives a worker restart, but a sync change that landed while the
// worker was asleep would not have been painted — so repaint on every wake-up.
chrome.runtime.onStartup.addListener(() => paintBadge());
paintBadge();

onSettingsChanged((settings) => {
  paintBadge(settings);
  sweepOpenTabs(settings);
});
