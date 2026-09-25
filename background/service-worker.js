/**
 * TurboSpeed Downloader - Service Worker (MV3)
 * Manages auto-interception, offscreen engine lifecycle,
 * CORS bypass rules, state persistence, and native downloads coordination.
 */

const DEFAULT_SETTINGS = {
  turboEnabled: true,
  autoIntercept: true,
  videoRightClick: true,
  threads: 16,
  minSizeMB: 1, // Intercept downloads larger than 1MB
  soundNotifications: true,
  maxConcurrentDownloads: 4, // MaxiMux: max simultaneous downloads
  autoRebuild: true // Auto-rebuild failed downloads
};

let interceptedUrls = new Set();
const extensionInitiatedNativeIds = new Set();
let localActiveDownloads = new Map();
let tabLastMedia = new Map(); // tabId -> { url, filename, title, time }
let offscreenReady = false;
const blobUrlsToRevoke = new Map(); // downloadItemId -> blobUrl

// ============================================================
// MaxiMux Download Queue System
// ============================================================
const MAX_CONCURRENT_DOWNLOADS = 4;
const downloadQueue = []; // Pending downloads waiting for a slot
const rebuildAttempts = new Map(); // downloadId -> retryCount
const MAX_REBUILD_ATTEMPTS = 3;

/**
 * Returns count of active (non-completed, non-error, non-cancelled) Turbo downloads.
 */
function getActiveTurboCount() {
  let count = 0;
  for (const dl of localActiveDownloads.values()) {
    if (!dl.isNative && dl.status !== 'completed' && dl.status !== 'error' && dl.status !== 'cancelled') {
      count++;
    }
  }
  return count;
}

/**
 * Computes threads per download.
 * Ensures every download maintains its full thread allocation so sequential
 * and concurrent downloads never suffer from artificial bandwidth throttling.
 */
function computeDynamicThreads(baseThreads) {
  return Math.max(8, baseThreads || 8);
}

/**
 * Broadcast queue/concurrent status to all open manager/popup pages.
 */
function broadcastQueueStatus() {
  const activeTurboCount = getActiveTurboCount();
  chrome.runtime.sendMessage({
    type: 'QUEUE_STATUS_UPDATE',
    payload: {
      active: activeTurboCount,
      queued: downloadQueue.length,
      maxConcurrent: MAX_CONCURRENT_DOWNLOADS
    }
  }).catch(() => {});
}

/**
 * Process the next item from the download queue if a slot is available.
 */
async function processDownloadQueue() {
  while (downloadQueue.length > 0 && getActiveTurboCount() < MAX_CONCURRENT_DOWNLOADS) {
    const next = downloadQueue.shift();
    if (!next) break;
    console.log('[TurboServiceWorker] MaxiMux: Processing queued download:', next.url);
    await _startTurboDownloadInternal(next.url, next.filename, next.threads, next.options);
  }
  broadcastQueueStatus();
}

/**
 * Schedule auto-rebuild of a failed download with exponential backoff.
 */
function scheduleRebuild(url, filename, threads, options = {}) {
  const rebuildKey = url + '_' + (filename || '');
  const attempts = rebuildAttempts.get(rebuildKey) || 0;
  if (attempts >= MAX_REBUILD_ATTEMPTS) {
    console.warn('[TurboServiceWorker] MaxiMux: Max rebuild attempts reached for:', url);
    rebuildAttempts.delete(rebuildKey);
    return;
  }
  rebuildAttempts.set(rebuildKey, attempts + 1);
  const delay = 1500 * Math.pow(1.5, attempts); // 1.5s, 2.25s, 3.375s
  console.log(`[TurboServiceWorker] MaxiMux: Scheduling rebuild attempt ${attempts + 1} for: ${url} in ${Math.round(delay)}ms`);
  setTimeout(async () => {
    try {
      await triggerTurboDownload(url, filename, threads, { ...options, isRebuild: true });
    } catch (e) {
      console.warn('[TurboServiceWorker] MaxiMux: Rebuild failed:', e.message);
    }
  }, delay);
}

// Initialize settings, CORS bypass rules, and context menus on install / start
chrome.runtime.onInstalled.addListener(async () => {
  await setupInitialConfig();
});

chrome.runtime.onStartup.addListener(async () => {
  await setupInitialConfig();
});

// Clean up tab tracking when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLastMedia.delete(tabId);
});

async function setupInitialConfig() {
  const data = await chrome.storage.local.get(['settings', 'history']);
  if (!data.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  if (!data.history) {
    await chrome.storage.local.set({ history: [] });
  }

  // Configure dynamic rules to allow offscreen chunk engine to make Range requests without CORS blocking
  await setupDeclarativeRules();

  // Create Context Menus
  registerContextMenus();

  // Ensure extension area shows full unobstructed thunderbolt icon
  try {
    chrome.action.setBadgeText({ text: '' });
  } catch (e) {}

  console.log('[TurboServiceWorker] TurboSpeed Downloader initialized.');
}

// Universal Context Menu Registration: ensures video download is available across all sites
let _contextMenusRegistering = false; // Guard against concurrent duplicate registration

function registerContextMenus() {
  // Prevent overlapping calls that cause duplicate menu items
  if (_contextMenusRegistering) return;
  _contextMenusRegistering = true;

  try {
    chrome.contextMenus.removeAll(() => {
      // Primary: Video right-click download for any site, video player, overlay, or frame
      chrome.contextMenus.create({
        id: 'turbo-download-video',
        title: 'Turbo Download Video',
        contexts: ['video', 'audio', 'page', 'frame', 'link']
      }, () => chrome.runtime.lastError); // suppress duplicate-ID error

      chrome.contextMenus.create({
        id: 'turbo-download-link',
        title: 'Turbo Download File / Link',
        contexts: ['link']
      }, () => chrome.runtime.lastError);

      chrome.contextMenus.create({
        id: 'turbo-download-selection',
        title: 'Turbo Download From Selected URL',
        contexts: ['selection']
      }, () => chrome.runtime.lastError);

      _contextMenusRegistering = false;
    });
  } catch (e) {
    _contextMenusRegistering = false;
    console.warn('[TurboServiceWorker] Context menu setup:', e);
  }
}

// NOTE: registerContextMenus() is called inside setupInitialConfig() only.
// Do NOT call it here at module top-level — that causes duplicate entries
// because the service worker wakes up and runs this file again while
// onInstalled/onStartup already scheduled it via setupInitialConfig().

// Setup Dynamic Declarative Rules to allow offscreen chunk engine to make Range requests without CORS blocking
async function setupDeclarativeRules() {
  try {
    if (!chrome?.declarativeNetRequest?.updateDynamicRules) return;

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existing.map(r => r.id);

    const rules = [
      {
        id: 1001,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Origin', operation: 'remove' }
          ],
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: `chrome-extension://${chrome.runtime.id}` },
            { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' },
            { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS, POST' },
            { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
            { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, Content-Type' }
          ]
        },
        condition: {
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ['xmlhttprequest', 'other']
        }
      }
    ];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds,
      addRules: rules
    });
    console.log('[TurboServiceWorker] Declarative CORS rules for offscreen acceleration ready.');
  } catch (err) {
    console.warn('[TurboServiceWorker] Note on declarative rules:', err.message || err);
  }
}

