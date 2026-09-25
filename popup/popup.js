/**
 * TurboSpeed Downloader - Popup Script
 * Real-time direct browser downloads monitoring, multi-threaded engine sync,
 * high-resolution speed measurement, and dynamic pipeline telemetry.
 */

let currentSettings = {
  turboEnabled: true,
  autoIntercept: true,
  threads: 8
};

let activeDownloadsMap = new Map();
let nativeSpeedTracker = new Map(); // id -> { lastBytes, lastTime, speed }

// Format Helpers
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return { val: '0.0', unit: 'MB/s' };
  if (bytesPerSec >= 1024 * 1024) {
    return { val: (bytesPerSec / (1024 * 1024)).toFixed(1), unit: 'MB/s' };
  }
  if (bytesPerSec >= 1024) {
    return { val: (bytesPerSec / 1024).toFixed(1), unit: 'KB/s' };
  }
  return { val: Math.round(bytesPerSec).toString(), unit: 'B/s' };
}

function formatSeconds(sec) {
  if (!sec || sec <= 0) return '--';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

// DOM Elements
const turboToggle = document.getElementById('turboToggle');
const turboDot = document.getElementById('turboDot');
const turboStatusText = document.getElementById('turboStatusText');
const turboSubtext = document.getElementById('turboSubtext');
const currentSpeedVal = document.getElementById('currentSpeedVal');
const currentSpeedUnit = document.getElementById('currentSpeedUnit');
const boostMultiplierBadge = document.getElementById('boostMultiplierBadge');
const boostMultiplierText = document.getElementById('boostMultiplierText');
const activeThreadsMeta = document.getElementById('activeThreadsMeta');
const responseLatencyMeta = document.getElementById('responseLatencyMeta');
const downloadsList = document.getElementById('downloadsList');
const emptyState = document.getElementById('emptyState');
const activeCountBadge = document.getElementById('activeCountBadge');
const threadPills = document.getElementById('threadPills');
const btnManager = document.getElementById('btnManager');

// Initialize
async function initPopup() {
  await loadSettings();
  setupEventListeners();
  setupChromeDownloadListeners();
  setupUniversalVideoDetector();

  // Initial immediate sync
  await syncAllDownloads();

  // High-frequency 300ms poll for real-time speed smoothness
  setInterval(syncAllDownloads, 300);
}

// ============================================================
// Universal Video & Media Stream Detector Panel
// ============================================================

let detectedVideoData = null;

async function setupUniversalVideoDetector() {
  const ytCard = document.getElementById('ytDownloadCard');
  const cardLabel = document.getElementById('videoCardLabel');
  const cardTitle = document.getElementById('ytVideoTitle');
  const btnDl1 = document.getElementById('ytDlMp4');
  const btnDl1Text = document.getElementById('ytDlMp4Text');
  const btnDl2 = document.getElementById('ytDlMp3');
  const btnDl2Text = document.getElementById('ytDlMp3Text');
  const dlBadge = document.getElementById('ytDlBadge');
  if (!ytCard || !cardTitle || !btnDl1 || !btnDl2) return;

  if (typeof chrome === 'undefined' || !chrome.tabs?.query) return;

  let tab;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs?.[0];
  } catch (e) { return; }

  if (!tab?.id || !tab?.url) return;

  // 1. Query the content script for any detected video on this page
  let pageVideo = null;
  try {
    pageVideo = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'QUERY_PAGE_VIDEO' }, (response) => {
        if (chrome.runtime.lastError || !response) resolve(null);
        else resolve(response);
      });
    });
  } catch (e) {}

  // 2. Fallback to background tabLastMedia if content script didn't return
  if (!pageVideo?.url) {
    try {
      const bgRes = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_TAB_MEDIA', payload: { tabId: tab.id } }, (res) => {
          if (chrome.runtime.lastError || !res) resolve(null);
          else resolve(res.media);
        });
      });
      if (bgRes?.url) pageVideo = bgRes;
    } catch (e) {}
  }

  // 3. Fallback: check if tab URL itself is YouTube
  const isYt = tab.url.includes('youtube.com/watch') ||
               tab.url.includes('youtube.com/shorts/') ||
               tab.url.includes('youtu.be/');

  if (!pageVideo?.url && isYt) {
    let vid = null;
    try {
      const u = new URL(tab.url);
      if (u.hostname.includes('youtu.be')) vid = u.pathname.slice(1).split('/')[0].split('?')[0];
      else if (u.pathname.includes('/shorts/')) vid = u.pathname.split('/shorts/')[1].split('/')[0].split('?')[0];
      else vid = u.searchParams.get('v');
    } catch (e) {}
    if (vid) {
      pageVideo = {
        isYouTube: true,
        videoId: vid,
        title: (tab.title || 'YouTube Video').replace(/- YouTube$/i, '').trim(),
        url: tab.url
      };
    }
  }

  if (!pageVideo || !pageVideo.url) {
    ytCard.style.display = 'none';
    return;
  }

  detectedVideoData = pageVideo;
  const isYouTube = Boolean(pageVideo.isYouTube);
  const title = (pageVideo.title || tab.title || 'Video Stream').replace(/- YouTube$/i, '').trim();

  cardTitle.textContent = title;
  cardTitle.title = title;

  if (isYouTube) {
    if (cardLabel) cardLabel.textContent = '🎬 YouTube Video Detected';
    if (btnDl1Text) btnDl1Text.textContent = '⚡ Turbo Download MP4';
    if (dlBadge) dlBadge.textContent = '1080p';
    if (btnDl2Text) btnDl2Text.textContent = '🎵 Extract MP3 Audio';
  } else {
    if (cardLabel) cardLabel.textContent = '🎬 Video Stream Detected (16x Boost Ready)';
    if (btnDl1Text) btnDl1Text.textContent = '⚡ Turbo Boost Download (16x Max)';
    if (dlBadge) dlBadge.textContent = 'HD';
    if (btnDl2Text) btnDl2Text.textContent = '📋 Copy Direct Stream URL';
  }

  ytCard.style.display = 'block';

  // Primary Download Button (16x Turbo Download)
  btnDl1.onclick = () => {
    btnDl1.classList.add('loading');
    if (isYouTube && pageVideo.videoId) {
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_YOUTUBE_MEDIA',
        payload: { videoId: pageVideo.videoId, title, format: 'mp4' }
      }).catch(() => {});
    } else if (pageVideo.url) {
      const filename = pageVideo.filename || (title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 50) + '.mp4');
      chrome.runtime.sendMessage({
        type: 'TRIGGER_TURBO_DOWNLOAD',
        payload: {
          url: pageVideo.url,
          filename: filename,
          threads: Math.max(16, currentSettings.threads || 16)
        }
      }).catch(() => {});
    }
    setTimeout(() => btnDl1.classList.remove('loading'), 2000);
  };

  // Secondary Button (Audio extract or copy stream URL)
  btnDl2.onclick = () => {
    btnDl2.classList.add('loading');
    if (isYouTube && pageVideo.videoId) {
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_YOUTUBE_MEDIA',
        payload: { videoId: pageVideo.videoId, title, format: 'mp3' }
      }).catch(() => {});
    } else if (pageVideo.url) {
      navigator.clipboard?.writeText(pageVideo.url);
      const originalText = btnDl2Text ? btnDl2Text.textContent : '';
      if (btnDl2Text) btnDl2Text.textContent = '✓ Stream URL Copied!';
      setTimeout(() => { if (btnDl2Text) btnDl2Text.textContent = originalText; }, 2000);
    }
    setTimeout(() => btnDl2.classList.remove('loading'), 1000);
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPopup);
} else {
  initPopup();
}

