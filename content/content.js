/* global chrome */
/**
 * TurboSpeed Downloader - Content Script
 * High-speed network preconnection, heavy file download detection,
 * universal video right-click download detection, and automatic download acceleration.
 * Accelerates all media and heavy files: MP4, WebM, AVI, MKV, MOV, TS, software, archives, and datasets.
 */

const HEAVY_FILE_EXTENSIONS = new Set([
  // Compressed & Archives
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'zst', 'lz4', 'lzma', 'cab', 'arj',
  // Software, Installers & Binaries
  'exe', 'msi', 'msp', 'msu', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'xapk', 'apkm', 'aab', 'ipa', 'appimage',
  'bin', 'run', 'crx', 'xpi', 'jar', 'war', 'ear', 'msix', 'appx', 'cmd', 'bat',
  // Disk Images & Virtualization
  'iso', 'img', 'vmdk', 'vdi', 'vhd', 'vhdx', 'qcow2', 'ova', 'ovf', 'wim', 'esd', 'toast', 'cue',
  // AI Models, Large Datasets & Databases
  'gguf', 'safetensors', 'onnx', 'pt', 'pth', 'ckpt', 'h5', 'pb', 'tflite', 'parquet', 'arrow', 'feather',
  'dump', 'sql', 'sqlite', 'db', 'mdf', 'bak',
  // Media & Video Files
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'm2ts', 'vob', 'mpg', 'mpeg', '3gp',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus', 'wma',
  // Heavy Design & 3D Assets
  'psd', 'ai', 'blend', 'fbx', 'obj', 'stl', 'dae', 'unityweb', 'pak', 'obb', 'assetbundle',
  // Heavy Documents
  'pdf', 'epub', 'mobi', 'torrent'
]);

const preconnectedOrigins = new Set();
let toastEl = null;
let toastTimeout = null;
let lastDetectedMedia = null; // { url, filename, title, time }
const capturedMediaUrls = new Map(); // url -> { time, initiatorType, size }

function isVideoResourceUrl(url, initiatorType) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('javascript:')) return false;

  const lower = url.toLowerCase();

  // 1. Explicit video/audio extensions in pathname or query
  if (/\.(mp4|webm|mkv|mov|avi|ts|m4v|flv|m4s|m3u8|mpd|mp3|m4a|aac|wav|ogg)(\?|$)/i.test(lower)) {
    return true;
  }

  // 2. Video streaming endpoints and CDN patterns
  if (
    lower.includes('videoplayback') ||
    lower.includes('/video/') ||
    lower.includes('/videos/') ||
    lower.includes('mime=video') ||
    lower.includes('mime=audio') ||
    lower.includes('/stream/') ||
    lower.includes('format=mp4') ||
    lower.includes('format=webm') ||
    lower.includes('itag=') ||
    lower.includes('video_url=') ||
    lower.includes('/media/') ||
    lower.includes('master.m3u8') ||
    lower.includes('index.m3u8')
  ) {
    return true;
  }

  // 3. Performance entry initiator
  if (initiatorType === 'video' || initiatorType === 'audio') {
    return true;
  }

  return false;
}

function setupRealtimeMediaSniffer() {
  try {
    if (typeof PerformanceObserver !== 'undefined') {
      const perfObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (isVideoResourceUrl(entry.name, entry.initiatorType)) {
            capturedMediaUrls.set(entry.name, {
              time: Date.now(),
              initiatorType: entry.initiatorType,
              size: entry.transferSize || 0
            });
            // Pre-notify service worker of real stream
            safeSendMessage({
              type: 'RECORD_PAGE_MEDIA',
              payload: {
                url: entry.name,
                filename: extractMediaFilename(null, entry.name),
                title: document.title
              }
            });
          }
        }
      });
      perfObserver.observe({ entryTypes: ['resource'] });
    }
  } catch (e) {}

  // Also listen for any video playback starting on the page
  document.addEventListener('play', (e) => {
    if (e.target instanceof HTMLVideoElement || e.target instanceof HTMLAudioElement) {
      setTimeout(() => {
        const mediaUrl = extractMediaUrl(e.target);
        if (mediaUrl) {
          const filename = extractMediaFilename(e.target, mediaUrl);
          lastDetectedMedia = {
            url: mediaUrl,
            filename,
            title: document.title,
            time: Date.now()
          };
          safeSendMessage({
            type: 'RECORD_PAGE_MEDIA',
            payload: lastDetectedMedia
          });
        }
      }, 500);
    }
  }, true);
}

