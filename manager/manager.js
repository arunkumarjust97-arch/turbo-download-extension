/**
 * TurboSpeed Downloader - Dashboard Controller (manager.js)
 * Real-time waveform canvas graph, active transfer tables, history, and engine settings.
 */

// Application State
const activeDownloads = new Map();
const speedHistory = new Array(60).fill(0); // 60 data points for waveform
let peakSpeed = 0;
let currentView = 'active';
let totalHistoryBytes = 0;
const managerSpeedTracker = new Map();

// MaxiMux Queue State
let maximuxActive = 0;
let maximuxMax = 4;
let maximuxQueued = 0;

// Formatting Helpers
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0.0 MB/s';
  if (bytesPerSec >= 1024 * 1024) {
    return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
  }
  if (bytesPerSec >= 1024) {
    return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
  }
  return Math.round(bytesPerSec) + ' B/s';
}

function formatSeconds(sec) {
  if (!sec || sec <= 0) return '--';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

// DOM References
const navItems = document.querySelectorAll('.nav-item');
const viewActive = document.getElementById('viewActive');
const viewHistory = document.getElementById('viewHistory');
const viewSettings = document.getElementById('viewSettings');
const chartPanel = document.getElementById('chartPanel');
const pageTitle = document.getElementById('pageTitle');
const navActiveBadge = document.getElementById('navActiveBadge');
const navHistoryBadge = document.getElementById('navHistoryBadge');

const topbarSpeed = document.getElementById('topbarSpeed');
const topbarTotalDownloaded = document.getElementById('topbarTotalDownloaded');
const chartInstantSpeed = document.getElementById('chartInstantSpeed');
const chartPeakSpeed = document.getElementById('chartPeakSpeed');

const activeTableBody = document.getElementById('activeTableBody');
const noActivePlaceholder = document.getElementById('noActivePlaceholder');
const historyTableBody = document.getElementById('historyTableBody');
const noHistoryPlaceholder = document.getElementById('noHistoryPlaceholder');

const sidebarThreadsReadout = document.getElementById('sidebarThreadsReadout');
const sidebarInterceptionStatus = document.getElementById('sidebarInterceptionStatus');
const sidebarEngineDot = document.getElementById('sidebarEngineDot');

// Modal Elements
const newDownloadModal = document.getElementById('newDownloadModal');
const btnOpenNewDownloadModal = document.getElementById('btnOpenNewDownloadModal');
const btnCloseModal = document.getElementById('btnCloseModal');
const btnCancelModal = document.getElementById('btnCancelModal');
const btnStartModalDownload = document.getElementById('btnStartModalDownload');
const modalUrlInput = document.getElementById('modalUrlInput');
const modalFilenameInput = document.getElementById('modalFilenameInput');
const modalThreadsSelect = document.getElementById('modalThreadsSelect');

// Settings Elements
const settingTurboEnabled = document.getElementById('settingTurboEnabled');
const settingAutoIntercept = document.getElementById('settingAutoIntercept');
const settingVideoRightClick = document.getElementById('settingVideoRightClick');
const settingThreads = document.getElementById('settingThreads');
const settingMinSize = document.getElementById('settingMinSize');
const settingNotifications = document.getElementById('settingNotifications');
const settingMaxConcurrent = document.getElementById('settingMaxConcurrent');
const settingAutoRebuild = document.getElementById('settingAutoRebuild');
const btnSaveSettings = document.getElementById('btnSaveSettings');
const btnResetSettings = document.getElementById('btnResetSettings');
const saveStatusFeedback = document.getElementById('saveStatusFeedback');
const btnClearHistory = document.getElementById('btnClearHistory');
const searchActiveInput = document.getElementById('searchActiveInput');

// Canvas Setup
const canvas = document.getElementById('speedChart');
const ctx = canvas ? canvas.getContext('2d') : null;

// ==========================================
// Initialization Routine
// ==========================================
async function initDashboard() {
  setupNavigation();
  setupModal();
  setupSettingsHandlers();
  setupTableDelegation();

  if (searchActiveInput) {
    searchActiveInput.addEventListener('input', () => {
      renderActiveTable();
    });
  }

  await loadSettings();
  await loadHistory();
  await fetchActiveTransfers();

  // Poll initial MaxiMux status from service worker
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: 'GET_QUEUE_STATUS' }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      updateMaxiMuxUI(res);
    });
  }

  // Polling loops
  setInterval(fetchActiveTransfers, 500);
  setInterval(updateWaveform, 100);

  // Chrome events sync
  if (typeof chrome !== 'undefined' && chrome.downloads) {
    chrome.downloads.onCreated?.addListener(() => fetchActiveTransfers());
    chrome.downloads.onChanged?.addListener(() => {
      fetchActiveTransfers();
      loadHistory();
    });
    chrome.downloads.onErased?.addListener(() => fetchActiveTransfers());
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'DOWNLOAD_PROGRESS' || message.type === 'DOWNLOAD_COMPLETE') {
        fetchActiveTransfers();
        if (message.type === 'DOWNLOAD_COMPLETE') loadHistory();
      } else if (message.type === 'QUEUE_STATUS_UPDATE') {
        // MaxiMux queue status update from service worker
        updateMaxiMuxUI(message.payload);
      } else if (message.type === 'CHUNK_RETRY_DISPLAY') {
        // Show chunk retry error inline in the active download row
        showChunkRetryAlert(message.payload);
      } else if (message.type === 'CHUNK_FAILED_DISPLAY') {
        // Show permanent failure — all retries exhausted
        showChunkFailedAlert(message.payload);
      }
    });
  }
}