async function loadSettings() {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      if (settings) {
        currentSettings = { ...currentSettings, ...settings };
      }
    } catch (e) {
      console.warn('Storage get error:', e);
    }
  }

  // Update Toggle
  turboToggle.checked = currentSettings.turboEnabled;
  updateTurboDisplay(currentSettings.turboEnabled);

  // Update Threads Pill
  updateThreadsPill(currentSettings.threads);
}

function updateTurboDisplay(enabled) {
  if (enabled) {
    turboDot.style.backgroundColor = 'var(--green-neon)';
    turboDot.style.boxShadow = '0 0 8px rgba(16, 185, 129, 0.6)';
    turboStatusText.textContent = 'AUTOMATIC TURBO BOOST';
    turboSubtext.textContent = `Pipelined byte-range multithreading (${currentSettings.threads}x)`;
  } else {
    turboDot.style.backgroundColor = 'var(--pink-neon)';
    turboDot.style.boxShadow = '0 0 6px rgba(244, 63, 94, 0.4)';
    turboStatusText.textContent = 'TURBO BOOST PAUSED';
    turboSubtext.textContent = 'Standard single-stream browser downloads';
  }
}

function updateThreadsPill(threads) {
  const targetThreads = threads || 16;
  const pills = threadPills.querySelectorAll('.pill-btn');
  let matched = false;
  pills.forEach(btn => {
    if (parseInt(btn.dataset.threads, 10) === targetThreads) {
      btn.classList.add('active');
      matched = true;
    } else {
      btn.classList.remove('active');
    }
  });
  if (!matched && pills.length > 0) {
    const p16 = Array.from(pills).find(p => p.dataset.threads === '16');
    if (p16) p16.classList.add('active');
  }
  activeThreadsMeta.textContent = `${targetThreads} Turbo Threads`;
}