function init() {
  // Remove any floating video corner badges or overlay elements from all media players
  document.querySelectorAll('.turbospeed-floating-badge, .turbospeed-context-pill, .turbospeed-yt-backdrop').forEach(el => el.remove());

  createToast();
  setupRealtimeMediaSniffer();

  // Instant preconnection on pointer interaction, hover, or keyboard focus
  document.addEventListener('pointerover', handlePreconnectTrigger, { passive: true });
  document.addEventListener('mouseover', handlePreconnectTrigger, { passive: true });
  document.addEventListener('focusin', handlePreconnectTrigger, { passive: true });

  // Automatic download acceleration when ANY download button or link is pressed
  document.addEventListener('click', handleDownloadButtonClick, { capture: true, passive: true });

  // Universal Video Right-Click Detection & Anti-Blocker Handling (Capture Phase)
  window.addEventListener('contextmenu', handleContextMenuCapture, true);

  // Track pointer movements to pre-identify hovered video elements
  document.addEventListener('mousemove', handlePointerMoveTrack, { passive: true });

  // Listen for messages from background service worker
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'SHOW_TURBO_TOAST') {
        showToast(message.payload?.title, message.payload?.message);
      } else if (message.type === 'QUERY_PAGE_VIDEO') {
        const videoData = getBestPageVideo();
        sendResponse(videoData || { url: null });
        return false;
      }
    });
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isDownloadableUrl(url) {
  try {
    const parsed = new URL(url, window.location.href);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    const pathname = parsed.pathname.toLowerCase();
    const extMatch = pathname.match(/\.([a-z0-9]+)$/i);
    if (extMatch && HEAVY_FILE_EXTENSIONS.has(extMatch[1])) {
      return true;
    }

    // Match query-based or endpoint-based file downloads
    const search = parsed.search.toLowerCase();
    if (
      pathname.endsWith('/download') ||
      pathname.includes('/download/') ||
      pathname.includes('/releases/download/') ||
      pathname.includes('/get/') ||
      pathname.includes('/dl/') ||
      pathname.includes('/file/d/') ||
      search.includes('download=') ||
      search.includes('dl=1') ||
      search.includes('export=download') ||
      search.includes('response-content-disposition') ||
      search.includes('filename=') ||
      search.includes('attachment')
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function preconnectOrigin(href) {
  try {
    const origin = new URL(href, window.location.href).origin;
    if (origin && origin.startsWith('http') && !preconnectedOrigins.has(origin)) {
      preconnectedOrigins.add(origin);

      const dnsLink = document.createElement('link');
      dnsLink.rel = 'dns-prefetch';
      dnsLink.href = origin;
      document.head.appendChild(dnsLink);

      const preLink = document.createElement('link');
      preLink.rel = 'preconnect';
      preLink.href = origin;
      preLink.crossOrigin = 'anonymous';
      document.head.appendChild(preLink);
    }
  } catch (e) {}
}

function handlePreconnectTrigger(e) {
  const target = e.target.closest('a, button, [data-download], [role="button"]');
  if (!target) return;

  const href = target.href || target.getAttribute('href') || target.dataset?.downloadUrl;
  if (!href) return;

  if (isDownloadableUrl(href) || target.hasAttribute('download')) {
    preconnectOrigin(href);
  }
}

function handleDownloadButtonClick(e) {
  const target = e.target.closest('a, button, [role="button"], input[type="submit"], input[type="button"], [data-download]');
  if (!target) return;

  const href = target.href || target.getAttribute('href') || target.dataset?.downloadUrl;
  const text = (target.textContent || target.value || target.title || target.getAttribute('aria-label') || '').toLowerCase().trim();

  const isDownloadAction = target.hasAttribute('download') ||
    /\b(download|get file|install|download now|direct download|download free|download zip|download iso|download 64-bit|download 32-bit)\b/i.test(text) ||
    (href && isDownloadableUrl(href));

  if (isDownloadAction) {
    if (href) {
      preconnectOrigin(href);
      safeSendMessage({
        type: 'PREPARE_TURBO_INTERCEPT',
        payload: { url: href }
      });
    }

    // Also detect if button is inside or near a video/audio player container
    const mediaContainer = target.closest(
      '.video-js, .jwplayer, .plyr, .html5-video-player, [data-player], [class*="player"], [id*="player"], [class*="video"], figure, article'
    );
    if (mediaContainer && !href) {
      const v = mediaContainer.querySelector('video, audio');
      if (v) {
        const resolved = extractMediaUrl(v);
        if (resolved) {
          preconnectOrigin(resolved);
          safeSendMessage({
            type: 'PREPARE_TURBO_INTERCEPT',
            payload: { url: resolved }
          });
        }
      }
    }

    showToast(
      '⚡ TurboSpeed Accelerated',
      'Accelerating download with multi-threaded speed boost automatically!'
    );
  }
}

// ==============================================================
// Universal Video Sniffer & Right-Click Downloader
// ==============================================================

/**
 * Finds any <video> or <audio> element at pointer coordinates,
 * penetrating through player overlay <div>s, control bars, and wrappers.
 */
function findVideoElementAt(e) {
  // 1. Direct target is video or audio
  if (e.target instanceof HTMLVideoElement || e.target instanceof HTMLAudioElement) {
    return e.target;
  }

  // 2. Direct target is an iframe embed (e.g. YouTube / Vimeo iframe)
  if (e.target instanceof HTMLIFrameElement || e.target?.tagName === 'IFRAME') {
    return e.target;
  }

  // Helper: check if element contains point with padding
  const containsPoint = (el, pad = 24) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 &&
      e.clientX >= (r.left - pad) && e.clientX <= (r.right + pad) &&
      e.clientY >= (r.top - pad) && e.clientY <= (r.bottom + pad);
  };

  // 3. Traversal through composedPath (handles shadow DOM, nested buttons, overlay wrappers)
  if (e.composedPath) {
    const path = e.composedPath();
    for (const el of path) {
      if (el instanceof HTMLVideoElement || el instanceof HTMLAudioElement || el instanceof HTMLIFrameElement) {
        return el;
      }
      if (el instanceof HTMLElement && el !== document.body && el !== document.documentElement) {
        const child = el.querySelector('video, audio, iframe');
        if (child && containsPoint(child, 40)) {
          return child;
        }
      }
    }
  }

  // 4. Penetrate through transparent overlays using elementsFromPoint
  if (typeof document.elementsFromPoint === 'function') {
    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    for (const el of elements) {
      if (el instanceof HTMLVideoElement || el instanceof HTMLAudioElement || el instanceof HTMLIFrameElement) {
        return el;
      }
      if (el instanceof HTMLElement && el !== document.body && el !== document.documentElement) {
        const child = el.querySelector('video, audio, iframe');
        if (child && containsPoint(child, 40)) {
          return child;
        }
      }
    }
  }

  // 5. Bounding box check across all videos on the page
  const allVideos = document.querySelectorAll('video, audio, iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="embed"]');
  for (const v of allVideos) {
    if (containsPoint(v, 10)) {
      return v;
    }
  }

  // 6. Check if inside a known video player container
  const playerContainer = e.target.closest(
    '.video-js, .jwplayer, .plyr, .html5-video-player, [data-player], [class*="player"], [id*="player"], [class*="video"], figure, article'
  );
  if (playerContainer) {
    const v = playerContainer.querySelector('video, audio, iframe');
    if (v) return v;
  }

  return null;
}

/**
 * Resolves the absolute playable/downloadable URL from a video element.
 */
/**
 * Resolves the absolute playable/downloadable URL from a video element.
 * Intelligently penetrates blob: wrappers to discover real direct MP4/WebM/Media URLs.
 */
function extractMediaUrl(mediaEl) {
  if (!mediaEl) return null;

  const isUsable = (s) => s && typeof s === 'string' &&
    !s.startsWith('blob:') && !s.startsWith('data:') && !s.startsWith('mediasource:') &&
    !s.startsWith('javascript:');

  // Handle iframe embeds (e.g. embedded YouTube player)
  if (mediaEl instanceof HTMLIFrameElement || mediaEl.tagName === 'IFRAME') {
    const iframeSrc = mediaEl.src || mediaEl.getAttribute('src') || '';
    if (iframeSrc) {
      if (iframeSrc.includes('youtube.com/embed/') || iframeSrc.includes('youtu.be/')) {
        const vid = getYouTubeVideoId(iframeSrc);
        if (vid) return `https://www.youtube.com/watch?v=${vid}`;
      }
    }
    return null;
  }

  let src = null;

  // 1. Check currentSrc if it is a real downloadable URL (not blob)
  if (isUsable(mediaEl.currentSrc)) {
    src = mediaEl.currentSrc;
  }

  // 2. Direct src attribute
  if (!src && isUsable(mediaEl.src)) {
    src = mediaEl.src;
  }

  // 3. Child <source> elements (prioritize mp4, webm, mkv)
  if (!src) {
    const sources = Array.from(mediaEl.querySelectorAll('source'));
    for (const s of sources) {
      const sSrc = s.src || s.getAttribute('src');
      if (isUsable(sSrc)) {
        src = sSrc;
        break;
      }
    }
  }

  // 4. Data attributes commonly used for lazy video players
  if (!src) {
    const dataCandidates = [
      mediaEl.dataset.src, mediaEl.dataset.videoUrl, mediaEl.dataset.original,
      mediaEl.dataset.mp4, mediaEl.dataset.file, mediaEl.dataset.stream,
      mediaEl.getAttribute('data-src'), mediaEl.getAttribute('data-url'),
      mediaEl.getAttribute('data-video-src'), mediaEl.getAttribute('data-mp4'),
      mediaEl.getAttribute('data-file')
    ];
    for (const candidate of dataCandidates) {
      if (isUsable(candidate)) {
        src = candidate;
        break;
      }
    }
  }

  // 5. Child <source> data attributes
  if (!src) {
    const sources = Array.from(mediaEl.querySelectorAll('source'));
    for (const s of sources) {
      const candidate = s.dataset.src || s.getAttribute('data-src') || s.getAttribute('data-video-src') || s.getAttribute('data-file');
      if (isUsable(candidate)) {
        src = candidate;
        break;
      }
    }
  }

  // 6. Enclosing link with direct video file
  if (!src && typeof mediaEl.closest === 'function') {
    const parentLink = mediaEl.closest('a[href]');
    if (parentLink && parentLink.href && isUsable(parentLink.href)) {
      const lowerHref = parentLink.href.toLowerCase().split('?')[0];
      if (lowerHref.endsWith('.mp4') || lowerHref.endsWith('.webm') || lowerHref.endsWith('.mkv') || lowerHref.endsWith('.mov') || lowerHref.endsWith('.avi')) {
        src = parentLink.href;
      }
    }
  }

  // 7. Inspect real-time captured video streams from network buffer
  if (!src && capturedMediaUrls.size > 0) {
    let latestUrl = null;
    let latestTime = 0;
    for (const [u, meta] of capturedMediaUrls.entries()) {
      if (meta.time > latestTime) {
        latestTime = meta.time;
        latestUrl = u;
      }
    }
    if (latestUrl) src = latestUrl;
  }

  // 8. Network Performance Buffer: If player wrapped stream in blob, inspect recent video resource requests
  if (!src && typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
    try {
      const resources = performance.getEntriesByType('resource');
      for (let i = resources.length - 1; i >= Math.max(0, resources.length - 150); i--) {
        const rName = resources[i].name;
        if (isUsable(rName) && isVideoResourceUrl(rName, resources[i].initiatorType)) {
          src = rName;
          break;
        }
      }
    } catch (_) {}
  }

  if (!src) return null;

  try {
    return new URL(src, window.location.href).href;
  } catch (e) {
    return src;
  }
}

/**
 * Generates a clean, sanitized filename for the video with appropriate extension.
 */
function extractMediaFilename(mediaEl, mediaUrl) {
  let title = '';

  if (mediaEl) {
    title = mediaEl.getAttribute('title') ||
            mediaEl.getAttribute('aria-label') ||
            mediaEl.getAttribute('alt') || '';

    if (!title) {
      const container = mediaEl.closest('article, section, [class*="post"], [class*="video"], [class*="player"], figure');
      if (container) {
        const heading = container.querySelector('h1, h2, h3, [class*="title"]');
        if (heading && heading.textContent.trim()) {
          title = heading.textContent.trim();
        }
      }
    }
  }

  if (!title) {
    title = document.title || 'video';
  }

  // Sanitize filename
  let clean = title
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);

  if (!clean) clean = 'video';

  // Determine media extension
  let ext = 'mp4';
  if (mediaUrl) {
    const lower = mediaUrl.toLowerCase().split('?')[0];
    if (lower.endsWith('.avi')) ext = 'avi';
    else if (lower.endsWith('.webm')) ext = 'webm';
    else if (lower.endsWith('.mkv')) ext = 'mkv';
    else if (lower.endsWith('.mov')) ext = 'mov';
    else if (lower.endsWith('.flv')) ext = 'flv';
    else if (lower.endsWith('.ts')) ext = 'ts';
    else if (lower.endsWith('.mp3')) ext = 'mp3';
    else if (lower.endsWith('.wav')) ext = 'wav';
    else if (lower.endsWith('.m4a')) ext = 'm4a';
    else if (lower.endsWith('.ogg')) ext = 'ogg';
  }

  if (!clean.toLowerCase().endsWith('.' + ext)) {
    clean += '.' + ext;
  }

  return clean;
}

function isYouTube() {
  return location.hostname.includes('youtube.com') || location.hostname.includes('youtu.be');
}

function getYouTubeVideoId(url = window.location.href) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtu.be')) {
      return parsed.pathname.slice(1).split('/')[0].split('?')[0];
    }
    if (parsed.pathname.includes('/shorts/')) {
      return parsed.pathname.split('/shorts/')[1].split('/')[0].split('?')[0];
    }
    if (parsed.pathname.includes('/embed/')) {
      return parsed.pathname.split('/embed/')[1].split('/')[0].split('?')[0];
    }
    return parsed.searchParams.get('v');
  } catch {
    return null;
  }
}

