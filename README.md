# StreamSniffer Pro: Quantum Gold Edition

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue?style=for-the-badge)
![Chrome 116+](https://img.shields.io/badge/Chrome-116+-green?style=for-the-badge&logo=google-chrome)
![License MIT](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)
![Zero WASM](https://img.shields.io/badge/Architecture-Zero%20WASM-orange?style=for-the-badge)

> **An enterprise-grade Chrome Extension for high-performance stream sniffing, live bandwidth telemetry, multi-quality HLS/DASH extraction, and in-order OPFS disk streaming.**

![StreamSniffer Pro Interface](screenshot.png)

*(Preview: Live telemetry HUD and multi-quality variant selector)*

---

## 🏗️ Architecture Deep-Dive

StreamSniffer Pro utilizes a strict, multi-context Manifest V3 architecture to bypass V8 heap limitations and Service Worker lifecycle constraints.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                             BROWSER TAB (Target Webpage)                    │
│  ┌──────────────────────────────┐      ┌────────────────────────────────┐  │
│  │  injected.js (MAIN World)    │      │  content.js (ISOLATED World)   │  │
│  │  - Intercepts HTMLMediaElem  │      │  - Secure message bridge       │  │
│  │  - Hooks SourceBuffer.append │─────▶│  - Filters & forwards events   │  │
│  └──────────────┬───────────────┘      └───────────────┬────────────────┘  │
└─────────────────┼──────────────────────────────────────┼────────────────────┘
                  │                                      │
                  ▼                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EXTENSION BACKGROUND CONTEXT                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  background.js (Service Worker)                                       │  │
│  │  - Atomic write queue coordinator                                     │  │
│  │  - chrome.alarms keep-alive lifeline                                   │  │
│  │  - Dynamic token-refresh handshake router (401/403 handling)          │  │
│  └───────────────────────────────┬───────────────────────────────────────┘  │
│                                  │                                          │
│                                  ▼                                          │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  offscreen.html / offscreen.js (Dedicated Offscreen Document)         │  │
│  │  - TS Demuxer (PAT/PMT parsing, PES reassembly)                       │  │
│  │  - fMP4 Muxer (Dual-track moof/mdat, trun v1 for B-frame CTS)         │  │
│  │  - Web Crypto API AES-128-CBC Decryption (SAMPLE-AES safe)            │  │
│  │  - OPFS FileSystemWritableFileStream (Zero-heap sliding window)       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                  ▲
                  │ (Live Telemetry & Control)
┌─────────────────┴─────────────────────────────────────────────────────────────┐
│  popup.html / popup.js (Interactive UI)                                       │
│  - Master Manifest Quality Selector (4K to Audio-only)                        │
│  - Pre-download Size Calculator & Live MB/s Telemetry HUD                     │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ Core Technical Capabilities

* **Zero-Heap OPFS Pipeline:** Streams multi-gigabyte files directly to the Origin Private File System via `FileSystemWritableFileStream`, eliminating V8 heap ceiling crashes and garbage collection stutter.
* **Sample-Accurate Demuxing & Remuxing:** Pure-JS MPEG-2 TS state machine parses PAT/PMT, reassembles PES packets, and outputs dual-track fMP4 fragments. Utilizes `trun` box version 1 with signed composition time offsets (`ctts`) for B-frame AV synchronization.
* **Adaptive Bitrate (ABR) Ladder Selection:** Dynamically parses `#EXT-X-STREAM-INF` (HLS) and `Representation` sets (MPEG-DASH) to allow pre-download selection across 4K, 1080p, 720p, 480p, 360p, or audio-only streams.
* **Hardware-Accelerated Web Crypto Decryption:** Decrypts HLS SAMPLE-AES and MPEG-DASH encrypted segments using the native Web Crypto API while preserving explicit/implicit IVs and TS header integrity.
* **Resilient Token-Refresh Handshake:** Detects mid-stream 401/403 CDN expirations (Akamai/Cloudflare), pauses the OPFS write queue, requests fresh authorization tokens from the MAIN world, and resumes fetching at the exact byte offset.
* **Service Worker Keep-Alive:** Employs `chrome.alarms` to prevent browser termination during long-running disk write operations.

---

## 📁 Directory Structure

```text
StreamSniffer-Pro/
├── manifest.json          # MV3 configuration, permissions, and icon mapping
├── background.js          # Service Worker: Queue coordination & message routing
├── content.js             # ISOLATED world: Secure bridge between MAIN and SW
├── injected.js            # MAIN world: DOM-level media element & fetch interception
├── offscreen.html         # Blank host document for the Offscreen API
├── offscreen.js           # OPFS worker: TS demuxing, fMP4 muxing, AES decryption
├── popup.html             # Interactive UI layout
├── popup.js               # UI logic: Telemetry HUD, variant selection, download triggers
├── icons/                 # Extension branding
│   ├── icon16.png         # 16×16 (Toolbar & tabs)
│   ├── icon48.png         # 48×48 (Extensions management page)
│   └── icon128.png        # 128×128 (Chrome Web Store listing)
├── screenshot.png         # UI preview for GitHub README
└── README.md              # Documentation
```

---

## 🚀 Quick Start & Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/ahmedbaligh0/StreamSniffer-Pro.git

---

## 📊 Performance & Memory Benchmarks

Traditional in-memory media downloaders fail on large files due to the V8 ~2GB heap limit. StreamSniffer Pro bypasses this with an OPFS sliding-window pipeline:

| Metric | Traditional In-Memory (Blob/ArrayBuffer) | StreamSniffer Pro (OPFS Pipeline) |
|---|---|---|
| **Max File Size** | ~1.5 GB (Browser crash imminent) | Unlimited (Bound only by disk space) |
| **Peak RAM Usage** | High (Scales linearly with file size) | < 50 MB (Constant sliding window) |
| **Garbage Collection** | Severe stuttering on large allocations | Zero (No large JS object retention) |
| **Mid-Stream Resume** | Fails (Lost memory state) | Seamless (OPFS byte-offset seeking) |
| **B-Frame AV Sync** | Often drifts or desyncs | Accurate (Signed `trun` v1 `ctts` offsets) |

---

## ⚖️ Legal & Compliance Disclaimer

StreamSniffer Pro is released under the **MIT License**.

This software is provided strictly for personal media backup, network research, security analysis, and educational purposes.

* **NO DRM CIRCUMVENTION:** This extension does not bypass commercial DRM systems (Widevine, PlayReady, FairPlay). It only processes clear-key or explicitly provided AES-128-CBC streams.
* **NO DATA EXFILTRATION:** The extension operates entirely locally. No browsing history, media URLs, or downloaded content is transmitted to external servers.
* **USER RESPONSIBILITY:** Users are solely responsible for ensuring compliance with the Terms of Service of accessed platforms and applicable local copyright regulations.

---

Built with precision for the modern web. For enterprise deployment inquiries or custom CDN integrations, please open a GitHub Issue.