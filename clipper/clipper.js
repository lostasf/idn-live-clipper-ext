/**
 * clipper.js — IDN Live Clipper Ext Clipper Studio Logic.
 *
 * Dedicated, independent tab for scrubbing timeline and downloading clips
 * without disturbing or pausing the live stream tab.
 */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    slug: '',
    sourceTabId: null,
    streamTitle: 'Live Stream',
    creatorName: '',
    stats: {
      count: 0,
      totalBytes: 0,
      minTime: 0,
      maxTime: 0,
      durationSec: 0,
    },
    segmentsMeta: [],
    selectionStartMs: 0,
    selectionEndMs: 0,
    playheadMs: 0,
    previewBlobUrl: null,
    isDragging: null, // 'start' | 'end' | 'body' | 'playhead'
    dragStartX: 0,
    dragStartVal: 0,
    dragStartEndVal: 0,
    isProcessing: false,
    hasAutoLoaded: false,
    isLocalMp4Mode: false,
    localMp4File: null,
    localMp4Url: null,
    isMigrating: false,
  };

  // Playhead and seeking state
  let isProgrammaticSeek = false;
  let ignoreVideoSeekUntil = 0;
  let justFinishedDrag = false;
  let rafSeekId = null;

  // ── DOM Elements ───────────────────────────────────────────────────────────
  const els = {};

  function initElements() {
    els.streamTitle = document.getElementById('stream-title');
    els.creatorName = document.getElementById('creator-name');
    els.streamSlug = document.getElementById('stream-slug');
    els.connectionStatus = document.getElementById('connection-status');
    els.connectionText = document.getElementById('connection-text');
    els.bufferDuration = document.getElementById('buffer-duration');
    els.bufferCount = document.getElementById('buffer-count');
    els.studioRetentionSelect = document.getElementById('studio-retention-select');
    els.btnRefresh = document.getElementById('btn-refresh-buffer');
    els.btnSwitchStream = document.getElementById('btn-switch-stream-tab');
    els.btnCachedStreamsModal = document.getElementById('btn-cached-streams-modal');
    els.btnOpenLocalMp4 = document.getElementById('btn-open-local-mp4');
    els.inputLocalMp4 = document.getElementById('input-local-mp4');
    els.studioCachedCount = document.getElementById('studio-cached-count');
    els.cachedStreamsModal = document.getElementById('cached-streams-modal');
    els.btnCloseCachedModal = document.getElementById('btn-close-cached-modal');
    els.modalTotalSize = document.getElementById('modal-total-size');
    els.modalStreamsCount = document.getElementById('modal-streams-count');
    els.btnModalClearAll = document.getElementById('btn-modal-clear-all');
    els.btnModalRefresh = document.getElementById('btn-modal-refresh');
    els.modalStreamsList = document.getElementById('modal-streams-list');
    els.modalEmptyState = document.getElementById('modal-empty-state');

    els.previewVideo = document.getElementById('preview-video');
    els.videoOverlayMsg = document.getElementById('video-overlay-msg');
    els.videoLoading = document.getElementById('video-loading');
    els.loadingStatusText = document.getElementById('loading-status-text');
    els.loadingProgressBar = document.getElementById('loading-progress-bar');

    els.clipDurationStat = document.getElementById('clip-duration-stat');
    els.clipSegmentsStat = document.getElementById('clip-segments-stat');
    els.clipSizeStat = document.getElementById('clip-size-stat');
    els.inputStartTime = document.getElementById('input-start-time');
    els.inputEndTime = document.getElementById('input-end-time');
    els.labelStartTime = document.getElementById('label-start-time');
    els.labelEndTime = document.getElementById('label-end-time');
    els.inputFilename = document.getElementById('input-filename');
    els.btnStartMinus1 = document.getElementById('btn-start-minus-1');
    els.btnStartPlus1 = document.getElementById('btn-start-plus-1');
    els.btnEndMinus1 = document.getElementById('btn-end-minus-1');
    els.btnEndPlus1 = document.getElementById('btn-end-plus-1');

    els.btnPreviewClip = document.getElementById('btn-preview-clip');
    els.btnPreviewClipText = document.getElementById('btn-preview-clip-text');
    els.btnDownloadMp4 = document.getElementById('btn-download-mp4');
    els.taskProgress = document.getElementById('task-progress');
    els.taskActionName = document.getElementById('task-action-name');
    els.taskPercent = document.getElementById('task-percent');
    els.taskProgressFill = document.getElementById('task-progress-fill');
    els.taskSubtext = document.getElementById('task-subtext');

    els.timelineSection = document.querySelector('.timeline-section');
    els.timelineRangeInfo = document.getElementById('timeline-range-info');
    els.timelineWrap = document.getElementById('timeline-wrap');
    els.timelineRuler = document.getElementById('timeline-ruler');
    els.timelineTrack = document.getElementById('timeline-track');
    els.timelineBuffered = document.getElementById('timeline-buffered');
    els.timelineSelection = document.getElementById('timeline-selection');
    els.selectionBody = document.getElementById('selection-body');
    els.handleStart = document.getElementById('handle-start');
    els.handleEnd = document.getElementById('handle-end');
    els.tagStart = document.getElementById('tag-start');
    els.tagEnd = document.getElementById('tag-end');
    els.timelinePlayhead = document.getElementById('timeline-playhead');
    els.playheadTag = document.getElementById('playhead-tag');
    els.timelineLiveMarker = document.getElementById('timeline-live-marker');
    els.timelineTooltip = document.getElementById('timeline-tooltip');

    els.btnSetStartPlayhead = document.getElementById('btn-set-start-playhead');
    els.btnSetEndPlayhead = document.getElementById('btn-set-end-playhead');
  }

  // ── URL Params ─────────────────────────────────────────────────────────────
  function parseQueryParams() {
    const params = new URLSearchParams(window.location.search);
    state.slug = params.get('slug') || '';
    const tabId = params.get('tabId');
    state.sourceTabId = tabId ? parseInt(tabId, 10) : null;
  }

  // ── Tab Communication ──────────────────────────────────────────────────────
  async function resolveStreamTab() {
    // If state.sourceTabId was already provided via query param, verify it is still alive
    if (state.sourceTabId) {
      try {
        const tab = await chrome.tabs.get(state.sourceTabId);
        if (tab && tab.url && tab.url.includes('idn.app')) {
          if (!state.slug || tab.url.includes(state.slug)) {
            return tab;
          }
        }
        state.sourceTabId = null;
      } catch (_) {
        state.sourceTabId = null;
      }
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'findStreamTab', slug: state.slug }, (res) => {
        if (chrome.runtime.lastError) {
          console.warn('[Clipper Studio] findStreamTab warning:', chrome.runtime.lastError.message);
        }
        if (res && res.tab) {
          state.sourceTabId = res.tab.id;
          resolve(res.tab);
        } else {
          state.sourceTabId = null;
          resolve(null);
        }
      });
    });
  }

  // ── Segment Migration from Stream Tab ──────────────────────────────────────
  async function migrateSegmentsFromStreamTab(tabId, slug) {
    if (!tabId || !slug || state.isMigrating) return;
    state.isMigrating = true;

    showTaskProgress(true, 'Syncing segments for offline use...', 5, 'Fetching cached stream segments from IDN tab...');

    try {
      let offset = 0;
      const limit = 30;
      let total = 0;
      let migratedCount = 0;

      while (true) {
        const res = await new Promise((resolve) => {
          chrome.tabs.sendMessage(
            tabId,
            { action: 'GET_SEGMENTS_CHUNK_BASE64', slug, offset, limit },
            (response) => {
              if (chrome.runtime.lastError || !response || !response.ok) {
                resolve(null);
              } else {
                resolve(response);
              }
            }
          );
        });

        if (!res || !res.items || res.items.length === 0) break;
        total = res.total || total;

        for (const item of res.items) {
          if (item.base64) {
            const binary = atob(item.base64);
            const len = binary.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            if (window.ClipperStorage) {
              await window.ClipperStorage.saveSegment({
                streamSlug: item.streamSlug,
                sequence: item.sequence,
                timestamp: item.timestamp,
                duration: item.duration,
                url: item.url,
                quality: item.quality,
                isInitSegment: item.isInitSegment,
                data: bytes.buffer,
              });
            }
            migratedCount++;
          }
        }

        const pct = total > 0 ? Math.min(95, Math.round((migratedCount / total) * 100)) : 50;
        showTaskProgress(true, 'Syncing segments for offline use...', pct, `Synced ${migratedCount} of ${total || '?'} segments...`);

        if (!res.hasMore) break;
        offset += limit;
      }

      console.log(`[Clipper Studio] Successfully migrated ${migratedCount} segments to Extension IndexedDB!`);
      showTaskProgress(true, '✅ Segments Synced for Offline Use!', 100, `All ${migratedCount} segments stored offline. You can safely close the IDN tab.`);
      setTimeout(() => showTaskProgress(false), 5000);

      // Re-read local stats and refresh UI
      if (window.ClipperStorage) {
        const localStats = await window.ClipperStorage.getStats(slug);
        const segmentsMeta = await window.ClipperStorage.getSegmentsMeta(slug);
        const meta = await window.ClipperStorage.getStreamMetadata(slug);
        applyStreamData({
          streamInfo: {
            title: meta?.title || (state.streamTitle !== 'Live Stream' ? state.streamTitle : 'Cached Stream'),
            creator: { name: meta?.creator || state.creatorName || '' },
            slug,
            playbackUrl: meta?.playbackUrl || '',
          },
          stats: localStats,
          segmentsMeta,
        });
        updateConnectionStatus(true, 'Cached Stream Buffer Loaded (100% Offline Ready)');
      }
    } catch (err) {
      console.warn('[Clipper Studio] Segment migration error:', err);
      showTaskProgress(false);
    } finally {
      state.isMigrating = false;
    }
  }

  // ── Local MP4 File Support ─────────────────────────────────────────────────
  function loadLocalMp4File(file) {
    if (!file) return;

    if (state.previewBlobUrl && !state.isLocalMp4Mode) {
      URL.revokeObjectURL(state.previewBlobUrl);
    }

    const localUrl = URL.createObjectURL(file);
    state.isLocalMp4Mode = true;
    state.localMp4File = file;
    state.localMp4Url = localUrl;
    state.previewBlobUrl = localUrl;

    showLoading(true, 'Loading local MP4 file into player...');
    hideVideoOverlay();

    els.previewVideo.src = localUrl;
    els.previewVideo.preload = 'metadata';
    els.previewVideo.load();

    els.previewVideo.onloadedmetadata = () => {
      showLoading(false);
      const durationSec = els.previewVideo.duration || 0;
      const durationMs = durationSec * 1000;

      state.streamTitle = file.name;
      state.creatorName = 'Local MP4 Clip';
      state.slug = file.name.replace(/\.[^/.]+$/, '');

      state.stats = {
        count: 1,
        totalBytes: file.size,
        durationSec: durationSec,
        minTime: 0,
        maxTime: durationMs,
      };

      state.selectionStartMs = 0;
      state.selectionEndMs = durationMs;
      state.playheadMs = 0;
      state.segmentsMeta = [];

      if (els.streamTitle) els.streamTitle.textContent = file.name;
      if (els.creatorName) els.creatorName.textContent = '📂 Local File';
      if (els.streamSlug) els.streamSlug.textContent = `💾 ${(file.size / (1024 * 1024)).toFixed(2)} MB`;
      if (els.bufferDuration) els.bufferDuration.textContent = formatDuration(durationSec);
      if (els.bufferCount) els.bufferCount.textContent = '1 file';
      if (els.inputFilename) els.inputFilename.value = `edited_${file.name}`;

      updateConnectionStatus(true, 'Local MP4 File Loaded (100% Offline)');

      renderTimeline();
      updateClipStats();
      els.previewVideo.currentTime = 0;
      els.previewVideo.pause();
    };

    els.previewVideo.onerror = () => {
      showLoading(false);
      alert('Could not open MP4 file. The format may not be supported by the browser.');
    };
  }

  async function fetchStreamData() {
    // 0. Auto-detect stream slug if none provided in query params
    if (!state.slug) {
      // Priority 1: Check if an active IDN live stream tab is currently open
      try {
        const tabRes = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'findStreamTab' }, resolve);
        });
        if (tabRes && tabRes.tab && tabRes.tab.url) {
          const match =
            tabRes.tab.url.match(/\/(?:live|embed-player|embed)\/([a-zA-Z0-9_-]+)/) ||
            tabRes.tab.url.match(/^\/[^/]+\/live\/([a-zA-Z0-9_-]+)/);
          if (match && match[1]) {
            state.slug = match[1];
            state.sourceTabId = tabRes.tab.id;
          }
        }
      } catch (_) {}

      // Priority 2: Check storage for freshest stream
      if (!state.slug) {
        try {
          const storageRes = await chrome.storage.local.get(['better_idn_cached_streams']);
          const map = storageRes.better_idn_cached_streams || {};
          const streams = Object.values(map);
          streams.sort((a, b) => (b.lastSavedAt || b.updatedAt || 0) - (a.lastSavedAt || a.updatedAt || 0));
          if (streams.length > 0) {
            state.slug = streams[0].streamSlug;
          }
        } catch (_) {}
      }

      // Priority 3: Check local Extension IndexedDB
      if (!state.slug && window.ClipperStorage) {
        try {
          const allCached = await window.ClipperStorage.getAllCachedStreams();
          if (allCached && allCached.length > 0) {
            allCached.sort((a, b) => (b.lastSavedAt || 0) - (a.lastSavedAt || 0));
            state.slug = allCached[0].streamSlug;
          }
        } catch (_) {}
      }

      if (state.slug) {
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.set('slug', state.slug);
        if (state.sourceTabId) newUrl.searchParams.set('tabId', state.sourceTabId);
        window.history.replaceState({}, '', newUrl.toString());
      }
    }

    // 1. Try reading directly from Extension-Origin IndexedDB (Works standalone offline without IDN app open!)
    let hasLocalData = false;
    let localValidCount = 0;
    if (window.ClipperStorage && state.slug) {
      try {
        const localStats = await window.ClipperStorage.getStats(state.slug);
        if (localStats && localStats.count > 0 && localStats.totalBytes > 0) {
          const segmentsMeta = await window.ClipperStorage.getSegmentsMeta(state.slug);
          localValidCount = segmentsMeta.length;

          if (localValidCount > 0) {
            const meta = await window.ClipperStorage.getStreamMetadata(state.slug);
            applyStreamData({
              streamInfo: {
                title: meta?.title || (state.streamTitle !== 'Live Stream' ? state.streamTitle : 'Cached Stream'),
                creator: { name: meta?.creator || state.creatorName || '' },
                slug: state.slug,
                playbackUrl: meta?.playbackUrl || '',
              },
              stats: localStats,
              segmentsMeta,
            });
            updateConnectionStatus(true, 'Cached Stream Buffer Loaded (Offline Ready)');
            hasLocalData = true;
          }
        }
      } catch (err) {
        console.warn('[Clipper Studio] Error checking local extension storage:', err);
      }
    }

    // 2. Check if an active IDN live stream tab is currently open for live updates or segment migration
    await resolveStreamTab();

    if (!state.sourceTabId) {
      if (hasLocalData) return;

      // Fallback: check storage record in chrome.storage.local
      const storageRes = await chrome.storage.local.get(['better_idn_cached_streams']);
      const stream = storageRes.better_idn_cached_streams?.[state.slug];
      if (stream) {
        updateConnectionStatus(true, 'Viewing Cached Stream Buffer (Offline)');
        applyStreamData({
          streamInfo: {
            title: stream.title || 'Cached Stream',
            creator: { name: stream.creator || '' },
            slug: stream.streamSlug,
          },
          stats: {
            count: stream.count,
            totalBytes: stream.totalBytes,
            durationSec: stream.durationSec,
            minTime: stream.minTime,
            maxTime: stream.maxTime,
          },
        });
        return;
      }
      updateConnectionStatus(false, 'No active stream or cached segments found');
      return;
    }

    // Tab is open: fetch snapshot and trigger migration if local storage lacks full data
    updateConnectionStatus(true, hasLocalData ? 'Buffer Loaded · Ready to Clip' : 'Connecting to stream...');

    chrome.tabs.sendMessage(
      state.sourceTabId,
      { action: 'GET_CLIPPER_DATA', slug: state.slug },
      async (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) {
          if (hasLocalData) return;
          updateConnectionStatus(false, 'Waiting for stream tab...');
          return;
        }

        updateConnectionStatus(true, 'Buffer Snapshot Loaded · Ready to Clip');
        applyStreamData(response);

        // If local extension storage is empty or has fewer valid segments than the stream tab, auto-migrate!
        const streamTabCount = response.stats?.count || 0;
        if (streamTabCount > 0 && localValidCount < streamTabCount) {
          console.log(`[Clipper Studio] Auto-migrating ${streamTabCount} segments from stream tab to extension origin...`);
          migrateSegmentsFromStreamTab(state.sourceTabId, state.slug);
        }
      }
    );
  }

  function updateConnectionStatus(connected, text) {
    if (!els.connectionStatus) return;
    const dot = els.connectionStatus.querySelector('.status-dot');
    if (dot) {
      dot.className = 'status-dot ' + (connected ? 'green' : 'yellow');
    }
    if (els.connectionText) {
      els.connectionText.textContent = text;
    }
  }

  function generateDefaultFilename() {
    const memberName = (state.creatorName || state.slug || 'IDN_Live')
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '');

    const refMs = state.stats.minTime || Date.now();
    const d = new Date(refMs);
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const min = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    const datetime = `${yyyy}${mm}${dd}_${hh}${min}${ss}`;

    return `${memberName}_${datetime}.mp4`;
  }

  function applyStreamData(data) {
    if (data.streamInfo) {
      state.streamTitle = data.streamInfo.title || 'Live Stream';
      state.creatorName = data.streamInfo.creator?.name || '';
      if (els.streamTitle) els.streamTitle.textContent = state.streamTitle;
      if (els.creatorName) els.creatorName.textContent = state.creatorName ? '👤 ' + state.creatorName : '';
      if (els.streamSlug) els.streamSlug.textContent = state.slug ? '🔗 ' + state.slug : '';

      // Default filename: MemberName_datetime.mp4
      if (!els.inputFilename.value || els.inputFilename.dataset.userEdited !== 'true') {
        els.inputFilename.value = generateDefaultFilename();
      }
    }

    if (data.stats) {
      state.stats = data.stats;
      if (els.bufferDuration) els.bufferDuration.textContent = formatDuration(state.stats.durationSec);
      if (els.bufferCount) els.bufferCount.textContent = state.stats.count;
    }

    if (data.segmentsMeta) {
      state.segmentsMeta = data.segmentsMeta;
    }

    // Default selection to the last 30 seconds of buffered stream (or full duration if < 30s)
    const max = state.stats.maxTime || Date.now();
    const min = state.stats.minTime || (max - 30000);
    if (!state.selectionStartMs || !state.selectionEndMs) {
      const defaultDurationMs = Math.min(30000, Math.max(0, max - min));
      state.selectionStartMs = Math.max(min, max - defaultDurationMs);
      state.selectionEndMs = max;
    }
    if (!state.playheadMs) {
      state.playheadMs = state.selectionStartMs;
    }

    renderTimeline();
    updateClipStats();

    // Auto-load segments into player and pause so user doesn't have to click load
    if (!state.hasAutoLoaded && state.stats && state.stats.count > 0) {
      autoLoadPreview();
    }
  }

  function updateClipStats() {
    const min = state.stats.minTime;
    const max = state.stats.maxTime;
    const durationMs = Math.max(0, state.selectionEndMs - state.selectionStartMs);
    const durationSec = durationMs / 1000;

    // Update duration stat
    if (els.clipDurationStat) {
      els.clipDurationStat.textContent = durationSec.toFixed(1) + 's';
    }

    // Estimate segments & size
    const segs = getSelectedSegmentsMeta();
    if (els.clipSegmentsStat) {
      els.clipSegmentsStat.textContent = segs.length + ' segs';
    }

    const totalBytes = segs.reduce((acc, s) => acc + (s.byteLength || 0), 0);
    if (els.clipSizeStat) {
      els.clipSizeStat.textContent = totalBytes > 0
        ? '~' + (totalBytes / (1024 * 1024)).toFixed(1) + ' MB'
        : '~' + (durationSec * 0.18).toFixed(1) + ' MB';
    }

    // Input times (Clock Time HH:MM:SS)
    if (els.inputStartTime && document.activeElement !== els.inputStartTime) {
      els.inputStartTime.value = formatClockTime(state.selectionStartMs);
    }
    if (els.inputEndTime && document.activeElement !== els.inputEndTime) {
      els.inputEndTime.value = formatClockTime(state.selectionEndMs);
    }
    if (els.labelStartTime) {
      els.labelStartTime.textContent = 'Start Time';
    }
    if (els.labelEndTime) {
      els.labelEndTime.textContent = 'End Time';
    }

    // Dynamic Preview Button status
    if (els.btnPreviewClipText) {
      const isChanged = !state.lastRemuxedRange ||
        state.lastRemuxedRange.start !== state.selectionStartMs ||
        state.lastRemuxedRange.end !== state.selectionEndMs;
      if (isChanged && state.hasAutoLoaded) {
        els.btnPreviewClipText.textContent = `Preview Selection (${durationSec.toFixed(1)}s)`;
      } else {
        els.btnPreviewClipText.textContent = 'Preview Selection';
      }
    }
  }

  function getSelectedSegmentsMeta() {
    if (!state.segmentsMeta || state.segmentsMeta.length === 0) {
      // Estimate based on 2.0s segments
      const dur = (state.selectionEndMs - state.selectionStartMs) / 1000;
      const count = Math.max(1, Math.round(dur / 2.0));
      return new Array(count).fill({ byteLength: 350000 });
    }

    return state.segmentsMeta.filter((s) => {
      const segEnd = s.timestamp + (s.duration * 1000);
      return segEnd >= state.selectionStartMs && s.timestamp <= state.selectionEndMs;
    });
  }

  // ── Timeline Rendering ─────────────────────────────────────────────────────
  function renderTimeline() {
    const min = state.stats.minTime;
    const max = state.stats.maxTime;
    const span = Math.max(1000, max - min);

    // Update range info header
    if (els.timelineRangeInfo) {
      els.timelineRangeInfo.textContent = `Buffered: ${formatClockTime(min)} - ${formatClockTime(max)} (${formatDuration(state.stats.durationSec)})`;
    }

    // Selection position & width
    const startPct = Math.max(0, Math.min(100, ((state.selectionStartMs - min) / span) * 100));
    const endPct = Math.max(0, Math.min(100, ((state.selectionEndMs - min) / span) * 100));
    const widthPct = Math.max(0.5, endPct - startPct);

    if (els.timelineSelection) {
      els.timelineSelection.style.left = startPct + '%';
      els.timelineSelection.style.width = widthPct + '%';
    }

    // Selection handle tags
    if (els.tagStart) {
      els.tagStart.textContent = formatClockTime(state.selectionStartMs);
    }
    if (els.tagEnd) {
      els.tagEnd.textContent = formatClockTime(state.selectionEndMs);
    }

    // Playhead position
    const playheadPct = Math.max(0, Math.min(100, ((state.playheadMs - min) / span) * 100));
    if (els.timelinePlayhead) {
      els.timelinePlayhead.style.left = playheadPct + '%';
    }
    if (els.playheadTag) {
      els.playheadTag.textContent = formatClockTime(state.playheadMs);
    }

    renderRuler(min, max, span);
  }

  function renderRuler(min, max, span) {
    if (!els.timelineRuler) return;
    els.timelineRuler.innerHTML = '';

    const rulerWidth = els.timelineRuler.clientWidth || 800;
    const numTicks = span < 60000 ? 4 : rulerWidth < 650 ? 5 : rulerWidth < 950 ? 6 : 8;

    for (let i = 0; i <= numTicks; i++) {
      const ratio = i / numTicks;
      const timeMs = min + (ratio * span);
      const tick = document.createElement('div');
      tick.className = 'ruler-tick';
      tick.style.left = (ratio * 100) + '%';
      if (i === 0) {
        tick.style.transform = 'translateX(0)';
      } else if (i === numTicks) {
        tick.style.transform = 'translateX(-100%)';
      } else {
        tick.style.transform = 'translateX(-50%)';
      }

      tick.textContent = formatClockTime(timeMs);
      els.timelineRuler.appendChild(tick);
    }
  }

  // ── Drag & Drop Timeline Interaction ───────────────────────────────────────
  function requestSyncVideo() {
    if (rafSeekId) return;
    rafSeekId = requestAnimationFrame(() => {
      rafSeekId = null;
      syncVideoToPlayhead();
    });
  }

  function initTimelineInteractions() {
    // 0. Drag Playhead Needle (Time Indicator)
    if (els.timelinePlayhead) {
      els.timelinePlayhead.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        state.isDragging = 'playhead';
        state.dragStartX = e.clientX;
        state.dragStartVal = state.playheadMs;
        ignoreVideoSeekUntil = Date.now() + 600;
        isProgrammaticSeek = true;
      });
    }

    // 1. Drag Start Handle
    els.handleStart.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      state.isDragging = 'start';
      state.dragStartX = e.clientX;
      state.dragStartVal = state.selectionStartMs;
    });

    // 2. Drag End Handle
    els.handleEnd.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      state.isDragging = 'end';
      state.dragStartX = e.clientX;
      state.dragStartVal = state.selectionEndMs;
    });

    // 3. Drag Entire Selection Window
    els.selectionBody.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      state.isDragging = 'body';
      state.dragStartX = e.clientX;
      state.dragStartVal = state.selectionStartMs;
      state.dragStartEndVal = state.selectionEndMs;
    });

    // 4. Click Track to move Playhead
    els.timelineTrack.addEventListener('click', (e) => {
      if (justFinishedDrag || state.isDragging) return;
      if (e.target.closest('#handle-start') || e.target.closest('#handle-end') || e.target.closest('#timeline-playhead')) return;

      const rect = els.timelineTrack.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, clickX / rect.width));
      const span = state.stats.maxTime - state.stats.minTime;
      const targetMs = state.stats.minTime + (ratio * span);

      state.playheadMs = targetMs;
      renderTimeline();

      isProgrammaticSeek = true;
      ignoreVideoSeekUntil = Date.now() + 600;
      syncVideoToPlayhead();
    });

    // Global MouseMove & MouseUp
    window.addEventListener('mousemove', (e) => {
      if (!state.isDragging) {
        handleTimelineHover(e);
        return;
      }

      const rect = els.timelineTrack.getBoundingClientRect();
      const span = state.stats.maxTime - state.stats.minTime;
      if (span <= 0 || rect.width <= 0) return;

      if (state.isDragging === 'playhead') {
        const trackX = e.clientX - rect.left;
        const ratio = Math.max(0, Math.min(1, trackX / rect.width));
        state.playheadMs = state.stats.minTime + (ratio * span);
        renderTimeline();
        requestSyncVideo();
      } else if (state.isDragging === 'start') {
        const deltaX = e.clientX - state.dragStartX;
        const deltaMs = (deltaX / rect.width) * span;
        const newStart = Math.min(state.selectionEndMs - 1000, Math.max(state.stats.minTime, state.dragStartVal + deltaMs));
        state.selectionStartMs = newStart;
        renderTimeline();
        updateClipStats();
      } else if (state.isDragging === 'end') {
        const deltaX = e.clientX - state.dragStartX;
        const deltaMs = (deltaX / rect.width) * span;
        const newEnd = Math.max(state.selectionStartMs + 1000, Math.min(state.stats.maxTime, state.dragStartVal + deltaMs));
        state.selectionEndMs = newEnd;
        renderTimeline();
        updateClipStats();
      } else if (state.isDragging === 'body') {
        const deltaX = e.clientX - state.dragStartX;
        const deltaMs = (deltaX / rect.width) * span;
        const selSpan = state.dragStartEndVal - state.dragStartVal;
        let newStart = state.dragStartVal + deltaMs;
        let newEnd = state.dragStartEndVal + deltaMs;

        if (newStart < state.stats.minTime) {
          newStart = state.stats.minTime;
          newEnd = newStart + selSpan;
        }
        if (newEnd > state.stats.maxTime) {
          newEnd = state.stats.maxTime;
          newStart = newEnd - selSpan;
        }

        state.selectionStartMs = newStart;
        state.selectionEndMs = newEnd;
        renderTimeline();
        updateClipStats();
      }
    });

    window.addEventListener('mouseup', () => {
      if (state.isDragging) {
        const wasDraggingPlayhead = state.isDragging === 'playhead';
        state.isDragging = null;
        justFinishedDrag = true;
        setTimeout(() => {
          justFinishedDrag = false;
        }, 100);

        if (wasDraggingPlayhead) {
          isProgrammaticSeek = true;
          ignoreVideoSeekUntil = Date.now() + 600;
          syncVideoToPlayhead();
        }
      }
    });

    // Tooltip hide on mouseleave
    els.timelineTrack.addEventListener('mouseleave', () => {
      if (els.timelineTooltip) els.timelineTooltip.style.display = 'none';
    });
  }

  function handleTimelineHover(e) {
    if (!els.timelineTooltip) return;
    const rect = els.timelineTrack.getBoundingClientRect();
    if (e.clientY < rect.top - 20 || e.clientY > rect.bottom + 20 || e.clientX < rect.left || e.clientX > rect.right) {
      els.timelineTooltip.style.display = 'none';
      return;
    }

    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const span = state.stats.maxTime - state.stats.minTime;
    const hoverMs = state.stats.minTime + (ratio * span);

    els.timelineTooltip.style.display = 'block';
    els.timelineTooltip.style.left = (e.clientX - rect.left) + 'px';
    els.timelineTooltip.textContent = formatClockTime(hoverMs);
  }

  function syncVideoToPlayhead() {
    if (!els.previewVideo || !els.previewVideo.src || isNaN(els.previewVideo.duration)) return;

    let targetSec;
    if (state.isLocalMp4Mode) {
      targetSec = state.playheadMs / 1000;
    } else {
      // In stream mode, previewVideo only contains the range [selectionStartMs, selectionEndMs]
      if (state.playheadMs < state.selectionStartMs || state.playheadMs > state.selectionEndMs) {
        // Outside loaded clip range: do not seek preview video
        return;
      }
      targetSec = (state.playheadMs - state.selectionStartMs) / 1000;
    }

    targetSec = Math.max(0, Math.min(els.previewVideo.duration, targetSec));
    if (Math.abs(els.previewVideo.currentTime - targetSec) > 0.05) {
      isProgrammaticSeek = true;
      ignoreVideoSeekUntil = Date.now() + 600;
      try {
        els.previewVideo.currentTime = targetSec;
      } catch (_) {}
    }
  }

  // ── Preview Player & MP4 Remuxer ───────────────────────────────────────────

  async function transmuxClip(startMs, endMs, options = {}) {
    // 0. If in Local MP4 File Mode
    if (state.isLocalMp4Mode && state.localMp4File) {
      const durSec = Math.max(0.1, (endMs - startMs) / 1000);
      return {
        blob: state.localMp4File,
        duration: durSec,
        size: state.localMp4File.size,
        segmentCount: 1,
      };
    }

    // 1. Primary: Try local transmuxing from Extension-Origin IndexedDB (Works 100% standalone with NO IDN tab open!)
    if (window.ClipperStorage && window.ClipperTransmuxer) {
      try {
        let localSegments = await window.ClipperStorage.getSegmentsInRange(state.slug, startMs, endMs);
        if ((!localSegments || localSegments.length === 0) && state.slug) {
          localSegments = await window.ClipperStorage.getAllSegments(state.slug);
        }
        if (localSegments && localSegments.length > 0) {
          const hasValidData = localSegments.some(
            (s) => (s.data instanceof ArrayBuffer || s.data instanceof Uint8Array) && s.data.byteLength > 0
          );
          if (hasValidData) {
            console.log(`[Clipper Studio] Transmuxing ${localSegments.length} segments directly from Extension Storage...`);
            return await window.ClipperTransmuxer.transmux(localSegments, (pct) => {
              updateLoadingProgress(Math.round(pct * 100));
            });
          } else {
            console.warn('[Clipper Studio] Local segments in Extension Storage have empty or invalid data, trying live stream tab...');
          }
        }
      } catch (localErr) {
        console.warn('[Clipper Studio] Local transmuxing error, trying live stream tab:', localErr);
      }
    }

    // 2. Secondary / Fallback: Request remux from open live stream tab
    return await transmuxClipFromStreamTab(startMs, endMs, options);
  }

  async function transmuxClipFromStreamTab(startMs, endMs, options = {}) {
    if (!state.sourceTabId) {
      await resolveStreamTab();
    }

    if (!state.sourceTabId) {
      throw new Error('IDN Live stream tab is not open, and no segments were found in local Extension Storage for this stream.');
    }

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        state.sourceTabId,
        {
          action: 'TRANSMUX_CLIP_RANGE',
          startMs,
          endMs,
          slug: state.slug,
          isDownload: !!options.isDownload,
          filename: options.filename || '',
        },
        async (res) => {
          if (chrome.runtime.lastError) {
            state.sourceTabId = null;
            return reject(new Error('Live stream tab was closed or unreachable (' + chrome.runtime.lastError.message + ').'));
          }
          if (!res || !res.ok) {
            return reject(new Error(res?.error || 'Failed to remux clip from stream tab'));
          }

          if (res.downloadTriggeredDirectly) {
            return resolve({
              downloadTriggeredDirectly: true,
              duration: res.duration,
              size: res.size,
              segmentCount: res.segmentCount,
            });
          }

          try {
            // Convert Base64 data string to ArrayBuffer & Blob
            const binary = atob(res.base64);
            const len = binary.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: 'video/mp4' });
            resolve({
              blob,
              duration: res.duration,
              size: res.size,
              segmentCount: res.segmentCount,
            });
          } catch (decodeErr) {
            reject(new Error('Failed to decode MP4 clip: ' + decodeErr.message));
          }
        }
      );
    });
  }

  async function autoLoadPreview() {
    if (state.isProcessing || !state.stats || state.stats.count === 0 || state.isLocalMp4Mode) return;
    state.isProcessing = true;

    showLoading(true, 'Loading clip segments into player...');
    updateLoadingProgress(30);

    try {
      const result = await transmuxClip(state.selectionStartMs, state.selectionEndMs);
      updateLoadingProgress(80);

      if (state.previewBlobUrl) {
        URL.revokeObjectURL(state.previewBlobUrl);
      }

      state.previewBlobUrl = URL.createObjectURL(result.blob);
      state.lastRemuxedResult = result;
      state.lastRemuxedRange = { start: state.selectionStartMs, end: state.selectionEndMs };

      ignoreVideoSeekUntil = Date.now() + 1000;
      isProgrammaticSeek = true;
      els.previewVideo.src = state.previewBlobUrl;
      els.previewVideo.preload = 'auto';
      els.previewVideo.load();
      els.previewVideo.pause();

      hideVideoOverlay();
      updateLoadingProgress(100);
      showLoading(false);
      state.hasAutoLoaded = true;
    } catch (err) {
      console.warn('[Clipper Studio] Auto-load preview error:', err);
      showLoading(false);
    } finally {
      state.isProcessing = false;
    }
  }

  async function loadPreviewClip(autoPlay = false) {
    if (state.isProcessing) return;
    if (state.isLocalMp4Mode) {
      ignoreVideoSeekUntil = Date.now() + 600;
      isProgrammaticSeek = true;
      els.previewVideo.currentTime = Math.max(0, state.selectionStartMs / 1000);
      hideVideoOverlay();
      if (autoPlay) {
        state.playheadMs = state.selectionStartMs;
        renderTimeline();
        els.previewVideo.play().catch(() => {});
      } else {
        els.previewVideo.pause();
      }
      return;
    }
    state.isProcessing = true;

    showLoading(true, 'Loading clip segments into player...');
    updateLoadingProgress(30);

    try {
      const result = await transmuxClip(state.selectionStartMs, state.selectionEndMs);
      updateLoadingProgress(80);

      if (state.previewBlobUrl) {
        URL.revokeObjectURL(state.previewBlobUrl);
      }

      state.previewBlobUrl = URL.createObjectURL(result.blob);
      state.lastRemuxedResult = result;
      state.lastRemuxedRange = { start: state.selectionStartMs, end: state.selectionEndMs };

      ignoreVideoSeekUntil = Date.now() + 1000;
      isProgrammaticSeek = true;
      els.previewVideo.src = state.previewBlobUrl;
      els.previewVideo.preload = 'auto';
      els.previewVideo.load();

      if (autoPlay) {
        state.playheadMs = state.selectionStartMs;
        renderTimeline();
        await els.previewVideo.play().catch(() => {});
      } else {
        els.previewVideo.pause();
      }

      // Hide overlay message
      hideVideoOverlay();

      updateLoadingProgress(100);
      showLoading(false);
      state.hasAutoLoaded = true;
    } catch (err) {
      console.error('[Clipper Studio] Preview error:', err);
      showLoading(false);
      alert('Could not preview clip: ' + err.message);
    } finally {
      state.isProcessing = false;
    }
  }

  async function downloadMp4Clip() {
    if (state.isProcessing) return;
    state.isProcessing = true;

    showTaskProgress(true, 'Preparing MP4 clip...', 20, 'Transmuxing video segments...');

    try {
      const filename = (els.inputFilename.value || 'clip.mp4').trim();
      let result;
      // If user already previewed this exact selection range, reuse the ready blob!
      if (
        state.lastRemuxedResult &&
        state.lastRemuxedRange &&
        state.lastRemuxedRange.start === state.selectionStartMs &&
        state.lastRemuxedRange.end === state.selectionEndMs &&
        state.lastRemuxedResult.blob
      ) {
        result = state.lastRemuxedResult;
        showTaskProgress(true, 'Using ready clip...', 70, 'Packaging MP4 file...');
      } else {
        showTaskProgress(true, 'Remuxing segments to MP4...', 40, 'Transmuxing & patching duration metadata...');
        result = await transmuxClip(state.selectionStartMs, state.selectionEndMs, { isDownload: true, filename });
      }

      if (result.downloadTriggeredDirectly) {
        showTaskProgress(true, '✅ Download complete!', 100, `Saved as ${filename} (${(result.size / (1024 * 1024)).toFixed(2)} MB, duration: ${result.duration.toFixed(1)}s)`);
        setTimeout(() => showTaskProgress(false), 5000);
        return;
      }

      showTaskProgress(true, 'Delivering MP4 download...', 90, 'Packaging file...');

      const blobUrl = URL.createObjectURL(result.blob);

      // Trigger download via chrome.downloads API
      chrome.runtime.sendMessage(
        {
          action: 'downloadClip',
          payload: {
            url: blobUrl,
            filename,
            saveAs: true,
          },
        },
        (res) => {
          showTaskProgress(true, '✅ Download complete!', 100, `Saved as ${filename} (${(result.size / (1024 * 1024)).toFixed(2)} MB, duration: ${result.duration.toFixed(1)}s)`);
          setTimeout(() => showTaskProgress(false), 5000);
        }
      );
    } catch (err) {
      console.error('[Clipper Studio] Download error:', err);
      showTaskProgress(true, '❌ Download failed', 0, err.message);
      alert('Download error: ' + err.message);
    } finally {
      state.isProcessing = false;
    }
  }

  // ── UI Helpers ─────────────────────────────────────────────────────────────
  function hideVideoOverlay() {
    if (els.videoOverlayMsg) {
      els.videoOverlayMsg.classList.add('hidden');
      els.videoOverlayMsg.style.display = 'none';
    }
  }

  function showVideoOverlay() {
    if (els.videoOverlayMsg) {
      els.videoOverlayMsg.classList.remove('hidden');
      els.videoOverlayMsg.style.display = 'flex';
    }
  }


  function showLoading(show, text = '') {
    if (!els.videoLoading) return;
    els.videoLoading.style.display = show ? 'flex' : 'none';
    if (els.loadingStatusText && text) els.loadingStatusText.textContent = text;
    if (show && els.loadingProgressBar) els.loadingProgressBar.style.width = '0%';
  }

  function updateLoadingProgress(pct) {
    if (els.loadingProgressBar) {
      els.loadingProgressBar.style.width = Math.min(100, pct) + '%';
    }
  }

  function showTaskProgress(show, actionName = '', pct = 0, subtext = '') {
    if (!els.taskProgress) return;
    els.taskProgress.style.display = show ? 'block' : 'none';
    if (els.taskActionName) els.taskActionName.textContent = actionName;
    if (els.taskPercent) els.taskPercent.textContent = pct + '%';
    if (els.taskProgressFill) els.taskProgressFill.style.width = pct + '%';
    if (els.taskSubtext) els.taskSubtext.textContent = subtext;
  }

  function formatDuration(sec) {
    if (!sec || isNaN(sec)) return '0s';
    const s = Math.round(sec);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m === 0) return `${rem}s`;
    return `${m}m ${rem}s`;
  }

  function formatClockTime(ms) {
    if (ms == null || isNaN(ms)) return '00:00:00';
    if (state.isLocalMp4Mode || ms < 86400000 * 365) {
      const totalSec = Math.max(0, Math.floor(ms / 1000));
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(h)}:${pad(m)}:${pad(s)}`;
    }
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '00:00:00';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function parseTimeToMs(str, baseMs, fallbackMs) {
    if (!str || typeof str !== 'string') return fallbackMs;
    const trimmed = str.trim();
    if (!trimmed || trimmed.toUpperCase() === 'LIVE') {
      return state.stats.maxTime || fallbackMs;
    }

    // Clock format: HH:MM:SS or HH:MM
    const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (match) {
      const h = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      const s = match[3] ? parseInt(match[3], 10) : 0;
      if (h >= 0 && h < 24 && m >= 0 && m < 60 && s >= 0 && s < 60) {
        if (state.isLocalMp4Mode || (state.stats.maxTime && state.stats.maxTime < 86400000 * 365)) {
          return (h * 3600 + m * 60 + s) * 1000;
        }
        const d = new Date(baseMs || state.stats.maxTime || Date.now());
        d.setHours(h, m, s, 0);
        let targetMs = d.getTime();

        // Handle possible midnight crossover (e.g. buffer spans 23:50 to 00:20)
        if (state.stats.maxTime && state.stats.minTime) {
          if (targetMs > state.stats.maxTime + 43200000) {
            targetMs -= 86400000;
          } else if (targetMs < state.stats.minTime - 43200000) {
            targetMs += 86400000;
          }
        }
        return targetMs;
      }
    }

    return fallbackMs;
  }

  function formatSeconds(sec) {
    if (isNaN(sec)) return '00:00.0';
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(1);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(4, '0')}`;
  }

  // ── Event Listeners ────────────────────────────────────────────────────────
  function initListeners() {
    // Refresh button
    els.btnRefresh.addEventListener('click', () => {
      fetchStreamData();
    });

    // Switch to Stream Tab
    els.btnSwitchStream.addEventListener('click', () => {
      if (state.sourceTabId) {
        chrome.tabs.update(state.sourceTabId, { active: true });
      }
    });

    // Buffer Retention Select
    if (els.studioRetentionSelect) {
      els.studioRetentionSelect.addEventListener('change', async () => {
        const mins = parseInt(els.studioRetentionSelect.value, 10) || 0;
        await chrome.storage.local.set({ better_idn_buffer_retention: mins });
        await chrome.runtime.sendMessage({ action: 'setRetention', minutes: mins }).catch(() => {});
        if (state.sourceTabId) {
          chrome.tabs.sendMessage(state.sourceTabId, { action: 'setRetention', minutes: mins }).catch(() => {});
        }
      });
    }

    // Editable Start & End inputs
    if (els.inputStartTime) {
      els.inputStartTime.addEventListener('focus', () => {
        els.inputStartTime.value = formatClockTime(state.selectionStartMs);
        els.inputStartTime.select();
      });
      els.inputStartTime.addEventListener('change', () => {
        const parsed = parseTimeToMs(els.inputStartTime.value, state.selectionStartMs, state.selectionStartMs);
        state.selectionStartMs = Math.max(state.stats.minTime, Math.min(state.selectionEndMs - 2000, parsed));
        renderTimeline();
        updateClipStats();
      });
      els.inputStartTime.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') els.inputStartTime.blur();
      });
    }

    if (els.inputEndTime) {
      els.inputEndTime.addEventListener('focus', () => {
        els.inputEndTime.value = formatClockTime(state.selectionEndMs);
        els.inputEndTime.select();
      });
      els.inputEndTime.addEventListener('change', () => {
        const parsed = parseTimeToMs(els.inputEndTime.value, state.selectionEndMs, state.selectionEndMs);
        state.selectionEndMs = Math.max(state.selectionStartMs + 2000, Math.min(state.stats.maxTime, parsed));
        renderTimeline();
        updateClipStats();
      });
      els.inputEndTime.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') els.inputEndTime.blur();
      });
    }

    // Fine adjustments
    els.btnStartMinus1.addEventListener('click', () => {
      state.selectionStartMs = Math.max(state.stats.minTime, state.selectionStartMs - 1000);
      renderTimeline();
      updateClipStats();
    });
    els.btnStartPlus1.addEventListener('click', () => {
      state.selectionStartMs = Math.min(state.selectionEndMs - 2000, state.selectionStartMs + 1000);
      renderTimeline();
      updateClipStats();
    });
    els.btnEndMinus1.addEventListener('click', () => {
      state.selectionEndMs = Math.max(state.selectionStartMs + 2000, state.selectionEndMs - 1000);
      renderTimeline();
      updateClipStats();
    });
    els.btnEndPlus1.addEventListener('click', () => {
      state.selectionEndMs = Math.min(state.stats.maxTime, state.selectionEndMs + 1000);
      renderTimeline();
      updateClipStats();
    });

    // Quick selection buttons
    els.btnSetStartPlayhead.addEventListener('click', () => {
      state.selectionStartMs = Math.min(state.selectionEndMs - 2000, state.playheadMs);
      renderTimeline();
      updateClipStats();
    });
    els.btnSetEndPlayhead.addEventListener('click', () => {
      state.selectionEndMs = Math.max(state.selectionStartMs + 2000, state.playheadMs);
      renderTimeline();
      updateClipStats();
    });

    // Filename tracking
    if (els.inputFilename) {
      els.inputFilename.addEventListener('input', () => {
        els.inputFilename.dataset.userEdited = 'true';
      });
    }

    // Video overlay click to load preview
    if (els.videoOverlayMsg) {
      els.videoOverlayMsg.addEventListener('click', () => {
        loadPreviewClip();
      });
    }

    // Video player synchronization
    els.previewVideo.addEventListener('timeupdate', () => {
      if (els.previewVideo.currentTime > 0) {
        hideVideoOverlay();
      }
      if (state.isDragging) return;
      if (Date.now() < ignoreVideoSeekUntil) return;

      // The timeline indicator moves during active video playback
      if (!els.previewVideo.paused && !els.previewVideo.ended && els.previewVideo.duration) {
        const baseMs = state.isLocalMp4Mode ? 0 : state.selectionStartMs;
        state.playheadMs = baseMs + (els.previewVideo.currentTime * 1000);
        renderTimeline();
      }
    });

    function handleVideoMediaControlSeek() {
      if (state.isDragging) return;
      if (isProgrammaticSeek || Date.now() < ignoreVideoSeekUntil) {
        isProgrammaticSeek = false;
        return;
      }
      // User scrubbed or seeked using the video player's media controls
      if (els.previewVideo.duration) {
        const baseMs = state.isLocalMp4Mode ? 0 : state.selectionStartMs;
        state.playheadMs = baseMs + (els.previewVideo.currentTime * 1000);
        renderTimeline();
      }
    }

    els.previewVideo.addEventListener('seeked', handleVideoMediaControlSeek);
    els.previewVideo.addEventListener('seeking', handleVideoMediaControlSeek);

    els.previewVideo.addEventListener('play', () => {
      hideVideoOverlay();
    });
    els.previewVideo.addEventListener('playing', () => {
      hideVideoOverlay();
    });
    els.previewVideo.addEventListener('loadeddata', () => {
      hideVideoOverlay();
    });

    // Preview button
    if (els.btnPreviewClip) {
      els.btnPreviewClip.addEventListener('click', () => {
        loadPreviewClip(true);
      });
    }

    // Download button
    els.btnDownloadMp4.addEventListener('click', downloadMp4Clip);

    // Open Local MP4 File
    if (els.btnOpenLocalMp4 && els.inputLocalMp4) {
      els.btnOpenLocalMp4.addEventListener('click', () => {
        els.inputLocalMp4.value = '';
        els.inputLocalMp4.click();
      });
      els.inputLocalMp4.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) {
          loadLocalMp4File(file);
        }
      });
    }

    // Cached Streams Modal listeners
    if (els.btnCachedStreamsModal) {
      els.btnCachedStreamsModal.addEventListener('click', openCachedModal);
    }
    if (els.btnCloseCachedModal) {
      els.btnCloseCachedModal.addEventListener('click', closeCachedModal);
    }
    if (els.cachedStreamsModal) {
      els.cachedStreamsModal.addEventListener('click', (e) => {
        if (e.target === els.cachedStreamsModal) closeCachedModal();
      });
    }
    if (els.btnModalRefresh) {
      els.btnModalRefresh.addEventListener('click', loadStudioCachedStreams);
    }
    if (els.btnModalClearAll) {
      els.btnModalClearAll.addEventListener('click', async () => {
        if (confirm('Clear ALL cached stream videos across all streams?')) {
          els.btnModalClearAll.disabled = true;
          try {
            if (window.ClipperStorage) {
              await window.ClipperStorage.clearAll().catch(() => {});
            }
            await chrome.runtime.sendMessage({ action: 'CLEAR_ALL_CACHED_STREAMS' });
            state.stats = { count: 0, totalBytes: 0, minTime: 0, maxTime: 0, durationSec: 0 };
            state.segmentsMeta = [];
            if (els.bufferDuration) els.bufferDuration.textContent = '0s';
            if (els.bufferCount) els.bufferCount.textContent = '0';
            renderTimeline();
            updateClipStats();
            await loadStudioCachedStreams();
          } catch (e) {
            console.error('Failed to clear all:', e);
          } finally {
            els.btnModalClearAll.disabled = false;
          }
        }
      });
    }

    // Listen for live segment updates broadcasted by content script
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'clipper_segment_update') {
        // Only refresh cached streams manager modal if it is currently OPEN
        if (els.cachedStreamsModal && els.cachedStreamsModal.style.display !== 'none') {
          if (!window._lastStudioCacheRefresh || Date.now() - window._lastStudioCacheRefresh > 4000) {
            window._lastStudioCacheRefresh = Date.now();
            loadStudioCachedStreams().catch(() => {});
          }
        }
      }
    });

    // Global Studio Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
        if (e.key === 'Escape') {
          document.activeElement.blur();
        }
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        if (!els.previewVideo.src) {
          loadPreviewClip();
        } else if (els.previewVideo.paused) {
          els.previewVideo.play().catch(() => {});
        } else {
          els.previewVideo.pause();
        }
      } else if (e.key === '[') {
        e.preventDefault();
        state.selectionStartMs = Math.min(state.selectionEndMs - 2000, state.playheadMs);
        renderTimeline();
        updateClipStats();
      } else if (e.key === ']') {
        e.preventDefault();
        state.selectionEndMs = Math.max(state.selectionStartMs + 2000, state.playheadMs);
        renderTimeline();
        updateClipStats();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const delta = e.shiftKey ? 10 : 1;
        state.playheadMs = Math.max(state.stats.minTime, state.playheadMs - (delta * 1000));
        renderTimeline();
        isProgrammaticSeek = true;
        ignoreVideoSeekUntil = Date.now() + 600;
        syncVideoToPlayhead();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const delta = e.shiftKey ? 10 : 1;
        state.playheadMs = Math.min(state.stats.maxTime, state.playheadMs + (delta * 1000));
        renderTimeline();
        isProgrammaticSeek = true;
        ignoreVideoSeekUntil = Date.now() + 600;
        syncVideoToPlayhead();
      } else if (e.key === 'Escape') {
        if (els.cachedStreamsModal && els.cachedStreamsModal.style.display !== 'none') {
          closeCachedModal();
        }
      }
    });
  }

  // ── Cached Streams Modal Logic ─────────────────────────────────────────────

  async function loadStudioCachedStreams() {
    try {
      const mergedMap = new Map();

      const mergeIntoMap = (s) => {
        if (!s || !s.streamSlug) return;
        const existing = mergedMap.get(s.streamSlug);
        if (!existing) {
          mergedMap.set(s.streamSlug, { ...s });
        } else {
          mergedMap.set(s.streamSlug, {
            ...existing,
            ...s,
            count: Math.max(existing.count || 0, s.count || 0),
            totalBytes: Math.max(existing.totalBytes || 0, s.totalBytes || 0),
            durationSec: Math.max(existing.durationSec || 0, s.durationSec || 0),
            lastSavedAt: Math.max(existing.lastSavedAt || 0, s.lastSavedAt || 0),
          });
        }
      };

      const updateUI = () => {
        const streams = Array.from(mergedMap.values());
        streams.sort((a, b) => (b.lastSavedAt || b.updatedAt || 0) - (a.lastSavedAt || a.updatedAt || 0));
        const validStreams = streams.filter((s) => (s.count && s.count > 0) || (s.totalBytes && s.totalBytes > 0));
        if (els.studioCachedCount) {
          els.studioCachedCount.textContent = validStreams.length;
        }
        renderStudioCachedStreams(validStreams);
      };

      // 1. Fast path: check local extension IndexedDB directly (< 1ms from STORE_METADATA)
      if (window.ClipperStorage) {
        try {
          const localStreams = await window.ClipperStorage.getAllCachedStreams();
          if (Array.isArray(localStreams)) {
            for (const s of localStreams) mergeIntoMap(s);
          }
        } catch (_) {}
      }

      // 2. Fast path: read storage cache (~1ms)
      try {
        const storageRes = await chrome.storage.local.get(['better_idn_cached_streams']);
        const cachedMap = storageRes.better_idn_cached_streams || {};
        for (const s of Object.values(cachedMap)) mergeIntoMap(s);
      } catch (_) {}

      // Immediate render on frame 1
      updateUI();

      // 3. Request fresh list from background asynchronously to catch any active tab buffer
      chrome.runtime.sendMessage({ action: 'GET_ALL_CACHED_STREAMS' }).then((response) => {
        if (response && response.ok && Array.isArray(response.streams)) {
          for (const s of response.streams) mergeIntoMap(s);
          updateUI();
        }
      }).catch(() => {});
    } catch (_) {
      if (els.studioCachedCount) els.studioCachedCount.textContent = '0';
    }
  }

  function renderStudioCachedStreams(streams) {
    if (!els.modalStreamsList) return;

    let totalBytes = 0;
    for (const s of streams) totalBytes += s.totalBytes || 0;

    if (els.modalTotalSize) els.modalTotalSize.textContent = formatBytes(totalBytes);
    if (els.modalStreamsCount) els.modalStreamsCount.textContent = streams.length;

    if (streams.length === 0) {
      els.modalStreamsList.innerHTML = '';
      if (els.modalEmptyState) els.modalEmptyState.style.display = '';
      if (els.btnModalClearAll) els.btnModalClearAll.disabled = true;
      return;
    }

    if (els.modalEmptyState) els.modalEmptyState.style.display = 'none';
    if (els.btnModalClearAll) els.btnModalClearAll.disabled = false;

    els.modalStreamsList.innerHTML = '';

    streams.forEach((stream) => {
      const card = document.createElement('div');
      const isCurrent = stream.streamSlug === state.slug;
      card.className = 'modal-stream-card' + (isCurrent ? ' active-stream' : '');

      const title = stream.title || stream.streamSlug;
      const creator = stream.creator || (stream.creatorUsername ? '@' + stream.creatorUsername : '');
      const isEnded = stream.status === 'ended';
      const durFormatted = stream.formattedDuration || formatDuration(stream.durationSec);
      const sizeFormatted = stream.formattedSize || formatBytes(stream.totalBytes);

      card.innerHTML = `
        <div class="modal-stream-header">
          <div>
            <div class="modal-stream-title">${escapeHtml(title)}</div>
            <div class="modal-stream-creator">${escapeHtml(creator || stream.streamSlug)}</div>
          </div>
          <div class="modal-badge-group">
            ${isCurrent ? '<span class="badge-status status-active-pill">Loaded</span>' : ''}
            <span class="badge-status ${isEnded ? 'status-ended' : 'status-live'}">
              <span class="badge-dot"></span>
              <span>${isEnded ? 'Ended' : 'Live'}</span>
            </span>
          </div>
        </div>
        <div class="modal-stream-meta">
          <span class="meta-tag"><strong>Duration</strong> ${escapeHtml(durFormatted)}</span>
          <span class="meta-tag"><strong>Segments</strong> ${stream.count || 0}</span>
          <span class="meta-tag"><strong>Size</strong> ${escapeHtml(sizeFormatted)}</span>
        </div>
        <div class="modal-stream-footer">
          <span class="modal-time-ago">${formatTimeAgo(stream.lastSavedAt || stream.updatedAt)}</span>
          <div class="modal-actions">
            ${!isCurrent ? `<button class="btn btn-secondary btn-sm btn-modal-load" data-slug="${escapeHtml(stream.streamSlug)}">Load into Studio</button>` : ''}
            <button class="btn btn-ghost btn-sm btn-modal-clear" data-slug="${escapeHtml(stream.streamSlug)}" title="Delete cached segments">
              <svg class="btn-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18"></path>
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
              </svg>
              <span>Clear</span>
            </button>
          </div>
        </div>
      `;

      // Load Button
      const loadBtn = card.querySelector('.btn-modal-load');
      if (loadBtn) {
        loadBtn.addEventListener('click', () => {
          state.slug = stream.streamSlug;
          state.sourceTabId = null;
          const newUrl = new URL(window.location.href);
          newUrl.searchParams.set('slug', stream.streamSlug);
          window.history.replaceState({}, '', newUrl.toString());
          fetchStreamData();
          closeCachedModal();
          loadStudioCachedStreams();
        });
      }

      // Clear Button
      const clearBtn = card.querySelector('.btn-modal-clear');
      if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
          if (confirm(`Clear cached video segments for "${stream.title || stream.streamSlug}"?`)) {
            clearBtn.disabled = true;
            clearBtn.textContent = '⏳';
            try {
              if (window.ClipperStorage) {
                await window.ClipperStorage.clearStream(stream.streamSlug).catch(() => {});
              }
              await chrome.runtime.sendMessage({ action: 'CLEAR_CACHED_STREAM', slug: stream.streamSlug });
              if (stream.streamSlug === state.slug) {
                state.stats = { count: 0, totalBytes: 0, minTime: 0, maxTime: 0, durationSec: 0 };
                state.segmentsMeta = [];
                if (els.bufferDuration) els.bufferDuration.textContent = '0s';
                if (els.bufferCount) els.bufferCount.textContent = '0';
                renderTimeline();
                updateClipStats();
              }
              await loadStudioCachedStreams();
            } catch (err) {
              console.error('Failed to clear stream:', err);
              clearBtn.disabled = false;
              clearBtn.textContent = '🗑️ Clear';
            }
          }
        });
      }

      els.modalStreamsList.appendChild(card);
    });
  }

  function openCachedModal() {
    if (els.cachedStreamsModal) {
      els.cachedStreamsModal.style.display = 'flex';
      loadStudioCachedStreams();
    }
  }

  function closeCachedModal() {
    if (els.cachedStreamsModal) {
      els.cachedStreamsModal.style.display = 'none';
    }
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1) + ' ' + sizes[i];
  }

  function formatTimeAgo(ts) {
    if (!ts) return 'recently';
    const diffSec = Math.floor((Date.now() - ts) / 1000);
    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    initElements();
    parseQueryParams();
    initTimelineInteractions();
    initListeners();

    // Load saved buffer retention preference
    chrome.storage.local.get(['better_idn_buffer_retention']).then((res) => {
      const mins = res.better_idn_buffer_retention !== undefined ? Number(res.better_idn_buffer_retention) : 0;
      if (els.studioRetentionSelect) {
        els.studioRetentionSelect.value = String(mins);
      }
    }).catch(() => {});

    fetchStreamData();
    loadStudioCachedStreams();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