function getYouTubeTitle() {
  const el = document.querySelector('h1.ytd-watch-metadata, #title h1, h1.title, ytd-video-primary-info-renderer h1');
  let title = el?.textContent?.trim() || document.title || 'YouTube Video';
  return title.replace(/- YouTube$/i, '').trim();
}

/**
 * Find the best candidate video on the current page.
 */
function getBestPageVideo() {
  if (isYouTube()) {
    const vid = getYouTubeVideoId();
    if (vid) {
      return {
        url: window.location.href,
        isYouTube: true,
        videoId: vid,
        filename: getYouTubeTitle() + '.mp4',
        title: getYouTubeTitle()
      };
    }
  }

  // 1. Freshly detected right-click media (within 30s)
  if (lastDetectedMedia && (Date.now() - lastDetectedMedia.time) < 30000 && lastDetectedMedia.url) {
    return {
      url: lastDetectedMedia.url,
      filename: lastDetectedMedia.filename,
      title: lastDetectedMedia.title,
      isYouTube: lastDetectedMedia.isYouTube || false,
      videoId: lastDetectedMedia.videoId || null
    };
  }

  const videos = Array.from(document.querySelectorAll('video, audio'));

  // 2. Currently playing video
  const playing = videos.find(v => !v.paused && v.currentTime > 0);
  if (playing) {
    const url = extractMediaUrl(playing);
    if (url) {
      return { url, filename: extractMediaFilename(playing, url), title: document.title };
    }
  }

  // 3. First visible video in viewport
  const visible = videos.find(v => {
    const r = v.getBoundingClientRect();
    return r.width > 80 && r.height > 60 &&
           r.top < window.innerHeight && r.bottom > 0 &&
           r.left < window.innerWidth && r.right > 0;
  });
  if (visible) {
    const url = extractMediaUrl(visible);
    if (url) {
      return { url, filename: extractMediaFilename(visible, url), title: document.title };
    }
  }

  // 4. Any media on page
  for (const v of videos) {
    const url = extractMediaUrl(v);
    if (url) {
      return { url, filename: extractMediaFilename(v, url), title: document.title };
    }
  }

  // 5. Check real-time captured video streams from network PerformanceObserver
  if (capturedMediaUrls.size > 0) {
    let latestUrl = null;
    let latestTime = 0;
    for (const [u, meta] of capturedMediaUrls.entries()) {
      if (meta.time > latestTime) {
        latestTime = meta.time;
        latestUrl = u;
      }
    }
    if (latestUrl) {
      return {
        url: latestUrl,
        filename: extractMediaFilename(null, latestUrl),
        title: document.title
      };
    }
  }

  return null;
}