function showChunkRetryAlert(payload) {
  if (!payload) return;
  const { chunkId, attempt, maxAttempts, error } = payload;
  console.warn(`[Manager] Chunk ${chunkId} retrying (${attempt}/${maxAttempts}):`, error);
}

function showChunkFailedAlert(payload) {
  if (!payload) return;
  const { chunkId, error } = payload;
  console.error(`[Manager] Chunk ${chunkId} permanently failed:`, error);
}

// ==========================================
// Navigation & Views
// ==========================================
function switchView(view) {
  if (!view) return;
  currentView = view;

  // 1. Update navigation active state
  document.querySelectorAll('.nav-item').forEach(item => {
    if (item.dataset.view === view) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // 2. Query view panels dynamically
  const vActive = document.getElementById('viewActive');
  const vHistory = document.getElementById('viewHistory');
  const vSettings = document.getElementById('viewSettings');
  const cPanel = document.getElementById('chartPanel');
  const pTitle = document.getElementById('pageTitle');
  const statPills = document.querySelectorAll('.topbar .stat-pill');
  const btnNewDownload = document.getElementById('btnOpenNewDownloadModal');

  // 3. Explicitly toggle visibility classes and styles with priority
  if (vActive) {
    if (view === 'active') {
      vActive.classList.add('active-view');
      vActive.style.setProperty('display', 'flex', 'important');
    } else {
      vActive.classList.remove('active-view');
      vActive.style.setProperty('display', 'none', 'important');
    }
  }

  if (vHistory) {
    if (view === 'history') {
      vHistory.classList.add('active-view');
      vHistory.style.setProperty('display', 'flex', 'important');
    } else {
      vHistory.classList.remove('active-view');
      vHistory.style.setProperty('display', 'none', 'important');
    }
  }

  if (vSettings) {
    if (view === 'settings') {
      vSettings.classList.add('active-view');
      vSettings.style.setProperty('display', 'flex', 'important');
    } else {
      vSettings.classList.remove('active-view');
      vSettings.style.setProperty('display', 'none', 'important');
    }
  }

  if (cPanel) {
    if (view === 'active') {
      cPanel.classList.add('active-view');
      cPanel.style.setProperty('display', 'flex', 'important');
    } else {
      cPanel.classList.remove('active-view');
      cPanel.style.setProperty('display', 'none', 'important');
    }
  }

  // 4. Clean topbar view switching: hide live throughput pills and action buttons on Settings/History
  if (view === 'active') {
    statPills.forEach(p => p.style.setProperty('display', 'flex'));
    if (btnNewDownload) btnNewDownload.style.setProperty('display', 'flex');
    if (pTitle) pTitle.textContent = 'Active Accelerated Transfers';
    fetchActiveTransfers();
  } else if (view === 'history') {
    statPills.forEach(p => p.style.setProperty('display', 'none'));
    if (btnNewDownload) btnNewDownload.style.setProperty('display', 'none');
    if (pTitle) pTitle.textContent = 'Accelerated Download History';
    loadHistory();
  } else if (view === 'settings') {
    statPills.forEach(p => p.style.setProperty('display', 'none'));
    if (btnNewDownload) btnNewDownload.style.setProperty('display', 'none');
    if (pTitle) pTitle.textContent = 'Settings & Rules';
    loadSettings();
  }

  try {
    if (window.location.hash !== '#' + view) {
      history.replaceState(null, '', '#' + view);
    }
  } catch (_) {}
}

function setupNavigation() {
  // Bind direct click listeners
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const view = item.dataset.view;
      if (view) switchView(view);
    });
  });

  // Event delegation on nav menu to guarantee clicks on children (svg, path, span) always trigger
  const navMenu = document.querySelector('.nav-menu');
  if (navMenu) {
    navMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.nav-item');
      if (item && item.dataset.view) {
        e.preventDefault();
        switchView(item.dataset.view);
      }
    });
  }

  // URL Hash support (#settings, #history, #active)
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace('#', '');
    if (hash === 'settings' || hash === 'history' || hash === 'active') {
      switchView(hash);
    }
  });

  const initialHash = window.location.hash.replace('#', '');
  if (initialHash === 'settings' || initialHash === 'history' || initialHash === 'active') {
    switchView(initialHash);
  }
}

// ==========================================
// Modal Logic
// ==========================================
function setupModal() {
  const closeModal = () => {
    if (newDownloadModal) newDownloadModal.style.display = 'none';
    if (modalUrlInput) modalUrlInput.value = '';
    if (modalFilenameInput) modalFilenameInput.value = '';
  };

  if (btnOpenNewDownloadModal) {
    btnOpenNewDownloadModal.addEventListener('click', () => {
      if (newDownloadModal) {
        newDownloadModal.style.display = 'flex';
        modalUrlInput?.focus();
      }
    });
  }

  if (btnCloseModal) btnCloseModal.addEventListener('click', closeModal);
  if (btnCancelModal) btnCancelModal.addEventListener('click', closeModal);

  if (newDownloadModal) {
    newDownloadModal.addEventListener('click', (e) => {
      if (e.target === newDownloadModal) closeModal();
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && newDownloadModal && newDownloadModal.style.display === 'flex') {
      closeModal();
    }
  });

  if (btnStartModalDownload) {
    btnStartModalDownload.addEventListener('click', async () => {
      const url = modalUrlInput ? modalUrlInput.value.trim() : '';
      if (!url) {
        alert('Please enter a valid HTTP or HTTPS download URL.');
        modalUrlInput?.focus();
        return;
      }

      const filename = modalFilenameInput ? modalFilenameInput.value.trim() || null : null;
      const threads = modalThreadsSelect ? parseInt(modalThreadsSelect.value, 10) : 16;

      btnStartModalDownload.disabled = true;
      btnStartModalDownload.textContent = 'Initiating...';

      try {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          const res = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
              type: 'TRIGGER_TURBO_DOWNLOAD',
              payload: { url, filename, threads }
            }, response => {
              if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
              } else {
                resolve(response || { success: true });
              }
            });
          });

          if (res?.success) {
            closeModal();
            switchView('active');
            fetchActiveTransfers();
          } else {
            alert('Could not start download: ' + (res?.error || 'Unknown error'));
          }
        } else {
          closeModal();
          alert('Preview mode: Simulated turbo download for ' + url);
        }
      } catch (err) {
        console.error(err);
      } finally {
        btnStartModalDownload.disabled = false;
        btnStartModalDownload.textContent = 'Start Turbo Download';
      }
    });
  }
}