setupDeclarativeRules();

function updateActionBadge() {
  try {
    const count = localActiveDownloads.size;
    if (count > 0) {
      chrome.action.setBadgeText({ text: `${count}` });
      chrome.action.setBadgeBackgroundColor({ color: '#00f2fe' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {}
}

// Safe notification helper with fully-qualified asset URL and lastError suppression
function showNotification(title, message, priority = 1) {
  try {
    if (!chrome?.notifications?.create) return;
    const notificationId = 'turbo_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const options = {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icon128.png'),
      title: title || 'TurboSpeed Downloader',
      message: message || '',
      priority: Math.min(Math.max(priority, 0), 2)
    };
    chrome.notifications.create(notificationId, options, () => {
      // Consume lastError to prevent "Unchecked runtime.lastError" in extensions::notifications
      if (chrome.runtime.lastError) {
        // Silently handled
      }
    });
  } catch (err) {
    console.warn('[TurboServiceWorker] Note on notification display:', err.message || err);
  }
}

// Send in-page notification to website active tab
async function notifyWebsite(title, message) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'SHOW_TURBO_TOAST',
        payload: { title, message }
      }).catch(() => {});
    }
  } catch (e) {}
}

let browserDownloadSpeeds = new Map();

async function pollBrowserDownloads() {
  try {
    const items = await chrome.downloads.search({ state: 'in_progress' });
    const now = performance.now();

    items.forEach(item => {
      // Ignore extension-assembled blob downloads
      if (item.url && item.url.startsWith('blob:')) return;

      const key = 'browser_' + item.id;
      let prev = browserDownloadSpeeds.get(item.id);
      if (!prev || !Array.isArray(prev.samples)) {
        const startTimestamp = item.startTime ? new Date(item.startTime).getTime() : Date.now();
        prev = {
          samples: [{ time: now, bytes: item.bytesReceived || 0 }],
          speed: 0,
          startTime: isNaN(startTimestamp) ? Date.now() : startTimestamp
        };
        browserDownloadSpeeds.set(item.id, prev);
      } else {
        prev.samples.push({ time: now, bytes: item.bytesReceived || 0 });
        // Retain samples within a 1.4-second rolling window to absorb bursty network I/O
        while (prev.samples.length > 2 && (now - prev.samples[0].time) > 1400) {
          prev.samples.shift();
        }

        const oldest = prev.samples[0];
        const timeSpan = (now - oldest.time) / 1000;
        const bytesSpan = Math.max(0, (item.bytesReceived || 0) - oldest.bytes);

        if (item.paused) {
          prev.speed = 0;
        } else if (timeSpan >= 0.25) {
          const measured = bytesSpan / timeSpan;
          if (prev.speed === 0) {
            prev.speed = measured;
          } else if (bytesSpan > 0) {
            // Stable Exponential Moving Average over the rolling window
            prev.speed = 0.35 * measured + 0.65 * prev.speed;
          } else if ((now - oldest.time) > 1600) {
            // Only gently taper if zero bytes arrived for over 1.6 seconds
            prev.speed = prev.speed * 0.85;
            if (prev.speed < 1024) prev.speed = 0;
          }
        }
        browserDownloadSpeeds.set(item.id, prev);
      }

      const total = item.totalBytes > 0 ? item.totalBytes : (item.bytesReceived || 0);
      const percent = total > 0 ? Math.min(100, ((item.bytesReceived || 0) / total) * 100) : 0;
      const remaining = Math.max(0, total - (item.bytesReceived || 0));
      const eta = prev.speed > 0 ? Math.ceil(remaining / prev.speed) : 0;

      localActiveDownloads.set(key, {
        id: key,
        nativeId: item.id,
        url: item.url,
        filename: item.filename ? item.filename.split(/[\\/]/).pop() : 'Browser Download',
        status: item.paused ? 'paused' : 'downloading',
        totalBytes: total,
        downloadedBytes: item.bytesReceived || 0,
        percent: percent,
        speed: prev.speed,
        etaSeconds: eta,
        latencyMs: 14,
        isNative: true,
        startTime: prev.startTime,
        chunks: Array.from({ length: 8 }).map((_, t) => {
          const chunkSize = total > 0 ? Math.floor(total / 8) : 0;
          const chunkDone = total > 0 ? Math.min(chunkSize, Math.max(0, (item.bytesReceived || 0) - (t * chunkSize))) : 0;
          const chunkPct = chunkSize > 0 ? Math.min(100, (chunkDone / chunkSize) * 100) : percent;
          return {
            id: t,
            total: chunkSize,
            downloaded: chunkDone,
            percent: chunkPct,
            status: item.paused ? 'paused' : 'downloading'
          };
        })
      });
    });

    const activeNativeKeys = new Set(items.map(i => 'browser_' + i.id));
    for (const k of localActiveDownloads.keys()) {
      if (k.startsWith('browser_') && !activeNativeKeys.has(k)) {
        localActiveDownloads.delete(k);
        browserDownloadSpeeds.delete(parseInt(k.replace('browser_', ''), 10));
      }
    }

    updateActionBadge();
  } catch (e) {}
}

// Continuous background monitoring and reactive event handling
setInterval(pollBrowserDownloads, 500);

