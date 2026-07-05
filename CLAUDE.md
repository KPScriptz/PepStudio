# PepStudio Ultimate Rebuild Specification & Architecture Blueprint

You are the Principal AI Software Architect tasking with building/rebuilding PepStudio. This document represents the absolute source of truth for the codebase. Every system, schema, and layout has been production-verified. You must execute this architecture non-destructively, protecting established backend engines and DOM selector boundaries.

---

## 1. FIXED REPOSITORY STATE & ARCHITECTURAL GUARDRAILS

### A. Environment Core
- Stack: 100% Vanilla JavaScript, ESM module syntax, hardware-accelerated local subprocess spawning (`ffmpeg`, `whisper-cli` with Metal acceleration).
- Sandbox: All persistent state, local downloads, and rendering passes live cleanly in `~/Library/Application Support/PepStudio`. No project outputs pollute the source tree.
- Core UI Theme: dark = **CHROME DEEP flat obsidian** (#09090b chrome / #151518 panels / #1b1b1f tab wells / #0c0c0e input+track wells, 7%-white separators; lane tokens V2 violet #5a3791 · V1 cobalt #2244a0 · A1 teal #1a7468 · A2 amber #bc5333 · A3 ochre #cb812b; PepAI heat tiers = 2px TOP EDGES on V1 clips: hot crimson #ef4444 / warm orange #f97316 / cool blue #3b82f6 — fills stay uniform). Light theme = Liquid Glass (frosted cards, 22px blur). No emojis anywhere — SVG icons only.

### B. Selector Guardrails (DO NOT REMOVE, RENAME, OR SHIFT)
The application runtime attaches over 20 specific event listeners to these structural DOM nodes. They must remain active and intact across layout shifts:
`#funnyBtn`, `#player`, `#hlList`, `#analyzeBtn`, `#editor`, `#metaInfo`, `#progress`, `#toast`, `#themeToggle`, `#seqExportBtn`, `#pathInput`, `#importBar`, `#recentsGrid`.

### C. Critical Landmines to Prevent Regressions
- Never Overwrite Source Ranges: Do not write clip mutation loops that overwrite `clip.start` or `clip.end` with relative timeline offsets (0, 4, 8...). They must remain absolute source-video positions used for frame-accurate extraction.
- Avoid the `zoompan` Filter Bug: Never use FFmpeg's `zoompan` filter for frame resets or punch-ins. It triggers heavy drop-frame stuttering. High-retention emphasis zooms must use single-quoted frame-evaluated scaling (`scale='...':eval=frame`) combined with center crops (`crop=1080:1920:(iw-ow)/2:(ih-oh)/2`).
- Safe Libass Subtitle Headers: The `[Events] Format:` metadata layout inside subtitle files must remain a fully specified 10-field array (Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text) to stop rendering leaks.

---

## 2. COMPLETED FEATURE TRACKS (THE VERIFIED APP FEATURE SET)

### Track 1: Premiere-Style Project Launch Screen
- Implementation: Full-screen glass overlay (`#view-project-picker`) that initializes on boot, masking the main workspace. Features a `📁 New Project` button and a persistent historical grid (`#recentsGrid`).
- Persistence Layer: Saves project data arrays (`id`, `name`, `path`, `timestamp`) into `localStorage` (`pep_recents`).
- Card Actions: Hovering on recent project cards reveals interactive ✏️ (Rename) and 🗑️ (Delete) buttons that safely mutate local storage without breaking corresponding video render caches.
- Thumbnail Pipeline: Project cards fetch real video preview frames using the secure `GET /api/thumb?id=...&t=1` endpoint, rendering an extracted 480×270 JPEG of the source media at timestamp t=1.0s.

### Track 2: Premiere 4-Pane Workspace Grid Layout
- Architecture: Clicking a project instantly hides the picker overlay and reveals `#view-workspace` configured as a complete professional NLE interface frame:
  1. Left Column: Top pane houses `Effect Controls` showing real-time Transform inspector values (Position, Scale, Opacity); bottom pane houses the active `Project Media Bin` drop-zone container (`#importBar`).
  2. Center Panel: The main `Program Viewport Monitor` displaying the `#player` video element over a fallback "No Media Loaded" layout mask.
  3. Right Panel: The `Sequence Highlights Inspector` displaying the core `#hlList` scroll pane cards.
  4. Bottom Panel: The `Master Track Lanes System` showing color-coded track control headers (V2 Overlays, V1 Video, A1 Audio, A2 SFX/Music) aligned flush with the interactive canvas (`#timeline`).

### Track 3: Native Ingest & Cross-Platform Dialog Bridge
- Electron Native Dialog: Clicking `📁 Import Media` invokes a secure context-isolated IPC handle channel (`window.electron.showOpenDialog`) to trigger a genuine system file explorer window with video extension filtering (`.mp4`, `.mov`, `.mkv`).
- Browser Fallback: Gracefully degrades to a prompt window in headless/browser dev environments.
- Universal Landing Hook: Both the file dialog and the workspace drag-and-drop overlay route into `window.pepResolveNativeFilePath(absoluteDiskPath)`. This sets `state.currentVideoPath`, adds an active asset card (`🎬 filename.mp4`) inside the Media Bin, hides the player text fallbacks, and unlocks `#analyzeBtn`/`#funnyBtn` processing steps.

### Track 4: Advanced Sequence Exporting & Multi-Track Overlays
- Schema Layout: Structure fields handle parallel timeline tracks: `clip.overlays = []` for visual overlays and `clip.automation = { bgMusic: {}, sfxTrack: [] }`.
- Kinetic Caption Engine: Splits speech tokens into rapid-fire 1-2 word subtitle frames, strips punctuation, and highlights high-retention trigger keywords in amber.
- Time-Expression Zooms: Translates text token emphasis flags into automatic, artifact-free 1.15x camera jump cuts matching subtitle delivery frames.
- Mixed B-Roll Image Support: The `exportSequence` engine processes `type: 'broll'` overlay items by mapping supplementary image paths dynamically as extra inputs (`-i`), scaling them to fit the container height, and rendering them centered using an `overlay` video filter block.
- Single-Pass Compilation: Synthesizes vertical 9:16 video conversions, frame punch-ins, title blocks, B-roll frames, textfile captions, ducked background music loops, and delayed sound effects (`amix`, `adelay`) inside a single parallel FFmpeg command path.

### Track 5: PepAI GTA Comedy Retention Training Engine
- Data Layer: A zero-dependency background optimization worker (`lib/trainer.js`) executes a scheduled daily data pass to parse viral metrics from the top 100 gaming comedy creators, outputting structural weights directly into `data/gaming_heuristics.json`.
- Heuristic Configuration:
  1. Target Pacing: Drives a fast-paced cutting interval target (~1.32s) to capture rapid visual changes.
  2. Loudness Z-Score: Tracks localized volume deltas (~2.71) to immediately isolate chaotic screaming, prox-chat banter, and massive physical explosions.
  3. Comedic Delay Hangtime: Sustains visual playback for exactly 160ms *after* a peak audio threshold violation before triggering a hard jump-cut, ensuring the physical gag lands.
  4. Filtering: Gives a `+25` score priority boost to chaotic audio moments while applying a `-20` penalty to boring intro filler content ("Okay guys", "So basically").

---

## RECOVERY STATUS — 2026-07-01 (what is actually implemented on disk)

This codebase was **recovered from Claude session transcripts after a full Mac wipe** — the GitHub repo (`KPScriptz/clipforge`) was stuck at `v0.3.1`; the entire advanced NLE was local-only and never pushed. Recovered files were verified against the blueprint above. Honest current state:

- **Track 1 (Project picker/recents):** ✅ implemented — `public/app.js` (`pep_recents`, `recentsGrid`, rename/delete cards), `GET /api/thumb`.
- **Track 2 (4-pane workspace):** ✅ **implemented 2026-07-01.** `public/index.html` relocates `#importBar`, `.stage`, `.panels`, and the timelines into a 4-pane grid — Effect Controls + Media Bin (left) / Program Monitor (center) / Highlights + Ghost + Publish (right) / Phantasm timeline + track lanes (bottom) — via `.nle-*` classes in `public/style.css`. Done **non-destructively**: existing nodes are re-parented, no IDs renamed/duplicated; columns are fluid/shrinkable. `app.js` no longer hides `#editor` during import/analyze (workspace is persistent). Verified end-to-end in the browser: New Project → analyze sample → monitor + Phantasm waveform + highlights + V1/A1 multi-track all populate.
- **Track 3 (Native ingest bridge):** ✅ implemented — `pepResolveNativeFilePath` (app.js), `showOpenDialog` IPC (`electron/main.cjs` + `electron/preload.cjs`).
- **Track 4 (Sequence export / overlays):** ✅ implemented — `exportSequence` in `lib/exporter.js` wired at `server.js`, broll handling, kinetic captions (`lib/captions.js`), artifact-free zooms (`lib/zooms.js`, `scale=...:eval=frame` — never `zoompan`).
- **Track 5 (PepAI):** ✅ **enabled 2026-07-01** — Ollama 0.31.1 installed user-space (`~/.local/ollama` + `~/.local/bin/ollama` wrapper; models in `~/.ollama`), `llama3.2:3b` pulled, auto-starts via `~/Library/LaunchAgents/com.pepstudio.ollama.plist`. `/api/status` → `pepai.ready:true`; `POST /api/pepai/enhance {clips:[{id,transcript}]}` returns AI titles/tags via `lib/pepai.js`. The daily **`lib/trainer.js`** self-tuning worker (2026-07-01) writes `data/gaming_heuristics.json` — expands the retention-trigger lexicon monotonically and EMA-converges the pacing/loudness/delay/penalty weights toward the comedy targets. `lib/retention.js` consumes it: `triggerBoost(text)` raises a clip's score per trained trigger-word hit (capped at 3) and `hookPenalty` magnitude is now trainable; both feed the funny-ranking fusion in `server.js`. Runs at login + daily 8:00 AM via `~/Library/LaunchAgents/com.pepstudio.trainer.plist` (repo copy in `deploy/`). Path is pinned to `<clipforge>/data` in both trainer + reader so they agree across launch modes. (loudness-z / pacing / delay are stored + available via `retention.heuristics()`; deeper gate/trim consumption is a further step.)
- **NLE polish (2026-07-01):** transport bar under the monitor (play / ±5s / scrub / time) driving `#player`; **sequence playhead** over the track lanes (maps source time → the active kept clip's position); **score-tiered clip colors** (`.tblk.clip.hot/warm/cool`). Plus native macOS **drag-and-drop** of video files into the app (`pepstudio-mac` `DropWebView` → `pepResolveNativeFilePath`).
- **Guardrails verified present:** no `zoompan` (only a warning comment in `lib/zooms.js`), `eval=frame` zooms, 10-field ASS `Format:` headers, Liquid Glass theme (`public/style.css`).

### Run modes (macOS; user-space toolchain, NO Homebrew)
- **Native macOS app:** open `~/Documents/PepStudio/PepStudio.xcodeproj` → ⌘R (WKWebView shell, "Sign to Run Locally"; boots this server). Backed up at `KPScriptz/pepstudio-mac` (private).
- **Electron:** `cd ~/Documents/clipforge && npm run electron`
- **Server only:** `npm start` → http://localhost:4178
- **External tools:** `~/.local/bin` (`ffmpeg` with libass, `ffprobe`, `whisper-cli`, `yt-dlp`); whisper model at `~/whisper.cpp/models`; node at `~/.local/node/bin`.
- **Verify a change:** boot the server, generate a speech sample (`ffmpeg -f lavfi -i color=black:s=1280x720:d=11 -i ~/whisper.cpp/samples/jfk.wav -shortest out.mp4`), then drive the pipeline.

## STATUS ADDENDUM — 2026-07-02 (verified on disk)

- **Encoder policy (benchmarked, not assumed):** `libx264 veryfast` is the DEFAULT — on M1 Pro the vertical chain is filter-bound and x264 measured 7.4s vs VideoToolbox 9.2s (+20% file size) on a 60s 1080x1920 export. `PEP_ENCODER=vt` opts into hardware (frees CPU for concurrent whisper/analysis). Logic + benchmark note live in `lib/ff.js` `videoEncodeArgs()`.
- **Parallel pack rendering:** `/api/export/tiktok` renders clips CONCURRENTLY (per-clip whisper→zoom→encode pipelines are independent; `mkdtemp` per call verified collision-free). Measured: 3 captioned verticals in 14s wall.
- **Shorts quality chain:** light `unsharp` BEFORE the caption burn (no glyph ringing) + single-pass `loudnorm` to −16 LUFS mobile target (measured −14.6 on output). Lanczos scaling was already in place.
- **Title synthesizer (`lib/pepai.js`):** high-CTR frameworks (incomplete-narrative curiosity loop / hyperbolic stake / interpersonal drama), ≤55 chars, bans generic words (gaming/lets play/episode/part/stream/video).
- **Transport:** frame-accurate stepping (1/source-fps; Shift = 5s), SVG play/pause, spacebar play/pause (input-guarded).
- **Two LaunchAgents (do not conflate):** `com.pepstudio.ollama.plist` keeps the local LLM server alive; `com.pepstudio.trainer.plist` runs the DAILY 8:00 AM self-tuning pass (login + calendar) writing `data/gaming_heuristics.json`. The trainer is a local snapshot + EMA convergence — it does not fetch external creator telemetry.
- **PepAI interactive console (2026-07-02):** in-app chat panel (right column, `#pepaiChatLog/#pepaiChatInput/#pepaiChatSend`) → `POST /api/pepai/chat` → `chatWithPepAI()` (lib/pepai.js, Ollama /api/chat). The model may end replies with `[MUTATION]{...}`; server whitelists+clamps keys (targetPacingInterval 0.5-3, loudnessThresholdZ 1.5-4, comedicDelayTailMs 40-400, triggerWeight 0-2, hookPenalty -4-0, addTriggers≤12) and merges into `data/gaming_heuristics.json` — hot-reloaded by the ranker. Parser tolerates small-model output drift (fences / trailing prose / bare key=value). Chat can NEVER touch clips or files beyond that one weights file.
- **Sequence lanes are scrubbable (2026-07-02):** click/drag on `#trackLanes` back-maps lane-x% → sequence time → source time via `state.seqMap` (read-only). Trainer targets now the squad-chaos profile (pacing 1.15 / z 3.10 / tail 80ms + banter trigger phrases) — converged via the existing EMA machinery.
- **Not applicable on this hardware (do not implement):** NVENC/CUVID/CUDA, Direct3D11, AVX-512/x86 assembly, HugeTLB — Apple Silicon Mac; write no dead code for these.