let lastPointerCheckTime = 0;
function handlePointerMoveTrack(e) {
  const now = Date.now();
  if (now - lastPointerCheckTime < 250) return;
  lastPointerCheckTime = now;

  if (isYouTube()) {
    const vid = getYouTubeVideoId();
    if (vid) {
      const ytTitle = getYouTubeTitle();
      lastDetectedMedia = {
        url: window.location.href,
        filename: ytTitle + '.mp4',
        title: ytTitle,
        isYouTube: true,
        videoId: vid,
        time: now
      };
      return;
    }
  }

  const videoEl = findVideoElementAt(e);
  if (videoEl) {
    const url = extractMediaUrl(videoEl);
    if (url) {
      const filename = extractMediaFilename(videoEl, url);
      lastDetectedMedia = { url, filename, title: document.title, time: now };
    }
  }
}

function safeSendMessage(message) {
  const cr = typeof window !== 'undefined' ? window.chrome : null;
  if (!cr || !cr.runtime?.id || !cr.runtime?.sendMessage) {
    return Promise.resolve(null);
  }
  try {
    return cr.runtime.sendMessage(message).catch(() => {});
  } catch (err) {
    return Promise.resolve(null);
  }
}

/**
 * Capture-phase right-click handler.
 * Seamlessly detects video streams under the pointer and sends metadata to the
 * background service worker so the native browser context menu item ("Turbo Download Video")
 * downloads it instantly, without any intrusive in-page pills or modal overlays.
 */