// ==========================================
// Settings Management
// ==========================================
const DEFAULT_SETTINGS = Object.freeze({
  turboEnabled: true,
  autoIntercept: true,
  videoRightClick: true,
  threads: 16,
  minSizeMB: 1,
  soundNotifications: true,
  maxConcurrentDownloads: 4,
  autoRebuild: true
});

async function loadSettings() {
  let settings = { ...DEFAULT_SETTINGS };

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const data = await chrome.storage.local.get('settings');
      if (data?.settings) {
        settings = { ...settings, ...data.settings };
      }
    } catch (e) {
      console.warn('Storage read warning:', e);
    }
  }

  if (settingTurboEnabled) settingTurboEnabled.checked = settings.turboEnabled !== false;
  if (settingAutoIntercept) settingAutoIntercept.checked = settings.autoIntercept !== false;
  if (settingVideoRightClick) settingVideoRightClick.checked = settings.videoRightClick !== false;
  if (settingThreads) settingThreads.value = String(settings.threads || 8);
  if (settingMinSize) settingMinSize.value = String(settings.minSizeMB !== undefined ? settings.minSizeMB : 1);
  if (settingNotifications) settingNotifications.checked = settings.soundNotifications !== false;
  if (settingMaxConcurrent) settingMaxConcurrent.value = String(settings.maxConcurrentDownloads || 4);
  if (settingAutoRebuild) settingAutoRebuild.checked = settings.autoRebuild !== false;

  updateSidebarIndicators(settings);
}

function updateSidebarIndicators(settings) {
  if (sidebarThreadsReadout) {
    sidebarThreadsReadout.innerHTML = `${settings.threads || 8} <span>Parallel Threads</span>`;
  }
  if (sidebarInterceptionStatus) {
    sidebarInterceptionStatus.textContent = `Auto-Interception: ${settings.autoIntercept !== false ? 'Enabled' : 'Disabled'}`;
  }
  if (sidebarEngineDot) {
    sidebarEngineDot.style.background = settings.turboEnabled !== false ? 'var(--green-neon)' : 'var(--pink-neon)';
    sidebarEngineDot.style.boxShadow = settings.turboEnabled !== false ? '0 0 8px rgba(16, 185, 129, 0.6)' : '0 0 8px rgba(244, 63, 94, 0.6)';
  }
}

async function saveCurrentSettings(showNotice = false) {
  const updated = {
    turboEnabled: settingTurboEnabled ? settingTurboEnabled.checked : true,
    autoIntercept: settingAutoIntercept ? settingAutoIntercept.checked : true,
    videoRightClick: settingVideoRightClick ? settingVideoRightClick.checked : true,
    threads: settingThreads ? parseInt(settingThreads.value, 10) : 8,
    minSizeMB: settingMinSize ? parseFloat(settingMinSize.value) || 1 : 1,
    soundNotifications: settingNotifications ? settingNotifications.checked : true,
    maxConcurrentDownloads: settingMaxConcurrent ? parseInt(settingMaxConcurrent.value, 10) : 4,
    autoRebuild: settingAutoRebuild ? settingAutoRebuild.checked : true
  };

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const data = await chrome.storage.local.get('settings').catch(() => ({}));
      await chrome.storage.local.set({
        settings: { ...(data.settings || {}), ...updated }
      });
    } catch (e) {
      console.warn('Failed saving settings:', e);
    }
  }

  updateSidebarIndicators(updated);

  if (showNotice && saveStatusFeedback) {
    saveStatusFeedback.textContent = '✓ Settings saved successfully!';
    saveStatusFeedback.style.color = 'var(--green-neon)';
    saveStatusFeedback.style.display = 'inline';
    clearTimeout(saveStatusFeedback._timeout);
    saveStatusFeedback._timeout = setTimeout(() => {
      saveStatusFeedback.style.display = 'none';
    }, 2500);
  }
}