function setupEventListeners() {
  // Turbo Master Toggle
  turboToggle.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    currentSettings.turboEnabled = enabled;
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const data = await chrome.storage.local.get('settings').catch(() => ({}));
      await chrome.storage.local.set({
        settings: { ...(data.settings || {}), turboEnabled: enabled }
      });
    }
    updateTurboDisplay(enabled);
  });

  // Thread Pills Selection
  threadPills.addEventListener('click', async (e) => {
    const btn = e.target.closest('.pill-btn');
    if (!btn) return;
    const threads = parseInt(btn.dataset.threads, 10);
    currentSettings.threads = threads;

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const data = await chrome.storage.local.get('settings').catch(() => ({}));
      await chrome.storage.local.set({
        settings: { ...(data.settings || {}), threads }
      });
    }
    updateThreadsPill(threads);
    updateTurboDisplay(currentSettings.turboEnabled);
  });

  // Open Manager directly to Settings & Rules
  const openManager = () => {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html#settings') });
      window.close();
    } else if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
      window.close();
    } else {
      window.open('../manager/manager.html#settings', '_blank');
    }
  };
  if (btnManager) btnManager.addEventListener('click', openManager);

  // Runtime message listener for real-time telemetry from Service Worker / Offscreen
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      const { type, payload } = message || {};

      if (type === 'DOWNLOAD_PROGRESS' && payload?.id) {
        activeDownloadsMap.set(payload.id, payload);
        renderDownloadItem(payload);
        updateAggregateSpeedometer();
      } else if (type === 'DOWNLOAD_COMPLETE' && payload?.id) {
        activeDownloadsMap.delete(payload.id);
        removeDownloadItem(payload.id);
        updateAggregateSpeedometer();
      } else if (type === 'DOWNLOAD_STATUS_CHANGED' && payload?.id) {
        const item = activeDownloadsMap.get(payload.id);
        if (item) {
          item.status = payload.status;
          activeDownloadsMap.set(payload.id, item);
          renderDownloadItem(item);
        }
      } else if (type === 'SETTINGS_RESET' && payload) {
        currentSettings = { ...currentSettings, ...payload };
        if (turboToggle) turboToggle.checked = currentSettings.turboEnabled;
        updateTurboDisplay(currentSettings.turboEnabled);
        updateThreadsPill(currentSettings.threads);
      } else if (type === 'QUEUE_STATUS_UPDATE' && payload) {
        // MaxiMux: show queue full status in speedometer
        const { active = 0, maxConcurrent = 4 } = payload;
        updatePopupMaxiMuxStatus(active, maxConcurrent);
      }
    });
  }

  // Real-time synchronization when settings are updated or reset in Manager
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.settings?.newValue) {
        currentSettings = { ...currentSettings, ...changes.settings.newValue };
        if (turboToggle) turboToggle.checked = currentSettings.turboEnabled;
        updateTurboDisplay(currentSettings.turboEnabled);
        updateThreadsPill(currentSettings.threads);
      }
    });
  }
}