function handleContextMenuCapture(e) {
  // 1. YouTube Watch Page or Video Link Check
  if (isYouTube()) {
    const linkEl = e.target?.closest?.('a[href]');
    const targetHref = linkEl?.href || window.location.href;
    const vid = getYouTubeVideoId(targetHref) || getYouTubeVideoId(window.location.href);
    if (vid) {
      const ytTitle = (linkEl?.textContent?.trim() || getYouTubeTitle());
      lastDetectedMedia = {
        url: `https://www.youtube.com/watch?v=${vid}`,
        filename: ytTitle + '.mp4',
        title: ytTitle,
        isYouTube: true,
        videoId: vid,
        time: Date.now()
      };

      safeSendMessage({
        type: 'RECORD_RIGHT_CLICKED_MEDIA',
        payload: lastDetectedMedia
      });
      return;
    }
  }

  // 2. Direct Media Link Check (user right-clicked on an <a href="video.mp4"> or audio link)
  const linkEl = e.target?.closest?.('a[href]');
  if (linkEl && linkEl.href) {
    const cleanHref = linkEl.href.split('?')[0].toLowerCase();
    const ext = cleanHref.split('.').pop();
    if (HEAVY_FILE_EXTENSIONS.has(ext)) {
      const filename = extractMediaFilename(linkEl, linkEl.href);
      lastDetectedMedia = {
        url: linkEl.href,
        filename,
        title: document.title,
        time: Date.now()
      };
      safeSendMessage({
        type: 'RECORD_RIGHT_CLICKED_MEDIA',
        payload: lastDetectedMedia
      });
      return;
    }
  }

  // 3. Find video element directly under cursor or within player container
  let videoEl = findVideoElementAt(e);

  // 4. Fallback: if not directly over a video element, check for any active playing video on page
  if (!videoEl) {
    const playing = document.querySelector('video:not([paused]), audio:not([paused])');
    if (playing && playing.currentTime > 0) {
      videoEl = playing;
    }
  }

  if (!videoEl) return;

  // 5. Embedded YouTube iframe on external websites
  if (videoEl instanceof HTMLIFrameElement || videoEl.tagName === 'IFRAME') {
    const iframeSrc = videoEl.src || videoEl.getAttribute('src') || '';
    if (iframeSrc.includes('youtube.com/embed/') || iframeSrc.includes('youtu.be/')) {
      const vid = getYouTubeVideoId(iframeSrc);
      if (vid) {
        const title = document.title || 'YouTube Video';
        lastDetectedMedia = {
          url: `https://www.youtube.com/watch?v=${vid}`,
          filename: title + '.mp4',
          title,
          isYouTube: true,
          videoId: vid,
          time: Date.now()
        };
        safeSendMessage({
          type: 'RECORD_RIGHT_CLICKED_MEDIA',
          payload: lastDetectedMedia
        });
        return;
      }
    }
  }

  const mediaUrl = extractMediaUrl(videoEl);
  if (!mediaUrl) {
    // If user clicked on a blob: stream or MSE stream, record it as a protected stream
    // so background service worker provides helpful feedback instead of "No Video Detected"
    const rawSrc = videoEl.currentSrc || videoEl.src || '';
    if (rawSrc.startsWith('blob:') || rawSrc.startsWith('mediasource:')) {
      const filename = extractMediaFilename(videoEl, null);
      lastDetectedMedia = {
        url: 'blob:stream',
        filename,
        title: document.title,
        isBlobStream: true,
        time: Date.now()
      };
      safeSendMessage({
        type: 'RECORD_RIGHT_CLICKED_MEDIA',
        payload: {
          url: 'blob:stream',
          filename,
          title: document.title,
          isBlobStream: true
        }
      });
    }
    return;
  }

  const filename = extractMediaFilename(videoEl, mediaUrl);

  lastDetectedMedia = {
    url: mediaUrl,
    filename,
    title: document.title,
    time: Date.now()
  };

  // Transmit detected video to background service worker immediately
  safeSendMessage({
    type: 'RECORD_RIGHT_CLICKED_MEDIA',
    payload: {
      url: mediaUrl,
      filename,
      title: document.title
    }
  });
}

