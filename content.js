/**
 * content.js — Runs in the EXTENSION's isolated world on idn.app pages.
 *
 * Responsibilities:
 *  1. Inject lib/clipperStorage.js and injected.js into the page context.
 *  2. Bridge messages between the page (injected.js) and the extension (background.js / popup).
 *  3. Inject the on-page quality selector UI overlay.
 *  4. Inject the IDN Live Clipper dock, timeline scrubber, and secondary preview player.
 *  5. Provide fast in-browser MPEG-TS to MP4 remuxing and clipping downloads.
 */
(function () {
  'use strict';

  if (window !== window.top) {
    return;
  }

  const MSG_PREFIX = 'BETTER_IDN_LIVE';

  // ── State ────────────────────────────────────────────────────────────────

  const state = {
    m3u8Urls: [],
    playbackUrl: null,
    streamData: null,
    qualities: [],
    currentQuality: null,
    autoMode: true,
    hasPlayer: false,
  };

  const clipper = {
    isOpen: false,
    timeMode: 'local', // 'local' | 'relative'
    stats: {
      count: 0,
      totalBytes: 0,
      minTime: 0,
      maxTime: 0,
      durationSec: 0,
    },
    selectionStartMs: null,
    selectionEndMs: null,
    playheadMs: null,
    retentionMinutes: 30,
    previewVideo: null,
    previewBlobUrl: null,
    isPlayingPreview: false,
    isGeneratingPreview: false,
    dockEl: null,
    previewContainerEl: null,
    isDragging: null, // 'start' | 'end' | 'playhead'
    activeStreamSlug: null,
  };

  // ── 0. Suppress Zendesk Chat Widget ──────────────────────────────────────
  // idn.app unconditionally embeds Zendesk Messenger via static.zdassets.com.
  // Next.js _app checks document.getElementById('ze-snippet') before injecting.
  // We preempt this with a placeholder, inject hiding CSS, and purge any launcher nodes.

  const ZENDESK_SELECTORS = [
    '#launcher',
    '#webWidget',
    '#web-widget-launcher',
    '#web-widget-chat',
    '.zEWidget-launcher',
    'iframe[title*="Messaging window" i]',
    'iframe[title*="Launcher" i]',
    'iframe[title*="Zendesk" i]',
    'iframe[title*="Bantuan" i]',
    'iframe[name*="Messaging window" i]',
    'iframe[name*="Launcher" i]',
    'iframe[name*="Zendesk" i]',
    'iframe[src*="zendesk.com"]',
    'iframe[src*="zdassets.com"]',
    'div[class*="zEWidget"]',
    'div[data-testid="launcher"]',
    'div[data-testid="widget-launcher"]',
    'div[id*="zEWidget"]',
    'script[src*="zdassets.com"]',
    'script[src*="zendesk.com"]',
  ];

  function isZendeskElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.id === 'ze-snippet' && el.getAttribute('data-bidn-blocked') === 'true') return false;
    if (el.id === 'launcher' || el.id === 'webWidget' || el.id === 'web-widget-launcher' || el.id === 'web-widget-chat') return true;
    if (el.classList && el.classList.contains('zEWidget-launcher')) return true;
    if (el.tagName === 'IFRAME') {
      const title = (el.getAttribute('title') || '').toLowerCase();
      const name = (el.getAttribute('name') || '').toLowerCase();
      const src = (el.getAttribute('src') || '').toLowerCase();
      if (title.includes('messaging window') || title.includes('launcher') || title.includes('zendesk') || title.includes('bantuan')) return true;
      if (name.includes('messaging window') || name.includes('launcher') || name.includes('zendesk')) return true;
      if (src.includes('zendesk.com') || src.includes('zdassets.com')) return true;
    }
    if (el.tagName === 'SCRIPT') {
      const src = (el.getAttribute('src') || '').toLowerCase();
      if (src.includes('zdassets.com') || src.includes('zendesk.com')) return true;
    }
    if (el.getAttribute('data-testid') === 'launcher' || el.getAttribute('data-testid') === 'widget-launcher') return true;
    return false;
  }

  function purgeZendeskElements(root = document) {
    try {
      for (const sel of ZENDESK_SELECTORS) {
        const elements = root.querySelectorAll(sel);
        for (const el of elements) {
          if (el.id === 'ze-snippet' && el.getAttribute('data-bidn-blocked') === 'true') {
            continue;
          }
          el.remove();
        }
      }
    } catch (_) {}
  }

  function preemptZendesk() {
    const target = document.documentElement || document.head;
    if (!target) return;

    // 1. Preempt snippet insertion by Next.js _app.js
    if (!document.getElementById('ze-snippet')) {
      const dummy = document.createElement('script');
      dummy.id = 'ze-snippet';
      dummy.type = 'text/plain';
      dummy.setAttribute('data-bidn-blocked', 'true');
      dummy.textContent = '/* zendesk blocked by idn-live-clipper-ext */';
      target.appendChild(dummy);
    }

    // 2. Inject CSS rule to permanently hide any Zendesk launcher / widget
    if (!document.getElementById('bidn-suppress-zendesk-style')) {
      const style = document.createElement('style');
      style.id = 'bidn-suppress-zendesk-style';
      style.textContent = `
        #launcher,
        #webWidget,
        #web-widget-launcher,
        #web-widget-chat,
        .zEWidget-launcher,
        iframe[title*="Messaging window" i],
        iframe[title*="Launcher" i],
        iframe[title*="Zendesk" i],
        iframe[title*="Bantuan" i],
        iframe[name*="Messaging window" i],
        iframe[name*="Launcher" i],
        iframe[name*="Zendesk" i],
        iframe[src*="zendesk.com"],
        iframe[src*="zdassets.com"],
        div[class*="zEWidget"],
        div[data-testid="launcher"],
        div[data-testid="widget-launcher"],
        div[id*="zEWidget"] {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          pointer-events: none !important;
          width: 0 !important;
          height: 0 !important;
          max-width: 0 !important;
          max-height: 0 !important;
          position: absolute !important;
          top: -99999px !important;
          left: -99999px !important;
          clip: rect(0, 0, 0, 0) !important;
          z-index: -99999 !important;
        }
      `;
      target.appendChild(style);
    }

    purgeZendeskElements(document);
  }

  // Preempt immediately at document_start
  if (document.documentElement || document.head) {
    preemptZendesk();
  } else {
    document.addEventListener('DOMContentLoaded', preemptZendesk, { once: true });
  }

  // Observe and remove dynamically injected Zendesk nodes
  const zendeskCleanerObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (isZendeskElement(node)) {
            node.remove();
          } else if (node.firstElementChild) {
            purgeZendeskElements(node);
          }
        }
      }
    }
  });

  function startZendeskCleanerObserver() {
    const root = document.documentElement || document.body;
    if (root) {
      zendeskCleanerObserver.observe(root, { childList: true, subtree: true });
      purgeZendeskElements(root);
    } else {
      document.addEventListener('DOMContentLoaded', startZendeskCleanerObserver, { once: true });
    }
  }

  startZendeskCleanerObserver();

  // ── 1. Inject page-context scripts ───────────────────────────────────────

  function injectPageScripts() {
    const target = document.head || document.documentElement;
    if (!target) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectPageScripts, { once: true });
      }
      return;
    }
    const scripts = ['lib/clipperStorage.js', 'injected.js'];
    for (const src of scripts) {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(src);
      script.async = false;
      target.appendChild(script);
    }
  }

  injectPageScripts();

  // Helper to get active stream slug
  function getActiveSlug() {
    if (clipper.activeStreamSlug) return clipper.activeStreamSlug;
    if (state.streamData?.slug) return state.streamData.slug;
    const path = window.location.pathname;
    const match =
      path.match(/\/(?:live|embed-player|embed)\/([a-zA-Z0-9_-]+)/) ||
      path.match(/^\/[^/]+\/live\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : 'idn_stream';
  }

  // ── 2. Listen for messages from injected.js ──────────────────────────────

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== MSG_PREFIX) return;

    const { type, payload } = event.data;

    switch (type) {
      case 'M3U8_URL': {
        const url = payload.url;
        if (url && !state.m3u8Urls.includes(url)) {
          state.m3u8Urls.push(url);
          if (!url.includes('/chunked/') && !url.includes('/segment')) {
            state.playbackUrl = url;
            startBufferEngine(url, getActiveSlug());
          }
        }
        forwardToBackground('m3u8Found', { url, source: payload.source, all: state.m3u8Urls });
        break;
      }

      case 'PLAYBACK_URL': {
        state.playbackUrl = payload.url;
        forwardToBackground('playbackUrlFound', { url: payload.url, key: payload.key });
        startBufferEngine(payload.url, getActiveSlug());
        break;
      }

      case 'STREAM_DATA': {
        state.streamData = payload;
        if (payload.playbackUrl) {
          state.playbackUrl = payload.playbackUrl;
        }
        if (payload.slug) {
          clipper.activeStreamSlug = payload.slug;
        }
        forwardToBackground('streamData', payload);
        if (state.playbackUrl) {
          startBufferEngine(state.playbackUrl, clipper.activeStreamSlug || getActiveSlug());
        }
        if (window.ClipperStorage) {
          window.ClipperStorage.saveStreamMetadata(clipper.activeStreamSlug || getActiveSlug(), {
            title: payload.title,
            creator: payload.creator?.name,
            creatorUsername: payload.creator?.username,
            creatorAvatar: payload.creator?.image_url,
            status: payload.status || 'live',
            playbackUrl: payload.playback_url,
          }).then(() => syncCachedStreamsToStorage()).catch(() => {});
        }
        break;
      }

      case 'STREAM_ENDED': {
        const endedSlug = payload?.streamSlug || getActiveSlug();
        if (window.ClipperStorage) {
          window.ClipperStorage.saveStreamMetadata(endedSlug, { status: 'ended' })
            .then(() => syncCachedStreamsToStorage())
            .catch(() => {});
        }
        showToast('Stream ended. Cached video available in Clipper Studio', 'info', 4000);
        break;
      }

      case 'PLAYER_FOUND': {
        state.hasPlayer = true;
        forwardToBackground('playerFound', payload);
        createQualityOverlay();
        break;
      }

      case 'QUALITIES_AVAILABLE': {
        state.hasPlayer = true;
        state.qualities = payload.qualities || [];
        state.currentQuality = payload.current;
        state.autoMode = payload.autoMode;
        forwardToBackground('qualitiesAvailable', payload);
        createQualityOverlay();
        updateQualityOverlay();
        break;
      }

      case 'QUALITY_CHANGED': {
        state.hasPlayer = true;
        state.currentQuality = payload.current;
        if (payload.all) state.qualities = payload.all;
        forwardToBackground('qualityChanged', payload);
        createQualityOverlay();
        updateQualityOverlay();
        // Guard against ABR downgrades when minimized or in autoMode
        const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
        const isLowRes = payload.current?.name === '160p' || payload.current?.name === '360p';
        if (payload.current?.name && !state.autoMode && !payload.autoMode && !(isHidden && isLowRes)) {
          bufferEngine.setQuality(payload.current.name);
        }
        break;
      }

      case 'QUALITY_SET': {
        forwardToBackground('quality_set', payload);
        sendToPage('GET_QUALITIES', {});
        break;
      }

      case 'AUTO_QUALITY_SET': {
        forwardToBackground('auto_quality_set', payload);
        sendToPage('GET_QUALITIES', {});
        break;
      }

      case 'SEGMENT_CACHED': {
        if (payload.streamSlug) clipper.activeStreamSlug = payload.streamSlug;
        if (payload.sequence != null && typeof bufferEngine !== 'undefined') {
          bufferEngine.downloadedSeqs.add(payload.sequence);
        }
        refreshClipperStats();
        if (payload.data && payload.streamSlug) {
          // Send ArrayBuffer directly to avoid heavy base64 CPU conversion on main thread
          chrome.runtime.sendMessage({
            action: 'SAVE_SEGMENT',
            segment: {
              streamSlug: payload.streamSlug,
              sequence: payload.sequence,
              timestamp: payload.timestamp,
              duration: payload.duration,
              url: payload.url || '',
              data: payload.data,
              quality: payload.quality || 'auto',
            },
          }).catch(() => {});
        }
        break;
      }

      case 'CLIPPER_STATS': {
        clipper.stats = payload;
        forwardToBackground('clipperStats', payload);
        updateClipperUI();
        break;
      }

      case 'CLIPPER_BUFFER_CLEARED': {
        refreshClipperStats();
        break;
      }

      case 'ERROR':
      case 'PONG': {
        forwardToBackground(type.toLowerCase(), payload);
        break;
      }
    }
  });

  // ── 3. Listen for messages from popup / background ───────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case 'getState': {
        sendResponse({ ...state, clipperStats: clipper.stats });
        return true;
      }

      case 'setQuality': {
        sendToPage('SET_QUALITY', { name: message.qualityName });
        if (typeof bufferEngine !== 'undefined') {
          bufferEngine.setQuality(message.qualityName);
        }
        sendResponse({ ok: true });
        return true;
      }

      case 'setAutoQuality': {
        sendToPage('SET_AUTO_QUALITY', {});
        if (typeof bufferEngine !== 'undefined') {
          bufferEngine.setQuality('auto');
        }
        sendResponse({ ok: true });
        return true;
      }

      case 'getQualities': {
        sendToPage('GET_QUALITIES', {});
        sendResponse({ ok: true });
        return true;
      }

      case 'getStreamUrl': {
        sendToPage('GET_STREAM_URL', {});
        sendResponse({ ok: true, currentUrl: state.playbackUrl });
        return true;
      }

      case 'openClipper': {
        openClipperStudioTab();
        sendResponse({ ok: true });
        return true;
      }

      case 'closeClipper': {
        closeClipperDock();
        sendResponse({ ok: true });
        return true;
      }

      case 'GET_CLIPPER_DATA': {
        (async () => {
          try {
            const slug = message.slug || getActiveSlug();
            const stats = window.ClipperStorage ? await window.ClipperStorage.getStats(slug) : clipper.stats;
            const segmentsMeta = window.ClipperStorage ? await window.ClipperStorage.getSegmentsMeta(slug) : [];

            let title = document.title;
            let creator = {};
            let playbackUrl = '';
            let qualities = [];

            if (!message.slug || message.slug === getActiveSlug()) {
              title = state.streamData?.title || document.title;
              creator = state.streamData?.creator || {};
              playbackUrl = state.playbackUrl || '';
              qualities = state.qualities || [];
            } else {
              const meta = window.ClipperStorage ? await window.ClipperStorage.getStreamMetadata(slug) : null;
              if (meta) {
                title = meta.title || slug;
                creator = { name: meta.creator || '' };
                playbackUrl = meta.playbackUrl || '';
              } else {
                const storageRes = await chrome.storage.local.get(['better_idn_cached_streams']);
                const cached = storageRes.better_idn_cached_streams?.[slug];
                if (cached) {
                  title = cached.title || slug;
                  creator = { name: cached.creator || '' };
                  playbackUrl = cached.playbackUrl || '';
                }
              }
            }

            const streamInfo = {
              title,
              creator,
              slug,
              playbackUrl,
              qualities,
            };
            sendResponse({ ok: true, stats, segmentsMeta, streamInfo });
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
        })();
        return true;
      }

      case 'TRANSMUX_CLIP_RANGE': {
        (async () => {
          try {
            const slug = message.slug || getActiveSlug();
            if (!window.ClipperStorage || !window.ClipperTransmuxer) {
              return sendResponse({ ok: false, error: 'Clipper storage or transmuxer not ready' });
            }
            const segments = await window.ClipperStorage.getSegmentsInRange(slug, message.startMs, message.endMs);
            if (!segments || segments.length === 0) {
              return sendResponse({ ok: false, error: 'No buffered video segments available for selected range.' });
            }

            const { blob, duration, size, segmentCount } = await window.ClipperTransmuxer.transmux(segments);

            // If clip is too large to safely transfer over Chrome Extension IPC (>45MB blob ~ 60MB Base64)
            if (blob.size > 45 * 1024 * 1024) {
              if (message.isDownload) {
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = message.filename || `${slug}_clip.mp4`;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => a.remove(), 1000);
                return sendResponse({
                  ok: true,
                  downloadTriggeredDirectly: true,
                  duration,
                  size,
                  segmentCount,
                });
              } else {
                return sendResponse({
                  ok: false,
                  error: 'Selected clip is too large (>45MB) to preview. Please select a shorter range for preview or click Download MP4.',
                });
              }
            }

            // Convert MP4 Blob to Base64 for safe IPC transfer
            const reader = new FileReader();
            reader.onloadend = () => {
              const res = reader.result;
              const base64 = typeof res === 'string' && res.includes(',') ? res.split(',')[1] : '';
              sendResponse({
                ok: true,
                base64,
                duration,
                size,
                segmentCount,
              });
            };
            reader.onerror = () => {
              sendResponse({ ok: false, error: 'Failed to encode MP4 data' });
            };
            reader.readAsDataURL(blob);
          } catch (err) {
            console.error('[IDN Live Clipper Ext] Remux error:', err);
            sendResponse({ ok: false, error: err.message });
          }
        })();
        return true;
      }

      case 'SYNC_STREAM_TO_EXTENSION': {
        (async () => {
          try {
            await syncCurrentStreamSegmentsToExtension(message.slug);
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
        })();
        return true;
      }

      case 'GET_SEGMENTS_IN_RANGE': {
        (async () => {
          try {
            const slug = message.slug || getActiveSlug();
            if (!window.ClipperStorage) {
              return sendResponse({ ok: false, error: 'ClipperStorage not loaded' });
            }
            const segments = await window.ClipperStorage.getSegmentsInRange(slug, message.startMs, message.endMs);
            sendResponse({ ok: true, segments });
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
        })();
        return true;
      }

      case 'GET_SEGMENTS_CHUNK_BASE64': {
        (async () => {
          try {
            const slug = message.slug || getActiveSlug();
            const offset = message.offset || 0;
            const limit = message.limit || 25;
            if (!window.ClipperStorage) {
              return sendResponse({ ok: false, error: 'ClipperStorage not loaded' });
            }
            const allMeta = await window.ClipperStorage.getSegmentsMeta(slug);
            const sliceMeta = allMeta.slice(offset, offset + limit);
            const db = await window.ClipperStorage.openDB();
            const items = await new Promise((resolve) => {
              const tx = db.transaction(['segments'], 'readonly');
              const store = tx.objectStore('segments');
              const results = [];
              let remaining = sliceMeta.length;
              if (remaining === 0) return resolve([]);
              for (const m of sliceMeta) {
                const req = store.get(`${slug}_${m.sequence}`);
                req.onsuccess = () => {
                  const s = req.result;
                  if (s) {
                    results.push({
                      streamSlug: s.streamSlug,
                      sequence: s.sequence,
                      timestamp: s.timestamp,
                      duration: s.duration,
                      url: s.url,
                      quality: s.quality,
                      isInitSegment: s.isInitSegment,
                      base64: s.data ? arrayBufferToBase64(s.data) : '',
                      byteLength: s.byteLength,
                    });
                  }
                  if (--remaining === 0) {
                    results.sort((a, b) => a.sequence - b.sequence);
                    resolve(results);
                  }
                };
                req.onerror = () => {
                  if (--remaining === 0) {
                    results.sort((a, b) => a.sequence - b.sequence);
                    resolve(results);
                  }
                };
              }
            });
            sendResponse({
              ok: true,
              items,
              total: allMeta.length,
              offset,
              hasMore: offset + limit < allMeta.length,
            });
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
        })();
        return true;
      }

      case 'UNMUTE_STREAM': {
        unmuteLiveStream();
        sendResponse({ ok: true });
        return true;
      }

      case 'getClipperStats': {
        sendResponse(clipper.stats);
        return true;
      }

      case 'quickClip': {
        quickClipLastSeconds(message.seconds || 30)
          .then((result) => sendResponse({ ok: true, result }))
          .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;
      }

      case 'clearBuffer': {
        clearBuffer(message.slug)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;
      }

      case 'GET_ALL_CACHED_STREAMS': {
        (async () => {
          try {
            if (!window.ClipperStorage) {
              return sendResponse({ ok: false, error: 'ClipperStorage not ready' });
            }
            const slug = getActiveSlug();
            if (state.streamData) {
              await window.ClipperStorage.saveStreamMetadata(slug, {
                title: state.streamData.title,
                creator: state.streamData.creator?.name,
                creatorUsername: state.streamData.creator?.username,
                creatorAvatar: state.streamData.creator?.image_url,
                status: 'live',
                playbackUrl: state.playbackUrl,
              }).catch(() => {});
            }
            const streams = await window.ClipperStorage.getAllCachedStreams();
            await syncCachedStreamsToStorage(streams);
            sendResponse({ ok: true, streams });
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
        })();
        return true;
      }

      case 'CLEAR_CACHED_STREAM': {
        (async () => {
          try {
            const slug = message.slug || getActiveSlug();
            await clearBuffer(slug);
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
            if (window.ClipperStorage) {
              await window.ClipperStorage.clearAll();
            }
            sendToPage('CLEAR_CLIPPER_BUFFER', {});
            clipper.stats = { count: 0, totalBytes: 0, minTime: 0, maxTime: 0, durationSec: 0 };
            updateClipperUI();
            await chrome.storage.local.set({ better_idn_cached_streams: {} }).catch(() => {});
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
        })();
        return true;
      }

      case 'setRetention': {
        clipper.retentionMinutes = message.minutes || 30;
        sendToPage('SET_BUFFER_LIMIT', { retentionMinutes: clipper.retentionMinutes });
        sendResponse({ ok: true });
        return true;
      }

      case 'ping': {
        sendToPage('PING', {});
        sendResponse({ ok: true, state, clipperStats: clipper.stats });
        return true;
      }
    }
  });

  // ── 4. Message helpers & Audio Watchdog ──────────────────────────────────

  function unmuteLiveStream() {
    try {
      sendToPage('UNMUTE_LIVE_PLAYER', {});
      const videos = document.querySelectorAll('video');
      videos.forEach((v) => {
        v.muted = false;
        v.volume = 1.0;
        if (v.paused && v.dataset.bidnUserPaused !== 'true') {
          v.play().catch(() => {});
        }
      });
    } catch (_) {}
  }

  function forwardToBackground(action, payload) {
    chrome.runtime.sendMessage({ action, payload }).catch(() => {});
  }

  function sendToPage(type, payload) {
    window.postMessage({ source: MSG_PREFIX + '_CMD', type, payload }, '*');
  }

  async function refreshClipperStats() {
    if (!window.ClipperStorage) return;
    try {
      const slug = getActiveSlug();
      const stats = await window.ClipperStorage.getStats(slug);
      clipper.stats = stats;
      forwardToBackground('clipperStats', stats);
      chrome.runtime.sendMessage({ action: 'clipper_segment_update', slug, stats }).catch(() => {});
      updateClipperUI();
      // Throttle full storage sync to at most once every 10 seconds during active live stream
      if (!window._lastSyncStorage || Date.now() - window._lastSyncStorage > 10000) {
        window._lastSyncStorage = Date.now();
        syncCachedStreamsToStorage().catch(() => {});
      }
    } catch (_) {}
  }

  /**
   * Sync all cached streams summary from IndexedDB to chrome.storage.local
   * so popup and extension pages can inspect cached stream videos even when idle.
   */
  async function syncCachedStreamsToStorage(existingStreams) {
    if (!window.ClipperStorage) return [];
    try {
      const streams = existingStreams || (await window.ClipperStorage.getAllCachedStreams());
      const map = {};
      for (const s of streams) {
        map[s.streamSlug] = s;
      }
      await chrome.storage.local.set({ better_idn_cached_streams: map }).catch(() => {});
      return streams;
    } catch (_) {
      return [];
    }
  }

  function arrayBufferToBase64(buf) {
    if (!buf) return '';
    try {
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    } catch (_) {
      return '';
    }
  }

  /**
   * Sync buffered segments from web page IndexedDB to extension-origin IndexedDB.
   */
  async function syncCurrentStreamSegmentsToExtension(targetSlug) {
    if (!window.ClipperStorage) return;
    try {
      const slug = targetSlug || getActiveSlug();
      if (!slug) return;
      const segs = await window.ClipperStorage.getAllSegments(slug);
      // Batch in groups of 5 with a small pause to avoid overwhelming IPC
      for (let i = 0; i < segs.length; i += 5) {
        const batch = segs.slice(i, i + 5);
        await Promise.all(
          batch.map((s) => {
            const base64 = s.data ? arrayBufferToBase64(s.data) : '';
            if (!base64) return Promise.resolve();
            return chrome.runtime.sendMessage({
              action: 'SAVE_SEGMENT',
              segment: {
                streamSlug: s.streamSlug,
                sequence: s.sequence,
                timestamp: s.timestamp,
                duration: s.duration,
                url: s.url,
                base64,
                quality: s.quality,
              },
            }).catch(() => {});
          })
        );
        if (i + 5 < segs.length) {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    } catch (_) {}
  }

  /**
   * Process any deletion requests that were queued while no IDN tab was open.
   */
  async function processPendingClears() {
    if (!window.ClipperStorage) return;
    try {
      const res = await chrome.storage.local.get(['better_idn_pending_clears', 'better_idn_pending_clear_all']);
      if (res.better_idn_pending_clear_all) {
        await window.ClipperStorage.clearAll();
        await chrome.storage.local.remove(['better_idn_pending_clear_all', 'better_idn_pending_clears', 'better_idn_cached_streams']);
        return;
      }
      if (res.better_idn_pending_clears && Array.isArray(res.better_idn_pending_clears)) {
        for (const slug of res.better_idn_pending_clears) {
          await window.ClipperStorage.clearStream(slug);
        }
        await chrome.storage.local.remove('better_idn_pending_clears');
        await syncCachedStreamsToStorage();
      }
    } catch (_) {}
  }

  // ── 4b. Active HLS Buffer Engine & Anti-Throttling System ────────────────
  // Continuously fetches live HLS playlist & video segments directly into ClipperStorage (IndexedDB).
  // Includes dedicated Web Worker ticker + Web Audio keepalive so that when Chrome is MINIMIZED,
  // timer throttling, renderer freezing, and ABR downgrades are completely prevented.

  // 1. Dedicated Web Worker Ticker (WorkerTimer)
  // Web Workers run on a background OS thread and bypass Chromium DOM window timer throttling.
  let workerTicker = null;

  function initWorkerTicker() {
    if (workerTicker) return;
    try {
      const workerCode = `
        let timer = null;
        self.onmessage = function(e) {
          if (e.data === 'start') {
            if (!timer) {
              timer = setInterval(function() {
                self.postMessage('tick');
              }, 1000);
            }
          } else if (e.data === 'stop') {
            if (timer) {
              clearInterval(timer);
              timer = null;
            }
          }
        };
      `;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      workerTicker = new Worker(workerUrl);

      workerTicker.onmessage = function(e) {
        if (e.data === 'tick') {
          if (bufferEngine.isRunning && !bufferEngine.isPolling) {
            runBufferEngineCycle();
          }
        }
      };

      workerTicker.onerror = function(err) {
        console.warn('[IDN Live Clipper Ext] Worker ticker note:', err);
      };
    } catch (e) {
      console.warn('[IDN Live Clipper Ext] Web Worker ticker fallback:', e);
      workerTicker = null;
    }
  }

  function startWorkerTicker() {
    if (!workerTicker) initWorkerTicker();
    if (workerTicker) {
      try {
        workerTicker.postMessage('start');
      } catch (_) {}
    }
  }

  function stopWorkerTicker() {
    if (workerTicker) {
      try {
        workerTicker.postMessage('stop');
      } catch (_) {}
    }
  }

  // 2. Web Audio Keepalive & Anti-Throttling Engine
  // Chromium exempts tabs processing audio from Intensive Timer Throttling (60s clamp),
  // renderer freezing, and background tab discarding.
  let keepAliveAudioCtx = null;
  let keepAliveScriptNode = null;
  let keepAliveAudioEl = null;

  function initAudioKeepAlive() {
    if (keepAliveAudioCtx) return;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      keepAliveAudioCtx = new AudioCtx({ latencyHint: 'playback' });

      // ScriptProcessorNode produces continuous audio callbacks driven by physical audio hardware DAC
      // 4096 samples at 44.1kHz = ~92.8ms per callback. It NEVER gets throttled when minimized!
      let audioTickCount = 0;
      keepAliveScriptNode = keepAliveAudioCtx.createScriptProcessor(4096, 1, 1);
      keepAliveScriptNode.onaudioprocess = function(e) {
        // Output zero amplitude (pure digital silence)
        const out = e.outputBuffer.getChannelData(0);
        for (let i = 0; i < out.length; i++) out[i] = 0;

        audioTickCount++;
        // ~11 callbacks at 44.1kHz is ~1.02 seconds
        if (audioTickCount >= 11) {
          audioTickCount = 0;
          if (bufferEngine.isRunning && !bufferEngine.isPolling) {
            runBufferEngineCycle();
          }
        }
      };

      keepAliveScriptNode.connect(keepAliveAudioCtx.destination);

      const resumeAudio = () => {
        if (keepAliveAudioCtx && keepAliveAudioCtx.state === 'suspended') {
          keepAliveAudioCtx.resume().catch(() => {});
        }
        if (keepAliveAudioEl && keepAliveAudioEl.paused) {
          keepAliveAudioEl.play().catch(() => {});
        }
      };

      window.addEventListener('click', resumeAudio, { once: true, passive: true });
      window.addEventListener('keydown', resumeAudio, { once: true, passive: true });
      window.addEventListener('pointerdown', resumeAudio, { once: true, passive: true });

      // Also hook video playing events
      const hookVideos = () => {
        const vids = document.querySelectorAll('video');
        vids.forEach((v) => {
          v.addEventListener('play', resumeAudio, { passive: true });
          v.addEventListener('playing', resumeAudio, { passive: true });
        });
      };
      hookVideos();
      setTimeout(hookVideos, 2000);

    } catch (e) {
      console.warn('[IDN Live Clipper Ext] Audio keepalive note:', e);
    }

    // Companion silent HTML5 audio element
    try {
      if (!keepAliveAudioEl) {
        keepAliveAudioEl = document.createElement('audio');
        keepAliveAudioEl.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
        keepAliveAudioEl.loop = true;
        keepAliveAudioEl.volume = 0.0001;
        keepAliveAudioEl.setAttribute('playsinline', '');
        keepAliveAudioEl.setAttribute('data-bidn-keepalive', 'true');
        (document.body || document.documentElement).appendChild(keepAliveAudioEl);
        keepAliveAudioEl.play().catch(() => {});
      }
    } catch (_) {}
  }

  function startAudioKeepAlive() {
    if (!keepAliveAudioCtx) initAudioKeepAlive();
    if (keepAliveAudioCtx && keepAliveAudioCtx.state === 'suspended') {
      keepAliveAudioCtx.resume().catch(() => {});
    }
    if (keepAliveAudioEl && keepAliveAudioEl.paused) {
      keepAliveAudioEl.play().catch(() => {});
    }
  }

  // 3. Proactive Minimization & Visibility Watchdog
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      console.log('[IDN Live Clipper Ext] Window minimized/hidden: ensuring background recording continues unthrottled');
      startAudioKeepAlive();
      startWorkerTicker();
      if (bufferEngine.isRunning && !bufferEngine.isPolling) {
        runBufferEngineCycle();
      }
    } else {
      console.log('[IDN Live Clipper Ext] Window restored: checking buffer state');
      if (bufferEngine.isRunning && !bufferEngine.isPolling) {
        runBufferEngineCycle();
      }
    }
  });

  const bufferEngine = {
    isRunning: false,
    streamSlug: null,
    masterUrl: null,
    mediaUrl: null,
    targetDurationSec: 2.0,
    pollTimer: null,
    isPolling: false,
    downloadedSeqs: new Set(),
    inFlightSeqs: new Set(),
    activeQuality: null,
    consecutiveErrors: 0,
    activeDownloads: 0,
    maxConcurrentDownloads: 3,
    segmentCountSincePrune: 0,
    downloadQueue: [],

    setQuality(name) {
      if (!name || this.activeQuality === name) return;
      this.activeQuality = name;
      // Re-resolve media playlist for newly selected quality
      this.mediaUrl = null;
      if (this.isRunning && !this.isPolling) {
        runBufferEngineCycle();
      }
    },
  };

  function startBufferEngine(playbackUrl, slug = null) {
    if (!playbackUrl) return;
    const streamSlug = slug || getActiveSlug();
    if (!streamSlug) return;

    if (
      bufferEngine.isRunning &&
      bufferEngine.masterUrl === playbackUrl &&
      bufferEngine.streamSlug === streamSlug
    ) {
      return;
    }

    console.log(`[IDN Live Clipper Ext Buffer Engine] Starting for ${streamSlug}: ${playbackUrl}`);

    if (bufferEngine.isRunning) {
      stopBufferEngine();
    }

    bufferEngine.isRunning = true;
    bufferEngine.masterUrl = playbackUrl;
    bufferEngine.mediaUrl = null;
    bufferEngine.streamSlug = streamSlug;
    bufferEngine.downloadedSeqs.clear();
    bufferEngine.inFlightSeqs.clear();
    bufferEngine.downloadQueue = [];
    bufferEngine.consecutiveErrors = 0;
    bufferEngine.segmentCountSincePrune = 0;

    startWorkerTicker();
    startAudioKeepAlive();

    // Pre-populate already cached segment sequences from IndexedDB
    if (window.ClipperStorage) {
      window.ClipperStorage.getSegmentsMeta(streamSlug).then((segs) => {
        if (segs && Array.isArray(segs)) {
          for (const s of segs) {
            bufferEngine.downloadedSeqs.add(s.sequence);
          }
          refreshClipperStats();
        }
      }).catch(() => {});
    }

    runBufferEngineCycle();
  }

  function stopBufferEngine() {
    console.log('[IDN Live Clipper Ext Buffer Engine] Stopping');
    bufferEngine.isRunning = false;
    stopWorkerTicker();
    if (bufferEngine.pollTimer) {
      clearTimeout(bufferEngine.pollTimer);
      bufferEngine.pollTimer = null;
    }
    bufferEngine.downloadQueue = [];
    bufferEngine.inFlightSeqs.clear();
    bufferEngine.isPolling = false;
  }

  async function resolveMediaPlaylistUrl(masterUrl) {
    if (masterUrl.includes('/playlist/') || masterUrl.includes('/chunked/')) {
      return masterUrl;
    }

    try {
      const res = await fetch(masterUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();

      if (text.includes('#EXTINF:')) {
        return masterUrl;
      }

      const lines = text.split(/\r?\n/);
      const variants = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          const bwMatch = line.match(/BANDWIDTH=(\d+)/);
          const resMatch = line.match(/RESOLUTION=([\dx]+)/);
          const nameMatch = line.match(/NAME="([^"]+)"/);
          const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
          const resolution = resMatch ? resMatch[1] : '';
          const name = nameMatch ? nameMatch[1] : (resolution ? `${resolution.split('x')[1] || resolution}p` : 'auto');

          let nextLine = lines[i + 1]?.trim();
          if (nextLine && !nextLine.startsWith('#')) {
            let fullUrl;
            try {
              fullUrl = new URL(nextLine, masterUrl).href;
            } catch (_) {
              fullUrl = nextLine;
            }
            variants.push({
              name,
              bandwidth: bw,
              resolution,
              url: fullUrl,
            });
          }
        }
      }

      if (variants.length === 0) {
        return masterUrl;
      }

      // Populate state qualities if missing
      if (!state.qualities || state.qualities.length === 0) {
        state.qualities = variants.map((v) => ({
          name: v.name,
          bitrate: v.bandwidth,
          resolution: v.resolution,
        }));
        createQualityOverlay();
        updateQualityOverlay();
      }

      // Match chosen quality: In auto mode, always record highest quality (variants[0]).
      // Only target a specific variant if the user explicitly picked one (not autoMode).
      let chosen = null;
      const targetName = (!state.autoMode && bufferEngine.activeQuality) ? bufferEngine.activeQuality : null;
      if (targetName && targetName !== 'auto') {
        chosen = variants.find((v) => v.name.toLowerCase() === targetName.toLowerCase());
      }
      if (!chosen) {
        variants.sort((a, b) => b.bandwidth - a.bandwidth);
        chosen = variants[0];
      }

      return chosen ? chosen.url : masterUrl;
    } catch (err) {
      console.warn('[IDN Live Clipper Ext Buffer Engine] Error resolving media playlist:', err);
      return masterUrl;
    }
  }

  async function runBufferEngineCycle() {
    if (!bufferEngine.isRunning) return;

    if (bufferEngine.isPolling) {
      scheduleNextCycle(1000);
      return;
    }

    bufferEngine.isPolling = true;

    try {
      if (!bufferEngine.mediaUrl) {
        bufferEngine.mediaUrl = await resolveMediaPlaylistUrl(bufferEngine.masterUrl);
      }

      const res = await fetch(bufferEngine.mediaUrl, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`Media playlist HTTP ${res.status}`);
      }
      const text = await res.text();

      if (!text.includes('#EXTINF:')) {
        bufferEngine.mediaUrl = await resolveMediaPlaylistUrl(bufferEngine.mediaUrl);
        scheduleNextCycle(1000);
        bufferEngine.isPolling = false;
        return;
      }

      bufferEngine.consecutiveErrors = 0;

      const lines = text.split(/\r?\n/);
      let mediaSeq = 0;
      let targetDur = 2.0;
      let pdt = null;
      let curExtinfDur = 2.0;
      const discoveredSegments = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
          mediaSeq = parseInt(line.split(':')[1], 10) || 0;
        } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
          targetDur = parseFloat(line.split(':')[1]) || 2.0;
          bufferEngine.targetDurationSec = targetDur;
        } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
          const parsed = Date.parse(line.substring(line.indexOf(':') + 1));
          if (!isNaN(parsed)) pdt = parsed;
        } else if (line.startsWith('#EXTINF:')) {
          const dMatch = line.match(/#EXTINF:([\d.]+)/);
          curExtinfDur = dMatch ? parseFloat(dMatch[1]) : targetDur;
        } else if (line.startsWith('#EXT-X-PREFETCH:')) {
          const pUrl = line.substring(line.indexOf(':') + 1).trim();
          let fullUrl;
          try {
            fullUrl = new URL(pUrl, bufferEngine.mediaUrl).href;
          } catch (_) {
            fullUrl = pUrl;
          }
          const seq = mediaSeq++;
          if (pdt == null) pdt = Date.now();
          const time = pdt;
          pdt += Math.round(curExtinfDur * 1000);

          if (!bufferEngine.downloadedSeqs.has(seq)) {
            discoveredSegments.push({
              sequence: seq,
              duration: curExtinfDur,
              timestamp: time,
              url: fullUrl,
            });
          }
        } else if (line && !line.startsWith('#')) {
          let fullUrl;
          try {
            fullUrl = new URL(line, bufferEngine.mediaUrl).href;
          } catch (_) {
            fullUrl = line;
          }
          const seq = mediaSeq++;
          if (pdt == null) pdt = Date.now();
          const time = pdt;
          pdt += Math.round(curExtinfDur * 1000);

          if (!bufferEngine.downloadedSeqs.has(seq)) {
            discoveredSegments.push({
              sequence: seq,
              duration: curExtinfDur,
              timestamp: time,
              url: fullUrl,
            });
          }
        }
      }

      // Initial fast fill: take up to 8 recent segments to provide an instant buffer
      let segsToAdd = discoveredSegments;
      if (bufferEngine.downloadedSeqs.size === 0 && discoveredSegments.length > 8) {
        const toSkip = discoveredSegments.slice(0, discoveredSegments.length - 8);
        for (const s of toSkip) {
          bufferEngine.downloadedSeqs.add(s.sequence);
        }
        segsToAdd = discoveredSegments.slice(discoveredSegments.length - 8);
      }

      for (const seg of segsToAdd) {
        if (!bufferEngine.downloadedSeqs.has(seg.sequence) && !bufferEngine.inFlightSeqs.has(seg.sequence)) {
          bufferEngine.inFlightSeqs.add(seg.sequence);
          bufferEngine.downloadQueue.push(seg);
        }
      }

      drainDownloadQueue();

    } catch (err) {
      bufferEngine.consecutiveErrors++;
      console.warn('[IDN Live Clipper Ext Buffer Engine] Poll error:', err);
    } finally {
      bufferEngine.isPolling = false;
      const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      // When minimized or hidden, poll at 1000ms base delay to ensure live segments never slide off the playlist
      const baseDelay = isHidden ? 1000 : Math.max(1000, Math.min(2200, (bufferEngine.targetDurationSec * 1000) / 1.5));
      const delay = bufferEngine.consecutiveErrors > 0
        ? Math.min(5000, 1000 * Math.pow(1.4, bufferEngine.consecutiveErrors))
        : baseDelay;
      scheduleNextCycle(delay);
    }
  }

  function scheduleNextCycle(delayMs) {
    if (!bufferEngine.isRunning) return;
    if (bufferEngine.pollTimer) clearTimeout(bufferEngine.pollTimer);
    bufferEngine.pollTimer = setTimeout(runBufferEngineCycle, delayMs);
  }

  function drainDownloadQueue() {
    if (!bufferEngine.isRunning || !window.ClipperStorage) return;

    // Ensure download queue is strictly ordered by sequence ascending
    bufferEngine.downloadQueue.sort((a, b) => a.sequence - b.sequence);

    while (
      bufferEngine.activeDownloads < bufferEngine.maxConcurrentDownloads &&
      bufferEngine.downloadQueue.length > 0
    ) {
      const segItem = bufferEngine.downloadQueue.shift();
      downloadAndSaveSegment(segItem);
    }
  }

  async function downloadAndSaveSegment(segItem) {
    bufferEngine.activeDownloads++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout prevents stalled requests

    try {
      const res = await fetch(segItem.url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();

      if (arrayBuffer && arrayBuffer.byteLength > 500 && bufferEngine.isRunning) {
        const segRecord = {
          streamSlug: bufferEngine.streamSlug,
          sequence: segItem.sequence,
          timestamp: segItem.timestamp,
          duration: segItem.duration,
          url: segItem.url,
          data: arrayBuffer,
          quality: bufferEngine.activeQuality || state.currentQuality?.name || 'auto',
        };

        await window.ClipperStorage.saveSegment(segRecord);
        bufferEngine.downloadedSeqs.add(segItem.sequence);
        bufferEngine.inFlightSeqs.delete(segItem.sequence);

        // Forward segment to Extension-Origin IndexedDB in background using base64 for safe IPC
        const base64Data = arrayBufferToBase64(arrayBuffer);
        chrome.runtime.sendMessage({
          action: 'SAVE_SEGMENT',
          segment: {
            streamSlug: segRecord.streamSlug,
            sequence: segRecord.sequence,
            timestamp: segRecord.timestamp,
            duration: segRecord.duration,
            url: segRecord.url,
            quality: segRecord.quality,
            base64: base64Data,
          },
        }).catch(() => {});

        bufferEngine.segmentCountSincePrune++;
        if (bufferEngine.segmentCountSincePrune >= 10) {
          bufferEngine.segmentCountSincePrune = 0;
          window.ClipperStorage.pruneOldSegments(
            bufferEngine.streamSlug,
            clipper.retentionMinutes * 60 * 1000,
            1200 * 1024 * 1024
          ).catch(() => {});
        }

        refreshClipperStats();
      } else {
        bufferEngine.inFlightSeqs.delete(segItem.sequence);
      }
    } catch (err) {
      bufferEngine.inFlightSeqs.delete(segItem.sequence);
      console.warn(`[IDN Live Clipper Ext Buffer Engine] Failed to download segment ${segItem.sequence}:`, err);
    } finally {
      clearTimeout(timeoutId);
      bufferEngine.activeDownloads--;
      drainDownloadQueue();
    }
  }

  // ── 5. Formatting Utilities ──────────────────────────────────────────────

  function formatClockTime(ms) {
    if (!ms || isNaN(ms)) return '00:00:00';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '00:00:00';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function formatTimeOffset(ms, maxMs) {
    if (ms == null || maxMs == null) return '--:--';
    const diffSec = Math.round((ms - maxMs) / 1000);
    if (Math.abs(diffSec) < 2) return '00:00';

    const abs = Math.abs(diffSec);
    const m = Math.floor(abs / 60);
    const s = abs % 60;
    const sign = diffSec < 0 ? '-' : '+';
    return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function formatDuration(sec) {
    if (!sec || sec < 0) return '00:00';
    const s = Math.round(sec);
    const m = Math.floor(s / 60);
    const remS = s % 60;
    return `${String(m).padStart(2, '0')}:${String(remS).padStart(2, '0')}`;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 MB';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function showToast(message, type = 'info', duration = 3000) {
    const existing = document.getElementById('bidn-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'bidn-toast';
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      top: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: ${type === 'success' ? '#064E3B' : type === 'error' ? '#7F1D1D' : '#11141C'};
      color: #F3F4F6;
      padding: 9px 18px;
      border-radius: 9999px;
      font-size: 12.5px;
      font-weight: 500;
      z-index: 100002;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);
      border: 1px solid ${type === 'success' ? 'rgba(16, 185, 129, 0.4)' : type === 'error' ? 'rgba(239, 68, 68, 0.4)' : 'rgba(255, 255, 255, 0.14)'};
      pointer-events: none;
      animation: bidnFadeIn 0.2s ease-out;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
      backdrop-filter: blur(12px);
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(-6px)';
      toast.style.transition = 'opacity 0.25s, transform 0.25s';
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }

  // ── 6. On-Page Quality Overlay ───────────────────────────────────────────

  let overlayContainer = null;

  function createQualityOverlay() {
    if (overlayContainer) return;
    if (!document.body) return;
    if (!isLivePage(window.location.pathname)) return;

    overlayContainer = document.createElement('div');
    overlayContainer.id = 'idn-live-clipper-ext-overlay';
    overlayContainer.innerHTML = `
      <style>
        #idn-live-clipper-ext-overlay {
          position: fixed;
          bottom: 84px;
          right: 24px;
          z-index: 99997;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 10px;
          user-select: none;
        }

        .bidn-fab-btn {
          width: 42px;
          height: 42px;
          border-radius: 50%;
          background: #11141C;
          border: 1px solid rgba(255, 255, 255, 0.14);
          color: #F3F4F6;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
          backdrop-filter: blur(12px);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
          outline: none;
        }

        .bidn-fab-btn svg {
          width: 18px;
          height: 18px;
          transition: transform 0.2s;
        }

        .bidn-fab-btn:hover {
          background: #181C28;
          border-color: rgba(255, 255, 255, 0.3);
          transform: translateY(-2px) scale(1.05);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
        }

        .bidn-fab-btn:active {
          transform: translateY(0) scale(0.95);
        }

        .bidn-fab-clipper {
          background: linear-gradient(135deg, #FF2E56 0%, #D9103D 100%);
          border-color: rgba(255, 255, 255, 0.3);
          color: #FFF;
          box-shadow: 0 4px 16px rgba(255, 46, 86, 0.4);
        }

        .bidn-fab-clipper:hover {
          background: linear-gradient(135deg, #FF456A 0%, #E81946 100%);
          border-color: rgba(255, 255, 255, 0.5);
          box-shadow: 0 6px 20px rgba(255, 46, 86, 0.6);
        }

        #idn-live-clipper-ext-overlay .bidn-panel {
          display: none;
          position: absolute;
          bottom: 114px;
          right: 0;
          width: 240px;
          background: #11141C;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          padding: 12px;
          backdrop-filter: blur(20px);
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
        }

        #idn-live-clipper-ext-overlay .bidn-panel.open {
          display: block;
          animation: bidnFadeIn 0.18s ease-out;
        }

        .bidn-panel-title {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.02em;
          color: #9CA3AF;
          margin-bottom: 8px;
        }

        .bidn-quality-btn {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
          padding: 7px 10px;
          margin: 2px 0;
          background: transparent;
          border: 1px solid transparent;
          border-radius: 6px;
          color: #E5E7EB;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.15s;
          font-family: inherit;
        }

        .bidn-quality-btn:hover {
          background: #181C28;
          color: #FFF;
        }

        .bidn-quality-btn.active {
          background: rgba(255, 46, 86, 0.12);
          border-color: rgba(255, 46, 86, 0.4);
          color: #FFF;
          font-weight: 600;
        }

        .bidn-bitrate {
          font-size: 10.5px;
          font-family: ui-monospace, SFMono-Regular, monospace;
          color: #9CA3AF;
        }

        .bidn-divider {
          height: 1px;
          background: rgba(255, 255, 255, 0.08);
          margin: 10px 0;
        }

        .bidn-action-btn {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 7px 10px;
          margin-top: 5px;
          background: #181C28;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 6px;
          color: #E5E7EB;
          font-size: 11.5px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s;
          font-family: inherit;
        }

        .bidn-action-btn svg {
          width: 14px;
          height: 14px;
          flex-shrink: 0;
          color: #9CA3AF;
        }

        .bidn-action-btn:hover {
          background: #202636;
          border-color: rgba(255, 255, 255, 0.18);
          color: #FFF;
        }

        .bidn-action-btn.active-action {
          background: linear-gradient(135deg, #FF2E56 0%, #D9103D 100%);
          border-color: rgba(255, 255, 255, 0.2);
          color: #FFF;
          font-weight: 600;
        }

        .bidn-action-btn.active-action svg {
          color: #FFF;
        }

        .bidn-action-btn.active-action:hover {
          background: linear-gradient(135deg, #FF456A 0%, #E81946 100%);
        }

        .bidn-action-btn.copied {
          background: rgba(16, 185, 129, 0.2);
          border-color: rgba(16, 185, 129, 0.5);
          color: #34D399;
        }
      </style>

      <div class="bidn-panel" id="bidn-panel">
        <div class="bidn-panel-title">Video Quality</div>
        <div id="bidn-quality-list"></div>
        <div class="bidn-divider"></div>
        <div class="bidn-panel-title">Studio Tools</div>
        <button class="bidn-action-btn active-action" id="bidn-open-clipper-btn" title="Open timeline scrubber & clipper in dedicated studio tab">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line></svg>
          <span>Open Clipper Studio</span>
        </button>
        <button class="bidn-action-btn" id="bidn-quick-clip-btn" title="Quickly clip and download the last 30s as MP4">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
          <span>Quick Clip Last 30s</span>
        </button>
        <button class="bidn-action-btn" id="bidn-unmute-btn" title="Force unmute stream and restore 100% volume">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
          <span>Restore Audio (100%)</span>
        </button>
        <button class="bidn-action-btn" id="bidn-clear-buffer-btn" title="Clear cached video segments for this stream">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path></svg>
          <span>Clear Stream Buffer</span>
        </button>
        <button class="bidn-action-btn" id="bidn-copy-m3u8">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          <span>Copy m3u8 URL</span>
        </button>
        <button class="bidn-action-btn" id="bidn-open-vlc">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          <span>Open in VLC</span>
        </button>
      </div>

      <!-- Quick Clipper Studio Toggle FAB -->
      <button class="bidn-fab-btn bidn-fab-clipper" id="bidn-toggle-clipper" title="Open Clipper Studio in New Tab">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line></svg>
      </button>
      <!-- Quality Settings FAB -->
      <button class="bidn-fab-btn" id="bidn-toggle-panel" title="Video Quality & Studio Tools">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
      </button>
    `;

    document.body.appendChild(overlayContainer);

    const togglePanel = overlayContainer.querySelector('#bidn-toggle-panel');
    const panel = overlayContainer.querySelector('#bidn-panel');
    const toggleClipper = overlayContainer.querySelector('#bidn-toggle-clipper');
    const openClipperBtn = overlayContainer.querySelector('#bidn-open-clipper-btn');
    const unmuteBtn = overlayContainer.querySelector('#bidn-unmute-btn');
    const quickClipBtn = overlayContainer.querySelector('#bidn-quick-clip-btn');

    togglePanel.addEventListener('click', () => {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        sendToPage('GET_QUALITIES', {});
        sendToPage('GET_STREAM_URL', {});
      }
    });

    toggleClipper.addEventListener('click', () => {
      openClipperStudioTab();
    });

    openClipperBtn.addEventListener('click', () => {
      panel.classList.remove('open');
      openClipperStudioTab();
    });

    unmuteBtn.addEventListener('click', () => {
      unmuteLiveStream();
      unmuteBtn.textContent = '🔊 Audio Restored (100%)';
      setTimeout(() => {
        unmuteBtn.textContent = '🔊 Force Unmute / Restore Audio';
      }, 2000);
    });

    quickClipBtn.addEventListener('click', async () => {
      quickClipBtn.textContent = '⏳ Processing clip...';
      try {
        await quickClipLastSeconds(30);
        quickClipBtn.textContent = '✅ Clip Downloaded!';
        setTimeout(() => {
          quickClipBtn.textContent = '⚡ Quick Clip Last 30s';
        }, 2500);
      } catch (err) {
        quickClipBtn.textContent = '❌ ' + (err.message || 'Error');
        setTimeout(() => {
          quickClipBtn.textContent = '⚡ Quick Clip Last 30s';
        }, 3000);
      }
    });

    const clearBufferBtn = overlayContainer.querySelector('#bidn-clear-buffer-btn');
    if (clearBufferBtn) {
      clearBufferBtn.addEventListener('click', async () => {
        if (confirm('Clear cached video segments for this stream?')) {
          await clearBuffer();
          clearBufferBtn.textContent = '✅ Buffer Cleared!';
          showToast('Cached video buffer cleared', 'success', 2500);
          setTimeout(() => {
            clearBufferBtn.textContent = '🗑️ Clear Stream Buffer';
          }, 2000);
        }
      });
    }

    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
      if (!overlayContainer.contains(e.target)) {
        panel.classList.remove('open');
      }
    });

    // Copy m3u8 URL
    const copyBtn = overlayContainer.querySelector('#bidn-copy-m3u8');
    copyBtn.addEventListener('click', async () => {
      const url = state.playbackUrl || state.m3u8Urls[state.m3u8Urls.length - 1];
      if (url) {
        try {
          await navigator.clipboard.writeText(url);
          copyBtn.textContent = '✅ Copied!';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = '📋 Copy m3u8 URL';
            copyBtn.classList.remove('copied');
          }, 2000);
        } catch (_) {}
      }
    });

    // Open in VLC
    const vlcBtn = overlayContainer.querySelector('#bidn-open-vlc');
    vlcBtn.addEventListener('click', () => {
      const url = state.playbackUrl || state.m3u8Urls[state.m3u8Urls.length - 1];
      if (url) window.open('vlc://' + url, '_blank');
    });
  }

  function updateQualityOverlay() {
    if (!overlayContainer) return;
    const list = overlayContainer.querySelector('#bidn-quality-list');
    if (!list) return;

    list.innerHTML = '';

    const autoBtn = document.createElement('button');
    autoBtn.className = 'bidn-quality-btn' + (state.autoMode ? ' active' : '');
    const currentLabel = state.currentQuality
      ? state.currentQuality.height
        ? `${state.currentQuality.height}p`
        : state.currentQuality.name
      : '';
    autoBtn.innerHTML = `<span>Auto</span><span class="bidn-bitrate">${state.autoMode && currentLabel ? currentLabel : ''}</span>`;
    autoBtn.addEventListener('click', () => {
      sendToPage('SET_AUTO_QUALITY', {});
      if (typeof bufferEngine !== 'undefined') {
        bufferEngine.setQuality('auto');
      }
    });
    list.appendChild(autoBtn);

    if (!state.qualities || state.qualities.length === 0) {
      const loading = document.createElement('div');
      loading.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.4);padding:6px 10px;text-align:center;';
      loading.textContent = state.hasPlayer ? 'Loading qualities...' : 'Searching for player...';
      list.appendChild(loading);
      return;
    }

    const sorted = [...state.qualities].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    for (const q of sorted) {
      const btn = document.createElement('button');
      const isActive = !state.autoMode && state.currentQuality?.name === q.name;
      btn.className = 'bidn-quality-btn' + (isActive ? ' active' : '');

      const label = q.height ? `${q.height}p` : q.name;
      const bitrate = q.bitrate ? `${Math.round(q.bitrate / 1000)}k` : '';
      btn.innerHTML = `<span>${label}</span><span class="bidn-bitrate">${bitrate}</span>`;
      btn.addEventListener('click', () => {
        sendToPage('SET_QUALITY', { name: q.name });
        if (typeof bufferEngine !== 'undefined') {
          bufferEngine.setQuality(q.name);
        }
      });
      list.appendChild(btn);
    }
  }

  // ── 7. IDN Live Clipper & Timeline Scrubber UI ───────────────────────────

  function ensureClipperUI() {
    if (clipper.dockEl) return;

    // Inject styles
    const style = document.createElement('style');
    style.id = 'bidn-clipper-styles';
    style.textContent = `
      @keyframes bidnFadeIn {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }

      #bidn-clipper-dock {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        z-index: 99998;
        background: rgba(14, 16, 24, 0.96);
        border-top: 1px solid rgba(255, 255, 255, 0.15);
        backdrop-filter: blur(20px);
        box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.7);
        padding: 12px 24px 16px;
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        user-select: none;
        transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.28s;
      }

      #bidn-clipper-dock.bidn-hidden {
        transform: translateY(110%);
        opacity: 0;
        pointer-events: none;
      }

      /* Dock Header */
      .bidn-dock-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
      }
      .bidn-dock-title-group {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .bidn-dock-title {
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.5px;
        display: flex;
        align-items: center;
        gap: 6px;
        color: #fff;
      }
      .bidn-badge {
        font-size: 11px;
        padding: 3px 8px;
        border-radius: 12px;
        font-weight: 500;
        background: rgba(255, 255, 255, 0.1);
        color: rgba(255, 255, 255, 0.8);
      }
      .bidn-badge-buffer {
        background: rgba(59, 130, 246, 0.2);
        color: #60a5fa;
        border: 1px solid rgba(59, 130, 246, 0.3);
      }
      .bidn-badge-clip {
        background: rgba(16, 185, 129, 0.2);
        color: #34d399;
        border: 1px solid rgba(16, 185, 129, 0.4);
        font-weight: 600;
      }
      .bidn-dock-header-right {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .bidn-btn-return-live {
        background: linear-gradient(135deg, #ef4444, #dc2626);
        border: 1px solid rgba(255, 255, 255, 0.3);
        color: #fff;
        padding: 5px 12px;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: all 0.15s;
        box-shadow: 0 2px 8px rgba(239, 68, 68, 0.4);
      }
      .bidn-btn-return-live:hover {
        transform: scale(1.05);
        box-shadow: 0 4px 12px rgba(239, 68, 68, 0.6);
      }
      .bidn-btn-close-dock {
        background: transparent;
        border: none;
        color: rgba(255, 255, 255, 0.5);
        font-size: 16px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 6px;
      }
      .bidn-btn-close-dock:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.1);
      }

      /* Timeline Scrubber Container */
      .bidn-timeline-wrap {
        position: relative;
        margin: 10px 0 16px;
      }
      .bidn-timeline-ruler {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.4);
        margin-bottom: 6px;
      }
      .bidn-timeline-track {
        position: relative;
        height: 28px;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 6px;
        cursor: pointer;
        overflow: visible;
        border: 1px solid rgba(255, 255, 255, 0.1);
      }
      .bidn-timeline-buffered {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 100%;
        background: linear-gradient(90deg, rgba(30, 58, 138, 0.6), rgba(37, 99, 235, 0.7));
        border-radius: 5px;
        pointer-events: none;
      }
      .bidn-timeline-selection {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 20%;
        width: 40%;
        background: rgba(0, 229, 255, 0.28);
        border-top: 2px solid #00e5ff;
        border-bottom: 2px solid #00e5ff;
        pointer-events: none;
        box-shadow: inset 0 0 12px rgba(0, 229, 255, 0.2);
      }

      /* Handles */
      .bidn-handle {
        position: absolute;
        top: -6px;
        bottom: -6px;
        width: 16px;
        cursor: ew-resize;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.1s;
      }
      .bidn-handle:hover {
        transform: scale(1.15);
      }
      .bidn-handle-start {
        left: calc(20% - 8px);
      }
      .bidn-handle-end {
        left: calc(60% - 8px);
      }
      .bidn-handle-bar {
        width: 6px;
        height: 100%;
        background: #00e5ff;
        border-radius: 3px;
        box-shadow: 0 0 8px rgba(0, 229, 255, 0.8);
      }
      .bidn-handle-tooltip {
        position: absolute;
        bottom: 42px;
        background: rgba(0, 0, 0, 0.85);
        color: #fff;
        font-size: 10px;
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 4px;
        white-space: nowrap;
        pointer-events: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
      }

      /* Playhead */
      .bidn-playhead {
        position: absolute;
        top: -8px;
        bottom: -8px;
        width: 2px;
        background: #fff;
        left: 50%;
        z-index: 15;
        box-shadow: 0 0 8px #fff;
        pointer-events: none;
      }
      .bidn-playhead::after {
        content: '';
        position: absolute;
        top: 0;
        left: -5px;
        width: 12px;
        height: 12px;
        background: #fff;
        border-radius: 50%;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
      }

      /* Hover Tooltip */
      .bidn-timeline-hover-tip {
        display: none;
        position: absolute;
        bottom: 34px;
        transform: translateX(-50%);
        background: rgba(10, 10, 15, 0.9);
        color: #fff;
        font-size: 11px;
        padding: 3px 8px;
        border-radius: 4px;
        white-space: nowrap;
        pointer-events: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
      }

      /* Dock Controls */
      .bidn-dock-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;
      }
      .bidn-ctrl-group {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .bidn-btn {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: #fff;
        padding: 6px 12px;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: all 0.15s;
      }
      .bidn-btn:hover {
        background: rgba(255, 255, 255, 0.18);
        border-color: rgba(255, 255, 255, 0.3);
      }
      .bidn-btn-primary {
        background: linear-gradient(135deg, #2563eb, #1d4ed8);
        border-color: rgba(59, 130, 246, 0.5);
        color: #fff;
        font-weight: 600;
        box-shadow: 0 2px 8px rgba(37, 99, 235, 0.35);
      }
      .bidn-btn-primary:hover {
        background: linear-gradient(135deg, #3b82f6, #2563eb);
        transform: scale(1.03);
      }
      .bidn-btn-download {
        background: linear-gradient(135deg, #10b981, #059669);
        border-color: rgba(16, 185, 129, 0.5);
        color: #fff;
        font-weight: 600;
        box-shadow: 0 2px 8px rgba(16, 185, 129, 0.35);
      }
      .bidn-btn-download:hover {
        background: linear-gradient(135deg, #34d399, #10b981);
        transform: scale(1.03);
      }
      .bidn-btn-preset {
        font-size: 11px;
        padding: 5px 8px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.07);
      }
      .bidn-select-retention {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: #fff;
        padding: 6px 10px;
        border-radius: 8px;
        font-size: 11px;
        cursor: pointer;
        outline: none;
      }
      .bidn-select-retention option {
        background: #181b26;
        color: #fff;
      }

      /* Secondary Preview Video Overlay */
      #bidn-clipper-preview-container {
        display: none;
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: #000;
        z-index: 99990;
      }
      #bidn-clipper-preview {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }
      .bidn-preview-watermark {
        position: absolute;
        top: 14px;
        left: 14px;
        background: rgba(0, 0, 0, 0.7);
        border: 1px solid rgba(255, 255, 255, 0.2);
        padding: 4px 10px;
        border-radius: 20px;
        font-size: 11px;
        font-weight: 600;
        color: #38bdf8;
        display: flex;
        align-items: center;
        gap: 6px;
        pointer-events: none;
        backdrop-filter: blur(8px);
      }
    `;
    document.head.appendChild(style);

    // Create Dock Element
    const dock = document.createElement('div');
    dock.id = 'bidn-clipper-dock';
    dock.className = 'bidn-hidden';
    dock.innerHTML = `
      <div class="bidn-dock-header">
        <div class="bidn-dock-title-group">
          <div class="bidn-dock-title">✂️ IDN LIVE CLIPPER & REWIND</div>
          <span class="bidn-badge bidn-badge-buffer" id="bidn-stats-buffer">Buffer: 0s (0 MB)</span>
          <span class="bidn-badge bidn-badge-clip" id="bidn-stats-clip">Clip: 00:30</span>
        </div>
        <div class="bidn-dock-header-right">
          <button class="bidn-btn-return-live" id="bidn-btn-return-live" title="Return to Live Playback">
            🔴 Return to Live
          </button>
          <button class="bidn-btn-close-dock" id="bidn-btn-close-dock" title="Close Clipper">✕</button>
        </div>
      </div>

      <!-- Timeline Track -->
      <div class="bidn-timeline-wrap" id="bidn-timeline-wrap">
        <div class="bidn-timeline-ruler">
          <span id="bidn-ruler-start">-00:00</span>
          <span id="bidn-ruler-mid">-00:00</span>
          <span id="bidn-ruler-end">00:00</span>
        </div>

        <div class="bidn-timeline-track" id="bidn-timeline-track">
          <div class="bidn-timeline-buffered" id="bidn-timeline-buffered"></div>
          <div class="bidn-timeline-selection" id="bidn-timeline-selection"></div>
          <div class="bidn-handle bidn-handle-start" id="bidn-handle-start">
            <div class="bidn-handle-bar"></div>
            <div class="bidn-handle-tooltip" id="bidn-tip-start">-00:30</div>
          </div>
          <div class="bidn-handle bidn-handle-end" id="bidn-handle-end">
            <div class="bidn-handle-bar"></div>
            <div class="bidn-handle-tooltip" id="bidn-tip-end">00:00</div>
          </div>
          <div class="bidn-playhead" id="bidn-playhead"></div>
          <div class="bidn-timeline-hover-tip" id="bidn-hover-tip"></div>
        </div>
      </div>

      <!-- Controls Row -->
      <div class="bidn-dock-controls">
        <!-- Transport -->
        <div class="bidn-ctrl-group">
          <button class="bidn-btn" id="bidn-btn-play-preview" title="Play/Pause Preview (Space)">
            ▶️ Play
          </button>
          <button class="bidn-btn" id="bidn-btn-rewind-5" title="Rewind 5s">⏪ -5s</button>
          <button class="bidn-btn" id="bidn-btn-forward-5" title="Forward 5s">+5s ⏩</button>
          <button class="bidn-btn" id="bidn-btn-set-start" title="Set Start at Playhead ([)">[ Start</button>
          <button class="bidn-btn" id="bidn-btn-set-end" title="Set End at Playhead (])">End ]</button>
        </div>

        <!-- Quick Presets -->
        <div class="bidn-ctrl-group">
          <button class="bidn-btn bidn-btn-preset" data-preset="15">15s</button>
          <button class="bidn-btn bidn-btn-preset" data-preset="30">30s</button>
          <button class="bidn-btn bidn-btn-preset" data-preset="60">1m</button>
          <button class="bidn-btn bidn-btn-preset" data-preset="120">2m</button>
          <button class="bidn-btn bidn-btn-preset" data-preset="300">5m</button>
        </div>

        <!-- Actions -->
        <div class="bidn-ctrl-group">
          <button class="bidn-btn bidn-btn-primary" id="bidn-btn-preview-clip" title="Preview selected clip range">
            👁️ Preview Clip
          </button>
          <button class="bidn-btn bidn-btn-download" id="bidn-btn-download-clip" title="Remux & Download MP4">
            ⬇️ Download MP4
          </button>
          <select class="bidn-select-retention" id="bidn-select-retention" title="Buffer Retention Limit">
            <option value="15">15m Buffer</option>
            <option value="30" selected>30m Buffer</option>
            <option value="60">60m Buffer</option>
          </select>
          <button class="bidn-btn" id="bidn-btn-clear-buffer" title="Clear Cached Segments">
            🗑️ Clear
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(dock);
    clipper.dockEl = dock;

    // Attach timeline interaction & button listeners
    initTimelineInteractions();
    initDockListeners();
    initPreviewPlayer();
    initKeyboardShortcuts();
  }

  // ── 8. Preview Player (Runs in dedicated Clipper Studio Tab) ─────────────

  function initPreviewPlayer() {}
  function showPreviewPlayer() {}
  function hidePreviewPlayer() {}

  // ── 9. Timeline Interaction & Draggable Handles ──────────────────────────

  function initTimelineInteractions() {
    const track = document.getElementById('bidn-timeline-track');
    const handleStart = document.getElementById('bidn-handle-start');
    const handleEnd = document.getElementById('bidn-handle-end');
    const hoverTip = document.getElementById('bidn-hover-tip');

    if (!track) return;

    function getTrackRatio(e) {
      const rect = track.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      return x / rect.width;
    }

    // Hover tooltip
    track.addEventListener('mousemove', (e) => {
      if (clipper.stats.minTime >= clipper.stats.maxTime) return;
      const ratio = getTrackRatio(e);
      const targetMs = clipper.stats.minTime + (ratio * (clipper.stats.maxTime - clipper.stats.minTime));
      hoverTip.style.display = 'block';
      hoverTip.style.left = `${ratio * 100}%`;
      hoverTip.textContent = formatClockTime(targetMs);
    });

    track.addEventListener('mouseleave', () => {
      hoverTip.style.display = 'none';
    });

    // Handle dragging
    handleStart.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      clipper.isDragging = 'start';
      handleStart.setPointerCapture(e.pointerId);
    });

    handleEnd.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      clipper.isDragging = 'end';
      handleEnd.setPointerCapture(e.pointerId);
    });

    track.addEventListener('pointerdown', (e) => {
      if (e.target === handleStart || e.target === handleEnd) return;
      const ratio = getTrackRatio(e);
      const span = clipper.stats.maxTime - clipper.stats.minTime;
      if (span <= 0) return;

      const clickMs = clipper.stats.minTime + (ratio * span);
      clipper.playheadMs = clickMs;
      updateTimelinePositions();
      seekPreviewToTime(clickMs);
    });

    window.addEventListener('pointermove', (e) => {
      if (!clipper.isDragging) return;
      const ratio = getTrackRatio(e);
      const span = clipper.stats.maxTime - clipper.stats.minTime;
      if (span <= 0) return;

      const currentMs = clipper.stats.minTime + (ratio * span);

      if (clipper.isDragging === 'start') {
        clipper.selectionStartMs = Math.min(currentMs, clipper.selectionEndMs - 1000);
      } else if (clipper.isDragging === 'end') {
        clipper.selectionEndMs = Math.max(currentMs, clipper.selectionStartMs + 1000);
      }

      updateTimelinePositions();
    });

    window.addEventListener('pointerup', () => {
      clipper.isDragging = null;
    });
  }

  function updateTimelinePositions() {
    const min = clipper.stats.minTime;
    const max = clipper.stats.maxTime;
    const span = max - min;

    if (span <= 0) return;

    if (clipper.selectionStartMs == null || clipper.selectionEndMs == null) {
      // Default selection: last 30s
      clipper.selectionEndMs = max;
      clipper.selectionStartMs = Math.max(min, max - 30000);
      clipper.playheadMs = clipper.selectionStartMs;
    }

    // Clamp values
    clipper.selectionStartMs = Math.max(min, Math.min(clipper.selectionStartMs, max - 1000));
    clipper.selectionEndMs = Math.max(clipper.selectionStartMs + 1000, Math.min(clipper.selectionEndMs, max));
    if (clipper.playheadMs == null) clipper.playheadMs = clipper.selectionStartMs;
    clipper.playheadMs = Math.max(min, Math.min(clipper.playheadMs, max));

    const startPct = ((clipper.selectionStartMs - min) / span) * 100;
    const endPct = ((clipper.selectionEndMs - min) / span) * 100;
    const playheadPct = ((clipper.playheadMs - min) / span) * 100;

    const selectionEl = document.getElementById('bidn-timeline-selection');
    const handleStartEl = document.getElementById('bidn-handle-start');
    const handleEndEl = document.getElementById('bidn-handle-end');
    const playheadEl = document.getElementById('bidn-playhead');
    const tipStart = document.getElementById('bidn-tip-start');
    const tipEnd = document.getElementById('bidn-tip-end');
    const clipBadge = document.getElementById('bidn-stats-clip');

    if (selectionEl) {
      selectionEl.style.left = `${startPct}%`;
      selectionEl.style.width = `${endPct - startPct}%`;
    }

    if (handleStartEl) handleStartEl.style.left = `calc(${startPct}% - 8px)`;
    if (handleEndEl) handleEndEl.style.left = `calc(${endPct}% - 8px)`;
    if (playheadEl) playheadEl.style.left = `${playheadPct}%`;

    if (tipStart) {
      tipStart.textContent = formatClockTime(clipper.selectionStartMs);
    }
    if (tipEnd) {
      tipEnd.textContent = formatClockTime(clipper.selectionEndMs);
    }

    const clipDurationSec = (clipper.selectionEndMs - clipper.selectionStartMs) / 1000;
    if (clipBadge) {
      const rangeStr = `${formatClockTime(clipper.selectionStartMs)} - ${formatClockTime(clipper.selectionEndMs)}`;
      clipBadge.textContent = `Clip: ${formatDuration(clipDurationSec)} (${rangeStr})`;
    }
  }

  function updateClipperUI() {
    if (!clipper.dockEl) return;

    const bufferBadge = document.getElementById('bidn-stats-buffer');
    if (bufferBadge) {
      const timeSpanStr = (clipper.stats.minTime && clipper.stats.maxTime)
        ? ` · ${formatClockTime(clipper.stats.minTime)} - ${formatClockTime(clipper.stats.maxTime)}`
        : '';
      bufferBadge.textContent = `Buffer: ${formatDuration(clipper.stats.durationSec)} (${clipper.stats.count} segs · ${formatBytes(clipper.stats.totalBytes)}${timeSpanStr})`;
    }

    const rulerStart = document.getElementById('bidn-ruler-start');
    const rulerMid = document.getElementById('bidn-ruler-mid');
    const rulerEnd = document.getElementById('bidn-ruler-end');

    if (rulerStart && clipper.stats.minTime && clipper.stats.maxTime) {
      const midTime = (clipper.stats.minTime + clipper.stats.maxTime) / 2;
      rulerStart.textContent = formatClockTime(clipper.stats.minTime);
      if (rulerMid) rulerMid.textContent = formatClockTime(midTime);
      if (rulerEnd) rulerEnd.textContent = formatClockTime(clipper.stats.maxTime);
    }

    updateTimelinePositions();
  }

  // ── 10. Dock Controls & Actions ──────────────────────────────────────────

  function initDockListeners() {
    const dock = clipper.dockEl;
    if (!dock) return;

    // Close button
    dock.querySelector('#bidn-btn-close-dock').addEventListener('click', closeClipperDock);

    // Return to live
    dock.querySelector('#bidn-btn-return-live').addEventListener('click', () => {
      closeClipperDock();
      showToast('🔴 Returned to Live Stream', 'success', 2000);
    });

    // Play / Pause preview
    dock.querySelector('#bidn-btn-play-preview').addEventListener('click', togglePreviewPlayback);

    // Rewind / Forward 5s
    dock.querySelector('#bidn-btn-rewind-5').addEventListener('click', () => stepPlayhead(-5));
    dock.querySelector('#bidn-btn-forward-5').addEventListener('click', () => stepPlayhead(5));

    // Set Start & Set End buttons
    dock.querySelector('#bidn-btn-set-start').addEventListener('click', () => {
      if (clipper.playheadMs != null) {
        clipper.selectionStartMs = Math.min(clipper.playheadMs, clipper.selectionEndMs - 1000);
        updateTimelinePositions();
        showToast('Set [ Start Point', 'info', 1500);
      }
    });

    dock.querySelector('#bidn-btn-set-end').addEventListener('click', () => {
      if (clipper.playheadMs != null) {
        clipper.selectionEndMs = Math.max(clipper.playheadMs, clipper.selectionStartMs + 1000);
        updateTimelinePositions();
        showToast('Set End Point ]', 'info', 1500);
      }
    });

    // Preset buttons
    dock.querySelectorAll('.bidn-btn-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sec = parseInt(btn.dataset.preset, 10);
        applyPreset(sec);
      });
    });

    // Preview Clip
    dock.querySelector('#bidn-btn-preview-clip').addEventListener('click', previewSelectedClip);

    // Download MP4
    dock.querySelector('#bidn-btn-download-clip').addEventListener('click', downloadCurrentClip);

    // Retention change
    const retentionSelect = dock.querySelector('#bidn-select-retention');
    retentionSelect.addEventListener('change', () => {
      const mins = parseInt(retentionSelect.value, 10);
      clipper.retentionMinutes = mins;
      sendToPage('SET_BUFFER_LIMIT', { retentionMinutes: mins });
      showToast(`Buffer retention set to ${mins}m`, 'info', 2000);
    });

    // Clear Buffer
    dock.querySelector('#bidn-btn-clear-buffer').addEventListener('click', async () => {
      if (confirm('Clear all cached video segments for this stream?')) {
        await clearBuffer();
        showToast('Buffer cleared', 'info', 2000);
      }
    });
  }

  function applyPreset(seconds) {
    if (!clipper.stats.maxTime) return;
    const durMs = seconds * 1000;
    clipper.selectionEndMs = clipper.stats.maxTime;
    clipper.selectionStartMs = Math.max(clipper.stats.minTime, clipper.stats.maxTime - durMs);
    clipper.playheadMs = clipper.selectionStartMs;
    updateTimelinePositions();
    showToast(`Selected last ${seconds}s`, 'info', 1500);
  }

  function stepPlayhead(deltaSeconds) {
    if (clipper.playheadMs == null) return;
    const newMs = clipper.playheadMs + (deltaSeconds * 1000);
    clipper.playheadMs = Math.max(clipper.stats.minTime, Math.min(newMs, clipper.stats.maxTime));
    updateTimelinePositions();
    seekPreviewToTime(clipper.playheadMs);
  }

  async function seekPreviewToTime(targetMs) {
    if (!clipper.previewVideo) initPreviewPlayer();
    showPreviewPlayer();

    // If preview video already has source loaded covering this range
    if (clipper.previewVideo.src && clipper.selectionStartMs && clipper.selectionEndMs) {
      if (targetMs >= clipper.selectionStartMs && targetMs <= clipper.selectionEndMs) {
        const offsetSec = (targetMs - clipper.selectionStartMs) / 1000;
        clipper.previewVideo.currentTime = offsetSec;
        return;
      }
    }

    // Otherwise render a 15-second slice around targetMs for smooth scrubbing
    await loadSliceForPreview(Math.max(clipper.stats.minTime, targetMs - 2000), targetMs + 12000);
  }

  async function loadSliceForPreview(startMs, endMs) {
    if (!window.ClipperStorage || !window.ClipperTransmuxer) return;
    const slug = getActiveSlug();

    try {
      const segments = await window.ClipperStorage.getSegmentsInRange(slug, startMs, endMs);
      if (!segments || segments.length === 0) return;

      const { blob } = await window.ClipperTransmuxer.transmux(segments);
      if (clipper.previewBlobUrl) URL.revokeObjectURL(clipper.previewBlobUrl);

      clipper.previewBlobUrl = URL.createObjectURL(blob);
      clipper.previewVideo.src = clipper.previewBlobUrl;
      clipper.previewVideo.play().catch(() => {});
    } catch (err) {
      console.warn('[IDN Live Clipper Ext] Slice preview error:', err);
    }
  }

  async function previewSelectedClip() {
    if (clipper.isGeneratingPreview) return;
    clipper.isGeneratingPreview = true;

    const btn = document.getElementById('bidn-btn-preview-clip');
    if (btn) btn.textContent = '⏳ Loading...';

    try {
      const slug = getActiveSlug();
      const segments = await window.ClipperStorage.getSegmentsInRange(
        slug,
        clipper.selectionStartMs,
        clipper.selectionEndMs
      );

      if (!segments || segments.length === 0) {
        showToast('⚠️ No video segments found in selected range', 'error');
        return;
      }

      showToast(`Generating clip preview (${segments.length} segments)...`, 'info', 2000);
      showPreviewPlayer();

      const { blob } = await window.ClipperTransmuxer.transmux(segments);
      if (clipper.previewBlobUrl) URL.revokeObjectURL(clipper.previewBlobUrl);

      clipper.previewBlobUrl = URL.createObjectURL(blob);
      clipper.previewVideo.src = clipper.previewBlobUrl;
      clipper.previewVideo.currentTime = 0;
      await clipper.previewVideo.play();
      showToast('▶️ Playing clip preview on loop', 'success', 2000);
    } catch (err) {
      console.error('[IDN Live Clipper Ext] Clip preview failed:', err);
      showToast(`Preview failed: ${err.message}`, 'error');
    } finally {
      clipper.isGeneratingPreview = false;
      if (btn) btn.textContent = '👁️ Preview Clip';
    }
  }

  function togglePreviewPlayback() {
    if (!clipper.previewVideo || !clipper.previewVideo.src) {
      previewSelectedClip();
      return;
    }
    if (clipper.previewVideo.paused) {
      clipper.previewVideo.play().catch(() => {});
    } else {
      clipper.previewVideo.pause();
    }
  }

  // ── 11. Remux & Download MP4 ─────────────────────────────────────────────

  async function downloadCurrentClip() {
    if (!window.ClipperStorage || !window.ClipperTransmuxer) {
      showToast('⚠️ Clipper engine not ready', 'error');
      return;
    }

    const btn = document.getElementById('bidn-btn-download-clip');
    const origText = btn ? btn.innerHTML : '⬇️ Download MP4';

    try {
      if (btn) btn.textContent = '⏳ Slicing...';
      const slug = getActiveSlug();
      const segments = await window.ClipperStorage.getSegmentsInRange(
        slug,
        clipper.selectionStartMs,
        clipper.selectionEndMs
      );

      if (!segments || segments.length === 0) {
        showToast('⚠️ No segments found in selected range', 'error');
        if (btn) btn.innerHTML = origText;
        return;
      }

      showToast(`Remuxing ${segments.length} segments to MP4...`, 'info', 2500);

      const { blob, duration } = await window.ClipperTransmuxer.transmux(
        segments,
        (pct) => {
          if (btn) btn.textContent = `⚡ Remuxing: ${pct}%`;
        }
      );

      // Generate filename
      const streamer = (
        state.streamData?.creator?.username ||
        state.streamData?.creator?.name ||
        'IDN_Live'
      ).replace(/[^a-zA-Z0-9_-]/g, '_');

      const title = (state.streamData?.title || 'Clip')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .substring(0, 24);

      const timestampStr = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const filename = `${streamer}_${title}_${Math.round(duration)}s_${timestampStr}.mp4`;

      const blobUrl = URL.createObjectURL(blob);

      // Trigger download via background script (or fallback)
      chrome.runtime.sendMessage(
        {
          action: 'downloadClip',
          payload: { url: blobUrl, filename, saveAs: false },
        },
        (resp) => {
          if (!resp || !resp.ok) {
            // Fallback download link
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
          }
        }
      );

      showToast(`✅ Download started: ${filename}`, 'success', 4000);
      if (btn) btn.textContent = '✅ Downloaded!';
      setTimeout(() => {
        if (btn) btn.innerHTML = origText;
      }, 3000);
    } catch (err) {
      console.error('[IDN Live Clipper Ext] Remux & Download error:', err);
      showToast(`Download failed: ${err.message}`, 'error');
      if (btn) btn.innerHTML = origText;
    }
  }

  async function quickClipLastSeconds(seconds = 30) {
    if (!window.ClipperStorage || !window.ClipperTransmuxer) {
      throw new Error('Clipper engine not initialized');
    }

    const slug = getActiveSlug();
    const stats = await window.ClipperStorage.getStats(slug);
    if (!stats || stats.count === 0) {
      throw new Error('No buffered video segments available. Play the stream first!');
    }

    const endMs = stats.maxTime || Date.now();
    const startMs = Math.max(stats.minTime, endMs - (seconds * 1000));

    const segments = await window.ClipperStorage.getSegmentsInRange(slug, startMs, endMs);
    if (!segments || segments.length === 0) {
      throw new Error(`No segments available in the last ${seconds}s`);
    }

    showToast(`⚡ Quick clipping last ${seconds}s...`, 'info', 2500);

    const { blob, duration } = await window.ClipperTransmuxer.transmux(segments);
    const streamer = (
      state.streamData?.creator?.username ||
      state.streamData?.creator?.name ||
      'IDN_Live'
    ).replace(/[^a-zA-Z0-9_-]/g, '_');

    const timestampStr = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename = `${streamer}_QuickClip_${Math.round(duration)}s_${timestampStr}.mp4`;
    const blobUrl = URL.createObjectURL(blob);

    chrome.runtime.sendMessage(
      {
        action: 'downloadClip',
        payload: { url: blobUrl, filename, saveAs: false },
      },
      (resp) => {
        if (!resp || !resp.ok) {
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
        }
      }
    );

    showToast(`✅ Quick Clip downloaded: ${filename}`, 'success', 3500);
    return { filename, duration };
  }

  async function clearBuffer(targetSlug) {
    if (!window.ClipperStorage) return;
    const slug = targetSlug || getActiveSlug();
    await window.ClipperStorage.clearStream(slug);
    if (!targetSlug || targetSlug === getActiveSlug()) {
      sendToPage('CLEAR_CLIPPER_BUFFER', {});
      clipper.stats = { count: 0, totalBytes: 0, minTime: 0, maxTime: 0, durationSec: 0 };
      updateClipperUI();
    }
    await syncCachedStreamsToStorage();
  }

  function openClipperStudioTab() {
    const slug = getActiveSlug();
    chrome.runtime.sendMessage({
      action: 'openClipperTab',
      slug,
      payload: { slug },
    });
  }

  function openClipperDock() {
    openClipperStudioTab();
  }

  function closeClipperDock() {
    // Dedicated tab mode
  }

  function toggleClipperDock() {
    openClipperStudioTab();
  }

  // ── 12. Keyboard Shortcuts ───────────────────────────────────────────────

  function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ignore if user is typing in an input or textarea
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable) {
        return;
      }

      if (e.key === 'c' || e.key === 'C') {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          openClipperStudioTab();
        }
      }
    });
  }

  // ── 13. Initialize & SPA Observation ─────────────────────────────────────

  function isLivePage(path) {
    if (!path) return false;
    return (
      path.startsWith('/live/') ||
      /^\/[^/]+\/live(\/|$)/.test(path) ||
      path.startsWith('/embed-player/') ||
      path.startsWith('/embed/')
    );
  }

  const IDN_API_KEY = '123f4c4e-6ce1-404d-8786-d17e46d65b5c';

  async function discoverStreamFromApi() {
    const slug = getActiveSlug();
    if (!slug || slug === 'idn_stream') return;

    try {
      const res = await fetch(`https://api.idn.app/api/v1/web/livestream/${slug}`, {
        headers: { 'X-API-Key': IDN_API_KEY },
      });
      if (!res.ok) return;
      const json = await res.json();
      const data = json.data;
      if (data && data.playback_url) {
        state.streamData = data;
        state.playbackUrl = data.playback_url;
        clipper.activeStreamSlug = data.slug || slug;
        forwardToBackground('streamData', data);
        forwardToBackground('playbackUrlFound', { url: data.playback_url });
        startBufferEngine(data.playback_url, data.slug || slug);
        if (window.ClipperStorage) {
          window.ClipperStorage.saveStreamMetadata(data.slug || slug, {
            title: data.title,
            creator: data.creator?.name,
            creatorUsername: data.creator?.username,
            creatorAvatar: data.creator?.image_url,
            status: data.status || 'live',
            playbackUrl: data.playback_url,
          }).then(() => syncCachedStreamsToStorage()).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('[IDN Live Clipper Ext] Proactive stream discovery error:', err);
    }
  }

  function init() {
    processPendingClears()
      .then(() => syncCachedStreamsToStorage())
      .then(() => syncCurrentStreamSegmentsToExtension())
      .catch(() => {});
    if (isLivePage(window.location.pathname)) {
      setTimeout(createQualityOverlay, 500);
      setTimeout(createQualityOverlay, 2000);
      discoverStreamFromApi();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Watch for Next.js SPA navigation
  let lastPath = window.location.pathname;
  const navObserver = new MutationObserver(() => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      purgeZendeskElements();
      stopBufferEngine();
      clipper.activeStreamSlug = null;
      if (isLivePage(lastPath)) {
        setTimeout(createQualityOverlay, 500);
        discoverStreamFromApi();
      } else {
        if (overlayContainer) {
          overlayContainer.remove();
          overlayContainer = null;
        }
        closeClipperDock();
      }
    }
  });

  function startNavObserver() {
    const root = document.documentElement || document.body;
    if (root) {
      navObserver.observe(root, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', startNavObserver, { once: true });
    }
  }
  startNavObserver();

  console.log('[IDN Live Clipper Ext] Content script & Clipper loaded');
})();
