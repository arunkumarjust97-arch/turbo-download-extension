# ⚡ TurboSpeed Downloader

> **Enterprise-grade multi-threaded download accelerator and dynamic stream interceptor for Chromium browsers (Manifest V3).**

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension%20MV3-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Browsers](https://img.shields.io/badge/Browsers-Chrome_•_Edge_•_Brave_•_Opera_•_Vivaldi-FF7139?style=for-the-badge&logo=googlechrome&logoColor=white)](#browser-compatibility-matrix)
[![Platforms](https://img.shields.io/badge/Platforms-Windows_•_macOS_•_Linux_•_ChromeOS-0078D6?style=for-the-badge&logo=windows&logoColor=white)](#operating-system-compatibility)
[![Multi-Threading](https://img.shields.io/badge/Multi--Threading-2x%20to%2032x-6366F1?style=for-the-badge&logo=speedtest&logoColor=white)](#pipelined-multi-threaded-engine)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES2024-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![License: MIT](https://img.shields.io/badge/License-MIT-10B981?style=for-the-badge)](LICENSE)

---

## 📖 Overview

**TurboSpeed Downloader** delivers up to **10x faster downloads** by splitting files into concurrent byte-range segments and pulling them simultaneously across parallel network streams. Designed specifically for modern Chromium environments (Google Chrome, Brave, Edge, Opera, Vivaldi), it combines an **Offscreen Document chunk engine**, smart browser-level auto-interception, universal video extraction, and an IDM-style visual dashboard.

---

## ✨ Key Features

### 🚀 Pipelined Multi-Threaded Engine
- **Byte-Range Segmentation**: Splits large files into up to **32 concurrent streams** (HTTP 206 Partial Content).
- **Default Best Option**: Pre-configured to **8 Threads** — the optimal sweet spot providing maximum acceleration without triggering server rate-limits or connection drops.
- **Dynamic Chunk Allocation**: Slices remaining file bytes on-the-fly to ensure all threads finish simultaneously.
- **Fail-Safe Fallback**: Gracefully routes back to standard single-stream native downloads if a target server does not support HTTP Range headers.

### 🎯 Smart Auto-Interception
- **Zero-Config Interception**: Automatically detects heavy file downloads in the browser and routes them through the acceleration pipeline.
- **Extensive Format Coverage**: Supports archives (`.zip`, `.rar`, `.7z`, `.tar.gz`), executables (`.exe`, `.msi`, `.dmg`, `.pkg`, `.deb`, `.apk`), disk images (`.iso`, `.img`, `.vhd`), AI models/datasets (`.safetensors`, `.gguf`, `.onnx`, `.parquet`), media, and documents.
- **Configurable Threshold**: Filters out small web assets (default: > 1 MB threshold) to eliminate multithreading overhead on tiny files.

### 🎬 Universal Media & Video Right-Click Capture
- **Context-Menu Integration**: Right-click on any video or audio stream to trigger `"⚡ Turbo Download Video"`.
- **Anti-Blocker & Custom Player Support**: Intercepts HTML5 media players (`<video>`, `<audio>`, embedded stream sources) even on sites with custom control layers.
- **Clean Interface**: Completely overlay-free; media controls remain clean and uncluttered.

### 📊 Real-Time Popup & Dashboard
- **Telemetry Popup**:
  - Live speedometer displaying transfer rates in MB/s and KB/s.
  - Active transfer queue with progress bars and latency readouts.
  - Quick-toggle thread count pills (`4x`, `8x`, `12x`, `16x`).
  - Master acceleration toggle switch.
- **Full-Screen Management Dashboard (`manager.html`)**:
  - **Live Transfer Canvas**: Real-time interactive waveform visualizer tracking aggregate network throughput.
  - **Individual Chunk Visualizers**: IDM-style segmented progress strips displaying each active thread's chunk status.
  - **Transfer Controls**: Pause, resume, cancel, and clear downloads.
  - **Download History**: Searchable archive of all completed accelerated downloads.
  - **Settings & Rules Configurator**: Customize parallel threads, auto-interception behavior, sound alerts, and threshold limits.

---

## 🏗️ Architecture & Technical Design

TurboSpeed is built strictly in accordance with **Manifest V3** security and sandboxing specifications:

```
┌─────────────────────────────────────────────────────────────┐
│                       Content Script                        │
│   • Link & click listener • Video element detector          │
│   • Network pre-connection • Context menu target capture    │
└──────────────────────────────┬──────────────────────────────┘
                               │ Chrome Runtime Messaging
┌──────────────────────────────▼──────────────────────────────┐
│                    Service Worker (MV3)                     │
│   • Download event listener (`chrome.downloads`)            │
│   • DeclarativeNetRequest rules (CORS bypass for Range)     │
│   • Context menu dispatcher • State manager                 │
└──────────────────────────────┬──────────────────────────────┘
                               │ Lifecycle & Stream Control
┌──────────────────────────────▼──────────────────────────────┐
│                  Offscreen Document Engine                  │
│   • Dynamic HTTP HEAD & Range probing                       │
│   • TurboChunkEngine (parallel Uint8Array chunk streaming)  │
│   • Blob assembly & DOM anchor fallback trigger             │
└──────────────────────────────┬──────────────────────────────┘
                               │ State Sync
┌──────────────────────────────▼──────────────────────────────┐
│                  UI Layer (Popup & Manager)                 │
│   • Real-time speed & latency computation                   │
│   • HTML5 Canvas network waveform renderer                  │
│   • IDM segmented thread strips • Settings persistence     │
└─────────────────────────────────────────────────────────────┘
```

- **Offscreen Document (`offscreen/`)**: Overcomes MV3 service worker execution termination limits and provides direct access to high-performance Blob assembling and DOM triggers.
- **Declarative Net Request (`declarativeNetRequest`)**: Dynamically manages request headers to prevent CORS blocking during segment chunk fetching.
- **Zero External Dependencies**: Pure vanilla JavaScript (ES2024), HTML5, and CSS3. No heavy frameworks or third-party bundle bloat.

---

## 🌐 Cross-Platform & Cross-Browser Compatibility

TurboSpeed Downloader is engineered from the ground up for universal, cross-platform and cross-browser reliability. It conforms strictly to the W3C WebExtensions standard and the Chromium Manifest V3 specification.

### 🧭 Browser Compatibility Matrix

| Browser | Engine | Minimum Version | Status | Extension URL |
| :--- | :--- | :--- | :---: | :--- |
| **Google Chrome** | Blink / V8 | Chrome 109+ | ✅ **Fully Supported** | `chrome://extensions/` |
| **Microsoft Edge** | Blink / V8 | Edge 109+ | ✅ **Fully Supported** | `edge://extensions/` |
| **Brave Browser** | Blink / V8 | Brave 1.48+ | ✅ **Fully Supported** *(Brave Shields Compatible)* | `brave://extensions/` |
| **Opera & Opera GX** | Blink / V8 | Opera 95+ | ✅ **Fully Supported** | `opera://extensions/` |
| **Vivaldi** | Blink / V8 | Vivaldi 5.7+ | ✅ **Fully Supported** | `vivaldi://extensions/` |
| **Arc Browser** | Blink / V8 | Arc 1.0+ | ✅ **Fully Supported** | `arc://extensions/` |
| **Ungoogled Chromium** | Blink / V8 | Chromium 109+ | ✅ **Fully Supported** | `chrome://extensions/` |
| **Mozilla Firefox** | Gecko / SpiderMonkey | Firefox 115+ | ⚠️ **Developer Preview** | `about:debugging#/runtime/this-firefox` |

### 💻 Operating System Compatibility

TurboSpeed operates flawlessly across all major desktop and workstation operating systems:

| Platform | Architectures | Status | File System & Path Handling |
| :--- | :--- | :---: | :--- |
| **Windows 11 / 10** | x86_64, ARM64 | ✅ **Fully Supported** | Sanitizes Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1–9`, `LPT1–9`) and illegal chars (`<>:"/\\|?*`). |
| **macOS** | Apple Silicon (M1/M2/M3/M4), Intel | ✅ **Fully Supported** | Native POSIX path normalization, case-preserving filenames, and macOS notification banners. |
| **Linux** | x86_64, aarch64, armhf | ✅ **Fully Supported** | Tested on Ubuntu, Debian, Fedora, Arch Linux, Manjaro, openSUSE. Works seamlessly on both X11 and Wayland. |
| **ChromeOS** | x86_64, ARM | ✅ **Fully Supported** | Integrated directly into the ChromeOS browser shell and native Files app. |

### 🛡️ Cross-Platform & Cross-Browser Engineering Details

1. **Universal Path Sanitization (`/[\\/]/`)**:
   - All filename parsers utilize cross-platform regular expressions (`split(/[\\/]/)`) that safely process both Windows backslashes (`\`) and Unix forward slashes (`/`).
   - Null bytes (`\0`) and non-printable control characters (`\x00-\x1F`) are automatically stripped.

2. **Windows Reserved Device Name Immunity**:
   - If a web download is named `aux.mp4`, `con.zip`, or `prn.pdf`, TurboSpeed automatically prepends `dl_` to prevent Windows file-system write rejections.

3. **Brave Shields & CORS Bypass Compatibility**:
   - Brave's built-in tracker shield can occasionally block cross-origin Range headers. TurboSpeed uses Declarative Net Request rules (`id: 1001`) with `initiatorDomains: [chrome.runtime.id]` to sanitize `Origin` and set `Sec-Fetch-Mode: no-cors`, ensuring full speed even with aggressive shields enabled.

4. **Universal Offscreen Document Singleton Lock**:
   - Chromium allows only one offscreen document per extension. TurboSpeed implements an asynchronous promise-lock pattern (`_offscreenInitPromise`) that coordinates concurrent download requests, completely preventing `"Only a single offscreen document may be created"` crashes across all Chromium derivatives.

---

## 📦 Installation & Setup

1. **Clone or Download the Repository**:
   ```bash
   git clone https://github.com/arunkumarjust97-arch/turbo-download-extension.git
   ```
2. **Open Extensions Manager** in your preferred browser:
   - **Google Chrome**: Go to `chrome://extensions/`
   - **Microsoft Edge**: Go to `edge://extensions/`
   - **Brave Browser**: Go to `brave://extensions/`
   - **Opera / Opera GX**: Go to `opera://extensions/`
   - **Vivaldi**: Go to `vivaldi://extensions/`
   - **Arc Browser**: Open Command Bar (`Ctrl+T` or `Cmd+T`), type `arc://extensions`, and press Enter.

3. **Enable Developer Mode**:
   - Toggle the **"Developer mode"** switch (usually located in the top-right corner).

4. **Load the Extension**:
   - Click the **"Load unpacked"** (or **"Load Extension"**) button.
   - Select the `Turbo Download` directory containing `manifest.json`.

5. **Pin the Extension**:
   - Click the puzzle icon in your browser toolbar and pin **TurboSpeed Downloader** for quick access.

---

## 🎮 How to Use

### 1. Automatic Interception
Initiate any download on the web as you normally would. If the file exceeds the size threshold (default: 1 MB), TurboSpeed automatically captures the transfer, probes for byte-range support, and accelerates the download using parallel streams.

### 2. Manual URL Download
1. Click the **TurboSpeed** icon in your browser toolbar.
2. Click the gear icon to open the **Dashboard** (`manager.html`).
3. Click **"+ Add New Download"**.
4. Paste any direct download link, adjust thread count if desired, and click **"Start Turbo Download"**.

### 3. Universal Video & Media Download
1. Right-click on any video or audio player on any webpage.
2. Select **"⚡ Turbo Download Video"** from the context menu.
3. The media stream will be detected and accelerated immediately.

---

## ⚙️ Configuration & Optimization

Under the **Settings & Rules** tab in the Dashboard:

| Setting | Default Value | Description |
| :--- | :--- | :--- |
| **Master Turbo Acceleration** | `Enabled` | Master switch for all multi-threaded segmentation algorithms. |
| **Automatic Interception** | `Enabled` | Detects browser downloads automatically and accelerates them. |
| **Parallel Connections** | `8 Threads (Default - Best Option)` | Optimal connection count balancing maximum speed and server compatibility. |
| **Right-Click Video Download**| `Enabled` | Enables the context menu media sniffer on video elements. |
| **Minimum File Size** | `1.0 MB` | Small files below this size download via native browser single-stream. |
| **Desktop Notifications** | `Enabled` | Displays desktop alerts when accelerated transfers start or complete. |

> **Why 8 Threads is the Best Option:**  
> While TurboSpeed supports up to 32 parallel connections, **8 Threads** delivers up to 5x–10x acceleration while remaining within the concurrency limits enforced by the majority of web servers and CDNs (Cloudflare, AWS CloudFront, Fastly).

---

## 📁 Project Directory Structure

```text
├── assets/                  # Application icons & branding assets
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   ├── icon128.png
│   └── github.png
├── background/              # Background service worker (MV3)
│   └── service-worker.js    # Interception, CORS rules, and messaging coordinator
├── content/                 # Webpage content scripts
│   ├── content.js           # Pre-connection, download click sniffer, video capture
│   └── content.css          # Non-intrusive floating feedback styles
├── manager/                 # Full-screen Dashboard & Options page
│   ├── manager.html         # Live transfers, waveform visualizer, history, and settings
│   ├── manager.css          # Light pastel SaaS responsive design system
│   └── manager.js           # Canvas waveform telemetry, history table, and state persistence
├── offscreen/               # Offscreen Document multi-threading engine
│   ├── offscreen.html       # Offscreen DOM container
│   ├── offscreen.js         # Engine orchestrator & message bridge
│   └── chunk-engine.js      # TurboChunkEngine: Range probing, chunk slicing & Blob stitching
├── popup/                   # Browser action toolbar popup
│   ├── popup.html           # Compact speedometer & active queue view
│   ├── popup.css            # Micro-animations & glassmorphic layout
│   └── popup.js             # Telemetry display & threads selector pills
├── manifest.json            # Chromium Manifest V3 configuration
└── README.md                # Project documentation
```

---

## 🔒 Permissions & Security

TurboSpeed strictly declares only the permissions necessary to accelerate and manage downloads:

- `downloads`: To initiate, monitor, and finalize accelerated files in the user's default downloads directory.
- `storage`: To store user preferences and download history locally on the client machine.
- `offscreen`: To execute multi-threaded byte-range fetching in an isolated DOM document.
- `contextMenus`: To register the right-click "⚡ Turbo Download Video" action.
- `declarativeNetRequest`: To inject required Range headers and bypass cross-origin restrictions on accelerated streams.
- `activeTab`: To inspect video elements and resolve direct media source URLs.
- `notifications`: To provide visual confirmation when a multi-gigabyte transfer finishes.

---

## 👨‍💻 Author & Credits

- **Engine Architecture & Design**: [Arun Kumar](https://github.com/arunkumarjust97-arch)
- **Repository**: [turbo-download-extension](https://github.com/arunkumarjust97-arch/turbo-download-extension.git)
- **Support & Bug Reports**: `devteam.official@myyahoo.com`

---

## 📄 License

This project is licensed under the [MIT License](LICENSE) - feel free to use, modify, and distribute it for personal and commercial projects.