chrome.downloads.onChanged.addListener(async (delta) => {
  // Free offscreen blob URL when assembled download finishes writing to disk
  if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
    if (blobUrlsToRevoke.has(delta.id)) {
      const bUrl = blobUrlsToRevoke.get(delta.id);
      blobUrlsToRevoke.delete(delta.id);
      chrome.runtime.sendMessage({ type: 'REVOKE_BLOB_URL', payload: { blobUrl: bUrl } }).catch(() => {});
    }
  }

  if (delta.state && delta.state.current === 'complete') {
    const key = 'browser_' + delta.id;
    const tracked = localActiveDownloads.get(key);
    const speedInfo = browserDownloadSpeeds.get(delta.id);
    if (tracked) {
      try {
        const { history = [] } = await chrome.storage.local.get('history');
        const startTs = speedInfo?.startTime || tracked.startTime || (Date.now() - 1000);
        const durationSec = Math.max(0.5, (Date.now() - startTs) / 1000);
        const total = tracked.totalBytes || tracked.downloadedBytes || 0;
        const avgSpeed = durationSec > 0 ? Math.round(total / durationSec) : (speedInfo?.speed || tracked.speed || 0);

        const completedRecord = {
          id: key,
          downloadItemId: delta.id,
          filename: tracked.filename || 'download',
          totalBytes: total,
          duration: durationSec.toFixed(1),
          averageSpeed: avgSpeed,
          completedAt: Date.now()
        };
        history.unshift(completedRecord);
        if (history.length > 100) history.pop();
        await chrome.storage.local.set({ history });
      } catch (e) {}
    }
    localActiveDownloads.delete(key);
    browserDownloadSpeeds.delete(delta.id);
    updateActionBadge();
  } else if (delta.state && delta.state.current === 'interrupted') {
    const key = 'browser_' + delta.id;
    const tracked = localActiveDownloads.get(key);
    // If an accelerated blob download was interrupted, automatically recover by downloading the original URL
    if (tracked?.originalUrl && (tracked.originalUrl.startsWith('http://') || tracked.originalUrl.startsWith('https://'))) {
      console.warn('[TurboServiceWorker] Accelerated blob download was interrupted; auto-recovering with direct download of original URL:', tracked.originalUrl);
      interceptedUrls.add(tracked.originalUrl);
      chrome.downloads.download({
        url: tracked.originalUrl,
        filename: tracked.filename && !tracked.filename.startsWith('Probing') ? tracked.filename : undefined,
        conflictAction: 'uniquify',
        saveAs: false
      }).catch(err => console.error('[TurboServiceWorker] Recovery download failed:', err));
    }
    localActiveDownloads.delete(key);
    browserDownloadSpeeds.delete(delta.id);
    updateActionBadge();
  } else {
    pollBrowserDownloads();
  }
});

chrome.downloads.onErased.addListener((downloadId) => {
  localActiveDownloads.delete('browser_' + downloadId);
  browserDownloadSpeeds.delete(downloadId);
  updateActionBadge();
});

// Module-level Singleton Promise Lock for offscreen document initialization
let _offscreenInitPromise = null;

/**
 * Fast-path ping to verify if offscreen document is actively listening
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function pingOffscreen(timeoutMs = 120) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);

    try {
      if (!chrome?.runtime?.sendMessage) {
        clearTimeout(timer);
        return resolve(false);
      }
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' }, (response) => {
        const _lastErr = chrome.runtime.lastError; // Clear lastError immediately
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (_lastErr || !response || response.status !== 'READY') {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    }
  });
}

/**
 * Checks whether an offscreen document exists in Chrome
 * @returns {Promise<boolean>}
 */
async function hasOffscreenDocument() {
  if (chrome.offscreen?.hasDocument) {
    try {
      return await chrome.offscreen.hasDocument();
    } catch (e) {
      return false;
    }
  }
  if ('getContexts' in chrome.runtime) {
    try {
      const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [offscreenUrl]
      });
      return Boolean(contexts && contexts.length > 0);
    } catch (e) {
      return false;
    }
  }
  return false;
}

/**
 * Closes existing or unresponsive offscreen document safely
 */
async function closeOffscreenDocument() {
  if (chrome.offscreen?.closeDocument) {
    try {
      await chrome.offscreen.closeDocument();
    } catch (e) {
      // Ignore if document was already closed
    }
  }
}

/**
 * Ensure Offscreen Document is running, responsive, and ready
 * Uses singleton promise locking to eliminate race conditions and
 * "Only a single offscreen document may be created" errors.
 */
async function ensureOffscreenDocument() {
  if (!chrome?.offscreen?.createDocument) {
    console.warn('[TurboServiceWorker] chrome.offscreen API not available.');
    return false;
  }

  // If another verification/creation is currently in progress, wait for that exact promise
  if (_offscreenInitPromise) {
    return _offscreenInitPromise;
  }

  _offscreenInitPromise = _ensureOffscreenDocumentInternal().finally(() => {
    _offscreenInitPromise = null;
  });

  return _offscreenInitPromise;
}

async function _ensureOffscreenDocumentInternal() {
  // 1. FAST PATH: Ping the document directly
  // If it responds immediately, it is active and healthy (0-2ms latency)
  const isImmediatelyResponsive = await pingOffscreen(120);
  if (isImmediatelyResponsive) {
    offscreenReady = true;
    return true;
  }

  // 2. Check if a document already exists according to Chrome
  const exists = await hasOffscreenDocument();
  if (exists) {
    // Document exists in Chrome but missed the 120ms ping.
    // Give it a slightly longer grace ping (250ms) in case it was busy assembling a chunk
    const retryPing = await pingOffscreen(250);
    if (retryPing) {
      offscreenReady = true;
      return true;
    }

    // Still not responding -> Zombie / unresponsive offscreen document!
    // Safely tear it down so we can create a clean, responsive instance
    console.warn('[TurboServiceWorker] Offscreen document exists but is unresponsive; recovering...');
    await closeOffscreenDocument();
    await new Promise(r => setTimeout(r, 60));
  }

  // 3. Create fresh Offscreen Document
  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');
  try {
    const reasons = [
      chrome.offscreen?.Reason?.BLOBS || 'BLOBS',
      chrome.offscreen?.Reason?.DOM_SCRAPING || 'DOM_SCRAPING'
    ];
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: reasons,
      justification: 'Parallel multi-threaded chunk assembling and download acceleration'
    });
    console.log('[TurboServiceWorker] Offscreen document created successfully.');
  } catch (err) {
    const msg = err?.message || String(err);
    if (!msg.includes('Only a single offscreen document may be created')) {
      console.warn('[TurboServiceWorker] Note on offscreen creation:', msg);
    }
  }

  // 4. Handshake Ping Loop: Wait for module script to load and initialize
  for (let attempt = 0; attempt < 25; attempt++) {
    const isReady = await pingOffscreen(100);
    if (isReady) {
      offscreenReady = true;
      return true;
    }
    await new Promise(r => setTimeout(r, 50));
  }

  console.error('[TurboServiceWorker] Offscreen document failed to respond to handshake.');
  offscreenReady = false;
  return false;
}

let interceptedDownloadIds = new Set();

