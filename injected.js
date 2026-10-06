/**
 * injected.js — Runs in the PAGE context (not extension sandbox).
 *
 * Responsibilities:
 *  1. Intercept fetch() and XMLHttpRequest to capture m3u8 URLs and GraphQL
 *     playback_url responses.
 *  2. Find the Amazon IVS player instance so we can read/set quality levels.
 *  3. Disable the page's DevTools-blocking code.
 *  4. Communicate everything back to content.js via window.postMessage.
 */
(function () {
  'use strict';

  // ── Neutralize Zendesk Chat Widget ────────────────────────────────────────
  // idn.app loads Zendesk Messenger via snippet.js which appends a floating chat
  // bubble launcher icon. We suppress it by preempting the script tag, setting
  // suppress configurations on window.zESettings, and providing safe dummy globals.
  try {
    window.zESettings = {
      webWidget: {
        chat: { suppress: true },
        contactForm: { suppress: true },
        helpCenter: { suppress: true },
        launcher: { label: { '*': '' } },
      },
      messenger: {
        suppress: true,
      },
    };

    const dummyZE = function () {};
    dummyZE.identify = function () {};
    dummyZE.hide = function () {};
    dummyZE.show = function () {};
    dummyZE.activate = function () {};
    dummyZE.setLocale = function () {};
    dummyZE.setHelpCenterSuggestions = function () {};

    try {
      Object.defineProperty(window, 'zE', {
        configurable: true,
        enumerable: true,
        get: () => dummyZE,
        set: () => {},
      });
      Object.defineProperty(window, 'zEmbed', {
        configurable: true,
        enumerable: true,
        get: () => dummyZE,
        set: () => {},
      });
    } catch (_) {
      window.zE = dummyZE;
      window.zEmbed = dummyZE;
    }

    // Preempt ze-snippet if head/documentElement exists
    const targetEl = document.documentElement || document.head;
    if (targetEl && !document.getElementById('ze-snippet')) {
      const dummy = document.createElement('script');
      dummy.id = 'ze-snippet';
      dummy.type = 'text/plain';
      dummy.setAttribute('data-bidn-blocked', 'true');
      dummy.textContent = '/* zendesk blocked by idn-live-clipper-ext */';
      targetEl.appendChild(dummy);
    }
  } catch (_) {}

  // Namespace all our messages so the content script can filter them.
  const MSG_PREFIX = 'BETTER_IDN_LIVE';

  // ── Helpers ──────────────────────────────────────────────────────────────

  function post(type, payload) {
    window.postMessage({ source: MSG_PREFIX, type, payload }, '*');
  }

  /**
   * Walk an object tree looking for a key whose value is a string containing
   * the given needle. Returns the first match or null.
   */
  function deepFindString(obj, needle, depth = 0) {
    if (depth > 10 || !obj || typeof obj !== 'object') return null;
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'string' && val.includes(needle)) return { key, value: val };
      if (typeof val === 'object') {
        const found = deepFindString(val, needle, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Recursively extract all string values containing a needle.
   */
  function deepFindAllStrings(obj, needle, depth = 0, results = []) {
    if (depth > 10 || !obj || typeof obj !== 'object') return results;
    for (const val of Object.values(obj)) {
      if (typeof val === 'string' && val.includes(needle)) {
        results.push(val);
      } else if (typeof val === 'object') {
        deepFindAllStrings(val, needle, depth + 1, results);
      }
    }
    return results;
  }

  // ── Clipper Segment & Playlist Interception ──────────────────────────────

  let currentStreamSlug = null;
  const knownSegmentsMap = new Map(); // url -> { sequence, duration, timestamp }
  let autoSequenceCounter = 1;
  let segmentCountSincePrune = 0;
  let clipperRetentionMs = 0; // 0 = Unlimited (keep entire stream by default)
  let clipperMaxBytes = 0; // 0 = Unlimited (no byte size cap)

  function getSlugFromUrl() {
    const path = window.location.pathname;
    const match =
      path.match(/\/(?:live|embed-player|embed)\/([a-zA-Z0-9_-]+)/) ||
      path.match(/^\/[^/]+\/live\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  function getActiveSlug() {
    return currentStreamSlug || getSlugFromUrl() || 'idn_stream';
  }

  function parseMediaPlaylist(text, playlistUrl) {
    if (!text || !text.includes('#EXTINF:')) return;

    try {
      const lines = text.split(/\r?\n/);
      let mediaSequence = 0;
      let targetDuration = 2.0;
      let programDateTimeMs = null;
      let currentExtinfDuration = 2.0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
          mediaSequence = parseInt(line.split(':')[1], 10) || 0;
        } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
          targetDuration = parseFloat(line.split(':')[1]) || 2.0;
        } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
          const dtStr = line.substring(line.indexOf(':') + 1);
          const parsed = Date.parse(dtStr);
          if (!isNaN(parsed)) programDateTimeMs = parsed;
        } else if (line.startsWith('#EXTINF:')) {
          const durMatch = line.match(/#EXTINF:([\d.]+)/);
          currentExtinfDuration = durMatch ? parseFloat(durMatch[1]) : targetDuration;
        } else if (line.startsWith('#EXT-X-ENDLIST')) {
          const endedSlug = getActiveSlug();
          post('STREAM_ENDED', { streamSlug: endedSlug });
          if (window.ClipperStorage) {
            window.ClipperStorage.saveStreamMetadata(endedSlug, { status: 'ended' }).catch(() => {});
          }
        } else if (line && !line.startsWith('#')) {
          // This line is a segment URI
          let fullUrl = line;
          try {
            fullUrl = new URL(line, playlistUrl).href;
          } catch (_) {}

          const segSeq = mediaSequence++;
          if (programDateTimeMs == null) programDateTimeMs = Date.now();
          const segTime = programDateTimeMs;
          programDateTimeMs += Math.round(currentExtinfDuration * 1000);

          knownSegmentsMap.set(fullUrl, {
            sequence: segSeq,
            duration: currentExtinfDuration,
            timestamp: segTime,
          });

          // Prevent map from growing unbounded
          if (knownSegmentsMap.size > 2000) {
            const firstKey = knownSegmentsMap.keys().next().value;
            knownSegmentsMap.delete(firstKey);
          }
        }
      }

      post('PLAYLIST_PARSED', {
        streamSlug: getActiveSlug(),
        targetDuration,
        knownSegments: knownSegmentsMap.size,
      });
    } catch (e) {
      console.warn('[IDN Live Clipper Ext] Error parsing media playlist:', e);
    }
  }

  function isSegmentUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.includes('.m3u8')) return false;
    if (url.includes('/graphql') || url.includes('/api/v1/web/')) return false;
    if (knownSegmentsMap.has(url)) return true;
    if (/\.(ts|m4s|mp4)(\?|$)/i.test(url)) return true;
    if (url.includes('/chunked/') || url.includes('/segment/')) return true;
    return false;
  }

  async function handleIncomingSegment(url, arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength < 500) return;

    try {
      const streamSlug = getActiveSlug();
      const meta = knownSegmentsMap.get(url) || {};

      let sequence = meta.sequence;
      if (sequence == null) {
        // Try extracting sequence number from url filename (e.g. 58291.ts)
        const match = url.match(/(\d+)\.(ts|m4s|mp4)/);
        if (match) {
          sequence = parseInt(match[1], 10);
        } else {
          sequence = autoSequenceCounter++;
        }
      }

      const duration = meta.duration || 2.0;
      const timestamp = meta.timestamp || Date.now();
      const quality = playerInstance?.getQuality?.()?.name || 'auto';

      // When Chrome is minimized or hidden, the in-page player drops to low-res 160p ABR.
      // Do not save degraded 160p chunks into storage as they cause severe stutter & lag when remuxed with 1080p/720p.
      const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (quality === '160p' && (isHidden || arrayBuffer.byteLength < 250000)) {
        return;
      }

      if (window.ClipperStorage) {
        await window.ClipperStorage.saveSegment({
          streamSlug,
          sequence,
          timestamp,
          duration,
          url,
          data: arrayBuffer,
          quality,
        });

        // Periodic rolling buffer prune (only when a retention limit or size cap is configured)
        segmentCountSincePrune++;
        if (segmentCountSincePrune >= 10) {
          segmentCountSincePrune = 0;
          if (clipperRetentionMs > 0 || clipperMaxBytes > 0) {
            window.ClipperStorage.pruneOldSegments(
              streamSlug,
              clipperRetentionMs,
              clipperMaxBytes
            ).catch(() => {});
          }
        }

        // Notify content script of buffered segment
        post('SEGMENT_CACHED', {
          streamSlug,
          sequence,
          duration,
          timestamp,
          size: arrayBuffer.byteLength,
          url,
          quality,
          data: arrayBuffer,
        });
      }
    } catch (err) {
      console.warn('[IDN Live Clipper Ext] Error caching segment:', err);
    }
  }

  // ── 1. Intercept fetch() ─────────────────────────────────────────────────

  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const request = args[0];
    const url = typeof request === 'string' ? request : request?.url;

    // Capture any m3u8 URL that goes through fetch
    if (url && typeof url === 'string' && url.includes('.m3u8')) {
      post('M3U8_URL', { url, source: 'fetch' });
    }

    const isSeg = url && typeof url === 'string' && isSegmentUrl(url);

    const response = await _fetch.apply(this, args);

    // If media segment, clone and store ArrayBuffer in ClipperStorage
    if (isSeg) {
      try {
        const clone = response.clone();
        clone.arrayBuffer().then((buf) => {
          handleIncomingSegment(url, buf);
        }).catch(() => {});
      } catch (_) {}
    }

    // Inspect m3u8 playlists for segment durations & sequence numbers
    if (url && typeof url === 'string' && url.includes('.m3u8')) {
      try {
        const clone = response.clone();
        clone.text().then((text) => {
          parseMediaPlaylist(text, url);
        }).catch(() => {});
      } catch (_) {}
    }

    // Inspect GraphQL responses for playback_url
    if (url && typeof url === 'string' && (url.includes('graphql') || url.includes('/api/'))) {
      try {
        const clone = response.clone();
        const json = await clone.json();
        const m3u8Match = deepFindString(json, '.m3u8');
        if (m3u8Match) {
          post('PLAYBACK_URL', { url: m3u8Match.value, key: m3u8Match.key, source: 'graphql' });
        }
        // Also forward the entire livestream response for metadata
        const streamData = extractStreamData(json);
        if (streamData) {
          if (streamData.slug) currentStreamSlug = streamData.slug;
          post('STREAM_DATA', streamData);
          if (window.ClipperStorage) {
            window.ClipperStorage.saveStreamMetadata(streamData.slug || currentStreamSlug, {
              title: streamData.title,
              creator: streamData.creator?.name,
              creatorUsername: streamData.creator?.username,
              creatorAvatar: streamData.creator?.image_url,
              status: streamData.status || 'live',
              playbackUrl: streamData.playback_url,
            }).catch(() => {});
          }
        }
      } catch (_) {
        // Not JSON or failed — ignore
      }
    }

    return response;
  };

  // ── 2. Intercept XMLHttpRequest ──────────────────────────────────────────

  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__betterIdnUrl = url;
    if (url && typeof url === 'string' && url.includes('.m3u8')) {
      post('M3U8_URL', { url, source: 'xhr' });
    }
    return _xhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__betterIdnUrl;

    if (url && typeof url === 'string') {
      if (isSegmentUrl(url)) {
        this.addEventListener('load', () => {
          try {
            if (this.response instanceof ArrayBuffer) {
              handleIncomingSegment(url, this.response.slice(0));
            } else if (this.responseType === 'blob' && this.response instanceof Blob) {
              this.response.arrayBuffer().then((buf) => handleIncomingSegment(url, buf));
            }
          } catch (e) {
            console.warn('[IDN Live Clipper Ext] XHR segment capture error:', e);
          }
        });
      }

      if (url.includes('.m3u8')) {
        this.addEventListener('load', () => {
          try {
            if (this.responseText && this.responseText.includes('#EXTINF:')) {
              parseMediaPlaylist(this.responseText, url);
            }
          } catch (_) {}
        });
      }

      if (url.includes('graphql') || url.includes('/api/')) {
        this.addEventListener('load', () => {
          try {
            const json = JSON.parse(this.responseText);
            const m3u8Match = deepFindString(json, '.m3u8');
            if (m3u8Match) {
              post('PLAYBACK_URL', { url: m3u8Match.value, key: m3u8Match.key, source: 'graphql-xhr' });
            }
            const streamData = extractStreamData(json);
            if (streamData) {
              if (streamData.slug) currentStreamSlug = streamData.slug;
              post('STREAM_DATA', streamData);
            }
          } catch (_) {}
        });
      }
    }

    return _xhrSend.apply(this, args);
  };

  // ── 3. Extract stream metadata from API responses ────────────────────────

  function extractStreamData(json) {
    if (!json || typeof json !== 'object') return null;

    // Look for common patterns in the response
    const data = json.data || json;

    // Try to find livestream object (could be nested under various keys)
    const candidates = ['getLivestream', 'livestream', 'live', 'stream', 'room'];
    for (const key of candidates) {
      if (data[key]) {
        const stream = data[key];
        return {
          slug: stream.slug || stream.id || null,
          title: stream.title || stream.name || null,
          status: stream.status || null,
          playbackUrl: stream.playback_url || stream.playbackUrl || stream.stream_url || null,
          imageUrl: stream.image_url || stream.imageUrl || stream.thumbnail || null,
          creator: stream.creator || stream.user || stream.streamer || null,
          viewCount: stream.view_count || stream.viewCount || stream.viewer_count || null,
        };
      }
    }
    return null;
  }

  // ── 3b. Extract from window.__NEXT_DATA__ ───────────────────────────────

  function extractFromNextData() {
    try {
      const nextData = window.__NEXT_DATA__;
      const livestream = nextData?.props?.pageProps?.livestream;
      if (livestream) {
        const streamData = {
          slug: livestream.slug || null,
          title: livestream.title || null,
          status: livestream.status || null,
          playbackUrl: livestream.playback_url || livestream.entity?.playback_url || null,
          imageUrl: livestream.image_url || null,
          creator: livestream.creator || null,
          viewCount: livestream.view_count || null,
        };
        post('STREAM_DATA', streamData);
        if (streamData.playbackUrl) {
          post('PLAYBACK_URL', { url: streamData.playbackUrl, source: 'next_data' });
        }
      }
    } catch (_) {}
  }

  // ── 4. Find and hook the IVS Player ──────────────────────────────────────

  let playerInstance = null;
  let playerCheckInterval = null;

  /**
   * Traverse React Fiber tree from all <video> elements on page to locate
   * the active Amazon IVS Player instance (which is held in component hooks).
   */
  function getIDNPlayer() {
    const videos = Array.from(document.querySelectorAll('video'));
    for (const video of videos) {
      // 1. Direct property attached to video element
      const direct = video.__ivs_player || video._player || video.player || video.__player;
      if (direct && typeof direct.getQualities === 'function') {
        return direct;
      }

      // 2. React fiber traversal
      const fiberKey = Object.keys(video).find(
        (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
      );
      if (!fiberKey) continue;

      let curr = video[fiberKey];
      while (curr) {
        // Walk the entire hook memoizedState linked list
        let hook = curr.memoizedState;
        while (hook) {
          const val = hook.memoizedState;
          if (val?.current && typeof val.current.getQualities === 'function') {
            return val.current;
          }
          if (val && typeof val.getQualities === 'function') {
            return val;
          }
          hook = hook.next;
        }

        // Check memoizedProps
        const props = curr.memoizedProps;
        if (props && typeof props === 'object') {
          for (const k of Object.keys(props)) {
            const val = props[k];
            if (val?.current && typeof val.current.getQualities === 'function') {
              return val.current;
            }
            if (val && typeof val.getQualities === 'function') {
              return val;
            }
          }
        }

        // Check stateNode
        const node = curr.stateNode;
        if (node && typeof node.getQualities === 'function') {
          return node;
        }

        curr = curr.return;
      }
    }
    return null;
  }

  function hookIVSPlayerCreate() {
    if (!window.IVSPlayer || !window.IVSPlayer.create || window.IVSPlayer.create.__betterIdnHooked) return;
    const _create = window.IVSPlayer.create;
    const hookedCreate = function (...args) {
      let player;
      if (new.target) {
        player = Reflect.construct(_create, args, new.target);
      } else {
        player = _create.apply(this, args);
      }
      try {
        setPlayer(player);
      } catch (e) {
        console.warn('[IDN Live Clipper Ext] Error in setPlayer hook:', e);
      }
      return player;
    };
    hookedCreate.__betterIdnHooked = true;
    try {
      Object.assign(hookedCreate, _create);
      hookedCreate.prototype = _create.prototype;
    } catch (_) {}
    window.IVSPlayer.create = hookedCreate;

    // Also hook MediaPlayer.prototype.attachHTMLVideoElement if available
    try {
      const proto = window.IVSPlayer.MediaPlayer?.prototype;
      if (proto && proto.attachHTMLVideoElement && !proto.attachHTMLVideoElement.__betterIdnHooked) {
        const _origAttach = proto.attachHTMLVideoElement;
        proto.attachHTMLVideoElement = function (video) {
          try {
            if (video) video.__ivs_player = this;
            setPlayer(this);
          } catch (_) {}
          return _origAttach.apply(this, arguments);
        };
        proto.attachHTMLVideoElement.__betterIdnHooked = true;
      }
    } catch (_) {}
  }

  // Intercept window.IVSPlayer as soon as it is assigned by Next.js
  let _ivsPlayerGlobal = window.IVSPlayer;
  if (_ivsPlayerGlobal && _ivsPlayerGlobal.create) {
    hookIVSPlayerCreate();
  } else {
    try {
      Object.defineProperty(window, 'IVSPlayer', {
        configurable: true,
        enumerable: true,
        get() {
          return _ivsPlayerGlobal;
        },
        set(val) {
          _ivsPlayerGlobal = val;
          if (_ivsPlayerGlobal && _ivsPlayerGlobal.create) {
            hookIVSPlayerCreate();
          }
        },
      });
    } catch (_) {}
  }

  function ensureAudioPlaying(forceUserInitiated = false) {
    try {
      const videos = document.querySelectorAll('video');
      videos.forEach((v) => {
        if (v.muted) {
          v.muted = false;
        }
        if (v.volume < 1.0) {
          v.volume = 1.0;
        }
        if (v.paused && forceUserInitiated) {
          v.play().catch(() => {});
        }
      });
      if (playerInstance) {
        if (typeof playerInstance.isMuted === 'function' && playerInstance.isMuted()) {
          if (typeof playerInstance.setMuted === 'function') playerInstance.setMuted(false);
        }
        if (typeof playerInstance.getVolume === 'function' && playerInstance.getVolume() < 1.0) {
          if (typeof playerInstance.setVolume === 'function') playerInstance.setVolume(1.0);
        }
      }
    } catch (_) {}
  }

  function findIVSPlayer() {
    // Strategy 1: Check React fiber tree / direct properties from video element
    const reactPlayer = getIDNPlayer();
    if (reactPlayer) {
      setPlayer(reactPlayer);
      return reactPlayer;
    }

    // Strategy 2: Hook window.IVSPlayer.create if present
    if (window.IVSPlayer && window.IVSPlayer.create) {
      hookIVSPlayerCreate();
    }

    // Strategy 3: Scan window for player-like objects
    for (const key of Object.keys(window)) {
      try {
        const obj = window[key];
        if (obj && typeof obj === 'object' && typeof obj.getQualities === 'function' && typeof obj.setQuality === 'function') {
          setPlayer(obj);
          return obj;
        }
      } catch (_) {}
    }

    return null;
  }

  function setPlayer(player) {
    if (!player || typeof player.getQualities !== 'function') return;
    if (playerInstance === player) {
      sendQualityInfo();
      return;
    }
    playerInstance = player;

    // Attach to video element for fast reference
    try {
      const video = document.querySelector('video');
      if (video) video.__ivs_player = player;
    } catch (_) {}

    // Notify the content script
    post('PLAYER_FOUND', { hasPlayer: true });

    // Listen for quality changes & player state
    try {
      if (typeof player.addEventListener === 'function') {
        const eventTypes = window.IVSPlayer?.PlayerEventType || {};
        const qualityEvent = eventTypes.QUALITY_CHANGED || 'PlayerQualityChanged';
        const qualitiesEvent = eventTypes.QUALITIES_CHANGED || 'PlayerQualitiesChanged';
        const stateEvent = eventTypes.STATE_CHANGED || 'PlayerStateChanged';

        player.addEventListener(qualityEvent, (quality) => {
          post('QUALITY_CHANGED', {
            current: serializeQuality(quality),
            all: getQualities(),
          });
        });

        player.addEventListener(qualitiesEvent, () => {
          sendQualityInfo();
        });

        player.addEventListener(stateEvent, () => {
          sendQualityInfo();
          setTimeout(sendQualityInfo, 500);
        });
      }
    } catch (e) {
      console.warn('[IDN Live Clipper Ext] Error setting up player listeners:', e);
    }

    // Send initial quality info
    sendQualityInfo();
    setTimeout(sendQualityInfo, 1000);
    setTimeout(sendQualityInfo, 2500);
  }

  function getQualities() {
    if (!playerInstance || typeof playerInstance.getQualities !== 'function') {
      const p = getIDNPlayer();
      if (p) setPlayer(p);
    }
    if (!playerInstance || typeof playerInstance.getQualities !== 'function') return [];
    try {
      return playerInstance.getQualities().map(serializeQuality);
    } catch (_) {
      return [];
    }
  }

  function serializeQuality(q) {
    if (!q) return null;
    return {
      name: q.name || 'unknown',
      codecs: q.codecs || '',
      bitrate: q.bitrate || 0,
      width: q.width || 0,
      height: q.height || 0,
      framerate: q.framerate || 0,
    };
  }

  function sendQualityInfo() {
    if (!playerInstance) {
      const p = getIDNPlayer();
      if (p) setPlayer(p);
    }
    if (!playerInstance) return;
    const qualities = getQualities();
    let current = null;
    let autoMode = true;
    try {
      current = serializeQuality(playerInstance.getQuality?.());
      autoMode = playerInstance.isAutoQualityMode?.() ?? true;
    } catch (_) {}

    if (qualities.length > 0 || current) {
      post('QUALITIES_AVAILABLE', {
        qualities,
        current,
        autoMode,
      });
    }
  }

  // ── 5. Listen for commands from content.js ───────────────────────────────

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== MSG_PREFIX + '_CMD') return;

    const { type, payload } = event.data;

    switch (type) {
      case 'SET_QUALITY': {
        if (!playerInstance) {
          const p = getIDNPlayer();
          if (p) setPlayer(p);
        }
        if (!playerInstance) {
          post('ERROR', { message: 'Player not found' });
          return;
        }
        try {
          const qualities = playerInstance.getQualities();
          const target = qualities.find(
            (q) => q.name === payload.name || (q.height && `${q.height}p` === payload.name)
          );
          if (target) {
            if (typeof playerInstance.setAutoQualityMode === 'function') {
              playerInstance.setAutoQualityMode(false);
            }
            playerInstance.setQuality(target);
            post('QUALITY_SET', { quality: serializeQuality(target) });
            setTimeout(sendQualityInfo, 250);
          } else {
            post('ERROR', { message: `Quality "${payload.name}" not found` });
          }
        } catch (e) {
          post('ERROR', { message: e.message });
        }
        break;
      }

      case 'SET_AUTO_QUALITY': {
        if (!playerInstance) {
          const p = getIDNPlayer();
          if (p) setPlayer(p);
        }
        if (!playerInstance) {
          post('ERROR', { message: 'Player not found' });
          return;
        }
        try {
          if (typeof playerInstance.setAutoQualityMode === 'function') {
            playerInstance.setAutoQualityMode(true);
          }
          try {
            playerInstance.setQuality(null);
          } catch (_) {}
          post('AUTO_QUALITY_SET', {});
          setTimeout(sendQualityInfo, 250);
        } catch (e) {
          post('ERROR', { message: e.message });
        }
        break;
      }

      case 'GET_QUALITIES': {
        if (!playerInstance) {
          findIVSPlayer();
        }
        sendQualityInfo();
        break;
      }

      case 'GET_STREAM_URL': {
        extractFromNextData();
        const video = document.querySelector('video');
        if (video && video.src) {
          post('M3U8_URL', { url: video.src, source: 'video-element' });
        }
        if (playerInstance) {
          try {
            const src = playerInstance.getSource?.() || playerInstance.src;
            if (src) {
              post('M3U8_URL', { url: src, source: 'ivs-player' });
            }
          } catch (_) {}
        }
        break;
      }

      case 'PING': {
        if (!playerInstance) {
          findIVSPlayer();
        }
        post('PONG', {
          hasPlayer: !!playerInstance,
          qualityCount: getQualities().length,
        });
        break;
      }

      case 'PAUSE_LIVE_PLAYER': {
        // Live stream player must NEVER be paused, dimmed, or disrupted!
        post('LIVE_PLAYER_PAUSED', { suppressed: true });
        break;
      }

      case 'RESUME_LIVE_PLAYER': {
        ensureAudioPlaying(false);
        post('LIVE_PLAYER_RESUMED', {});
        break;
      }

      case 'UNMUTE_LIVE_PLAYER': {
        ensureAudioPlaying(true);
        post('LIVE_PLAYER_UNMUTED', {});
        break;
      }

      case 'GET_CLIPPER_STATS': {
        if (window.ClipperStorage) {
          window.ClipperStorage.getStats(getActiveSlug()).then((stats) => {
            post('CLIPPER_STATS', stats);
          }).catch(() => {});
        }
        break;
      }

      case 'CLEAR_CLIPPER_BUFFER': {
        if (window.ClipperStorage) {
          window.ClipperStorage.clearStream(getActiveSlug()).then(() => {
            post('CLIPPER_BUFFER_CLEARED', { streamSlug: getActiveSlug() });
            window.ClipperStorage.getStats(getActiveSlug()).then((stats) => {
              post('CLIPPER_STATS', stats);
            }).catch(() => {});
          }).catch(() => {});
        }
        break;
      }

      case 'SET_BUFFER_LIMIT': {
        if (payload?.retentionMinutes !== undefined) {
          const mins = Number(payload.retentionMinutes) || 0;
          clipperRetentionMs = mins > 0 ? mins * 60 * 1000 : 0;
        }
        if (payload?.maxBytes !== undefined) {
          clipperMaxBytes = Number(payload.maxBytes) || 0;
        }
        break;
      }
    }
  });

  // ── 6. Disable DevTools blocking ─────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) {
      e.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener('contextmenu', (e) => {
    e.stopImmediatePropagation();
  }, true);

  const _setInterval = window.setInterval;
  window.setInterval = function (fn, ms, ...args) {
    if (typeof fn === 'function' && ms < 100) {
      const fnStr = fn.toString();
      if (fnStr.includes('debugger') || fnStr.includes('devtool')) {
        return _setInterval(() => {}, ms);
      }
    }
    return _setInterval(fn, ms, ...args);
  };

  // ── 7. Start player discovery & SPA observation ──────────────────────────

  let lastUrl = window.location.href;

  function startPlayerDiscovery() {
    extractFromNextData();
    findIVSPlayer();

    // Periodic check to discover player and handle Next.js SPA transitions
    playerCheckInterval = setInterval(() => {
      // Check if URL changed (SPA navigation)
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        playerInstance = null;
        extractFromNextData();
        findIVSPlayer();
        return;
      }

      // If no player yet, keep trying
      if (!playerInstance) {
        findIVSPlayer();
      } else {
        // Verify attached video element is still in the document
        const currentVideo = document.querySelector('video');
        const attachedVideo = playerInstance.getHTMLVideoElement?.();
        if (currentVideo && attachedVideo && currentVideo !== attachedVideo) {
          playerInstance = null;
          findIVSPlayer();
        }
      }
    }, 1000);
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPlayerDiscovery);
  } else {
    startPlayerDiscovery();
  }

  // Also watch for dynamic video element insertion
  const bodyObserver = new MutationObserver(() => {
    if (!playerInstance) {
      findIVSPlayer();
    }
  });

  if (document.body) {
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    });
  }

  console.log('[IDN Live Clipper Ext] Injected script loaded');
})();
