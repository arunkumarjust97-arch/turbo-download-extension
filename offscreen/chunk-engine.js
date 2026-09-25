/**
 * TurboSpeed Downloader - Multi-threaded Segmented Engine
 * Handles dynamic byte-range splitting, concurrent pipelining,
 * connection throttling bypass, and real-time telemetry.
 */

export class TurboChunkEngine {
  constructor(options = {}) {
    this.id = options.id || 'dl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    this.url = options.url;
    this.customFilename = options.filename;
    this.threadCount = Math.max(1, Math.min(32, options.threads || 8));
    this.onProgress = options.onProgress || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onError = options.onError || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onFallbackNative = options.onFallbackNative || (() => {});
    this.onChunkRetry = options.onChunkRetry || (() => {}); // Called when a chunk fails and is retried
    this.onChunkFailed = options.onChunkFailed || (() => {}); // Called when all chunk retries are exhausted

    this.status = 'idle'; // 'probing' | 'downloading' | 'paused' | 'assembling' | 'completed' | 'error' | 'cancelled'
    this.supportsRange = false;
    this.totalBytes = 0;
    this.downloadedBytes = 0;
    this.filename = this.customFilename || this._extractFilename(this.url);
    this.mimeType = 'application/octet-stream';
    this.blob = null;
    this.blobUrl = null;
    
    this.chunks = [];
    this.chunkBuffers = []; // Array of Uint8Array parts per chunk
    this.abortController = null;
    
    // Telemetry tracking
    this.lastTransferred = 0;
    this.lastTime = performance.now();
    this.currentSpeed = 0; // Bytes per second
    this.averageSpeed = 0;
    this.startTime = 0;
    this.progressTimer = null;
    this.responseLatencyMs = 0;
  }