// Automatic Download Acceleration & Smart Safe Interception
chrome.downloads.onCreated.addListener(async (item) => {
  pollBrowserDownloads();

  try {
    if (item.byExtensionId === chrome.runtime.id) return;
    if (extensionInitiatedNativeIds.has(item.id)) return;
    if (!item.url || item.url.startsWith('blob:') || item.url.startsWith('data:') || item.url.startsWith('chrome:')) return;
    if (!item.url.startsWith('http://') && !item.url.startsWith('https://')) return;
    if (interceptedDownloadIds.has(item.id)) return;

    const { settings } = await chrome.storage.local.get('settings');
    const currentSettings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    if (!currentSettings.turboEnabled || !currentSettings.autoIntercept) return;

    // Immediately pause the native single-stream download to prevent it from saturating
    // network bandwidth, starving Chrome's socket pool, or triggering remote server rate limits!
    try {
      await chrome.downloads.pause(item.id);
    } catch (pauseErr) {
      // Non-fatal if download is still initializing
    }

    // Probe the URL in offscreen engine to see if it supports HTTP 206 byte-range acceleration
    const ready = await ensureOffscreenDocument();
    if (!ready) {
      // Offscreen unavailable; resume native browser download seamlessly
      try { await chrome.downloads.resume(item.id); } catch (e) {}
      return;
    }

    chrome.runtime.sendMessage({ type: 'PROBE_URL', payload: { url: item.url } }, async (res) => {
      const _err = chrome.runtime.lastError;
      if (_err || !res || !res.success || !res.result) {
        // Probe failed or timed out; resume native download so user file still downloads
        try { await chrome.downloads.resume(item.id); } catch (e) {}
        return;
      }

      const result = res.result;
      const minBytes = (currentSettings.minSizeMB || 1) * 1024 * 1024;
      const totalBytes = Math.max(result.totalBytes || 0, item.totalBytes || 0, item.fileSize || 0);

      // If URL returned an HTML webpage rather than a media stream, avoid downloading fake KB files
      if (result.isHtmlPage) {
        try { await chrome.downloads.resume(item.id); } catch (e) {}
        return;
      }

      // Accelerate if server confirmed HTTP 206 Range support and file meets minimum size (or size is unknown/streamed)
      if (result.supportsRange && (totalBytes === 0 || totalBytes >= minBytes)) {
        interceptedDownloadIds.add(item.id);
        if (interceptedDownloadIds.size > 200) interceptedDownloadIds.clear();

        const proposedName = item.filename ? item.filename.split(/[\\/]/).pop() : (result.filename || 'download');

        // Cancel and erase native download immediately so its TCP socket is closed,
        // eliminating all server connection limits and bandwidth contention!
        try {
          await chrome.downloads.cancel(item.id);
          await chrome.downloads.erase({ id: item.id });
        } catch (e) {}

        // Maximum boost speed: 16 parallel threads
        const targetThreads = Math.max(16, currentSettings.threads || 16);
        await triggerTurboDownload(item.url, proposedName, targetThreads, {
          filename: proposedName,
          mimeType: result.mimeType,
          totalBytes: totalBytes
        });

        const sizeStr = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(1) + ' MB' : 'Heavy File';
        notifyWebsite(
          '⚡ TurboSpeed Accelerated',
          `Accelerating "${proposedName}" (${sizeStr}) with ${targetThreads} parallel sockets!`
        );

        if (currentSettings.soundNotifications) {
          showNotification(
            '⚡ TurboSpeed Accelerated',
            `Accelerating "${proposedName}" (${sizeStr}) with ${targetThreads} parallel sockets!`,
            1
          );
        }
      } else {
        // Server does NOT support byte-range slicing; resume native browser download smoothly
        try { await chrome.downloads.resume(item.id); } catch (e) {}
      }
    });
  } catch (err) {
    console.warn('[TurboServiceWorker] Note on auto-interception:', err.message || err);
    try { await chrome.downloads.resume(item.id); } catch (e) {}
  }
});

// Dedicated YouTube Media Download Handler
function handleYouTubeMediaDownload(videoId, title = 'YouTube Video', format = 'mp4') {
  if (!videoId) return;

  const cleanTitle = (title || 'YouTube Video').replace(/- YouTube$/i, '').trim();

  // Create fast-path download stream URL
  let streamUrl = '';
  if (format === 'mp3') {
    streamUrl = `https://www.y2mate.com/youtube-mp3/${encodeURIComponent(videoId)}`;
  } else {
    streamUrl = `https://ssyoutube.com/watch?v=${encodeURIComponent(videoId)}`;
  }

  showNotification(
    '⚡ Turbo YouTube Downloader',
    `Opening high-speed ${format.toUpperCase()} download stream for "${cleanTitle}"...`,
    2
  );

  chrome.tabs.create({ url: streamUrl });
}

// Trigger a Turbo-accelerated download using the multi-threaded chunk engine
async function triggerTurboDownload(url, proposedFilename, customThreads, options = {}) {
  try {
    if (!url || typeof url !== 'string' || !url.trim()) {
      throw new Error('Invalid or empty download URL');
    }

    let cleanUrl = url.trim();

    // Guard against unsupported blob: URLs which cause Chrome "Failed - No internet connection"
    if (cleanUrl.startsWith('blob:')) {
      console.warn('[TurboServiceWorker] Rejecting cross-origin blob URL download to prevent network error:', cleanUrl);
      showNotification(
        '⚡ Stream Protected',
        'This media stream uses MediaSource blobs. Please use the Turbo download options to save this video.'
      );
      return null;
    }

    // Auto-detect YouTube video URLs to avoid downloading HTML page
    if (cleanUrl.includes('youtube.com/watch') || cleanUrl.includes('youtu.be/') || cleanUrl.includes('youtube.com/shorts/')) {
      let vid = null;
      try {
        const u = new URL(cleanUrl.startsWith('//') ? 'https:' + cleanUrl : (cleanUrl.startsWith('http') ? cleanUrl : 'https://' + cleanUrl));
        if (u.hostname.includes('youtu.be')) vid = u.pathname.slice(1).split('/')[0];
        else if (u.pathname.includes('/shorts/')) vid = u.pathname.split('/shorts/')[1].split('/')[0];
        else vid = u.searchParams.get('v');
      } catch (e) {}

      if (vid) {
        handleYouTubeMediaDownload(vid, proposedFilename || 'YouTube Video', 'mp4');
        return 'yt_' + vid;
      }
    }

    if (cleanUrl.startsWith('//')) {
      cleanUrl = 'https:' + cleanUrl;
    } else if (!/^[a-zA-Z][a-zA-Z\d+\-.]*?:/.test(cleanUrl)) {
      cleanUrl = 'https://' + cleanUrl;
    }

    const { settings } = await chrome.storage.local.get('settings');
    const currentSettings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    const baseThreads = customThreads || currentSettings.threads || 8;

    if (!currentSettings.turboEnabled) {
      // Fallback to native Chrome download if Turbo is disabled
      const downloadOptions = { url: cleanUrl, conflictAction: 'uniquify', saveAs: false };
      if (proposedFilename) downloadOptions.filename = proposedFilename;
      const downloadItemId = await chrome.downloads.download(downloadOptions);
      pollBrowserDownloads();
      return 'browser_' + downloadItemId;
    }

    // ============================================================
    // MaxiMux: Check concurrent download limit (max 4)
    // ============================================================
    const activeTurboCount = getActiveTurboCount();
    if (activeTurboCount >= MAX_CONCURRENT_DOWNLOADS && !options.isRebuild) {
      // Queue is full: auto-cancel (decline) this new download request
      console.warn(`[TurboServiceWorker] MaxiMux: ${MAX_CONCURRENT_DOWNLOADS} downloads already active. Cancelling new download request: ${cleanUrl}`);
      notifyWebsite(
        '⚡ MaxiMux Queue Full',
        `${MAX_CONCURRENT_DOWNLOADS} downloads already running. This download was automatically cancelled. Wait for a slot to free up.`
      );
      if (currentSettings.soundNotifications) {
        showNotification(
          '⚡ MaxiMux Queue Full',
          `Max ${MAX_CONCURRENT_DOWNLOADS} concurrent downloads reached. New download cancelled.`,
          1
        );
      }
      broadcastQueueStatus();
      return null;
    }

    return await _startTurboDownloadInternal(cleanUrl, proposedFilename, baseThreads, options);
  } catch (err) {
    console.warn('[TurboServiceWorker] Note on triggering download:', err.message || err);
    throw err;
  }
}

