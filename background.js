/**
 * background.js — Extension Service Worker (Manifest V3).
 *
 * Responsibilities:
 *  1. Capture m3u8 URLs via webRequest API as backup interception.
 *  2. Store stream state per tab.
 *  3. Relay messages between content script and popup.
 *  4. Provide direct API access for fetching stream data.
 */

try {
  importScripts('lib/clipperStorage.js');
} catch (e) {
  console.warn('[IDN Live Clipper Ext Service Worker] Could not load clipperStorage:', e);
}

// ── Constants ──────────────────────────────────────────────────────────────

const IDN_API_KEY = '123f4c4e-6ce1-404d-8786-d17e46d65b5c';
const IDN_GRAPHQL_URL = 'https://api.idn.app/graphql';
const IDN_REST_URL = 'https://api.idn.app/api/v1/web/livestream';

// ── Per-tab state ──────────────────────────────────────────────────────────

const tabState = {};

function getTabState(tabId) {
  if (!tabState[tabId]) {
    tabState[tabId] = {
      m3u8Urls: [],
      playbackUrl: null,
      streamData: null,
      qualities: [],
      currentQuality: null,
      autoMode: true,
      hasPlayer: false,
      clipperStats: { count: 0, totalBytes: 0, durationSec: 0 },
      lastUpdated: Date.now(),
    };
  }
  return tabState[tabId];
}

// Clean up state when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabState[tabId];
});

// ── 1. webRequest interception for m3u8 ────────────────────────────────────

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.url.includes('.m3u8') && details.tabId > 0) {
      const state = getTabState(details.tabId);

      if (!state.m3u8Urls.includes(details.url)) {
        state.m3u8Urls.push(details.url);
      }

      // Keep the master playlist (not variant/chunked)
      if (!details.url.includes('/chunked') && !details.url.includes('_chunked')) {
        state.playbackUrl = details.url;
        state.lastUpdated = Date.now();
      }

      // Update the extension badge
      updateBadge(details.tabId, 'LIVE');
    }
  },
  {
    urls: [
      'https://*.live-video.net/*.m3u8*',
      'https://*.cloudfront.net/*.m3u8*',
      'https://*.hls.live-video.net/*.m3u8*',
    ],
  }
);