async function resetSettingsToDefaults() {
  const confirmed = confirm('Reset all TurboSpeed settings to default configuration?');
  if (!confirmed) return;

  const defaults = { ...DEFAULT_SETTINGS };

  // 1. Update UI form controls
  if (settingTurboEnabled) settingTurboEnabled.checked = defaults.turboEnabled;
  if (settingAutoIntercept) settingAutoIntercept.checked = defaults.autoIntercept;
  if (settingVideoRightClick) settingVideoRightClick.checked = defaults.videoRightClick;
  if (settingThreads) settingThreads.value = String(defaults.threads);
  if (settingMinSize) settingMinSize.value = String(defaults.minSizeMB);
  if (settingNotifications) settingNotifications.checked = defaults.soundNotifications;
  if (settingMaxConcurrent) settingMaxConcurrent.value = String(defaults.maxConcurrentDownloads || 4);
  if (settingAutoRebuild) settingAutoRebuild.checked = defaults.autoRebuild !== false;

  // 2. Persist to Chrome storage
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      await chrome.storage.local.set({ settings: defaults });
    } catch (e) {
      console.warn('Failed resetting settings to storage:', e);
    }
  }

  // 3. Update sidebar telemetry & indicators
  updateSidebarIndicators(defaults);

  // 4. Broadcast event to popup & background service worker
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({
      type: 'SETTINGS_RESET',
      payload: defaults
    }).catch(() => {});
  }

  // 5. Visual confirmation feedback banner
  if (saveStatusFeedback) {
    saveStatusFeedback.textContent = '✓ Settings successfully reset to defaults!';
    saveStatusFeedback.style.color = 'var(--brand-primary)';
    saveStatusFeedback.style.display = 'inline';
    clearTimeout(saveStatusFeedback._timeout);
    saveStatusFeedback._timeout = setTimeout(() => {
      saveStatusFeedback.style.display = 'none';
      saveStatusFeedback.textContent = '✓ Settings saved successfully!';
      saveStatusFeedback.style.color = 'var(--green-neon)';
    }, 3000);
  }
}

function setupSettingsHandlers() {
  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', () => saveCurrentSettings(true));
  }

  if (btnResetSettings) {
    btnResetSettings.addEventListener('click', resetSettingsToDefaults);
  }

  // Auto-save on any change so settings never get stuck or lost
  [settingTurboEnabled, settingAutoIntercept, settingVideoRightClick, settingNotifications].forEach(el => {
    if (el) el.addEventListener('change', () => saveCurrentSettings(false));
  });

  if (settingThreads) {
    settingThreads.addEventListener('change', () => saveCurrentSettings(false));
  }

  if (settingMinSize) {
    settingMinSize.addEventListener('change', () => saveCurrentSettings(false));
  }

  if (settingMaxConcurrent) {
    settingMaxConcurrent.addEventListener('change', () => saveCurrentSettings(false));
  }
  if (settingAutoRebuild) {
    settingAutoRebuild.addEventListener('change', () => saveCurrentSettings(false));
  }

  // GitHub Repository Link Handler (Image Only)
  const githubRepoLink = document.querySelector('.github-image-only-link, .github-repo-link');
  if (githubRepoLink) {
    githubRepoLink.addEventListener('click', (e) => {
      e.preventDefault();
      const targetUrl = 'https://github.com/arunkumarjust97-arch/turbo-download-extension.git';
      if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
        chrome.tabs.create({ url: targetUrl });
      } else {
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
      }
    });
  }

  // Support Email Copy Handler
  const btnCopySupportEmail = document.getElementById('btnCopySupportEmail');
  const copyEmailText = document.getElementById('copyEmailText');
  if (btnCopySupportEmail) {
    btnCopySupportEmail.addEventListener('click', async () => {
      const email = 'devteam.official@myyahoo.com';
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(email);
          copied = true;
        }
      } catch (_) {}

      if (!copied) {
        try {
          const ta = document.createElement('textarea');
          ta.value = email;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          copied = true;
        } catch (_) {}
      }

      if (copied) {
        if (copyEmailText) copyEmailText.textContent = '✓ Copied!';
        btnCopySupportEmail.classList.add('copied');
        setTimeout(() => {
          if (copyEmailText) copyEmailText.textContent = 'Copy Email';
          btnCopySupportEmail.classList.remove('copied');
        }, 2200);
      } else {
        prompt('Copy support email:', email);
      }
    });
  }

  // Clear History Button
  if (btnClearHistory) {
    btnClearHistory.addEventListener('click', async () => {
      if (confirm('Are you sure you want to clear your accelerated download history?')) {
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          await chrome.storage.local.set({ history: [] });
        }
        await loadHistory();
      }
    });
  }
}

// ==========================================
// MaxiMux Queue UI Update
// ==========================================
function updateMaxiMuxUI(payload) {
  if (!payload) return;
  const { active = 0, queued = 0, maxConcurrent = 4 } = payload;
  maximuxActive = active;
  maximuxMax = maxConcurrent;
  maximuxQueued = queued;

  // Update sidebar count
  const countEl = document.getElementById('maximuxActiveCount');
  if (countEl) countEl.textContent = active;

  // Update slot bars
  for (let i = 0; i < 4; i++) {
    const slot = document.getElementById(`maximuxSlot${i}`);
    if (slot) {
      slot.classList.toggle('active', i < active);
      slot.classList.remove('rebuilding');
    }
  }

  // Update status dot color
  const dot = document.getElementById('maximuxStatusDot');
  if (dot) {
    if (active >= maxConcurrent) {
      dot.style.background = '#f43f5e';
      dot.style.boxShadow = '0 0 8px rgba(244,63,94,0.5)';
    } else if (active > 0) {
      dot.style.background = '#6366f1';
      dot.style.boxShadow = '0 0 8px rgba(99,102,241,0.5)';
    } else {
      dot.style.background = '#10b981';
      dot.style.boxShadow = '0 0 8px rgba(16,185,129,0.5)';
    }
  }

  // Update thread split info
  const threadInfo = document.getElementById('maximuxThreadsInfo');
  if (threadInfo) {
    if (active > 1) {
      const baseThreads = parseInt(document.getElementById('settingThreads')?.value || '8', 10);
      const perDl = Math.max(2, Math.floor(baseThreads / active));
      threadInfo.textContent = `${perDl} threads/download (${active} active)`;
    } else if (active === 1) {
      const baseThreads = parseInt(document.getElementById('settingThreads')?.value || '8', 10);
      threadInfo.textContent = `${baseThreads} threads (1 active)`;
    } else {
      threadInfo.textContent = 'Ready · Dynamic thread split';
    }
  }

  // Show/hide queue full banner
  const banner = document.getElementById('maximuxQueueBanner');
  if (banner) {
    if (active >= maxConcurrent) {
      banner.style.display = 'flex';
      const bannerText = document.getElementById('maximuxQueueText');
      if (bannerText) {
        bannerText.textContent = `MaxiMux: ${active}/${maxConcurrent} slots active · New downloads are auto-cancelled until a slot frees`;
      }
    } else {
      banner.style.display = 'none';
    }
  }
}