/**
 * Internal: actually starts a Turbo download slot (after queue check passes).
 */
async function _startTurboDownloadInternal(cleanUrl, proposedFilename, baseThreads, options = {}) {
  const { settings } = await chrome.storage.local.get('settings');
  const currentSettings = { ...DEFAULT_SETTINGS, ...(settings || {}) };

  // Ensure offscreen chunk engine is active
  const isReady = await ensureOffscreenDocument();
  if (!isReady) {
    console.warn('[TurboServiceWorker] Offscreen not ready, falling back to native download.');
    const downloadOptions = { url: cleanUrl, conflictAction: 'uniquify', saveAs: false };
    if (proposedFilename) downloadOptions.filename = proposedFilename;
    const downloadItemId = await chrome.downloads.download(downloadOptions);
    pollBrowserDownloads();
    return 'browser_' + downloadItemId;
  }

  // MaxiMux: High-throughput thread allocation for all media and heavy files
  const isVideo = options.isVideoDownload ||
    Boolean(cleanUrl.match(/\.(mp4|webm|mkv|mov|avi|ts|flv|m4v|m3u8|mp3|m4a|wav|aac)(\?|$)/i)) ||
    Boolean(proposedFilename && proposedFilename.match(/\.(mp4|webm|mkv|mov|avi|ts|flv|m4v|m3u8|mp3|m4a|wav|aac)(\?|$)/i)) ||
    Boolean(options.filename && options.filename.match(/\.(mp4|webm|mkv|mov|avi|ts|flv|m4v|m3u8|mp3|m4a|wav|aac)(\?|$)/i)) ||
    Boolean(cleanUrl.includes('videoplayback') || cleanUrl.includes('/video') || cleanUrl.includes('stream') || cleanUrl.includes('video/'));
  const isHeavyFile = Boolean(cleanUrl.match(/\.(zip|iso|rar|7z|tar|gz|exe|msi|dmg|pkg|bin|apk|img)(\?|$)/i)) ||
    Boolean(proposedFilename && proposedFilename.match(/\.(zip|iso|rar|7z|tar|gz|exe|msi|dmg|pkg|bin|apk|img)(\?|$)/i)) ||
    Boolean(options.filename && options.filename.match(/\.(zip|iso|rar|7z|tar|gz|exe|msi|dmg|pkg|bin|apk|img)(\?|$)/i));
  const activeTurboCount = getActiveTurboCount();
  // Guarantee full 16-32 parallel threads for video and heavy files, and configured threads for general downloads
  const dynamicThreads = (isVideo || isHeavyFile) ? Math.max(16, baseThreads || 16) : Math.max(12, baseThreads || 12);

  const turboId = 'turbo_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

  // Store rebuild metadata for auto-recovery
  const rebuildMeta = {
    url: cleanUrl,
    filename: proposedFilename,
    baseThreads: baseThreads
  };

  // Initial state in active downloads map
  localActiveDownloads.set(turboId, {
    id: turboId,
    url: cleanUrl,
    originalNativeId: options.originalNativeId || null,
    filename: proposedFilename || 'Probing download...',
    status: 'probing',
    totalBytes: 0,
    downloadedBytes: 0,
    percent: 0,
    speed: 0,
    etaSeconds: 0,
    latencyMs: 12,
    isNative: false,
    isRebuild: options.isRebuild || false,
    rebuildMeta: rebuildMeta,
    concurrentSlot: activeTurboCount + 1,
    dynamicThreads: dynamicThreads,
    chunks: Array.from({ length: dynamicThreads }).map((_, i) => ({
      id: i,
      total: 0,
      downloaded: 0,
      percent: 0,
      status: 'pending'
    }))
  });
  updateActionBadge();
  broadcastQueueStatus();

  // Command offscreen engine to start parallel segmented download with dynamic threads
  chrome.runtime.sendMessage({
    type: 'START_DOWNLOAD',
    payload: {
      id: turboId,
      url: cleanUrl,
      filename: proposedFilename,
      threads: dynamicThreads
    }
  }).catch((err) => {
    console.warn('[TurboServiceWorker] START_DOWNLOAD dispatch note:', err?.message || err);
  });

  if (currentSettings.soundNotifications && !options.isRebuild) {
    const slotStr = activeTurboCount > 0 ? ` (Slot ${activeTurboCount + 1}/${MAX_CONCURRENT_DOWNLOADS}, ${dynamicThreads} threads each)` : `(${dynamicThreads} threads)`;
    showNotification(
      '⚡ TurboSpeed MaxiMux Active',
      `Boosting download with ${dynamicThreads} parallel pipeline sockets!${slotStr}`,
      1
    );
  } else if (options.isRebuild) {
    notifyWebsite('⚡ TurboSpeed Rebuilding', `Auto-rebuilding failed download: ${proposedFilename || cleanUrl}`);
  }

  return turboId;
}