// ── 2. Unified message handling (Content script, Popup & Clipper Tab) ──────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.action) {
    case 'm3u8Found': {
      if (tabId) {
        const state = getTabState(tabId);
        const url = message.payload?.url;
        if (url && !state.m3u8Urls.includes(url)) {
          state.m3u8Urls.push(url);
        }
        if (url && !url.includes('/chunked') && !url.includes('_chunked')) {
          state.playbackUrl = url;
        }
        state.lastUpdated = Date.now();
        updateBadge(tabId, 'LIVE');
      }
      sendResponse({ ok: true });
      break;
    }

    case 'playbackUrlFound': {
      if (tabId) {
        const state = getTabState(tabId);
        state.playbackUrl = message.payload?.url;
        state.lastUpdated = Date.now();
        updateBadge(tabId, 'LIVE');
      }
      sendResponse({ ok: true });
      break;
    }

    case 'streamData': {
      if (tabId) {
        const state = getTabState(tabId);
        state.streamData = message.payload;
        if (message.payload?.playbackUrl) {
          state.playbackUrl = message.payload.playbackUrl;
        }
        state.lastUpdated = Date.now();
      }
      sendResponse({ ok: true });
      break;
    }

    case 'playerFound': {
      if (tabId) {
        const state = getTabState(tabId);
        state.hasPlayer = true;
      }
      sendResponse({ ok: true });
      break;
    }

    case 'qualitiesAvailable':
    case 'qualityChanged': {
      if (tabId) {
        const state = getTabState(tabId);
        if (message.payload?.qualities) {
          state.qualities = message.payload.qualities;
        }
        if (message.payload?.current) {
          state.currentQuality = message.payload.current;
        }
        if (message.payload?.autoMode !== undefined) {
          state.autoMode = message.payload.autoMode;
        }
        state.lastUpdated = Date.now();
      }
      sendResponse({ ok: true });
      break;
    }

    case 'clipperStats': {
      if (tabId) {
        const state = getTabState(tabId);
        state.clipperStats = message.payload;
        state.lastUpdated = Date.now();
      }
      sendResponse({ ok: true });
      break;
    }

    case 'getTabState': {
      const targetTabId = message.tabId || tabId;
      sendResponse(targetTabId ? (tabState[targetTabId] || null) : null);
      return true;
    }

    case 'getAllTabStates': {
      sendResponse(tabState);
      return true;
    }

    case 'openClipperTab': {
      let slug = message.payload?.slug || message.slug || '';
      const givenTabId = message.payload?.tabId || message.tabId;
      (async () => {
        let targetTabId = givenTabId;
        if (!targetTabId) {
          try {
            const tabs = await chrome.tabs.query({ url: ['https://*.idn.app/*', 'https://idn.app/*'] });
            let matchingTab = null;
            if (slug) {
              matchingTab = tabs.find((t) => t.url && t.url.includes(slug));
            } else if (tabs.length > 0) {
              matchingTab = tabs.find((t) => t.url && (t.url.includes('/live/') || t.url.includes('/embed-player/'))) || tabs[0];
              if (matchingTab && matchingTab.url) {
                const match =
                  matchingTab.url.match(/\/(?:live|embed-player|embed)\/([a-zA-Z0-9_-]+)/) ||
                  matchingTab.url.match(/^\/[^/]+\/live\/([a-zA-Z0-9_-]+)/);
                if (match && match[1]) slug = match[1];
              }
            }
            if (matchingTab) {
              targetTabId = matchingTab.id;
            }
          } catch (_) {}
        }
        if (!targetTabId && tabId && sender.tab?.url && sender.tab.url.includes('idn.app')) {
          if (!slug || sender.tab.url.includes(slug)) {
            targetTabId = tabId;
          }
        }
        const tabParam = targetTabId ? `&tabId=${targetTabId}` : '';
        const url = chrome.runtime.getURL(`clipper/clipper.html?slug=${encodeURIComponent(slug)}${tabParam}`);
        await chrome.tabs.create({ url });
        sendResponse({ ok: true, tabId: targetTabId });
      })();
      return true;
    }

    case 'findStreamTab': {
      const slug = message.slug || message.payload?.slug;
      chrome.tabs.query({ url: ['https://*.idn.app/*', 'https://idn.app/*'] }, (tabs) => {
        let matchingTab = null;
        if (slug) {
          matchingTab = tabs.find((t) => t.url && t.url.includes(slug));
        } else if (tabs.length > 0) {
          // If no slug requested, prefer active live stream tab
          matchingTab = tabs.find((t) => t.url && (t.url.includes('/live/') || t.url.includes('/embed-player/'))) || tabs[0];
        }
        sendResponse({ tab: matchingTab || null });
      });
      return true;
    }

    case 'downloadClip': {
      const payload = message.payload || {};
      chrome.downloads.download(
        {
          url: payload.url,
          filename: payload.filename || 'idn_live_clip.mp4',
          saveAs: payload.saveAs ?? false,
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ ok: true, downloadId });
          }
        }
      );
      return true;
    }

    case 'fetchLiveStreams': {
      fetchLiveStreams(message.category || 'all', message.page || 1)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case 'fetchStreamBySlug': {
      fetchStreamBySlug(message.slug)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case 'SAVE_SEGMENT': {
      (async () => {
        try {
          if (message.segment && globalThis.ClipperStorage) {
            let data = message.segment.data;
            const hasValidBuffer = data && (data instanceof ArrayBuffer || data instanceof Uint8Array) && data.byteLength > 0;
            if (!hasValidBuffer && message.segment.base64) {
              const bin = atob(message.segment.base64);
              const u8 = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) {
                u8[i] = bin.charCodeAt(i);
              }
              data = u8.buffer;
            } else if (hasValidBuffer && data instanceof Uint8Array) {
              data = data.buffer;
            } else if (!hasValidBuffer) {
              data = null;
            }

            if (data && data.byteLength > 0) {
              await globalThis.ClipperStorage.saveSegment({ ...message.segment, data });
              // Periodic prune: ~5% chance per incoming segment to keep buffer healthy
              if (Math.random() < 0.05) {
                globalThis.ClipperStorage.pruneOldSegments(message.segment.streamSlug).catch(() => {});
              }
            }
          }
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case 'SAVE_STREAM_METADATA': {
      (async () => {
        try {
          if (message.slug && message.metadata && globalThis.ClipperStorage) {
            await globalThis.ClipperStorage.saveStreamMetadata(message.slug, message.metadata);
            // Also keep chrome.storage.local sync map updated
            const storageRes = await chrome.storage.local.get(['better_idn_cached_streams']);
            const cachedMap = storageRes.better_idn_cached_streams || {};
            cachedMap[message.slug] = {
              ...(cachedMap[message.slug] || {}),
              streamSlug: message.slug,
              ...message.metadata,
              updatedAt: Date.now(),
            };
            await chrome.storage.local.set({ better_idn_cached_streams: cachedMap }).catch(() => {});
          }
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case 'GET_ALL_CACHED_STREAMS': {
      (async () => {
        try {
          const mergedMap = new Map();

          const mergeStream = (s) => {
            if (!s || !s.streamSlug) return;
            const existing = mergedMap.get(s.streamSlug);
            if (!existing) {
              mergedMap.set(s.streamSlug, { ...s });
            } else {
              const existingCount = existing.count || 0;
              const newCount = s.count || 0;
              const existingTime = existing.lastSavedAt || existing.updatedAt || 0;
              const newTime = s.lastSavedAt || s.updatedAt || 0;

              mergedMap.set(s.streamSlug, {
                ...existing,
                ...s,
                count: Math.max(existingCount, newCount),
                totalBytes: Math.max(existing.totalBytes || 0, s.totalBytes || 0),
                durationSec: Math.max(existing.durationSec || 0, s.durationSec || 0),
                lastSavedAt: Math.max(existingTime, newTime),
                updatedAt: Math.max(existingTime, newTime),
                title: s.title || existing.title || s.streamSlug,
                creator: s.creator || existing.creator || '',
                creatorUsername: s.creatorUsername || existing.creatorUsername || '',
                creatorAvatar: s.creatorAvatar || existing.creatorAvatar || '',
                status: s.status || existing.status || 'ended',
                playbackUrl: s.playbackUrl || existing.playbackUrl || '',
              });
            }
          };

          // 1. Read persisted streams metadata from chrome.storage.local
          try {
            const storageRes = await chrome.storage.local.get(['better_idn_cached_streams']);
            const cachedMap = storageRes.better_idn_cached_streams || {};
            for (const s of Object.values(cachedMap)) {
              mergeStream(s);
            }
          } catch (_) {}

          // 2. Query extension-origin IndexedDB directly
          if (globalThis.ClipperStorage) {
            try {
              const extStreams = await globalThis.ClipperStorage.getAllCachedStreams();
              if (Array.isArray(extStreams)) {
                for (const s of extStreams) {
                  mergeStream(s);
                }
              }
            } catch (_) {}
          }

          // 3. Query all active IDN tabs for real-time IndexedDB state
          try {
            const tabs = await chrome.tabs.query({ url: ['https://*.idn.app/*', 'https://idn.app/*'] });
            for (const tab of tabs) {
              try {
                const response = await chrome.tabs.sendMessage(tab.id, { action: 'GET_ALL_CACHED_STREAMS' });
                if (response && response.ok && Array.isArray(response.streams)) {
                  for (const s of response.streams) {
                    mergeStream(s);
                  }
                }
              } catch (_) {}
            }
          } catch (_) {}

          const streams = Array.from(mergedMap.values());
          streams.sort((a, b) => (b.lastSavedAt || b.updatedAt || 0) - (a.lastSavedAt || a.updatedAt || 0));

          // Keep chrome.storage.local updated with the merged map
          const newStorageMap = {};
          for (const s of streams) {
            newStorageMap[s.streamSlug] = s;
          }
          await chrome.storage.local.set({ better_idn_cached_streams: newStorageMap }).catch(() => {});

          sendResponse({ ok: true, streams });
        } catch (err) {
          sendResponse({ ok: false, error: err.message, streams: [] });
        }
      })();
      return true;
    }

    case 'CLEAR_CACHED_STREAM': {
      (async () => {
        try {
          const slug = message.slug;
          if (!slug) return sendResponse({ ok: false, error: 'No stream slug provided' });

          // 1. Clear from extension IndexedDB
          if (globalThis.ClipperStorage) {
            await globalThis.ClipperStorage.clearStream(slug).catch(() => {});
          }

          // 2. Update storage record immediately
          const storageRes = await chrome.storage.local.get(['better_idn_cached_streams', 'better_idn_pending_clears']);
          const cachedMap = storageRes.better_idn_cached_streams || {};
          delete cachedMap[slug];
          await chrome.storage.local.set({ better_idn_cached_streams: cachedMap });

          // 3. If IDN tab is open, ask it to purge from web page IndexedDB
          const tabs = await chrome.tabs.query({ url: ['https://*.idn.app/*', 'https://idn.app/*'] });
          let purged = false;
          if (tabs.length > 0) {
            for (const tab of tabs) {
              try {
                await chrome.tabs.sendMessage(tab.id, { action: 'CLEAR_CACHED_STREAM', slug });
                purged = true;
                break;
              } catch (_) {}
            }
          }

          // 4. If no IDN tab was open, queue for next IDN visit
          if (!purged) {
            const pending = storageRes.better_idn_pending_clears || [];
            if (!pending.includes(slug)) pending.push(slug);
            await chrome.storage.local.set({ better_idn_pending_clears: pending });
          }

          sendResponse({ ok: true, slug });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case 'CLEAR_ALL_CACHED_STREAMS': {
      (async () => {
        try {
          // 1. Clear extension IndexedDB
          if (globalThis.ClipperStorage) {
            await globalThis.ClipperStorage.clearAll().catch(() => {});
          }

          // 2. Clear storage immediately
          await chrome.storage.local.set({ better_idn_cached_streams: {} });

          // 3. If IDN tab is open, ask it to clear all
          const tabs = await chrome.tabs.query({ url: ['https://*.idn.app/*', 'https://idn.app/*'] });
          let purged = false;
          if (tabs.length > 0) {
            for (const tab of tabs) {
              try {
                await chrome.tabs.sendMessage(tab.id, { action: 'CLEAR_ALL_CACHED_STREAMS' });
                purged = true;
                break;
              } catch (_) {}
            }
          }

          if (!purged) {
            await chrome.storage.local.set({ better_idn_pending_clear_all: true });
          }

          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    default:
      sendResponse({ ok: true, unhandled: true });
      break;
  }
});

// ── 4. Direct API calls ────────────────────────────────────────────────────

async function fetchLiveStreams(category = 'all', page = 1) {
  const query = `
    query GetLivestream($category: String, $page: Int) {
      getLivestreams(category: $category, page: $page) {
        slug
        title
        image_url
        view_count
        playback_url
        room_identifier
        status
        live_at
        live_type
        category {
          name
          slug
        }
        creator {
          name
          username
          uuid
        }
      }
    }
  `;

  const response = await fetch(IDN_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': IDN_API_KEY,
    },
    body: JSON.stringify({
      query,
      variables: { category, page },
    }),
  });

  if (!response.ok) throw new Error(`GraphQL request failed: ${response.status}`);
  const json = await response.json();
  return json.data?.getLivestreams || [];
}

async function fetchStreamBySlug(slug) {
  const response = await fetch(`${IDN_REST_URL}/${slug}`, {
    headers: {
      'X-API-Key': IDN_API_KEY,
    },
  });

  if (!response.ok) throw new Error(`REST request failed: ${response.status}`);
  return response.json();
}

// ── 5. Badge management ────────────────────────────────────────────────────

function updateBadge(tabId, text) {
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#e53935', tabId }).catch(() => {});
}

// Clear badge when navigating away from idn.app
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && !changeInfo.url.includes('idn.app')) {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
    delete tabState[tabId];
  }
});

console.log('[IDN Live Clipper Ext] Service worker loaded');