  _extractFilename(url) {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname;
      const base = pathname.substring(pathname.lastIndexOf('/') + 1);
      if (base && base.includes('.')) {
        return decodeURIComponent(base.split('?')[0]);
      }
    } catch {
      // fallback
    }
    return 'turbo_download_' + Date.now();
  }

  _parseFilenameFromUrl(url) {
    return this._extractFilename(url);
  }

  _parseContentDisposition(header) {
    if (!header) return null;
    const matchUtf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
    if (matchUtf8 && matchUtf8[1]) {
      return decodeURIComponent(matchUtf8[1]);
    }
    const matchStandard = header.match(/filename="?([^";]+)"?/i);
    if (matchStandard && matchStandard[1]) {
      return matchStandard[1];
    }
    return null;
  }

  async probe() {
    this.status = 'probing';
    this.onStatusChange(this.status);

    try {
      const probeStart = performance.now();
      let res = null;

      // Step 1: Probe directly with standard 1KB range slice (bytes=0-1023), credentials, and high priority
      // 1KB range avoids CDN rejections where 2-byte ranges (0-1) are treated as invalid/unsupported
      const probeController = new AbortController();
      const probeTimer = setTimeout(() => probeController.abort(), 3500);
      try {
        res = await fetch(this.url, {
          method: 'GET',
          headers: {
            'Range': 'bytes=0-1023',
            'Accept': '*/*'
          },
          credentials: 'same-origin',
          priority: 'high',
          signal: probeController.signal,
          cache: 'no-store'
        });
      } catch (e) {
        res = null;
      } finally {
        clearTimeout(probeTimer);
      }

      this.responseLatencyMs = Math.max(1, Math.round(performance.now() - probeStart));

      // Follow redirect if URL changed
      if (res && res.url && res.url !== this.url) {
        this.url = res.url;
      }

      // Check if server responded with 206 Partial Content (Supports HTTP byte-range acceleration)
      if (res && res.ok && res.status === 206) {
        this.supportsRange = true;
        const contentRange = res.headers.get('content-range');
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)/);
          if (match && match[1]) {
            this.totalBytes = parseInt(match[1], 10);
          }
        }
      } else if (res && res.ok && res.status === 200) {
        // Server returned 200 OK (ignored range or delivered full stream)
        const contentLength = res.headers.get('content-length');
        if (contentLength) {
          this.totalBytes = parseInt(contentLength, 10);
        }
        const acceptRanges = res.headers.get('accept-ranges');
        if (acceptRanges && acceptRanges.toLowerCase().includes('bytes')) {
          this.supportsRange = true;
        }
      }

      // Cancel probe body stream to avoid leaking background download data
      if (res && res.body && typeof res.body.cancel === 'function') {
        try { res.body.cancel(); } catch (e) {}
      }

      // Step 2: If Range not confirmed yet, test with a mid-slice if totalBytes is known
      if (!this.supportsRange && this.totalBytes > 2048) {
        const midController = new AbortController();
        const midTimer = setTimeout(() => midController.abort(), 3500);
        try {
          const rangeTest = await fetch(this.url, {
            method: 'GET',
            headers: {
              'Range': 'bytes=1024-2047',
              'Accept': '*/*'
            },
            credentials: 'same-origin',
            priority: 'high',
            signal: midController.signal,
            cache: 'no-store'
          });
          if (rangeTest && rangeTest.ok && rangeTest.status === 206) {
            this.supportsRange = true;
          }
          if (rangeTest && rangeTest.body && typeof rangeTest.body.cancel === 'function') {
            try { rangeTest.body.cancel(); } catch (e) {}
          }
        } catch (e) {} finally {
          clearTimeout(midTimer);
        }
      }

      // Step 3: If still not resolved, try standard simple HEAD probe
      if (!this.supportsRange) {
        const headController = new AbortController();
        const headTimer = setTimeout(() => headController.abort(), 3500);
        try {
          const headRes = await fetch(this.url, {
            method: 'HEAD',
            headers: {
              'Accept': '*/*'
            },
            credentials: 'same-origin',
            priority: 'high',
            signal: headController.signal,
            cache: 'no-store'
          });
          if (headRes && headRes.ok) {
            res = headRes;
            const acceptRanges = headRes.headers.get('accept-ranges');
            const contentLength = headRes.headers.get('content-length');
            if (acceptRanges && acceptRanges.toLowerCase().includes('bytes')) {
              this.supportsRange = true;
            }
            if (contentLength && !this.totalBytes) {
              this.totalBytes = parseInt(contentLength, 10);
            }
          }
        } catch (e) {
          // HEAD not permitted or rejected
        } finally {
          clearTimeout(headTimer);
        }
      }

      // Step 4: Video / Media URLs & Heavy Binary heuristic
      // HTML5 video players on the web fundamentally rely on HTTP Range requests for seeking and playback.
      // If the URL or filename has a media/archive extension, or media MIME type, Range is supported!
      const isMedia = (this.mimeType && (this.mimeType.startsWith('video/') || this.mimeType.startsWith('audio/'))) ||
                      (this.url && this.url.match(/\.(mp4|webm|mkv|mov|avi|ts|flv|m4v|mp3|m4a|wav|aac)(\?|$)/i)) ||
                      (this.filename && this.filename.match(/\.(mp4|webm|mkv|mov|avi|ts|flv|m4v|mp3|m4a|wav|aac)(\?|$)/i)) ||
                      (this.customFilename && this.customFilename.match(/\.(mp4|webm|mkv|mov|avi|ts|flv|m4v|mp3|m4a|wav|aac)(\?|$)/i)) ||
                      (this.url && (this.url.includes('videoplayback') || this.url.includes('/video') || this.url.includes('stream') || this.url.includes('video/')));
      if (isMedia && this.totalBytes > 0) {
        this.supportsRange = true;
      }

      const isHeavy = (this.url && this.url.match(/\.(zip|iso|rar|7z|tar|gz|exe|msi|dmg|pkg|bin|apk|img)(\?|$)/i)) ||
                      (this.filename && this.filename.match(/\.(zip|iso|rar|7z|tar|gz|exe|msi|dmg|pkg|bin|apk|img)(\?|$)/i)) ||
                      (this.customFilename && this.customFilename.match(/\.(zip|iso|rar|7z|tar|gz|exe|msi|dmg|pkg|bin|apk|img)(\?|$)/i));
      if (isHeavy && this.totalBytes > 0 && res && res.status === 206) {
        this.supportsRange = true;
      }

      // Extract filename and Content-Type from any successful response headers
      if (res) {
        const cd = res.headers.get('content-disposition');
        const parsedName = this._parseContentDisposition(cd);
        if (parsedName) {
          this.filename = parsedName;
        }

        const ct = res.headers.get('content-type');
        if (ct) {
          this.mimeType = ct.split(';')[0].trim().toLowerCase();
          if (!this.filename.includes('.')) {
            if (this.mimeType === 'video/mp4') this.filename += '.mp4';
            else if (this.mimeType === 'video/webm') this.filename += '.webm';
            else if (this.mimeType === 'video/x-msvideo' || this.mimeType === 'video/avi' || this.mimeType === 'video/msvideo') this.filename += '.avi';
            else if (this.mimeType === 'video/quicktime') this.filename += '.mov';
            else if (this.mimeType === 'video/x-matroska') this.filename += '.mkv';
            else if (this.mimeType === 'video/mp2t') this.filename += '.ts';
            else if (this.mimeType === 'video/x-flv') this.filename += '.flv';
            else if (this.mimeType === 'audio/mpeg' || this.mimeType === 'audio/mp3') this.filename += '.mp3';
            else if (this.mimeType === 'audio/wav') this.filename += '.wav';
            else if (this.mimeType === 'audio/aac') this.filename += '.aac';
            else if (this.mimeType === 'audio/ogg') this.filename += '.ogg';
          }
        }
      }

      // Guard against HTML error / landing pages masquerading as media streams (prevents "download only Kb" bug)
      const isHtmlErrorPage = this.mimeType === 'text/html' && this.totalBytes > 0 && this.totalBytes < 500 * 1024;
      if (isHtmlErrorPage) {
        console.warn('[TurboChunkEngine] Aborting acceleration: URL returned HTML webpage (' + this.totalBytes + ' bytes), not media');
        return {
          supportsRange: false,
          isHtmlPage: true,
          totalBytes: this.totalBytes,
          filename: this.filename,
          mimeType: this.mimeType
        };
      }

      return {
        supportsRange: Boolean(this.supportsRange),
        totalBytes: this.totalBytes || 0,
        filename: this.filename,
        mimeType: this.mimeType
      };
    } catch (err) {
      console.log('[TurboChunkEngine] Single-stream mode confirmed for URL:', err?.message || err);
      return {
        supportsRange: false,
        totalBytes: 0,
        filename: this.filename || this._parseFilenameFromUrl(this.url),
        mimeType: this.mimeType
      };
    }
  }

  async start() {
    this.abortController = new AbortController();
    this.status = 'downloading';
    this.startTime = performance.now();
    this.lastTime = this.startTime;
    this.lastTransferred = 0;
    this.onStatusChange(this.status);

    this._startProgressTicker();

    try {
      if (this.supportsRange && this.totalBytes > 0 && this.threadCount > 1) {
        try {
          await this._startSegmentedDownload();
        } catch (segmentErr) {
          console.warn('[TurboChunkEngine] Segmented download failed, recovering with high-speed direct stream:', segmentErr?.message || segmentErr);
          if (this.status === 'downloading') {
            await this._startSingleStreamDownload();
          }
        }
      } else {
        // High-speed direct stream reader with real-time telemetry and Blob assembly
        await this._startSingleStreamDownload();
      }

      if (this.status === 'downloading') {
        this.status = 'assembling';
        this.onStatusChange(this.status);
        const blobUrl = await this._assembleFile();
        this.status = 'completed';
        this.onStatusChange(this.status);
        this._stopProgressTicker();
        
        // Final progress report at 100%
        this.onProgress(this.getTelemetry());

        this.onComplete({
          id: this.id,
          url: this.url,
          filename: this.filename,
          blobUrl,
          mimeType: this.mimeType,
          totalBytes: this.totalBytes,
          duration: ((performance.now() - this.startTime) / 1000).toFixed(2),
          averageSpeed: this.averageSpeed
        });
      }
    } catch (err) {
      this._stopProgressTicker();
      if (this.status === 'paused' || this.status === 'cancelled') {
        return;
      }
      console.warn('[TurboChunkEngine] Engine encountered fatal error, attempting fallback to native download:', err?.message || err);
      if (typeof this.onFallbackNative === 'function') {
        this.status = 'fallback';
        this.onStatusChange(this.status);
        this.onFallbackNative({
          id: this.id,
          url: this.url,
          filename: this.filename,
          reason: err?.message || 'Network download error'
        });
        return;
      }
      this.status = 'error';
      this.onStatusChange(this.status);
      this.onError(err);
    }
  }

  _prepareChunks() {
    this.chunks = [];
    this.chunkBuffers = [];

    // Pure Segmented Architecture (IDM / Aria2 model):
    // Chromium strictly enforces a maximum of 6 concurrent TCP sockets per host for HTTP/1.1
    // (kDefaultMaxSocketsPerGroup = 6 in net/socket/client_socket_pool_manager.h).
    // Attempting to burst 16 sockets to the same origin stalls workers 6-15 in Chrome's socket queue,
    // leading to socket timeouts, connection resets, and "TypeError: Failed to fetch" (network error).
    // By bounding segment count to the browser socket group limit (max 6), every segment
    // receives an instant, dedicated socket running at 100% TCP throughput with zero socket starvation.
    const maxSockets = 6;
    const threadTarget = Math.max(1, Math.min(maxSockets, this.threadCount || 6));
    
    // For small files, avoid opening more segments than 128KB chunks
    const segmentCount = this.totalBytes > 0
      ? Math.max(1, Math.min(threadTarget, Math.floor(this.totalBytes / (128 * 1024)) || 1))
      : 1;

    const segmentSize = Math.floor(this.totalBytes / segmentCount);

    for (let i = 0; i < segmentCount; i++) {
      const start = i * segmentSize;
      const end = (i === segmentCount - 1) ? (this.totalBytes - 1) : ((i + 1) * segmentSize - 1);
      const total = end - start + 1;

      this.chunks.push({
        id: i,
        start,
        end,
        currentOffset: start,
        total,
        downloaded: 0,
        status: 'pending', // 'pending' | 'downloading' | 'completed' | 'error'
        speed: 0,
        lastBytes: 0
      });

      this.chunkBuffers[i] = [];
    }
  }

  async _startSegmentedDownload() {
    if (this.chunks.length === 0) {
      this._prepareChunks();
    }

    // Chrome limits concurrent TCP connections to 6 per host for HTTP/1.1.
    // Governed socket pool ensures workers never exceed Chrome's socket queue limit.
    const MAX_CONCURRENT_SOCKETS = Math.min(6, this.chunks.length);
    let activeSockets = 0;

    const runWorker = async (workerId) => {
      // Stagger initial connections slightly (25ms) to allow smooth TCP handshakes
      if (workerId > 0) {
        await new Promise(r => setTimeout(r, workerId * 25));
      }

      // Initial assignment: worker i takes chunk i
      if (workerId < this.chunks.length) {
        activeSockets++;
        try {
          await this._downloadChunk(this.chunks[workerId]);
        } finally {
          activeSockets--;
        }
      }

      // Dynamic Work Stealing: if this worker finished early while another segment is still downloading,
      // help download the remaining half of the largest active segment (> 6MB)
      while (true) {
        if (this.abortController?.signal?.aborted) return;
        if (activeSockets >= 6) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }

        let candidate = null;
        let maxRemaining = 0;

        for (const c of this.chunks) {
          if (c.status === 'downloading' && !c._beingSplit) {
            const currentByte = (c.currentOffset !== undefined && c.currentOffset !== null) ? c.currentOffset : (c.start + c.downloaded);
            const remaining = c.end - currentByte + 1;
            if (remaining > 6 * 1024 * 1024 && remaining > maxRemaining) {
              maxRemaining = remaining;
              candidate = c;
            }
          }
        }

        if (!candidate || maxRemaining < 6 * 1024 * 1024) {
          break; // All segments finished or near completion
        }

        candidate._beingSplit = true;
        try {
          // Steal the second half of candidate's remaining range
          const currentByte = (candidate.currentOffset !== undefined && candidate.currentOffset !== null) ? candidate.currentOffset : (candidate.start + candidate.downloaded);
          const halfRemaining = Math.floor(maxRemaining / 2);
          const splitStart = candidate.end - halfRemaining + 1;

          if (splitStart > currentByte + 2 * 1024 * 1024) {
            const oldEnd = candidate.end;
            candidate.end = splitStart - 1;
            candidate.total = candidate.end - candidate.start + 1;

            const newChunkId = this.chunks.length;
            const stolenChunk = {
              id: newChunkId,
              start: splitStart,
              end: oldEnd,
              currentOffset: splitStart,
              total: oldEnd - splitStart + 1,
              downloaded: 0,
              status: 'pending',
              speed: 0,
              lastBytes: 0
            };

            this.chunks.push(stolenChunk);
            this.chunkBuffers[newChunkId] = [];

            activeSockets++;
            try {
              await this._downloadChunk(stolenChunk);
            } finally {
              activeSockets--;
            }
          } else {
            break;
          }
        } finally {
          candidate._beingSplit = false;
        }
      }
    };

    // Run active workers concurrently within host socket limit
    const workers = Array.from({ length: MAX_CONCURRENT_SOCKETS }, (_, i) => runWorker(i));
    await Promise.all(workers);
  }

  async _downloadChunk(chunk, retryCount = 0) {
    const startByte = (chunk.currentOffset !== undefined && chunk.currentOffset !== null) ? chunk.currentOffset : (chunk.start || 0);

    // Boundary check: chunk is already complete or beyond target
    if (chunk.total > 0 && (chunk.downloaded >= chunk.total || startByte > chunk.end)) {
      chunk.status = 'completed';
      return;
    }
    if (this.totalBytes > 0 && startByte >= this.totalBytes) {
      chunk.status = 'completed';
      return;
    }

    chunk.status = 'downloading';
    const rangeHeader = `bytes=${startByte}-${chunk.end}`;

    // Adaptive credentials strategy:
    // Default to 'same-origin' to prevent wildcard CORS rejections.
    // On retries, alternate to 'omit' or 'include' to bypass CDN cookie restrictions.
    const credentialsMode = retryCount === 0 ? 'same-origin' : (retryCount === 1 ? 'omit' : 'include');

    try {
      if (!this.chunkBuffers[chunk.id]) {
        this.chunkBuffers[chunk.id] = [];
      }

      const res = await fetch(this.url, {
        headers: {
          'Range': rangeHeader,
          'Accept': '*/*'
        },
        credentials: credentialsMode,
        priority: 'high',
        signal: this.abortController?.signal,
        cache: 'no-store'
      });

      if (res.status === 416) {
        // HTTP 416 Range Not Satisfiable: chunk is already at EOF or boundary
        if ((this.totalBytes > 0 && startByte >= this.totalBytes) || (chunk.total > 0 && chunk.downloaded >= chunk.total)) {
          chunk.status = 'completed';
          return;
        }
      }

      if (res.status !== 206) {
        // If server responds with 200 on chunk 0, accept full content
        if (res.status === 200 && chunk.id === 0 && startByte === 0) {
          // Handled via stream reader
        } else {
          throw new Error(`Server did not respond with 206 Partial Content (HTTP ${res.status}) on chunk ${chunk.id}`);
        }
      }

      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        try {
          while (true) {
            if (this.abortController?.signal?.aborted) {
              try { await reader.cancel(); } catch (e) {}
              return;
            }

            let streamData;
            try {
              streamData = await reader.read();
            } catch (readErr) {
              if (this.abortController?.signal?.aborted) return;
              if (chunk.total > 0 && chunk.downloaded >= chunk.total) {
                break; // Clean segment finish
              }
              throw readErr;
            }

            if (!streamData || streamData.done) break;

            let value = streamData.value;
            if (value && value.byteLength > 0) {
              // Clamp incoming bytes to chunk.total if dynamically adjusted
              if (chunk.total > 0 && chunk.downloaded + value.byteLength > chunk.total) {
                const needed = chunk.total - chunk.downloaded;
                if (needed > 0) {
                  value = value.subarray(0, needed);
                } else {
                  try { await reader.cancel(); } catch (e) {}
                  break;
                }
              }

              if (!this.chunkBuffers[chunk.id]) {
                this.chunkBuffers[chunk.id] = [];
              }
              this.chunkBuffers[chunk.id].push(value);
              chunk.downloaded = (chunk.downloaded || 0) + value.byteLength;
              chunk.currentOffset = (chunk.currentOffset || chunk.start || 0) + value.byteLength;
              this.downloadedBytes = (this.downloadedBytes || 0) + value.byteLength;
            }

            // Immediately break and cancel stream once all bytes for this segment have arrived!
            if (chunk.total > 0 && chunk.downloaded >= chunk.total) {
              try { await reader.cancel(); } catch (e) {}
              break;
            }
          }
        } finally {
          try { reader.releaseLock(); } catch (e) {}
        }
      } else {
        const buf = await res.arrayBuffer();
        if (buf && buf.byteLength > 0) {
          const value = new Uint8Array(buf);
          if (!this.chunkBuffers[chunk.id]) {
            this.chunkBuffers[chunk.id] = [];
          }
          this.chunkBuffers[chunk.id].push(value);
          chunk.downloaded = (chunk.downloaded || 0) + value.byteLength;
          chunk.currentOffset = (chunk.currentOffset || chunk.start || 0) + value.byteLength;
          this.downloadedBytes = (this.downloadedBytes || 0) + value.byteLength;
        }
      }

      if (chunk) {
        chunk.status = 'completed';
      }
    } catch (err) {
      if (this.abortController?.signal?.aborted) {
        return;
      }

      if (retryCount < 4) {
        const errMsg = err?.message || 'Network error';
        console.warn(`[TurboChunkEngine] Retrying chunk ${chunk?.id} (attempt ${retryCount + 1}):`, errMsg);
        if (chunk) chunk.status = 'retrying';

        // Exponential backoff with random jitter to relieve socket congestion
        const delay = Math.round(500 * Math.pow(1.5, retryCount) + Math.random() * 300);

        this.onChunkRetry({
          id: this.id,
          filename: this.filename,
          chunkId: chunk?.id ?? '?',
          attempt: retryCount + 1,
          maxAttempts: 4,
          error: errMsg,
          delayMs: delay
        });

        await new Promise(r => setTimeout(r, delay));
        return this._downloadChunk(chunk, retryCount + 1);
      } else {
        // All retries exhausted — mark chunk as permanently failed and notify UI
        if (chunk) chunk.status = 'error';
        const finalErrMsg = err?.message || 'Network error';
        console.error(`[TurboChunkEngine] Chunk ${chunk?.id} permanently failed after 4 retries:`, finalErrMsg);

        this.onChunkFailed({
          id: this.id,
          filename: this.filename,
          chunkId: chunk?.id ?? '?',
          maxAttempts: 4,
          error: finalErrMsg
        });

        throw err;
      }
    }
  }

  async _startSingleStreamDownload() {
    // Fallback single stream
    this.chunks = [{
      id: 0,
      start: 0,
      end: this.totalBytes ? this.totalBytes - 1 : 0,
      currentOffset: 0,
      total: this.totalBytes || 0,
      downloaded: 0,
      status: 'downloading',
      speed: 0
    }];
    this.chunkBuffers = [[]];

    const res = await fetch(this.url, {
      headers: {
        'Accept': '*/*'
      },
      credentials: 'same-origin',
      priority: 'high',
      signal: this.abortController?.signal,
      cache: 'no-store'
    });

    if (!res.ok) {
      throw new Error(`Single-stream fetch error ${res.status}`);
    }

    if (!this.totalBytes) {
      const len = res.headers.get('content-length');
      if (len) {
        this.totalBytes = parseInt(len, 10);
        if (this.chunks[0]) this.chunks[0].total = this.totalBytes;
      }
    }

    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      try {
        while (true) {
          if (this.abortController?.signal?.aborted) {
            try { await reader.cancel(); } catch (e) {}
            return;
          }

          let streamData;
          try {
            streamData = await reader.read();
          } catch (readErr) {
            if (this.abortController?.signal?.aborted) return;
            throw readErr;
          }

          if (!streamData || streamData.done) break;

          const value = streamData.value;
          if (value && value.byteLength > 0) {
            if (!this.chunkBuffers[0]) this.chunkBuffers[0] = [];
            this.chunkBuffers[0].push(value);
            if (this.chunks[0]) this.chunks[0].downloaded += value.byteLength;
            this.downloadedBytes = (this.downloadedBytes || 0) + value.byteLength;
            if (!this.totalBytes && this.chunks[0]) {
              this.chunks[0].total = this.downloadedBytes;
            }

            if (this.totalBytes > 0 && this.downloadedBytes >= this.totalBytes) {
              try { await reader.cancel(); } catch (e) {}
              break;
            }
          }
        }
      } finally {
        try { reader.releaseLock(); } catch (e) {}
      }
    } else {
      const buf = await res.arrayBuffer();
      if (buf && buf.byteLength > 0) {
        const value = new Uint8Array(buf);
        if (!this.chunkBuffers[0]) this.chunkBuffers[0] = [];
        this.chunkBuffers[0].push(value);
        if (this.chunks[0]) this.chunks[0].downloaded += value.byteLength;
        this.downloadedBytes = (this.downloadedBytes || 0) + value.byteLength;
        if (!this.totalBytes && this.chunks[0]) {
          this.chunks[0].total = this.downloadedBytes;
        }
      }
    }

    if (this.chunks && this.chunks[0]) {
      this.chunks[0].status = 'completed';
    }
    if (!this.totalBytes) {
      this.totalBytes = this.downloadedBytes;
    }
  }



  async _assembleFile() {
    // Sort all completed chunks by start byte to guarantee 100% contiguous sequential ordering
    const sortedChunks = [...this.chunks].sort((a, b) => a.start - b.start);

    const flattenedParts = [];
    for (const chunk of sortedChunks) {
      const bufList = this.chunkBuffers[chunk.id];
      if (Array.isArray(bufList)) {
        for (let j = 0; j < bufList.length; j++) {
          const part = bufList[j];
          if (part && part.byteLength > 0) {
            flattenedParts.push(part);
          }
        }
        this.chunkBuffers[chunk.id] = null; // Free chunk parts immediately to prevent memory ballooning
      }
    }

    const blob = new Blob(flattenedParts, { type: this.mimeType || 'application/octet-stream' });
    this.blobUrl = URL.createObjectURL(blob);

    // Immediately release JavaScript memory references so V8 can garbage-collect the byte arrays
    flattenedParts.length = 0;
    this.chunkBuffers = [];
    this.blob = null; // Native C++ BlobRegistry keeps the blob valid for URL.createObjectURL

    return this.blobUrl;
  }

  pause() {
    if (this.status !== 'downloading') return;
    this.status = 'paused';
    this.onStatusChange(this.status);
    this._stopProgressTicker();
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  async resume() {
    if (this.status !== 'paused') return;
    this.status = 'downloading';
    this.onStatusChange(this.status);
    this.abortController = new AbortController();
    this.lastTime = performance.now();
    this.lastTransferred = this.downloadedBytes;
    this._startProgressTicker();

    try {
      const activeChunks = this.chunks.filter(c => c.downloaded < c.total);
      const promises = activeChunks.map(chunk => this._downloadChunk(chunk));
      await Promise.all(promises);

      if (this.status === 'downloading') {
        this.status = 'assembling';
        this.onStatusChange(this.status);
        const blobUrl = await this._assembleFile();
        this.status = 'completed';
        this.onStatusChange(this.status);
        this._stopProgressTicker();

        this.onComplete({
          id: this.id,
          url: this.url,
          filename: this.filename,
          blobUrl,
          mimeType: this.mimeType,
          totalBytes: this.totalBytes,
          duration: ((performance.now() - this.startTime) / 1000).toFixed(2),
          averageSpeed: this.averageSpeed
        });
      }
    } catch (err) {
      this._stopProgressTicker();
      if (this.status === 'paused' || this.status === 'cancelled') return;
      this.status = 'error';
      this.onStatusChange(this.status);
      this.onError(err);
    }
  }

  cancel() {
    this.status = 'cancelled';
    this.onStatusChange(this.status);
    this._stopProgressTicker();
    if (this.abortController) {
      this.abortController.abort();
    }
    this.chunkBuffers = [];
  }

  _startProgressTicker() {
    this._stopProgressTicker();
    this.progressTimer = setInterval(() => {
      this._calculateSpeeds();
      this.onProgress(this.getTelemetry());
    }, 250);
  }

  _stopProgressTicker() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  _calculateSpeeds() {
    const now = performance.now();

    if (!this.speedSamples || !Array.isArray(this.speedSamples)) {
      this.speedSamples = [{ time: this.startTime || now, bytes: 0 }];
    }
    
    this.speedSamples.push({ time: now, bytes: this.downloadedBytes });
    // 1.4-second rolling sample window absorbs socket buffer flushes without collapsing MB/s into KB/s
    while (this.speedSamples.length > 2 && (now - this.speedSamples[0].time) > 1400) {
      this.speedSamples.shift();
    }

    const oldest = this.speedSamples[0];
    const timeSpan = (now - oldest.time) / 1000;
    const bytesSpan = Math.max(0, this.downloadedBytes - oldest.bytes);

    if (timeSpan >= 0.2) {
      const measured = bytesSpan / timeSpan;
      if (this.currentSpeed === 0) {
        this.currentSpeed = measured;
      } else if (bytesSpan > 0) {
        // Smooth Exponential Moving Average over rolling window
        this.currentSpeed = 0.4 * measured + 0.6 * this.currentSpeed;
      } else if ((now - oldest.time) > 1600) {
        // Only taper down if zero bytes arrived across 1.6+ seconds
        this.currentSpeed = this.currentSpeed * 0.85;
      }
    }

    const totalElapsed = (now - this.startTime) / 1000;
    if (totalElapsed > 0) {
      this.averageSpeed = this.downloadedBytes / totalElapsed;
    }
  }

  getTelemetry() {
    const percent = this.totalBytes > 0 
      ? Math.min(100, (this.downloadedBytes / this.totalBytes) * 100) 
      : 0;

    const remainingBytes = Math.max(0, this.totalBytes - this.downloadedBytes);
    const etaSeconds = (this.currentSpeed > 0 && remainingBytes > 0)
      ? Math.ceil(remainingBytes / this.currentSpeed)
      : 0;

    return {
      id: this.id,
      url: this.url,
      filename: this.filename,
      status: this.status,
      supportsRange: this.supportsRange,
      threadCount: this.chunks.length,
      totalBytes: this.totalBytes,
      downloadedBytes: this.downloadedBytes,
      percent: percent,
      speed: this.currentSpeed,
      averageSpeed: this.averageSpeed,
      etaSeconds: etaSeconds,
      latencyMs: this.responseLatencyMs,
      chunks: this.chunks.map(c => ({
        id: c.id,
        start: c.start,
        end: c.end,
        total: c.total,
        downloaded: c.downloaded,
        percent: c.total > 0 ? (c.downloaded / c.total) * 100 : 0,
        status: c.status
      }))
    };
  }
}