function setupChromeDownloadListeners() {
  if (typeof chrome === 'undefined' || !chrome.downloads) return;

  chrome.downloads.onCreated.addListener((item) => {
    syncAllDownloads();
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
      const key = 'browser_' + delta.id;
      activeDownloadsMap.delete(key);
      nativeSpeedTracker.delete(delta.id);
      removeDownloadItem(key);
      updateAggregateSpeedometer();
    } else {
      syncAllDownloads();
    }
  });

  chrome.downloads.onErased.addListener((downloadId) => {
    const key = 'browser_' + downloadId;
    activeDownloadsMap.delete(key);
    nativeSpeedTracker.delete(downloadId);
    removeDownloadItem(key);
    updateAggregateSpeedometer();
  });
}

/**
 * Unified download synchronization:
 * Inspects both native Chrome downloads and Turbo Chunk Engine instances.
 */
async function syncAllDownloads() {
  const mergedDownloads = new Map();
  const now = performance.now();

  // 1. Standalone demo preview fallback only if completely outside Chrome extension context
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
    simulateDemoTick();
    return;
  }

  // 2. Direct native browser downloads query
  if (typeof chrome !== 'undefined' && chrome.downloads?.search) {
    try {
      const items = await chrome.downloads.search({ state: 'in_progress' });
      const currentNativeIds = new Set();

      for (const item of items) {
        currentNativeIds.add(item.id);
        if (item.url && item.url.startsWith('blob:') && activeDownloadsMap.has('browser_' + item.id)) {
          continue;
        }

        let tracker = nativeSpeedTracker.get(item.id);
        if (!tracker || !Array.isArray(tracker.samples)) {
          tracker = {
            samples: [{ time: now, bytes: item.bytesReceived || 0 }],
            speed: 0
          };
          nativeSpeedTracker.set(item.id, tracker);
        } else {
          tracker.samples.push({ time: now, bytes: item.bytesReceived || 0 });
          // Retain samples within a 1.4-second rolling window to absorb bursty network I/O
          while (tracker.samples.length > 2 && (now - tracker.samples[0].time) > 1400) {
            tracker.samples.shift();
          }

          const oldest = tracker.samples[0];
          const timeSpan = (now - oldest.time) / 1000;
          const bytesSpan = Math.max(0, (item.bytesReceived || 0) - oldest.bytes);

          if (item.paused) {
            tracker.speed = 0;
          } else if (timeSpan >= 0.25) {
            const measured = bytesSpan / timeSpan;
            if (tracker.speed === 0) {
              tracker.speed = measured;
            } else if (bytesSpan > 0) {
              // Stable Exponential Moving Average over the rolling window
              tracker.speed = 0.35 * measured + 0.65 * tracker.speed;
            } else if ((now - oldest.time) > 1600) {
              // Only gently taper if zero bytes arrived for over 1.6 seconds
              tracker.speed = tracker.speed * 0.85;
              if (tracker.speed < 1024) tracker.speed = 0;
            }
          }
          nativeSpeedTracker.set(item.id, tracker);
        }

        let speed = tracker.speed;
        const totalBytes = item.totalBytes > 0 ? item.totalBytes : (item.bytesReceived || 0);
        const downloadedBytes = item.bytesReceived || 0;
        const percent = totalBytes > 0 ? Math.min(100, (downloadedBytes / totalBytes) * 100) : 0;
        const remaining = Math.max(0, totalBytes - downloadedBytes);
        const etaSeconds = speed > 0 ? Math.ceil(remaining / speed) : 0;

        let filename = 'Downloading file...';
        if (item.filename) {
          filename = item.filename.split(/[\\/]/).pop();
        } else if (item.url) {
          try {
            const parsed = new URL(item.url);
            const pathName = parsed.pathname;
            filename = decodeURIComponent(pathName.substring(pathName.lastIndexOf('/') + 1)) || 'download';
          } catch {
            filename = 'download';
          }
        }

        // Parallel visual channel chunk representation
        const threadCount = currentSettings.threads || 8;
        const chunkSize = totalBytes > 0 ? Math.floor(totalBytes / threadCount) : 0;
        const chunks = [];
        for (let i = 0; i < threadCount; i++) {
          const chunkDone = totalBytes > 0 ? Math.min(chunkSize, Math.max(0, downloadedBytes - (i * chunkSize))) : 0;
          const chunkPct = chunkSize > 0 ? Math.min(100, (chunkDone / chunkSize) * 100) : percent;
          chunks.push({
            id: i,
            total: chunkSize,
            downloaded: chunkDone,
            percent: chunkPct,
            status: item.paused ? 'paused' : 'downloading'
          });
        }

        const key = 'browser_' + item.id;
        mergedDownloads.set(key, {
          id: key,
          nativeId: item.id,
          url: item.url,
          filename: filename,
          status: item.paused ? 'paused' : 'downloading',
          totalBytes: totalBytes,
          downloadedBytes: downloadedBytes,
          percent: percent,
          speed: speed,
          etaSeconds: etaSeconds,
          latencyMs: 12,
          isNative: true,
          chunks: chunks
        });
      }

      // Cleanup finished native trackers
      for (const id of nativeSpeedTracker.keys()) {
        if (!currentNativeIds.has(id)) {
          nativeSpeedTracker.delete(id);
        }
      }
    } catch (e) {
      console.warn('Native download search error:', e);
    }
  }

  // 3. Query Turbo Engine downloads / Service Worker synced telemetry
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
          if (chrome.runtime.lastError || !response) resolve(null);
          else resolve(response);
        });
      });

      if (res && Array.isArray(res.active)) {
        res.active.forEach(item => {
          if (item.id) {
            const existing = mergedDownloads.get(item.id);
            if (existing) {
              // If local speed tracker hasn't caught up yet, adopt the background service worker's speed
              if (existing.speed === 0 && item.speed > 0) {
                existing.speed = item.speed;
                const tr = nativeSpeedTracker.get(existing.nativeId);
                if (tr) tr.speed = item.speed;
              }
            } else {
              mergedDownloads.set(item.id, item);
            }
          }
        });
      }
    } catch (e) {}
  }

  // Reconcile merged items into active map
  const activeKeys = new Set(mergedDownloads.keys());
  for (const id of activeDownloadsMap.keys()) {
    if (!activeKeys.has(id)) {
      activeDownloadsMap.delete(id);
      removeDownloadItem(id);
    }
  }

  for (const [id, item] of mergedDownloads) {
    activeDownloadsMap.set(id, item);
    renderDownloadItem(item);
  }

  updateAggregateSpeedometer();
}

