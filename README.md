# IDN Live Clipper Ext 🎬⚡

A high-performance Chrome extension (Manifest V3) for [IDN Live](https://www.idn.app/) (Amazon IVS) featuring continuous client-side stream buffering, instant rewinds, non-destructive clipping, zero-reencode MP4 remuxing, and stream quality selection.

---

## Architecture Overview

The extension decouples stream playback from clip generation to ensure live streams never freeze, stutter, or drop audio while clipping.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PAGE CONTEXT                                   │
│  injected.js (Main World)                                                   │
│  ├─ Hooks window.fetch & XMLHttpRequest                                     │
│  ├─ Intercepts HLS playlists (.m3u8) & raw chunks (.ts / .m4s)             │
│  ├─ Bypasses DevTools & right-click blocks; neutralizes Zendesk widget       │
│  └─ Dispatches cloned ArrayBuffers to Content Script via window.postMessage │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ postMessage
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                           EXTENSION SANDBOX                                 │
│  content.js (Isolated World)                                                │
│  ├─ bufferEngine: Fills missing segments & polls HLS playlists             │
│  ├─ Background Keep-Alive: Web Worker ticker + silent Web Audio oscillator  │
│  ├─ Quality Overlay FAB & Quick Clip Docks                                  │
│  └─ Writes chunks to IndexedDB ("BetterIdnLive_Clipper")                    │
└───────────────────┬─────────────────────────────────────┬───────────────────┘
                    │                                     │
                    │ IndexedDB / IPC                     │ chrome.tabs / IPC
┌───────────────────▼───────────────┐   ┌─────────────────▼───────────────────┐
│     BACKGROUND SERVICE WORKER     │   │      DEDICATED CLIPPER STUDIO       │
│  background.js                    │   │  clipper/clipper.html & clipper.js  │
│  ├─ Tab discovery & GraphQL API   │   │  ├─ Multi-track visual timeline     │
│  ├─ Extension-Origin IndexedDB    │   │  ├─ Sub-second range selectors      │
│  └─ chrome.downloads delivery     │   │  ├─ Synchronized HTML5 video player │
└───────────────────────────────────┘   │  └─ Offline & post-stream clipping  │
                                        └─────────────────┬───────────────────┘
                                                          │
                                        ┌─────────────────▼───────────────────┐
                                        │        TRANSMUXING ENGINE           │
                                        │  lib/clipperTransmuxer.js + mux.js  │
                                        │  ├─ TS PES demuxing & AVC NAL parse │
                                        │  ├─ ISO BMFF fMP4 container packing │
                                        │  └─ Binary duration box patcher     │
                                        └─────────────────────────────────────┘
```

---

## Technical Pipeline

### 1. Passive & Active Segment Recording
- **Zero-Copy Interception**: Hooks `window.fetch` and `XMLHttpRequest.prototype.send` in the page context. Incoming video chunks fetched by the native Amazon IVS player are cloned (`response.clone().arrayBuffer()`) and cached without duplicate network requests.
- **Fail-Safe Polling (`bufferEngine`)**: A background engine independently tracks `#EXT-X-MEDIA-SEQUENCE` and fills any missed segments across varying network conditions or tab states.
- **Throttling Immunity**: Employs a dedicated Web Worker timer and a 440 Hz silent Web Audio oscillator node to prevent Chrome from throttling or sleeping backgrounded/minimized livestream tabs.

### 2. Client-Side Storage & Eviction (`lib/clipperStorage.js`)
- Stores segment payloads as raw `ArrayBuffer` in IndexedDB (`BetterIdnLive_Clipper`, object store `segments`).
- Indexed by `streamSlug`, `sequence`, `timestamp`, and compound index `[streamSlug, sequence]`.
- **Rolling Buffer Eviction**: Maintains a configurable rolling window (15m, 30m, 60m; default 30 min / 1.2 GB limit). Pruning executes every 10 segments, discarding expired chunks FIFO while guaranteeing the latest segments remain intact.

### 3. Zero-Reencode MP4 Transmuxing (`lib/clipperTransmuxer.js`)
- Uses `videojs/mux.js` to transmux MPEG-TS packets into fragmented ISO BMFF MP4 containers entirely in JavaScript.
- Elementary video streams (H.264 / AVC NAL units) and audio streams (AAC ADTS) are repacked directly into `moov`, `moof`, and `mdat` boxes without re-encoding, preserving 100% source fidelity with minimal CPU overhead.
- Directly concatenates streams when already formatted as Fragmented MP4 (`.m4s`).

### 4. ISO BMFF Header Patching
- Standard `mux.js` output defaults duration fields to `0xFFFFFFFF` (~13 hours).
- `ClipperTransmuxer.patchMp4Duration` parses the binary MP4 box hierarchy and directly overrides duration and timescale values in:
  - `mvhd` (Movie Header Box)
  - `tkhd` (Track Header Box)
  - `mdhd` (Media Header Box)
  - `mehd` (Movie Extends Header Box)
- Result: Exported clips report exact trimmed durations (e.g., 30.0s) in VLC, QuickTime, Discord, and Premiere Pro.

---

## Resource Estimates & Benchmarks

### 1. CPU & Memory Consumption

| Operation | CPU Usage (Single Core) | Memory (RAM) Footprint | Notes |
|:---|:---|:---|:---|
| **Recording (Active Tab)** | **0.5% – 1.5%** | **~30 MB – 50 MB** | Passive interception. No video decoding or encoding in extension. |
| **Recording (Backgrounded)** | **1.0% – 2.0%** | **~40 MB – 70 MB** | Includes Web Worker ticker and Web Audio keep-alive. |
| **Timeline Scrubbing (Studio)**| **2.0% – 5.0%** | **~60 MB – 90 MB** | HTML5 video preview leverages hardware GPU decoding. |
| **Remuxing: 30s Clip** | **40% – 60%** (burst ~300ms) | **~45 MB – 65 MB** peak | Pure memory byte-stream manipulation; zero re-encoding. |
| **Remuxing: 2m Clip** | **50% – 75%** (burst ~1.2s) | **~160 MB – 220 MB** peak | Yields UI thread every 5 segments to prevent frame drops. |
| **Remuxing: 5m Clip** | **60% – 85%** (burst ~3.0s) | **~350 MB – 500 MB** peak | Clips > 45MB trigger direct DOM download to bypass Base64 IPC overhead. |

### 2. Network Bandwidth Usage

| Recording Mode | Video Quality | Bitrate / Bandwidth | Data Transferred |
|:---|:---|:---|:---|
| **Passive Interception** | Any | **0 KB/s (0 Mbps)** | **Zero additional network usage**. Intercepts the player's existing stream traffic. |
| **Background / Polling** | 1080p (Source) | ~3,500 – 5,000 kbps (437 – 625 KB/s) | ~26 – 37.5 MB / min (~1.5 – 2.25 GB / hr) |
| **Background / Polling** | 720p | ~1,800 – 2,500 kbps (225 – 312 KB/s) | ~13.5 – 18.7 MB / min (~810 MB – 1.1 GB / hr) |
| **Background / Polling** | 480p | ~800 – 1,200 kbps (100 – 150 KB/s) | ~6 – 9 MB / min (~360 – 540 MB / hr) |
| **Playlist Polling Only** | Control only | ~8 kbps (~1.0 KB/s) | ~60 KB / min (media playlist refresh every ~1.5–2.0s) |

*Deduplication Guard*: Segments already downloaded by the live player are tracked via sequence Sets and never re-fetched.

---

## File Structure

```
idn-live-clipper-ext/
├── manifest.json            # Manifest V3 configuration & permission boundaries
├── rules_zendesk.json       # Declarative Net Request rules blocking Zendesk telemetry/scripts
├── background.js            # MV3 service worker — tab routing, GraphQL API, downloads
├── content.js               # Content script — buffer engine, audio watchdog, floating UI
├── injected.js              # Page-world script — XHR/fetch hooks, player API bridge
├── clipper/                 # Dedicated Clipper Studio
│   ├── clipper.html         # Studio interface & dual-handle timeline
│   ├── clipper.js           # Studio controller, playhead tracking, IPC receiver
│   └── clipper.css          # Dark studio theme
├── lib/
│   ├── mux.min.js           # videojs/mux.js transmuxing core
│   ├── clipperStorage.js    # IndexedDB storage layer & rolling buffer manager
│   └── clipperTransmuxer.js # TS to fMP4 transmuxer & ISO BMFF box duration patcher
├── popup/
│   ├── popup.html           # Browser action popup UI
│   ├── popup.js             # Live stream browser & quick clip triggers
│   └── popup.css            # Extension popup styling
└── icons/                   # Extension icons (16px, 48px, 128px)
```

---

## Installation & Setup

1. Clone or download this repository:
   ```bash
   git clone https://github.com/<owner>/idn-live-clipper-ext.git
   ```
2. Navigate to `chrome://extensions/` in Google Chrome or any Chromium browser.
3. Enable **Developer mode** via the top-right toggle.
4. Click **Load unpacked** and select the `idn-live-clipper-ext` directory.

---

## Studio Keyboard Shortcuts

| Shortcut | Action |
|:---|:---|
| `Space` | Toggle Preview Play / Pause |
| `[` | Set Clip Start Point to current Playhead |
| `]` | Set Clip End Point to current Playhead |
| `←` / `→` | Step Playhead backward / forward by 1 second (Hold `Shift` for 10s) |
| `C` | Toggle Clipper Studio tab |
| `Esc` | Close modal or return focus |

---

## Permissions & Security

| Permission | Purpose |
|:---|:---|
| `activeTab` / `tabs` | Directs clip commands and syncs buffer between Studio and stream tabs. |
| `storage` / `unlimitedStorage` | Stores buffer retention preferences and overrides IndexedDB origin quotas. |
| `declarativeNetRequest` | High-efficiency network-level blocking of third-party trackers (Zendesk). |
| `webRequest` | Backup stream URL discovery for non-standard playback configurations. |
| `downloads` | Saves generated MP4 video files directly to the local filesystem. |
| `host_permissions` | Scoped strictly to `idn.app`, IDN API endpoints, and AWS CloudFront / IVS CDNs. |

---

## License

Distributed under the [MIT License](LICENSE).