// ==========================================
// Chunk Retry Error Display
// ==========================================
/**
 * Injects an inline warning alert into the matching download row in the
 * active table to surface chunk retry errors to the user visually.
 */
function showChunkRetryAlert(info) {
  if (!info) return;
  const { id, chunkId, attempt, maxAttempts, error, delayMs } = info;

  // Find the row for this download
  const row = document.getElementById(`tbl_row_${id}`);
  if (!row) return;

  // Remove any existing retry alert on this row
  const existing = row.querySelector('.chunk-retry-alert');
  if (existing) existing.remove();

  // Build alert element
  const alert = document.createElement('td');
  alert.colSpan = 7;
  alert.className = 'chunk-retry-alert-cell';
  alert.innerHTML = `
    <div class="chunk-retry-alert">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
      </svg>
      <span>
        <strong>Chunk ${chunkId} failed — retrying (${attempt}/${maxAttempts})</strong>
        &nbsp;·&nbsp;${error}
        &nbsp;·&nbsp;retrying in ${(delayMs / 1000).toFixed(1)}s
      </span>
      <button class="chunk-retry-dismiss" title="Dismiss">✕</button>
    </div>
  `;

  // Insert as a new row directly after the download row
  const alertRow = document.createElement('tr');
  alertRow.className = 'chunk-retry-row';
  alertRow.id = `retry_alert_${id}`;
  alertRow.appendChild(alert);

  // Replace any existing retry row for this download
  const existingRow = document.getElementById(`retry_alert_${id}`);
  if (existingRow) existingRow.remove();

  row.insertAdjacentElement('afterend', alertRow);

  // Dismiss button
  alertRow.querySelector('.chunk-retry-dismiss')?.addEventListener('click', () => {
    alertRow.style.opacity = '0';
    alertRow.style.transition = 'opacity 0.3s ease';
    setTimeout(() => alertRow.remove(), 320);
  });

  // Auto-dismiss after 6 seconds
  setTimeout(() => {
    if (alertRow.isConnected) {
      alertRow.style.opacity = '0';
      alertRow.style.transition = 'opacity 0.4s ease';
      setTimeout(() => { if (alertRow.isConnected) alertRow.remove(); }, 420);
    }
  }, 6000);
}

/**
 * Injects a permanent RED error alert into the download row when all retries
 * are exhausted. Does NOT auto-dismiss — user must close it manually.
 */
function showChunkFailedAlert(info) {
  if (!info) return;
  const { id, chunkId, maxAttempts, error } = info;

  const row = document.getElementById(`tbl_row_${id}`);
  if (!row) return;

  // Remove any soft retry alert (it's now superseded by this permanent failure)
  const retryRow = document.getElementById(`retry_alert_${id}`);
  if (retryRow) retryRow.remove();

  // Build permanent failure alert
  const alertTd = document.createElement('td');
  alertTd.colSpan = 7;
  alertTd.className = 'chunk-failed-alert-cell';
  alertTd.innerHTML = `
    <div class="chunk-failed-alert">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
      </svg>
      <span>
        <strong>❌ Chunk ${chunkId} permanently failed</strong>
        &nbsp;— all ${maxAttempts} retries exhausted
        &nbsp;·&nbsp;${error}
      </span>
      <button class="chunk-failed-dismiss" title="Dismiss">✕</button>
    </div>
  `;

  const alertRow = document.createElement('tr');
  alertRow.className = 'chunk-failed-row';
  alertRow.id = `failed_alert_${id}`;
  alertRow.appendChild(alertTd);

  // Remove any prior failed alert for this download
  const existingFailed = document.getElementById(`failed_alert_${id}`);
  if (existingFailed) existingFailed.remove();

  row.insertAdjacentElement('afterend', alertRow);

  // Manual dismiss only — no auto-dismiss for permanent failures
  alertRow.querySelector('.chunk-failed-dismiss')?.addEventListener('click', () => {
    alertRow.style.opacity = '0';
    alertRow.style.transition = 'opacity 0.3s ease';
    setTimeout(() => alertRow.remove(), 320);
  });
}