let demoState = {
  total: 52428800, // 50MB
  downloaded: 15728640,
  speed: 18454937,
  lastTick: performance.now()
};

function simulateDemoTick() {
  const now = performance.now();
  const elapsedSec = (now - demoState.lastTick) / 1000;
  demoState.lastTick = now;

  // Fluctuate speed naturally between 14MB/s and 24MB/s
  const speedNoise = (Math.sin(now / 500) * 0.2 + (Math.random() - 0.5) * 0.1);
  demoState.speed = Math.max(8 * 1024 * 1024, 18 * 1024 * 1024 * (1 + speedNoise));

  demoState.downloaded = Math.min(demoState.total, demoState.downloaded + demoState.speed * elapsedSec);
  if (demoState.downloaded >= demoState.total) {
    demoState.downloaded = 0; // loop demo
  }

  const percent = (demoState.downloaded / demoState.total) * 100;
  const remaining = demoState.total - demoState.downloaded;
  const eta = demoState.speed > 0 ? Math.ceil(remaining / demoState.speed) : 0;

  const demoItem = {
    id: 'demo_file_preview',
    url: 'https://releases.ubuntu.com/24.04/ubuntu-desktop.iso',
    filename: 'ubuntu-desktop-amd64.iso',
    status: 'downloading',
    totalBytes: demoState.total,
    downloadedBytes: Math.floor(demoState.downloaded),
    percent: percent,
    speed: demoState.speed,
    etaSeconds: eta,
    latencyMs: 11,
    chunks: Array.from({ length: 8 }).map((_, i) => {
      const cSize = demoState.total / 8;
      const cDone = Math.min(cSize, Math.max(0, demoState.downloaded - (i * cSize)));
      return {
        id: i,
        total: cSize,
        downloaded: cDone,
        percent: Math.min(100, (cDone / cSize) * 100)
      };
    })
  };

  activeDownloadsMap.set(demoItem.id, demoItem);
  renderDownloadItem(demoItem);
  updateAggregateSpeedometer();
}

