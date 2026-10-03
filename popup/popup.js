/**
 * popup.js — Extension popup logic with Live Stream & Cached Videos Manager.
 *
 * Responsibilities:
 *  1. Query active tab for current stream state (quality, clipper, url).
 *  2. Render quality options and allow switching.
 *  3. Display and copy m3u8 URL, open in VLC.
 *  4. Manage all cached stream videos: view count, duration, size, and clear on demand.
 *  5. Allow opening Clipper Studio for any cached stream even after stream ended.
 */
(function () {
  'use strict';

  // ── DOM References ────────────────────────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);

  // Tabs & Views
  const tabBtnLive = $('#tab-btn-live');
  const tabBtnCached = $('#tab-btn-cached');
  const navCachedBadge = $('#nav-cached-badge');
  const viewLive = $('#view-live');
  const viewCached = $('#view-cached');

  // Live Stream Elements
  const statusBar = $('#status-bar');
  const statusText = $('#status-text');
  const sectionNotIdn = $('#section-not-idn');
  const btnGotoCachedFromNotLive = $('#btn-goto-cached-from-not-live');
  const notLiveCachedCount = $('#not-live-cached-count');
  const sectionStream = $('#section-stream');
  const sectionQuality = $('#section-quality');
  const sectionClipper = $('#section-clipper');
  const clipperBadge = $('#clipper-badge');
  const clipperStatsText = $('#clipper-stats-text');
  const btnOpenClipper = $('#btn-open-clipper');
  const btnClearBuffer = $('#btn-clear-buffer');
  const btnViewAllCached = $('#btn-view-all-cached');
  const inlineCachedCount = $('#inline-cached-count');
  const sectionUrl = $('#section-url');
  const qualityList = $('#quality-list');
  const m3u8Display = $('#m3u8-url-display');
  const btnCopy = $('#btn-copy');
  const btnVlc = $('#btn-vlc');
  const btnRefresh = $('#btn-refresh');

  // Cached Videos View Elements
  const summaryTotalSize = $('#summary-total-size');
  const summaryStreamsCount = $('#summary-streams-count');
  const summarySegmentsCount = $('#summary-segments-count');
  const btnClearAllCached = $('#btn-clear-all-cached');
  const btnRefreshCached = $('#btn-refresh-cached');
  const cachedStreamsList = $('#cached-streams-list');
  const cachedEmptyState = $('#cached-empty-state');

  // ── State ─────────────────────────────────────────────────────────────────

  let currentTabId = null;
  let currentState = null;
  let activeTabName = 'live';
  let cachedStreams = [];

  // ── Init ──────────────────────────────────────────────────────────────────

  async function init() {
    initTabEvents();
    initCachedViewEvents();

    // 1. Instant local render from storage cache to eliminate popup load delay
    try {
      const res = await chrome.storage.local.get(['better_idn_cached_streams']);
      const map = res.better_idn_cached_streams || {};
      cachedStreams = Object.values(map);
      cachedStreams.sort((a, b) => (b.lastSavedAt || b.updatedAt || 0) - (a.lastSavedAt || a.updatedAt || 0));
      renderCachedStreams(cachedStreams);
    } catch (_) {}

    // 2. Fetch fresh cache stats in background without blocking tab discovery
    loadCachedStreams().catch(() => {});

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || !tab.url || !tab.url.includes('idn.app')) {
        showNotIdnPage();
        return;
      }

      currentTabId = tab.id;

      // Check if we're on a live stream page (handles /live/, /[user]/live/[slug], /embed-player/)
      const isLive = isLiveUrl(tab.url);
      if (isLive) {
        await loadTabState();
        await requestStateFromContentScript();
      } else {
        showNotIdnPage();
      }
    } catch (err) {
      console.error('[IDN Live Clipper Ext Popup] Init error:', err);
      showNotIdnPage();
    }
  }

  function isLiveUrl(urlStr) {
    try {
      const parsed = new URL(urlStr);
      const path = parsed.pathname;
      return (
        path.startsWith('/live/') ||
        /^\/[^/]+\/live(\/|$)/.test(path) ||
        path.startsWith('/embed-player/') ||
        path.startsWith('/embed/')
      );
    } catch (_) {
      return urlStr.includes('/live');
    }
  }

  // ── Tab Navigation ────────────────────────────────────────────────────────

  function initTabEvents() {
    tabBtnLive.addEventListener('click', () => switchTab('live'));
    tabBtnCached.addEventListener('click', () => switchTab('cached'));

    if (btnGotoCachedFromNotLive) {
      btnGotoCachedFromNotLive.addEventListener('click', () => switchTab('cached'));
    }
    if (btnViewAllCached) {
      btnViewAllCached.addEventListener('click', () => switchTab('cached'));
    }
  }

  function switchTab(tabName) {
    activeTabName = tabName;
    if (tabName === 'live') {
      tabBtnLive.classList.add('active');
      tabBtnCached.classList.remove('active');
      viewLive.style.display = '';
      viewCached.style.display = 'none';
    } else {
      tabBtnLive.classList.remove('active');
      tabBtnCached.classList.add('active');
      viewLive.style.display = 'none';
      viewCached.style.display = '';
      loadCachedStreams();
    }
  }

  // ── Cached Streams Manager ────────────────────────────────────────────────

  function initCachedViewEvents() {
    if (btnRefreshCached) {
      btnRefreshCached.addEventListener('click', async () => {
        btnRefreshCached.style.transform = 'rotate(180deg)';
        await loadCachedStreams();
        setTimeout(() => {
          btnRefreshCached.style.transform = 'none';
        }, 300);
      });
    }

    if (btnClearAllCached) {
      btnClearAllCached.addEventListener('click', async () => {
        if (!cachedStreams || cachedStreams.length === 0) return;
        if (confirm('Clear all cached stream videos? This will free all buffered video space.')) {
          btnClearAllCached.disabled = true;
          btnClearAllCached.textContent = '⏳ Clearing...';
          try {
            await chrome.runtime.sendMessage({ action: 'CLEAR_ALL_CACHED_STREAMS' });
            // Also notify active tab if open
            if (currentTabId) {
              chrome.tabs.sendMessage(currentTabId, { action: 'CLEAR_ALL_CACHED_STREAMS' }).catch(() => {});
            }
            cachedStreams = [];
            renderCachedStreams([]);
            updateCachedBadges(0, 0, 0);
          } catch (err) {
            console.error('Failed to clear all caches:', err);
          } finally {
            btnClearAllCached.disabled = false;
            btnClearAllCached.textContent = '🗑️ Clear All';
          }
        }
      });
    }
  }

  async function loadCachedStreams() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'GET_ALL_CACHED_STREAMS' });
      if (response && response.ok && Array.isArray(response.streams)) {
        cachedStreams = response.streams;
      } else {
        // Fallback: check storage directly
        const res = await chrome.storage.local.get(['better_idn_cached_streams']);
        const map = res.better_idn_cached_streams || {};
        cachedStreams = Object.values(map);
        cachedStreams.sort((a, b) => (b.lastSavedAt || 0) - (a.lastSavedAt || 0));
      }
    } catch (_) {
      try {
        const res = await chrome.storage.local.get(['better_idn_cached_streams']);
        const map = res.better_idn_cached_streams || {};
        cachedStreams = Object.values(map);
      } catch (e) {
        cachedStreams = [];
      }
    }

    renderCachedStreams(cachedStreams);
  }

  function renderCachedStreams(streams) {
    if (!cachedStreamsList) return;

    // Filter streams with valid count or size
    const validStreams = (streams || []).filter((s) => (s.count && s.count > 0) || (s.totalBytes && s.totalBytes > 0));

    let totalBytes = 0;
    let totalSegments = 0;
    for (const s of validStreams) {
      totalBytes += s.totalBytes || 0;
      totalSegments += s.count || 0;
    }

    updateCachedBadges(validStreams.length, totalBytes, totalSegments);

    if (validStreams.length === 0) {
      cachedStreamsList.innerHTML = '';
      if (cachedEmptyState) cachedEmptyState.style.display = '';
      if (btnClearAllCached) btnClearAllCached.disabled = true;
      return;
    }

    if (cachedEmptyState) cachedEmptyState.style.display = 'none';
    if (btnClearAllCached) btnClearAllCached.disabled = false;

    cachedStreamsList.innerHTML = '';

    validStreams.forEach((stream) => {
      const card = document.createElement('div');
      card.className = 'cached-stream-card';
      card.id = `cached-card-${stream.streamSlug}`;

      const title = stream.title || stream.streamSlug;
      const creator = stream.creator || (stream.creatorUsername ? '@' + stream.creatorUsername : 'Unknown Creator');
      const isEnded = stream.status === 'ended';
      const durFormatted = stream.formattedDuration || formatDuration(stream.durationSec);
      const sizeFormatted = stream.formattedSize || formatBytes(stream.totalBytes);
      const timeAgo = formatTimeAgo(stream.lastSavedAt || stream.updatedAt);

      card.innerHTML = `
        <div class="cached-card-header">
          <div class="cached-streamer-info">
            <div class="cached-streamer-name">${escapeHtml(creator)}</div>
            <div class="cached-stream-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
          </div>
          <span class="badge-status ${isEnded ? 'status-ended' : 'status-live'}">
            <span class="badge-dot"></span>
            <span>${isEnded ? 'Ended' : 'Live'}</span>
          </span>
        </div>
        <div class="cached-meta-grid">
          <div class="cached-meta-item" title="Cached Buffer Duration">
            <span class="meta-label">Duration</span>
            <span class="meta-text">${escapeHtml(durFormatted)}</span>
          </div>
          <div class="cached-meta-item" title="Downloaded Segments">
            <span class="meta-label">Segments</span>
            <span class="meta-text">${stream.count || 0}</span>
          </div>
          <div class="cached-meta-item" title="Local Storage Size">
            <span class="meta-label">Size</span>
            <span class="meta-text">${escapeHtml(sizeFormatted)}</span>
          </div>
        </div>
        <div class="cached-card-footer">
          <span class="cached-time-ago">${escapeHtml(timeAgo)}</span>
          <div class="cached-actions">
            <button class="btn btn-secondary btn-sm btn-action-studio" data-slug="${escapeHtml(stream.streamSlug)}" title="Open Clipper Studio to preview & export clips">
              <svg class="btn-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="6" cy="6" r="3"></circle>
                <circle cx="6" cy="18" r="3"></circle>
                <line x1="20" y1="4" x2="8.12" y2="15.88"></line>
                <line x1="14.47" y1="14.48" x2="20" y2="20"></line>
              </svg>
              <span>Studio</span>
            </button>
            <button class="btn btn-ghost btn-sm btn-action-clear" data-slug="${escapeHtml(stream.streamSlug)}" title="Delete cached video segments">
              <svg class="btn-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18"></path>
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
              </svg>
              <span>Clear</span>
            </button>
          </div>
        </div>
      `;

      // Studio Button
      const studioBtn = card.querySelector('.btn-action-studio');
      studioBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'openClipperTab', slug: stream.streamSlug });
        window.close();
      });

      // Clear Button
      const clearBtn = card.querySelector('.btn-action-clear');
      clearBtn.addEventListener('click', async () => {
        if (confirm(`Clear cached video segments for "${stream.title || stream.streamSlug}"?`)) {
          clearBtn.disabled = true;
          clearBtn.textContent = '⏳';
          try {
            await chrome.runtime.sendMessage({ action: 'CLEAR_CACHED_STREAM', slug: stream.streamSlug });
            if (currentTabId) {
              chrome.tabs.sendMessage(currentTabId, { action: 'CLEAR_CACHED_STREAM', slug: stream.streamSlug }).catch(() => {});
            }

            // Remove card with animation
            card.style.opacity = '0';
            card.style.transform = 'scale(0.95)';
            card.style.transition = 'all 0.2s';
            setTimeout(() => {
              card.remove();
              cachedStreams = cachedStreams.filter((s) => s.streamSlug !== stream.streamSlug);
              renderCachedStreams(cachedStreams);
            }, 200);
          } catch (err) {
            console.error('Failed to clear stream:', err);
            clearBtn.disabled = false;
            clearBtn.textContent = '🗑️ Clear';
          }
        }
      });

      cachedStreamsList.appendChild(card);
    });
  }

  function updateCachedBadges(streamCount, totalBytes, totalSegments) {
    if (navCachedBadge) {
      if (streamCount > 0) {
        navCachedBadge.style.display = 'inline-block';
        navCachedBadge.textContent = streamCount;
      } else {
        navCachedBadge.style.display = 'none';
      }
    }
    if (inlineCachedCount) {
      inlineCachedCount.textContent = streamCount;
    }
    if (notLiveCachedCount) {
      notLiveCachedCount.textContent = streamCount;
    }
    if (summaryTotalSize) {
      summaryTotalSize.textContent = formatBytes(totalBytes);
    }
    if (summaryStreamsCount) {
      summaryStreamsCount.textContent = streamCount;
    }
    if (summarySegmentsCount) {
      summarySegmentsCount.textContent = totalSegments;
    }
  }

  // ── Load state from background ────────────────────────────────────────────

  async function loadTabState() {
    try {
      const bgState = await chrome.runtime.sendMessage({
        action: 'getTabState',
        tabId: currentTabId,
      });

      if (bgState) {
        currentState = { ...(currentState || {}), ...bgState };
        renderState();
      }
    } catch (_) {}
  }

  // ── Request fresh state from content script ──────────────────────────────

  async function requestStateFromContentScript() {
    try {
      const response = await chrome.tabs.sendMessage(currentTabId, { action: 'getState' });
      if (response) {
        currentState = { ...(currentState || {}), ...response };
        renderState();
      }
    } catch (err) {
      console.warn('[IDN Live Clipper Ext Popup] Content script not responding:', err.message);
    }

    try {
      await chrome.tabs.sendMessage(currentTabId, { action: 'getQualities' });
      await chrome.tabs.sendMessage(currentTabId, { action: 'getStreamUrl' });
    } catch (_) {}

    setTimeout(async () => {
      try {
        const response = await chrome.tabs.sendMessage(currentTabId, { action: 'getState' });
        if (response) {
          currentState = { ...(currentState || {}), ...response };
          renderState();
        }
      } catch (_) {}
    }, 400);

    setTimeout(async () => {
      try {
        const response = await chrome.tabs.sendMessage(currentTabId, { action: 'getState' });
        if (response) {
          currentState = { ...(currentState || {}), ...response };
          renderState();
        }
      } catch (_) {}
    }, 1000);
  }

  // ── Render Live Stream state ─────────────────────────────────────────────

  function renderState() {
    if (!currentState) {
      showNotIdnPage();
      return;
    }

    const hasUrl = currentState.playbackUrl || (currentState.m3u8Urls && currentState.m3u8Urls.length > 0);

    // Status bar
    if (hasUrl) {
      statusBar.className = 'status-bar status-live';
      statusText.textContent = 'Stream detected';
    } else if (currentState.hasPlayer) {
      statusBar.className = 'status-bar status-connected';
      statusText.textContent = 'Player found, waiting for stream...';
    } else {
      statusBar.className = 'status-bar status-idle';
      statusText.textContent = 'Searching for player & stream...';
    }

    // Stream info
    if (currentState.streamData) {
      sectionStream.style.display = '';
      const data = currentState.streamData;
      $('#info-creator').textContent = data.creator?.name || data.creator?.username || '—';
      $('#info-title').textContent = data.title || '—';
      $('#info-viewers').textContent = data.viewCount != null ? Number(data.viewCount).toLocaleString() : '—';
    }

    // Quality selector
    sectionQuality.style.display = '';
    if (currentState.qualities && currentState.qualities.length > 0) {
      renderQualities();
    } else if (currentState.hasPlayer) {
      qualityList.innerHTML = '<div class="quality-loading">Loading stream qualities...</div>';
    } else {
      qualityList.innerHTML = '<div class="quality-loading">Searching for player...</div>';
    }

    // Clipper section
    sectionClipper.style.display = '';
    if (currentState.clipperStats && (currentState.clipperStats.count > 0 || currentState.clipperStats.durationSec > 0)) {
      const s = currentState.clipperStats;
      const durSec = s.durationSec || 0;
      const durFormatted = durSec < 60 ? `${Math.round(durSec)}s` : `${Math.floor(durSec / 60)}m ${Math.round(durSec % 60)}s`;
      const mbFormatted = s.totalBytes ? `${(s.totalBytes / (1024 * 1024)).toFixed(1)} MB` : '0 MB';
      clipperBadge.textContent = `${durFormatted} buffered`;
      clipperStatsText.textContent = `${s.count || 0} segs (${mbFormatted})`;
    } else {
      clipperBadge.textContent = '0s buffered';
      clipperStatsText.textContent = 'Buffering segments...';
    }

    // URL section
    sectionUrl.style.display = '';
    const url = currentState.playbackUrl || (currentState.m3u8Urls && currentState.m3u8Urls[currentState.m3u8Urls.length - 1]);
    if (url) {
      const shortUrl = url.length > 120 ? url.substring(0, 60) + '...' + url.substring(url.length - 50) : url;
      m3u8Display.textContent = shortUrl;
      m3u8Display.classList.add('has-url');
      m3u8Display.title = url;
      btnCopy.disabled = false;
      btnVlc.disabled = false;
    } else {
      m3u8Display.textContent = 'No URL captured yet — play the stream to detect';
      m3u8Display.classList.remove('has-url');
      btnCopy.disabled = true;
      btnVlc.disabled = true;
    }

    sectionNotIdn.style.display = 'none';
  }

  // ── Render quality buttons ────────────────────────────────────────────────

  function renderQualities() {
    qualityList.innerHTML = '';

    const qualities = currentState.qualities || [];
    const current = currentState.currentQuality;
    const autoMode = currentState.autoMode;

    const autoBtn = document.createElement('button');
    autoBtn.className = 'quality-btn' + (autoMode ? ' active' : '');
    const currentLabel = current ? (current.height ? `${current.height}p` : current.name) : '';
    autoBtn.innerHTML = `
      <span>Auto</span>
      <span class="q-meta">${autoMode && currentLabel ? currentLabel : 'ABR'}</span>
    `;
    autoBtn.addEventListener('click', () => setAutoQuality());
    qualityList.appendChild(autoBtn);

    const sorted = [...qualities].sort((a, b) => {
      const bRank = (b.height || 0) * 1000000 + (b.bitrate || 0);
      const aRank = (a.height || 0) * 1000000 + (a.bitrate || 0);
      return bRank - aRank;
    });

    for (const q of sorted) {
      const isActive = !autoMode && (current?.name === q.name || (current?.height && current?.height === q.height));
      const btn = document.createElement('button');
      btn.className = 'quality-btn' + (isActive ? ' active' : '');

      const label = q.height ? `${q.height}p` : q.name;
      const meta = [];
      if (q.bitrate) meta.push(`${Math.round(q.bitrate / 1000)}kbps`);
      if (q.framerate) meta.push(`${q.framerate}fps`);

      btn.innerHTML = `
        <span>${label}</span>
        <span class="q-meta">${meta.join(' · ')}</span>
      `;
      btn.addEventListener('click', () => setQuality(q.name));
      qualityList.appendChild(btn);
    }
  }

  // ── Quality actions ──────────────────────────────────────────────────────

  async function setQuality(name) {
    try {
      await chrome.tabs.sendMessage(currentTabId, {
        action: 'setQuality',
        qualityName: name,
      });
      if (currentState) {
        currentState.autoMode = false;
        currentState.currentQuality = currentState.qualities.find((q) => q.name === name) || currentState.currentQuality;
        renderQualities();
      }
    } catch (err) {
      console.error('Failed to set quality:', err);
    }
  }

  async function setAutoQuality() {
    try {
      await chrome.tabs.sendMessage(currentTabId, { action: 'setAutoQuality' });
      if (currentState) {
        currentState.autoMode = true;
        renderQualities();
      }
    } catch (err) {
      console.error('Failed to set auto quality:', err);
    }
  }

  // ── Copy & VLC ───────────────────────────────────────────────────────────

  function getStreamUrl() {
    if (!currentState) return null;
    return currentState.playbackUrl || (currentState.m3u8Urls && currentState.m3u8Urls[currentState.m3u8Urls.length - 1]) || null;
  }

  btnCopy.addEventListener('click', async () => {
    const url = getStreamUrl();
    if (!url) return;

    try {
      await navigator.clipboard.writeText(url);
      btnCopy.textContent = '✅ Copied!';
      btnCopy.classList.add('copied');
      setTimeout(() => {
        btnCopy.textContent = '📋 Copy URL';
        btnCopy.classList.remove('copied');
      }, 2000);
    } catch (err) {
      console.error('Clipboard write failed:', err);
    }
  });

  btnVlc.addEventListener('click', () => {
    const url = getStreamUrl();
    if (!url) return;
    chrome.tabs.create({ url: 'vlc://' + url });
  });

  btnRefresh.addEventListener('click', async () => {
    btnRefresh.textContent = '⏳ Refreshing...';
    btnRefresh.disabled = true;

    try {
      await chrome.tabs.sendMessage(currentTabId, { action: 'getStreamUrl' });
      await chrome.tabs.sendMessage(currentTabId, { action: 'getQualities' });

      setTimeout(async () => {
        await loadTabState();
        await requestStateFromContentScript();
        btnRefresh.textContent = '🔄 Refresh Stream URL';
        btnRefresh.disabled = false;
      }, 1500);
    } catch (err) {
      btnRefresh.textContent = '🔄 Refresh Stream URL';
      btnRefresh.disabled = false;
    }
  });

  // ── Show "not on IDN" state ──────────────────────────────────────────────

  function showNotIdnPage() {
    sectionNotIdn.style.display = '';
    sectionStream.style.display = 'none';
    sectionQuality.style.display = 'none';
    sectionClipper.style.display = 'none';
    sectionUrl.style.display = 'none';
    statusBar.className = 'status-bar status-idle';
    statusText.textContent = 'Not on IDN Live';
  }

  // ── Clipper Actions ──────────────────────────────────────────────────────

  btnOpenClipper.addEventListener('click', () => {
    chrome.tabs.sendMessage(currentTabId, { action: 'openClipper' });
    window.close();
  });

  btnClearBuffer.addEventListener('click', async () => {
    if (confirm('Clear cached video buffer for current live stream?')) {
      await chrome.tabs.sendMessage(currentTabId, { action: 'clearBuffer' });
      clipperBadge.textContent = '0s buffered';
      clipperStatsText.textContent = '0 segs (0 MB)';
      await loadCachedStreams();
    }
  });

  // ── Formatting Utilities ──────────────────────────────────────────────────

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1) + ' ' + sizes[i];
  }

  function formatDuration(sec) {
    if (!sec || sec <= 0) return '0s';
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const remSec = s % 60;
    if (h > 0) return `${h}h ${m}m ${remSec}s`;
    if (m > 0) return `${m}m ${remSec}s`;
    return `${remSec}s`;
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

  // ── Listen for real-time updates from background / content ─────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (!currentState) currentState = {};

    switch (message.action) {
      case 'qualitiesAvailable':
      case 'qualityChanged': {
        currentState.hasPlayer = true;
        if (message.payload?.qualities) currentState.qualities = message.payload.qualities;
        if (message.payload?.all) currentState.qualities = message.payload.all;
        if (message.payload?.current) currentState.currentQuality = message.payload.current;
        if (message.payload?.autoMode !== undefined) currentState.autoMode = message.payload.autoMode;
        renderState();
        break;
      }

      case 'playerFound': {
        currentState.hasPlayer = true;
        renderState();
        break;
      }

      case 'playbackUrlFound':
      case 'm3u8Found': {
        const url = message.payload?.url;
        if (url) {
          if (!currentState.m3u8Urls) currentState.m3u8Urls = [];
          if (!currentState.m3u8Urls.includes(url)) currentState.m3u8Urls.push(url);
          if (!url.includes('/chunked') && !url.includes('_chunked')) {
            currentState.playbackUrl = url;
          }
        }
        renderState();
        break;
      }

      case 'streamData': {
        currentState.streamData = message.payload;
        if (message.payload?.playbackUrl) {
          currentState.playbackUrl = message.payload.playbackUrl;
        }
        renderState();
        loadCachedStreams();
        break;
      }

      case 'clipperStats': {
        currentState.clipperStats = message.payload;
        renderState();
        break;
      }

      case 'clipper_segment_update': {
        // Throttle cache refresh during live streaming to at most once every 5 seconds
        if (!window._lastCacheRefresh || Date.now() - window._lastCacheRefresh > 5000) {
          window._lastCacheRefresh = Date.now();
          loadCachedStreams().catch(() => {});
        }
        break;
      }
    }
  });

  // ── Start ────────────────────────────────────────────────────────────────

  init();
})();