// Context Menu Click Handling - Universal Any-Site Video & Media Download
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let targetUrl = null;
  let proposedFilename = null;

  if (info.menuItemId === 'turbo-download-video' || info.menuItemId === 'turbo-download-media') {
    const isYtTab = tab?.url && (tab.url.includes('youtube.com') || tab.url.includes('youtu.be'));
    if (isYtTab) {
      let vid = null;
      let title = tab.title || 'YouTube Video';
      if (tab?.id && tabLastMedia.has(tab.id)) {
        const rec = tabLastMedia.get(tab.id);
        if (rec?.videoId) vid = rec.videoId;
        if (rec?.title) title = rec.title;
      }
      if (!vid && tab?.url) {
        try {
          const u = new URL(tab.url);
          if (u.hostname.includes('youtu.be')) vid = u.pathname.slice(1).split('/')[0];
          else if (u.pathname.includes('/shorts/')) vid = u.pathname.split('/shorts/')[1].split('/')[0];
          else vid = u.searchParams.get('v');
        } catch (e) {}
      }

      if (vid) {
        handleYouTubeMediaDownload(vid, title, 'mp4');
      } else if (tab?.id) {
        notifyWebsite(
          '⚡ No Video Detected',
          'Please open or play a specific YouTube video to download.'
        );
      }
      return;
    }

    // 1. Direct browser detected media srcUrl (ignore blob: to prevent network error)
    if (info.srcUrl && !info.srcUrl.startsWith('blob:') && !info.srcUrl.startsWith('data:')) {
      targetUrl = info.srcUrl;
    }

    // 2. Check content-script captured right-click media on this tab
    if (!targetUrl && tab?.id && tabLastMedia.has(tab.id)) {
      const rec = tabLastMedia.get(tab.id);
      if (rec && rec.url && !rec.url.startsWith('blob:') && (Date.now() - rec.time) < 45000) {
        targetUrl = rec.url;
        proposedFilename = rec.filename || rec.title;
      }
    }

    // 3. Fallback: Query active tab's content script for any playing, hovered, or visible video
    if (!targetUrl && tab?.id) {
      try {
        const queryRes = await chrome.tabs.sendMessage(tab.id, { type: 'QUERY_PAGE_VIDEO' }).catch(() => null);
        if (queryRes?.isYouTube && queryRes.videoId) {
          handleYouTubeMediaDownload(queryRes.videoId, queryRes.title, 'mp4');
          return;
        }
        if (queryRes && queryRes.url && !queryRes.url.startsWith('blob:')) {
          targetUrl = queryRes.url;
          proposedFilename = queryRes.filename || queryRes.title;
        }
      } catch (err) {
        // Tab might be restricted or non-web URL
      }
    }

    // 4. Fallback: Check if clicked on a media link
    if (!targetUrl && info.linkUrl && !info.linkUrl.startsWith('blob:')) {
      targetUrl = info.linkUrl;
    }

    if (!targetUrl) {
      if (tab?.id) {
        const lastMedia = tabLastMedia.get(tab.id);
        if (lastMedia?.isBlobStream || lastMedia?.url?.startsWith('blob:')) {
          notifyWebsite(
            'Stream Protected',
            'This video is streamed using dynamic MediaSource chunks (blob: MSE) and cannot be downloaded directly via right-click.'
          );
        } else {
          notifyWebsite(
            'No Video Detected',
            'Could not detect an active video stream under the cursor or playing on this page.'
          );
        }
      }
      return;
    }
  } else if (info.menuItemId === 'turbo-download-link' && info.linkUrl) {
    targetUrl = info.linkUrl;
  } else if (info.menuItemId === 'turbo-download-selection' && info.selectionText) {
    const sel = info.selectionText.trim();
    if (/^https?:\/\//i.test(sel) || sel.startsWith('//')) {
      targetUrl = sel;
    }
  }

  if (targetUrl) {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      const isVideoMenu = info.menuItemId === 'turbo-download-video' || info.menuItemId === 'turbo-download-media';
      const videoThreads = isVideoMenu ? Math.max(12, settings?.threads || 8) : (settings?.threads || 8);
      await triggerTurboDownload(targetUrl, proposedFilename, videoThreads, { isVideoDownload: isVideoMenu });
      if (tab?.id) {
        notifyWebsite(
          'TurboSpeed Accelerated',
          `Accelerating video download with ${videoThreads} parallel pipeline sockets!`
        );
      }
    } catch (err) {
      console.warn('[TurboServiceWorker] Context menu download warning:', err.message || err);
    }
  }
});

