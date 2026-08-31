// Service worker: navigation gate + badge. MV3 kills it after ~30s idle, so
// never keep state in a module-level variable here — always read chrome.storage.

import { getSettings, setSettings, getPlaylistCache, onSettingsChanged } from './storage.js';
import { shouldRedirect, isLocked, nextLockedUntil } from './matcher.js';

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
  const [settings, cache] = await Promise.all([getSettings(), getPlaylistCache()]);
  const target = shouldRedirect(url, settings, cache);
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
  const [tabs, cache] = await Promise.all([
    chrome.tabs.query({ url: '*://*.youtube.com/*' }),
    getPlaylistCache(),
  ]);
  for (const tab of tabs) {
    const target = shouldRedirect(tab.url ?? '', settings, cache);
    if (target) chrome.tabs.update(tab.id, { url: target }).catch(() => {});
  }
}

/**
 * Arm or clear the session lock in one place, so the popup and the keyboard
 * shortcut can't disagree about it. Switching on starts the timer; switching
 * off clears whatever is left of it.
 */
async function syncSessionLock(settings) {
  const { enabled, guard } = settings;
  if (enabled && guard.minSessionMinutes > 0 && !guard.lockedUntil) {
    await setSettings({ guard: { ...guard, lockedUntil: nextLockedUntil(settings) } });
  } else if (!enabled && guard.lockedUntil) {
    await setSettings({ guard: { ...guard, lockedUntil: null } });
  }
}

// Alt+Shift+Y. Refuses to switch off while the session lock holds — breaking it
// early means opening the popup and typing the phrase, which is the whole point.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-lock') return;
  const settings = await getSettings();
  if (settings.enabled && isLocked(settings)) return;
  await setSettings({ enabled: !settings.enabled });
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log('[TunnelTube] installed:', reason);
  paintBadge();
});

// The badge survives a worker restart, but a sync change that landed while the
// worker was asleep would not have been painted — so repaint on every wake-up.
chrome.runtime.onStartup.addListener(() => paintBadge());
paintBadge();

onSettingsChanged((settings, changes) => {
  paintBadge(settings);
  sweepOpenTabs(settings);
  syncSessionLock(settings);
  // "Hidden this session" means since you switched the tunnel on.
  if (changes.enabled?.newValue === true) {
    chrome.storage.local.set({ stats: { hidden: 0, startedAt: Date.now() } });
  }
});