async function loadHistory() {
  let history = [];
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const data = await chrome.storage.local.get('history');
      history = data.history || [];
    } catch (e) {
      console.warn('History read warning:', e);
    }
  } else {
    // Preview demo history
    history = [
      {
        id: 'turbo_hist_1',
        filename: 'Fedora-Workstation-40.iso',
        totalBytes: 2147483648,
        duration: '52.4',
        averageSpeed: 41943040,
        completedAt: Date.now() - 3600000
      },
      {
        id: 'turbo_hist_2',
        filename: 'Node-v22-win-x64.zip',
        totalBytes: 73400320,
        duration: '2.8',
        averageSpeed: 26214400,
        completedAt: Date.now() - 7200000
      }
    ];
  }

  totalHistoryBytes = history.reduce((acc, h) => acc + (h.totalBytes || 0), 0);
  if (navHistoryBadge) navHistoryBadge.textContent = history.length;
  updateTelemetrySummaries();

  if (!historyTableBody) return;

  if (history.length === 0) {
    historyTableBody.innerHTML = '';
    if (noHistoryPlaceholder) noHistoryPlaceholder.style.display = 'block';
    return;
  }

  if (noHistoryPlaceholder) noHistoryPlaceholder.style.display = 'none';

  historyTableBody.innerHTML = history.map(item => {
    const dateStr = new Date(item.completedAt).toLocaleString();
    const sizeStr = formatBytes(item.totalBytes);
    const speedStr = formatSpeed(item.averageSpeed);

    return `
      <tr>
        <td>
          <div class="table-file-col">
            <div class="file-badge-icon">
              <svg viewBox="0 0 24 24">
                <path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/>
              </svg>
            </div>
            <div class="file-text-col">
              <span class="tbl-filename" title="${item.filename}">${item.filename}</span>
              <span class="tbl-url">ID: ${item.id}</span>
            </div>
          </div>
        </td>
        <td><strong>${sizeStr}</strong></td>
        <td style="color: var(--cyan-glow); font-family: 'JetBrains Mono'; font-weight: 600;">${speedStr}</td>
        <td>${item.duration}s</td>
        <td style="color: var(--text-muted); font-size: 11px;">${dateStr}</td>
        <td>
          <div class="tbl-actions">
            ${item.downloadItemId ? `
              <button class="action-btn-sm btn-open-file" data-id="${item.downloadItemId}" title="Open containing folder">
                Show in Folder
              </button>
            ` : ''}
            <button class="action-btn-sm btn-del-history-item" data-id="${item.id}" title="Remove entry" style="color: var(--pink-neon);">
              Delete
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// ==========================================
// Active Downloads & Segment Queue
// ==========================================
let managerDemoState = {
  total: 104857600,
  downloaded: 47185920,
  speed: 28311552,
  lastTick: performance.now()
};

async function fetchActiveTransfers() {
  const merged = new Map();
  const now = performance.now();

  // 1. Preview demo fallback only if completely outside Chrome extension context
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
    const elapsedSec = (now - managerDemoState.lastTick) / 1000;
    managerDemoState.lastTick = now;

    const noise = Math.sin(now / 400) * 0.25;
    managerDemoState.speed = Math.max(12 * 1024 * 1024, 26 * 1024 * 1024 * (1 + noise));
    managerDemoState.downloaded = Math.min(managerDemoState.total, managerDemoState.downloaded + managerDemoState.speed * elapsedSec);
    if (managerDemoState.downloaded >= managerDemoState.total) {
      managerDemoState.downloaded = 0;
    }

    const pct = (managerDemoState.downloaded / managerDemoState.total) * 100;
    const remaining = managerDemoState.total - managerDemoState.downloaded;
    const eta = managerDemoState.speed > 0 ? Math.ceil(remaining / managerDemoState.speed) : 0;

    activeDownloads.set('demo_active_1', {
      id: 'demo_active_1',
      url: 'https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso',
      filename: 'ubuntu-24.04-desktop-amd64.iso',
      status: 'downloading',
      totalBytes: managerDemoState.total,
      downloadedBytes: Math.floor(managerDemoState.downloaded),
      percent: pct,
      speed: managerDemoState.speed,
      etaSeconds: eta,
      chunks: Array.from({ length: 8 }).map((_, i) => {
        const cSize = managerDemoState.total / 8;
        const cDone = Math.min(cSize, Math.max(0, managerDemoState.downloaded - (i * cSize)));
        return {
          id: i,
          total: cSize,
          downloaded: cDone,
          percent: Math.min(100, (cDone / cSize) * 100)
        };
      })
    });

    renderActiveTable();
    updateTelemetrySummaries();
    return;
  }

  // 2. Query Native Chrome Downloads
  if (typeof chrome !== 'undefined' && chrome.downloads?.search) {
    try {
      const items = await chrome.downloads.search({ state: 'in_progress' });
      const currentIds = new Set();

      for (const item of items) {
        currentIds.add(item.id);
        if (item.url && item.url.startsWith('blob:')) continue;

        let tracker = managerSpeedTracker.get(item.id);
        if (!tracker || !Array.isArray(tracker.samples)) {
          tracker = {
            samples: [{ time: now, bytes: item.bytesReceived || 0 }],
            speed: 0
          };
          managerSpeedTracker.set(item.id, tracker);
        } else {
          tracker.samples.push({ time: now, bytes: item.bytesReceived || 0 });
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
              tracker.speed = 0.35 * measured + 0.65 * tracker.speed;
            } else if ((now - oldest.time) > 1600) {
              tracker.speed = tracker.speed * 0.85;
              if (tracker.speed < 1024) tracker.speed = 0;
            }
          }
          managerSpeedTracker.set(item.id, tracker);
        }

        let speed = tracker.speed;
        const total = item.totalBytes > 0 ? item.totalBytes : (item.bytesReceived || 0);
        const downloaded = item.bytesReceived || 0;
        const percent = total > 0 ? Math.min(100, (downloaded / total) * 100) : 0;
        const remaining = Math.max(0, total - downloaded);
        const eta = speed > 0 ? Math.ceil(remaining / speed) : 0;

        let filename = 'Downloading file...';
        if (item.filename) {
          filename = item.filename.split(/[\\/]/).pop();
        } else if (item.url) {
          try {
            const parsed = new URL(item.url);
            filename = decodeURIComponent(parsed.pathname.substring(parsed.pathname.lastIndexOf('/') + 1)) || 'download';
          } catch {
            filename = 'download';
          }
        }

        const key = 'browser_' + item.id;
        merged.set(key, {
          id: key,
          nativeId: item.id,
          url: item.url,
          filename: filename,
          status: item.paused ? 'paused' : 'downloading',
          totalBytes: total,
          downloadedBytes: downloaded,
          percent: percent,
          speed: speed,
          etaSeconds: eta,
          isNative: true,
          chunks: Array.from({ length: 8 }).map((_, t) => {
            const chunkSize = total > 0 ? Math.floor(total / 8) : 0;
            const chunkDone = total > 0 ? Math.min(chunkSize, Math.max(0, downloaded - (t * chunkSize))) : 0;
            return {
              id: t,
              total: chunkSize,
              downloaded: chunkDone,
              percent: chunkSize > 0 ? Math.min(100, (chunkDone / chunkSize) * 100) : percent
            };
          })
        });
      }

      for (const id of managerSpeedTracker.keys()) {
        if (!currentIds.has(id)) {
          managerSpeedTracker.delete(id);
        }
      }
    } catch (e) {}
  }

  // 3. Query Service Worker Status
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
          if (chrome.runtime.lastError || !response) resolve(null);
          else resolve(response);
        });
      });

      if (res && Array.isArray(res.active)) {
        res.active.forEach(swItem => {
          if (swItem.id) {
            const existing = merged.get(swItem.id);
            if (existing) {
              if (existing.speed === 0 && swItem.speed > 0) {
                existing.speed = swItem.speed;
                const tr = managerSpeedTracker.get(existing.nativeId);
                if (tr) tr.speed = swItem.speed;
              }
            } else {
              merged.set(swItem.id, swItem);
            }
          }
        });
      }
    } catch (e) {}
  }

  // Reconcile into activeDownloads
  const currentKeys = new Set(merged.keys());
  for (const id of activeDownloads.keys()) {
    if (!currentKeys.has(id)) {
      activeDownloads.delete(id);
    }
  }

  for (const [id, item] of merged) {
    activeDownloads.set(id, item);
  }

  // Update MaxiMux slot count from active turbo downloads
  const activeTurboCount = Array.from(activeDownloads.values()).filter(d => !d.isNative).length;
  updateMaxiMuxUI({ active: activeTurboCount, queued: 0, maxConcurrent: maximuxMax });

  renderActiveTable();
  updateTelemetrySummaries();
}

function renderActiveTable() {
  if (!activeTableBody) return;

  let items = Array.from(activeDownloads.values());
  const query = searchActiveInput?.value?.trim().toLowerCase() || '';
  if (query) {
    items = items.filter(i => (i.filename || '').toLowerCase().includes(query) || (i.url || '').toLowerCase().includes(query));
  }

  if (navActiveBadge) navActiveBadge.textContent = items.length;

  if (items.length === 0) {
    activeTableBody.innerHTML = '';
    if (noActivePlaceholder) noActivePlaceholder.style.display = 'block';
    return;
  }

  if (noActivePlaceholder) noActivePlaceholder.style.display = 'none';

  activeTableBody.innerHTML = items.map(item => {
    const percent = (item.percent || 0).toFixed(1);
    const speedStr = formatSpeed(item.speed);
    const etaStr = formatSeconds(item.etaSeconds);
    const sizeStr = `${formatBytes(item.downloadedBytes)} / ${formatBytes(item.totalBytes)}`;

    // MaxiMux badges
    const isRebuild = item.isRebuild;
    const slotNum = item.concurrentSlot;
    const dynamicThreads = item.dynamicThreads;
    const slotBadge = slotNum ? `<span class="slot-badge">SLOT ${slotNum}/${maximuxMax}</span>` : '';
    const rebuildBadge = isRebuild ? `<span class="rebuild-badge">🔄 REBUILD</span>` : '';
    const threadBadge = dynamicThreads ? `<span class="slot-badge">${dynamicThreads}T</span>` : '';

    let threadCells = '';
    if (item.chunks && item.chunks.length > 0) {
      threadCells = item.chunks.map(c => `
        <div class="tbl-thread-cell" title="Thread ${c.id + 1}: ${formatBytes(c.downloaded)}/${formatBytes(c.total)}">
          <div class="tbl-thread-fill" style="width: ${c.percent || 0}%"></div>
        </div>
      `).join('');
    }

    return `
      <tr id="tbl_row_${item.id}">
        <td>
          <div class="table-file-col">
            <div class="file-badge-icon">
              <svg viewBox="0 0 24 24">
                <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/>
              </svg>
            </div>
            <div class="file-text-col">
              <span class="tbl-filename" title="${item.filename}">${item.filename}${slotBadge}${threadBadge}${rebuildBadge}</span>
              <span class="tbl-url" title="${item.url}">${item.url}</span>
            </div>
          </div>
        </td>
        <td style="width: 140px;">
          <div style="font-size: 11px; font-weight: 700; margin-bottom: 4px; display: flex; justify-content: space-between;">
            <span>${percent}%</span>
            <span style="color: var(--cyan-glow);">${item.status}</span>
          </div>
          <div style="height: 5px; background: rgba(99, 102, 241, 0.1); border-radius: 4px; overflow: hidden;">
            <div style="height: 100%; width: ${percent}%; background: var(--brand-gradient);"></div>
          </div>
        </td>
        <td style="font-family: 'JetBrains Mono'; font-size: 12px;">${sizeStr}</td>
        <td style="color: var(--cyan-glow); font-family: 'JetBrains Mono'; font-weight: 600;">${speedStr}</td>
        <td style="font-family: 'JetBrains Mono'; color: var(--text-secondary);">${etaStr}</td>
        <td>
          <div class="tbl-threads-grid">
            ${threadCells}
          </div>
        </td>
        <td>
          <div class="tbl-actions">
            ${item.status === 'downloading' ? `
              <button class="action-btn-sm btn-tbl-pause" data-id="${item.id}">Pause</button>
            ` : `
              <button class="action-btn-sm btn-tbl-resume" data-id="${item.id}">Resume</button>
            `}
            <button class="action-btn-sm btn-tbl-cancel" data-id="${item.id}" style="color: var(--pink-neon);">Cancel</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// ==========================================
// Event Delegation for Tables
// ==========================================
function setupTableDelegation() {
  if (activeTableBody) {
    activeTableBody.addEventListener('click', (e) => {
      const pauseBtn = e.target.closest('.btn-tbl-pause');
      if (pauseBtn) {
        const id = pauseBtn.dataset.id;
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({ type: 'PAUSE_TURBO_DOWNLOAD', payload: { id } }).catch(() => {});
        }
        const item = activeDownloads.get(id);
        if (item) {
          item.status = 'paused';
          renderActiveTable();
        }
        return;
      }

      const resumeBtn = e.target.closest('.btn-tbl-resume');
      if (resumeBtn) {
        const id = resumeBtn.dataset.id;
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({ type: 'RESUME_TURBO_DOWNLOAD', payload: { id } }).catch(() => {});
        }
        const item = activeDownloads.get(id);
        if (item) {
          item.status = 'downloading';
          renderActiveTable();
        }
        return;
      }

      const cancelBtn = e.target.closest('.btn-tbl-cancel');
      if (cancelBtn) {
        const id = cancelBtn.dataset.id;
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({ type: 'CANCEL_TURBO_DOWNLOAD', payload: { id } }).catch(() => {});
        }
        activeDownloads.delete(id);
        renderActiveTable();
        return;
      }
    });
  }

  if (historyTableBody) {
    historyTableBody.addEventListener('click', async (e) => {
      // Show in Folder
      const openBtn = e.target.closest('.btn-open-file');
      if (openBtn) {
        const id = parseInt(openBtn.dataset.id, 10);
        if (id && typeof chrome !== 'undefined' && chrome.downloads?.show) {
          chrome.downloads.show(id);
        }
        return;
      }

      // Delete single item from history
      const delBtn = e.target.closest('.btn-del-history-item');
      if (delBtn) {
        const id = delBtn.dataset.id;
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          try {
            const data = await chrome.storage.local.get('history');
            const history = (data.history || []).filter(h => h.id !== id);
            await chrome.storage.local.set({ history });
          } catch (err) {
            console.warn(err);
          }
        }
        await loadHistory();
      }
    });
  }
}