// Listen for messages from Offscreen, Popup, Manager, and Content Scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message || {};

  switch (type) {
    case 'OFFSCREEN_HEARTBEAT': {
      offscreenReady = true;
      sendResponse({ alive: true, timestamp: Date.now() });
      return false;
    }

    case 'DOWNLOAD_YOUTUBE_MEDIA': {
      const { videoId, title, format } = payload || {};
      if (videoId) {
        handleYouTubeMediaDownload(videoId, title, format || 'mp4');
      }
      sendResponse({ success: true });
      return false;
    }

    case 'RECORD_RIGHT_CLICKED_MEDIA':
    case 'RECORD_PAGE_MEDIA': {
      if (sender.tab?.id && payload?.url) {
        tabLastMedia.set(sender.tab.id, {
          url: payload.url,
          filename: payload.filename || '',
          title: payload.title || '',
          videoId: payload.videoId || null,
          isYouTube: payload.isYouTube || false,
          time: Date.now()
        });
      }
      sendResponse({ success: true });
      return false;
    }

    case 'GET_TAB_MEDIA': {
      const tabId = payload?.tabId;
      const media = tabId ? tabLastMedia.get(tabId) : null;
      sendResponse({ success: true, media: media || null });
      return false;
    }

    case 'PREPARE_TURBO_INTERCEPT': {
      ensureOffscreenDocument().catch(() => {});
      sendResponse({ success: true });
      return false;
    }

    case 'TRIGGER_TURBO_DOWNLOAD': {
      const targetThreads = Math.max(16, payload?.threads || 16);
      triggerTurboDownload(payload?.url, payload?.filename, targetThreads, { isVideoDownload: true })
        .then(id => sendResponse({ success: true, id }))
        .catch(err => {
          console.warn('[TurboServiceWorker] TRIGGER_TURBO_DOWNLOAD handled error:', err.message || err);
          sendResponse({ success: false, error: err.message || 'Download failed' });
        });
      return true;
    }

    case 'DOWNLOAD_PROGRESS': {
      if (payload && payload.id) {
        const existing = localActiveDownloads.get(payload.id);
        if (existing?.originalNativeId) {
          const natId = existing.originalNativeId;
          existing.originalNativeId = null; // Cleanly erase native download item
          try {
            chrome.downloads.cancel(natId).catch(() => {});
            chrome.downloads.erase({ id: natId }).catch(() => {});
          } catch (e) {}
        }

        localActiveDownloads.set(payload.id, {
          ...existing,
          ...payload
        });
      }
      break;
    }

    case 'DOWNLOAD_STATUS_CHANGED': {
      if (payload && payload.id) {
        const item = localActiveDownloads.get(payload.id);
        if (item) {
          item.status = payload.status;
          localActiveDownloads.set(payload.id, item);
        }
      }
      break;
    }

    case 'DOWNLOAD_COMPLETE': {
      handleDownloadComplete(payload);
      break;
    }

    case 'FALLBACK_TO_NATIVE': {
      if (payload && payload.url) {
        console.log('[TurboServiceWorker] Offscreen requested native fallback for:', payload.url);
        interceptedUrls.add(payload.url);
        const downloadOptions = {
          url: payload.url,
          conflictAction: 'uniquify',
          saveAs: false
        };
        if (payload.filename && !payload.filename.startsWith('turbo_download_')) {
          downloadOptions.filename = payload.filename;
        }
        chrome.downloads.download(downloadOptions).then(nativeId => {
          if (payload.id) localActiveDownloads.delete(payload.id);
          pollBrowserDownloads();
        }).catch(err => {
          console.warn('[TurboServiceWorker] Fallback with custom filename failed, retrying without:', err.message);
          delete downloadOptions.filename;
          chrome.downloads.download(downloadOptions).catch(() => {});
        });
      }
      break;
    }

    case 'DOWNLOAD_ERROR': {
      if (payload && payload.id) {
        const item = localActiveDownloads.get(payload.id);
        if (item) {
          item.status = 'error';
          item.error = payload.error;
          const fallbackUrl = payload.url || item.url;

          // MaxiMux Auto-Rebuild: attempt to restart failed download automatically
          chrome.storage.local.get('settings').then(({ settings }) => {
            const cs = { ...DEFAULT_SETTINGS, ...(settings || {}) };
            if (cs.autoRebuild && fallbackUrl && (fallbackUrl.startsWith('http://') || fallbackUrl.startsWith('https://'))) {
              const rebuildMeta = item.rebuildMeta || {};
              console.log('[TurboServiceWorker] MaxiMux: Scheduling auto-rebuild for failed download:', fallbackUrl);
              localActiveDownloads.delete(payload.id);
              updateActionBadge();
              broadcastQueueStatus();
              scheduleRebuild(rebuildMeta.url || fallbackUrl, rebuildMeta.filename || item.filename, rebuildMeta.baseThreads, {});
              // Also process queue in case a slot opened
              setTimeout(processDownloadQueue, 500);
              return;
            }

            // Fallback to native Chrome download if auto-rebuild is disabled
            if (fallbackUrl && (fallbackUrl.startsWith('http://') || fallbackUrl.startsWith('https://'))) {
              console.warn('[TurboServiceWorker] Turbo download failed; auto-recovering via native Chrome download:', fallbackUrl);
              interceptedUrls.add(fallbackUrl);
              const dlOptions = {
                url: fallbackUrl,
                conflictAction: 'uniquify',
                saveAs: false
              };
              if (item.filename && !item.filename.startsWith('Probing')) {
                dlOptions.filename = item.filename;
              }
              chrome.downloads.download(dlOptions).then(natId => {
                console.log('[TurboServiceWorker] Recovery native download started successfully:', natId);
                localActiveDownloads.delete(payload.id);
                pollBrowserDownloads();
                setTimeout(processDownloadQueue, 500);
              }).catch(e => {
                console.warn('[TurboServiceWorker] Fallback with filename failed, retrying without:', e.message);
                delete dlOptions.filename;
                chrome.downloads.download(dlOptions).then(natId => {
                  localActiveDownloads.delete(payload.id);
                  pollBrowserDownloads();
                  setTimeout(processDownloadQueue, 500);
                }).catch(err => console.error('[TurboServiceWorker] Fatal fallback download error:', err));
              });
            }
          }).catch(() => {});
        }
      }
      break;
    }

    case 'CHUNK_RETRY_ERROR': {
      if (payload) {
        const { filename, chunkId, attempt, maxAttempts, error, delayMs, id } = payload;
        // Suppress intrusive in-page website toasts during transient self-healing retries.
        // Transient retries are normal in parallel network streams and auto-recover within milliseconds.
        console.warn(`[TurboServiceWorker] Chunk ${chunkId} retrying (attempt ${attempt}/${maxAttempts}): ${error}`);

        // Broadcast quietly to manager / popup for UI status indicator
        chrome.runtime.sendMessage({
          type: 'CHUNK_RETRY_DISPLAY',
          payload: { id, filename, chunkId, attempt, maxAttempts, error, delayMs }
        }).catch(() => {});
      }
      break;
    }

    case 'CHUNK_FAILED_ERROR': {
      if (payload) {
        const { filename, chunkId, maxAttempts, error, id } = payload;
        const shortFile = (filename || 'download').length > 28
          ? (filename || 'download').substring(0, 26) + '…'
          : (filename || 'download');

        // Visible in-page toast — permanent failure is critical for the user to see
        notifyWebsite(
          `❌ Chunk ${chunkId} Failed — All ${maxAttempts} Retries Exhausted`,
          `"${shortFile}" — ${error}`
        );

        // Desktop notification for final failure
        showNotification(
          '❌ TurboSpeed Chunk Failed',
          `Chunk ${chunkId} of "${shortFile}" permanently failed: ${error}`,
          2
        );

        // Broadcast to manager / popup for red error alert banner in the download row
        chrome.runtime.sendMessage({
          type: 'CHUNK_FAILED_DISPLAY',
          payload: { id, filename, chunkId, maxAttempts, error }
        }).catch(() => {});
      }
      break;
    }

    case 'GET_STATUS': {
      pollBrowserDownloads().then(() => {
        sendResponse({
          success: true,
          active: Array.from(localActiveDownloads.values())
        });
      }).catch(() => {
        sendResponse({
          success: true,
          active: Array.from(localActiveDownloads.values())
        });
      });
      return true; // Keep message port open for async response
    }

    case 'OPEN_MANAGER': {
      chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
      sendResponse({ success: true });
      break;
    }

    case 'PAUSE_TURBO_DOWNLOAD': {
      if (payload?.id && payload.id.startsWith('browser_')) {
        const item = localActiveDownloads.get(payload.id);
        const nativeId = item?.nativeId || parseInt(payload.id.replace('browser_', ''), 10);
        if (nativeId && !isNaN(nativeId)) chrome.downloads.pause(nativeId).catch(() => {});
      } else if (payload) {
        chrome.runtime.sendMessage({ type: 'PAUSE_DOWNLOAD', payload }).catch(() => {});
      }
      sendResponse({ success: true });
      break;
    }

    case 'RESUME_TURBO_DOWNLOAD': {
      if (payload?.id && payload.id.startsWith('browser_')) {
        const item = localActiveDownloads.get(payload.id);
        const nativeId = item?.nativeId || parseInt(payload.id.replace('browser_', ''), 10);
        if (nativeId && !isNaN(nativeId)) chrome.downloads.resume(nativeId).catch(() => {});
      } else if (payload) {
        ensureOffscreenDocument().then(() => {
          chrome.runtime.sendMessage({ type: 'RESUME_DOWNLOAD', payload }).catch(() => {});
        }).catch(() => {});
      }
      sendResponse({ success: true });
      break;
    }

    case 'CANCEL_TURBO_DOWNLOAD': {
      if (payload?.id && payload.id.startsWith('browser_')) {
        const item = localActiveDownloads.get(payload.id);
        const nativeId = item?.nativeId || parseInt(payload.id.replace('browser_', ''), 10);
        if (nativeId && !isNaN(nativeId)) chrome.downloads.cancel(nativeId).catch(() => {});
      } else if (payload) {
        chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD', payload }).catch(() => {});
      }
      if (payload?.id) {
        localActiveDownloads.delete(payload.id);
        updateActionBadge();
        broadcastQueueStatus();
        // After cancellation, check if a queued download can start
        setTimeout(processDownloadQueue, 300);
      }
      sendResponse({ success: true });
      break;
    }

    case 'GET_QUEUE_STATUS': {
      sendResponse({
        success: true,
        active: getActiveTurboCount(),
        queued: downloadQueue.length,
        maxConcurrent: MAX_CONCURRENT_DOWNLOADS
      });
      break;
    }

    default:
      break;
  }
});