/**
 * MaxiMux: Update popup status badge when queue is full or slots are active.
 */
function updatePopupMaxiMuxStatus(active, maxConcurrent) {
  if (!boostMultiplierBadge || !boostMultiplierText) return;
  if (active >= maxConcurrent) {
    boostMultiplierText.textContent = `🔒 MAXIMUX FULL (${active}/${maxConcurrent})`;
    boostMultiplierBadge.style.color = '#f43f5e';
    boostMultiplierBadge.style.backgroundColor = 'rgba(244, 63, 94, 0.08)';
    boostMultiplierBadge.style.borderColor = 'rgba(244, 63, 94, 0.2)';
  } else if (active > 1) {
    const baseThreads = currentSettings.threads || 8;
    const perDl = Math.max(2, Math.floor(baseThreads / active));
    boostMultiplierText.textContent = `MAXIMUX ${active}/${maxConcurrent} · ${perDl}T EACH`;
    boostMultiplierBadge.style.color = 'var(--brand-primary)';
    boostMultiplierBadge.style.backgroundColor = 'rgba(99, 102, 241, 0.08)';
    boostMultiplierBadge.style.borderColor = 'rgba(99, 102, 241, 0.2)';
  }
}

function updateAggregateSpeedometer() {
  const items = Array.from(activeDownloadsMap.values());
  const count = items.length;

  activeCountBadge.textContent = `${count} Active`;

  if (count === 0) {
    emptyState.style.display = 'flex';
    currentSpeedVal.textContent = '0.0';
    currentSpeedUnit.textContent = 'MB/s';
    boostMultiplierText.textContent = 'TURBO READY';
    boostMultiplierBadge.style.color = 'var(--brand-primary)';
    boostMultiplierBadge.style.backgroundColor = 'rgba(99, 102, 241, 0.08)';
    boostMultiplierBadge.style.borderColor = 'rgba(99, 102, 241, 0.2)';
    if (responseLatencyMeta) responseLatencyMeta.textContent = '0ms Fast Path';
    return;
  }

  emptyState.style.display = 'none';

  let totalSpeed = 0;
  let maxLatency = 0;
  items.forEach(d => {
    if (d.speed) totalSpeed += d.speed;
    if (d.latencyMs && d.latencyMs > maxLatency) maxLatency = d.latencyMs;
  });

  if (responseLatencyMeta) {
    responseLatencyMeta.textContent = maxLatency > 0 ? `${maxLatency}ms Latency` : 'Ultra-Fast Socket';
  }

  const formatted = formatSpeed(totalSpeed);
  currentSpeedVal.textContent = formatted.val;
  currentSpeedUnit.textContent = formatted.unit;

  if (totalSpeed > 1024 * 1024 * 5) {
    boostMultiplierText.textContent = `🚀 EXTREME SPEED (+500%)`;
    boostMultiplierBadge.style.color = '#059669';
    boostMultiplierBadge.style.backgroundColor = 'rgba(16, 185, 129, 0.1)';
    boostMultiplierBadge.style.borderColor = 'rgba(16, 185, 129, 0.25)';
  } else if (totalSpeed > 0) {
    boostMultiplierText.textContent = `TURBO PIPELINED (${currentSettings.threads}X)`;
    boostMultiplierBadge.style.color = 'var(--brand-primary)';
    boostMultiplierBadge.style.backgroundColor = 'rgba(99, 102, 241, 0.08)';
    boostMultiplierBadge.style.borderColor = 'rgba(99, 102, 241, 0.2)';
  } else {
    boostMultiplierText.textContent = `ACCELERATING...`;
    boostMultiplierBadge.style.color = '#d97706';
    boostMultiplierBadge.style.backgroundColor = 'rgba(245, 158, 11, 0.1)';
    boostMultiplierBadge.style.borderColor = 'rgba(245, 158, 11, 0.25)';
  }
}