// ==========================================
// Telemetry Summaries & Waveform
// ==========================================
function updateTelemetrySummaries() {
  let aggregateSpeed = 0;
  let aggregateDownloaded = 0;

  activeDownloads.forEach(d => {
    if (d.speed) aggregateSpeed += d.speed;
    if (d.downloadedBytes) aggregateDownloaded += d.downloadedBytes;
  });

  if (topbarSpeed) topbarSpeed.textContent = formatSpeed(aggregateSpeed);
  if (chartInstantSpeed) chartInstantSpeed.textContent = formatSpeed(aggregateSpeed);
  if (topbarTotalDownloaded) {
    topbarTotalDownloaded.textContent = formatBytes(totalHistoryBytes + aggregateDownloaded);
  }

  if (aggregateSpeed > peakSpeed) {
    peakSpeed = aggregateSpeed;
    if (chartPeakSpeed) chartPeakSpeed.textContent = formatSpeed(peakSpeed);
  }

  speedHistory.push(aggregateSpeed);
  if (speedHistory.length > 60) {
    speedHistory.shift();
  }
}

function updateWaveform() {
  if (!ctx || !canvas || currentView !== 'active') return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Background grid
  ctx.strokeStyle = 'rgba(99, 102, 241, 0.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += 25) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Waveform line
  const maxVal = Math.max(peakSpeed, 1024 * 1024 * 2); // At least 2MB scale
  const step = w / (speedHistory.length - 1);

  ctx.beginPath();
  ctx.moveTo(0, h);

  for (let i = 0; i < speedHistory.length; i++) {
    const val = speedHistory[i];
    const x = i * step;
    const y = h - (val / maxVal) * (h - 20) - 10;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 2.5;
  ctx.shadowColor = 'rgba(99, 102, 241, 0.4)';
  ctx.shadowBlur = 8;
  ctx.stroke();

  // Gradient fill underneath
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();

  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, 'rgba(99, 102, 241, 0.18)');
  gradient.addColorStop(1, 'rgba(124, 58, 237, 0.0)');
  ctx.fillStyle = gradient;
  ctx.shadowBlur = 0;
  ctx.fill();
}

// ==========================================
// Bulletproof Launch - Handles readyState
// ==========================================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDashboard);
} else {
  initDashboard();
}