// ==============================================================
// Toast Notifications
// ==============================================================

function createToast() {
  if (toastEl) return;
  toastEl = document.createElement('div');
  toastEl.className = 'turbospeed-toast';
  toastEl.innerHTML = `
    <div class="turbospeed-toast-icon">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M13.5 2L4 13.5H11.5L9.5 22L20 9.5H13L14.5 2H13.5Z" fill="#ffea00" style="filter: drop-shadow(0 0 6px rgba(255, 234, 0, 0.9));"/>
      </svg>
    </div>
    <div class="turbospeed-toast-body">
      <div class="turbospeed-toast-title" id="toastTitle">TurboSpeed Active</div>
      <div class="turbospeed-toast-msg" id="toastMsg">Accelerating download...</div>
    </div>
  `;
  document.body.appendChild(toastEl);
}

function showToast(title, msg) {
  if (!toastEl) createToast();
  if (!toastEl) return;

  const titleEl = document.getElementById('toastTitle');
  const msgEl = document.getElementById('toastMsg');
  const cleanTitle = (title || 'TurboSpeed Active').replace(/^[⚡\s]+/, '').trim();
  if (titleEl) titleEl.textContent = cleanTitle || 'TurboSpeed Active';
  if (msgEl) msgEl.textContent = msg || 'Accelerating download at maximum multi-threaded speed...';

  toastEl.classList.add('show');

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastEl.classList.remove('show');
  }, 4000);
}

// Run when DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    init();
  });
} else {
  init();
}