// Finalize accelerated download and save file to user's disk
async function handleDownloadComplete(payload) {
  const { id, filename, blobUrl, totalBytes, duration, averageSpeed, originalUrl } = payload || {};
  console.log(`[TurboServiceWorker] Finalizing accelerated download "${filename}" (${totalBytes} bytes)...`);

  try {
    let cleanFilename = (filename || 'download').split(/[\\/]/).pop().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
    if (!cleanFilename || cleanFilename === '.' || cleanFilename === '..') cleanFilename = 'download';

    // Windows & Cross-Platform Reserved Device Names Protection
    const baseNameUpper = cleanFilename.split('.')[0].toUpperCase();
    const WINDOWS_RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);
    if (WINDOWS_RESERVED.has(baseNameUpper)) {
      cleanFilename = 'dl_' + cleanFilename;
    }

    // Ensure dedicated extensions for MP4 and AVI (Audio Video Interleave) if missing
    if (!cleanFilename.includes('.')) {
      const mime = (payload?.mimeType || '').toLowerCase();
      if (mime.includes('mp4')) {
        cleanFilename += '.mp4';
      } else if (mime.includes('avi') || mime.includes('msvideo')) {
        cleanFilename += '.avi';
      } else if (mime.includes('matroska') || mime.includes('mkv')) {
        cleanFilename += '.mkv';
      } else if (mime.includes('webm')) {
        cleanFilename += '.webm';
      } else if (mime.includes('quicktime')) {
        cleanFilename += '.mov';
      }
    }

    const downloadOptions = {
      url: blobUrl,
      filename: cleanFilename,
      conflictAction: 'uniquify',
      saveAs: false
    };

    let downloadItemId = null;
    try {
      downloadItemId = await chrome.downloads.download(downloadOptions);
    } catch (saveErr) {
      console.warn('[TurboServiceWorker] Download with filename failed, retrying without custom name:', saveErr.message);
      delete downloadOptions.filename;
      try {
        downloadItemId = await chrome.downloads.download(downloadOptions);
      } catch (blobErr) {
        console.warn('[TurboServiceWorker] Service worker blob download failed, trying offscreen DOM download:', blobErr.message);
        // Fallback 1: Offscreen DOM anchor download
        const domResult = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'TRIGGER_DOM_DOWNLOAD',
            payload: { blobUrl, filename: cleanFilename }
          }, (res) => {
            const _err = chrome.runtime.lastError;
            if (_err || !res) resolve(null);
            else resolve(res);
          });
        });

        if (!domResult?.success) {
          // Fallback 2: Direct browser download of original URL
          console.warn('[TurboServiceWorker] DOM download failed, falling back to original URL native download.');
          const targetUrl = originalUrl || payload.url;
          if (targetUrl) {
            interceptedUrls.add(targetUrl);
            downloadItemId = await chrome.downloads.download({
              url: targetUrl,
              filename: cleanFilename,
              conflictAction: 'uniquify',
              saveAs: false
            });
          }
        }
      }
    }

    if (downloadItemId && blobUrl) {
      blobUrlsToRevoke.set(downloadItemId, blobUrl);
    }

    // Save to download history
    const { history = [] } = await chrome.storage.local.get('history');
    const completedRecord = {
      id,
      downloadItemId: downloadItemId || Date.now(),
      filename: cleanFilename,
      totalBytes,
      duration,
      averageSpeed,
      completedAt: Date.now()
    };
    history.unshift(completedRecord);
    if (history.length > 100) history.pop();
    await chrome.storage.local.set({ history });

    localActiveDownloads.delete(id);
    updateActionBadge();
    broadcastQueueStatus();
    // After download completes, check if a queued download can start
    setTimeout(processDownloadQueue, 300);

    // Proactive blob revocation to instantly free RAM across sequential downloads
    if (downloadItemId && blobUrl) {
      setTimeout(async () => {
        if (blobUrlsToRevoke.has(downloadItemId)) {
          try {
            const [item] = await chrome.downloads.search({ id: downloadItemId });
            if (!item || item.state === 'complete' || item.state === 'interrupted') {
              const bUrl = blobUrlsToRevoke.get(downloadItemId);
              blobUrlsToRevoke.delete(downloadItemId);
              chrome.runtime.sendMessage({ type: 'REVOKE_BLOB_URL', payload: { blobUrl: bUrl } }).catch(() => {});
            }
          } catch (e) {}
        }
      }, 2500);

      setTimeout(() => {
        if (blobUrlsToRevoke.has(downloadItemId)) {
          const bUrl = blobUrlsToRevoke.get(downloadItemId);
          blobUrlsToRevoke.delete(downloadItemId);
          chrome.runtime.sendMessage({ type: 'REVOKE_BLOB_URL', payload: { blobUrl: bUrl } }).catch(() => {});
        }
      }, 30000);
    }

    // Show completion notification
    const { settings } = await chrome.storage.local.get('settings');
    if (settings?.soundNotifications !== false) {
      const speedMB = (averageSpeed / (1024 * 1024)).toFixed(1);
      showNotification(
        '⚡ Turbo Download Finished!',
        `"${cleanFilename}" saved successfully at ${speedMB} MB/s (${duration}s).`,
        2
      );
    }
  } catch (err) {
    console.error('[TurboServiceWorker] Fatal error in handleDownloadComplete:', err);
    const targetUrl = originalUrl || payload.url;
    if (targetUrl) {
      try {
        interceptedUrls.add(targetUrl);
        await chrome.downloads.download({ url: targetUrl, conflictAction: 'uniquify', saveAs: false });
      } catch (fallbackErr) {}
    }
  }
}
