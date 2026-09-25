import { TurboChunkEngine } from './chunk-engine.js';

// Global error handlers to prevent Chrome MV3 unhandled error flags
window.addEventListener('error', (event) => {
  console.warn('[Offscreen] Handled window error:', event?.message || event?.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.warn('[Offscreen] Handled unhandled rejection:', event?.reason?.message || event?.reason);
  event.preventDefault(); // Prevents Chrome from flagging an unhandled error badge on extension
});

const activeEngines = new Map();
const retainedBlobs = new Map(); // blobUrl -> { blob, id, filename, url }

// ── sendMsg helper ────────────────────────────────────────────────────────────
// Replaces the silent .catch(() => {}) pattern on chrome.runtime.sendMessage.
// • "Receiving end does not exist" → silently ignored (popup/manager is closed)
// • "Extension context invalidated" → silently ignored (extension reload)
// • Any other error → logged visibly so it isn't hidden from developers
const CRITICAL_MSG_TYPES = new Set([
  'CHUNK_RETRY_ERROR', 'CHUNK_FAILED_ERROR', 'DOWNLOAD_ERROR',
  'DOWNLOAD_COMPLETE', 'FALLBACK_TO_NATIVE'
]);

function sendMsg(message) {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.runtime?.sendMessage) {
    return Promise.resolve(null);
  }
  return chrome.runtime.sendMessage(message).catch((err) => {
    const msg = err?.message || String(err);
    if (
      msg.includes('Receiving end does not exist') ||
      msg.includes('message port closed') ||
      msg.includes('Could not establish connection') ||
      msg.includes('Extension context invalidated')
    ) {
      return; // Normal — popup/manager closed or extension reloaded
    }
    const logFn = CRITICAL_MSG_TYPES.has(message?.type) ? console.error : console.warn;
    logFn(
      `[Offscreen] sendMessage failed for type "${message?.type}":`,
      msg,
      message?.payload || ''
    );
  });
}

// ── Keep-Alive Heartbeat ──────────────────────────────────────────────────────
// Chrome MV3 offscreen documents are automatically terminated after 30 seconds
// of inactivity. Sending a periodic message resets this inactivity timer.
setInterval(() => {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;
  sendMsg({
    type: 'OFFSCREEN_HEARTBEAT',
    payload: {
      activeEngines: activeEngines.size,
      retainedBlobs: retainedBlobs.size,
      timestamp: Date.now()
    }
  });
}, 20000);

// ─────────────────────────────────────────────────────────────────────────────
// Listen for commands from service worker, popup, or manager
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message || {};

  if (type === 'OFFSCREEN_PING') {
    sendResponse({ status: 'READY' });
    return false;
  }

  switch (type) {
    case 'START_DOWNLOAD': {
      const { id, url, filename, threads } = payload || {};
      startDownload(id, url, filename, threads);
      sendResponse({ success: true, id });
      return false;
    }

    case 'TRIGGER_DOM_DOWNLOAD': {
      const { blobUrl, filename } = payload || {};
      try {
        if (!blobUrl) throw new Error('Missing blobUrl for DOM download');
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename || 'download';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          try { a.remove(); } catch (e) {}
        }, 2000);
        sendResponse({ success: true });
      } catch (err) {
        console.warn('[Offscreen] DOM download failed:', err);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }

    case 'PAUSE_DOWNLOAD': {
      const { id } = payload || {};
      const engine = activeEngines.get(id);
      if (engine) {
        engine.pause();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Download not found' });
      }
      return false;
    }

    case 'RESUME_DOWNLOAD': {
      const { id } = payload || {};
      const engine = activeEngines.get(id);
      if (engine) {
        engine.resume();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Download not found' });
      }
      return false;
    }

    case 'CANCEL_DOWNLOAD': {
      const { id } = payload || {};
      const engine = activeEngines.get(id);
      if (engine) {
        engine.cancel();
        activeEngines.delete(id);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Download not found' });
      }
      return false;
    }

    case 'GET_ACTIVE_TELEMETRY': {
      const telemetryList = Array.from(activeEngines.values()).map(engine => engine.getTelemetry());
      sendResponse({ success: true, active: telemetryList });
      return false;
    }

    case 'REVOKE_BLOB_URL': {
      if (payload?.blobUrl) {
        try {
          retainedBlobs.delete(payload.blobUrl);
          URL.revokeObjectURL(payload.blobUrl);
        } catch (e) {}
      }
      sendResponse({ success: true });
      return false;
    }

    case 'PROBE_URL': {
      const { url } = payload || {};
      if (!url) {
        sendResponse({ success: false, error: 'Missing probe URL' });
        return false;
      }
      const probeEngine = new TurboChunkEngine({ url, threads: 1 });
      probeEngine.probe().then(result => {
        sendResponse({ success: true, result });
      }).catch(err => {
        sendResponse({ success: false, error: err?.message || String(err) });
      });
      return true; // Asynchronous response
    }

    default:
      return false; // Not handled here, do NOT keep message port open
  }
});