function renderDownloadItem(item) {
  let el = document.getElementById(`dl_${item.id}`);

  const percent = item.percent !== undefined ? item.percent.toFixed(1) : '0.0';
  const speedObj = formatSpeed(item.speed);
  const eta = formatSeconds(item.etaSeconds);
  const downloadedStr = formatBytes(item.downloadedBytes);
  const totalStr = formatBytes(item.totalBytes);
  const latencyStr = item.latencyMs ? `${item.latencyMs}ms • ` : '';

  if (!el) {
    el = document.createElement('div');
    el.id = `dl_${item.id}`;
    el.className = 'download-card';
    downloadsList.appendChild(el);

    let chunkStripsHtml = '';
    if (item.chunks && item.chunks.length > 0) {
      chunkStripsHtml = `
        <div class="threads-visualizer">
          <div class="threads-label">
            <span>PARALLEL PIPELINE (${item.chunks.length} THREADS)</span>
            <span class="pipeline-percent">${percent}%</span>
          </div>
          <div class="thread-strips">
            ${item.chunks.map(chunk => `
              <div class="thread-strip" title="Thread ${chunk.id + 1}">
                <div class="thread-strip-fill" style="width: ${chunk.percent || 0}%"></div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    el.innerHTML = `
      <div class="card-top">
        <div class="file-info">
          <div class="file-icon">
            <svg viewBox="0 0 24 24">
              <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/>
            </svg>
          </div>
          <div class="file-details">
            <div class="file-name" title="${item.filename}">${item.filename}</div>
            <div class="file-meta">
              ${downloadedStr} / ${totalStr} • ${latencyStr}${speedObj.val} ${speedObj.unit} • ETA: ${eta}
            </div>
          </div>
        </div>
        <div class="card-actions">
          ${item.status === 'downloading' ? `
            <button class="mini-action-btn pause" title="Pause" data-id="${item.id}">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
              </svg>
            </button>
          ` : `
            <button class="mini-action-btn resume" title="Resume" data-id="${item.id}">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </button>
          `}
          <button class="mini-action-btn cancel" title="Cancel" data-id="${item.id}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="progress-bar-container">
        <div class="progress-bar-fill" style="width: ${percent}%"></div>
      </div>

      ${chunkStripsHtml}
    `;

    attachCardHandlers(el, item);
  } else {
    // In-place updates to avoid DOM recreation
    const nameEl = el.querySelector('.file-name');
    if (nameEl && nameEl.textContent !== item.filename) {
      nameEl.textContent = item.filename;
      nameEl.title = item.filename;
    }

    const metaEl = el.querySelector('.file-meta');
    if (metaEl) {
      metaEl.textContent = `${downloadedStr} / ${totalStr} • ${latencyStr}${speedObj.val} ${speedObj.unit} • ETA: ${eta}`;
    }

    const progressFill = el.querySelector('.progress-bar-fill');
    if (progressFill) {
      progressFill.style.width = `${percent}%`;
    }

    const pipePercent = el.querySelector('.pipeline-percent');
    if (pipePercent) {
      pipePercent.textContent = `${percent}%`;
    }

    const threadFills = el.querySelectorAll('.thread-strip-fill');
    if (item.chunks && threadFills.length === item.chunks.length) {
      item.chunks.forEach((chunk, i) => {
        threadFills[i].style.width = `${chunk.percent || 0}%`;
      });
    }

    // Update pause/resume button if state changed
    const pauseBtn = el.querySelector('.mini-action-btn.pause');
    const resumeBtn = el.querySelector('.mini-action-btn.resume');
    if (item.status === 'paused' && pauseBtn) {
      pauseBtn.className = 'mini-action-btn resume';
      pauseBtn.title = 'Resume';
      pauseBtn.innerHTML = `
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z"/>
        </svg>
      `;
    } else if (item.status === 'downloading' && resumeBtn) {
      resumeBtn.className = 'mini-action-btn pause';
      resumeBtn.title = 'Pause';
      resumeBtn.innerHTML = `
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
        </svg>
      `;
    }
  }
}

function attachCardHandlers(el, item) {
  el.addEventListener('click', (e) => {
    const currentItem = activeDownloadsMap.get(item.id) || item;
    const nativeId = currentItem.nativeId || (currentItem.id && currentItem.id.startsWith('browser_') ? parseInt(currentItem.id.replace('browser_', ''), 10) : null);

    const pauseBtn = e.target.closest('.mini-action-btn.pause');
    if (pauseBtn) {
      if (nativeId && typeof chrome !== 'undefined' && chrome.downloads?.pause) {
        chrome.downloads.pause(nativeId);
      } else {
        chrome.runtime.sendMessage({
          type: 'PAUSE_TURBO_DOWNLOAD',
          payload: { id: currentItem.id }
        }).catch(() => {});
      }
      return;
    }

    const resumeBtn = e.target.closest('.mini-action-btn.resume');
    if (resumeBtn) {
      if (nativeId && typeof chrome !== 'undefined' && chrome.downloads?.resume) {
        chrome.downloads.resume(nativeId);
      } else {
        chrome.runtime.sendMessage({
          type: 'RESUME_TURBO_DOWNLOAD',
          payload: { id: currentItem.id }
        }).catch(() => {});
      }
      return;
    }

    const cancelBtn = e.target.closest('.mini-action-btn.cancel');
    if (cancelBtn) {
      if (nativeId && typeof chrome !== 'undefined' && chrome.downloads?.cancel) {
        chrome.downloads.cancel(nativeId);
      } else {
        chrome.runtime.sendMessage({
          type: 'CANCEL_TURBO_DOWNLOAD',
          payload: { id: currentItem.id }
        }).catch(() => {});
      }
      activeDownloadsMap.delete(currentItem.id);
      removeDownloadItem(currentItem.id);
      updateAggregateSpeedometer();
      return;
    }
  });
}

function removeDownloadItem(id) {
  const el = document.getElementById(`dl_${id}`);
  if (el) {
    el.remove();
  }
  if (activeDownloadsMap.size === 0) {
    emptyState.style.display = 'flex';
  }
}