async function startDownload(id, url, filename, threads) {
  if (activeEngines.has(id)) {
    console.warn('[Offscreen] Download ID already running:', id);
    return;
  }

  // Purge any blob URLs older than 15s to keep memory footprint close to zero
  const now = Date.now();
  for (const [bUrl, info] of retainedBlobs.entries()) {
    if (now - (info.timestamp || 0) > 15000) {
      try { URL.revokeObjectURL(bUrl); } catch (e) {}
      retainedBlobs.delete(bUrl);
    }
  }

  const engine = new TurboChunkEngine({
    id,
    url,
    filename,
    threads: threads || 8,
    onProgress: (telemetry) => {
      sendMsg({
        type: 'DOWNLOAD_PROGRESS',
        payload: telemetry
      });
    },
    onStatusChange: (status) => {
      sendMsg({
        type: 'DOWNLOAD_STATUS_CHANGED',
        payload: { id, status }
      });
    },
    onChunkRetry: (info) => {
      sendMsg({
        type: 'CHUNK_RETRY_ERROR',
        payload: info
      });
    },
    onChunkFailed: (info) => {
      sendMsg({
        type: 'CHUNK_FAILED_ERROR',
        payload: info
      });
    },
    onError: (err) => {
      console.error(`[Offscreen] Download error on ${id}:`, err);
      sendMsg({
        type: 'DOWNLOAD_ERROR',
        payload: { id, error: err.message || 'Unknown network error', url: engine.url, filename: engine.filename }
      });
      activeEngines.delete(id); // Clean up on error to prevent memory leak
    },
    onFallbackNative: (fallbackData) => {
      console.log(`[Offscreen] Forwarding fallback for ${id} to background.`);
      sendMsg({
        type: 'FALLBACK_TO_NATIVE',
        payload: fallbackData
      });
      activeEngines.delete(id); // Clean up on fallback
    },
    onComplete: (data) => {
      console.log(`[Offscreen] Download ${id} completed successfully.`);
      if (data.blobUrl) {
        // Auto-purge any stale blob URLs older than 20 seconds to instantly free RAM
        const now = Date.now();
        for (const [bUrl, info] of retainedBlobs.entries()) {
          if (now - (info.timestamp || 0) > 20000) {
            try { URL.revokeObjectURL(bUrl); } catch (e) {}
            retainedBlobs.delete(bUrl);
          }
        }
        if (retainedBlobs.size >= 10) {
          const oldestKey = retainedBlobs.keys().next().value;
          if (oldestKey) {
            try { URL.revokeObjectURL(oldestKey); } catch (e) {}
            retainedBlobs.delete(oldestKey);
          }
        }
        // Store only metadata, NEVER strong references to Blobs in JS heap
        retainedBlobs.set(data.blobUrl, {
          id,
          filename: data.filename,
          url: engine.url,
          timestamp: Date.now()
        });
      }
      sendMsg({
        type: 'DOWNLOAD_COMPLETE',
        payload: {
          ...data,
          originalUrl: engine.url
        }
      });
      activeEngines.delete(id); // Clean up completed engine instance immediately
    }
  });

  activeEngines.set(id, engine);

  try {
    await engine.probe();
    await engine.start();
  } catch (err) {
    console.error(`[Offscreen] Fatal error starting ${id}:`, err);
    activeEngines.delete(id);
  }
}
