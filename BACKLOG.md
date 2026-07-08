# BACKLOG.md — vetted feature queue

Triage of a 100-item feature blueprint against the real codebase (2026-07-02). For agents
(Codex etc.) picking up work: build from **🟢 QUEUED**, respect the guardrails in
[AGENTS.md](AGENTS.md), and don't rebuild what's under ✅ or ⛔. Numbers are the blueprint's.

## ✅ Already implemented — do NOT rebuild
- **2** mono/16kHz whisper input — `lib/captions.js:50,241` (`-ar 16000 -ac 1 pcm_s16le`).
- **20 / 100** Ollama kept resident — `pepai.js` sends `keep_alive:"24h"`; `com.pepstudio.ollama` LaunchAgent.
- **38** caption keyword emphasis — `captions.js` flags RETENTION_TRIGGERS for amber styling.
- **40** multi-framework AI titles — `pepai.js` (curiosity-loop / hyperbolic / drama / glitch, ≤55ch).
- **45** music ducked under speech — `exporter.js` (`amix normalize=0`, bgMusic `volume≈0.15`).
- **59** frame-step transport — `#tpBack/#tpFwd` (1/fps; Shift = 5s).
- **64** `B` keyboard shortcut — bound (banish); `G`/`V`/`B` all live.
- **72** styled toasts not `alert()` — `#toast`; native shell also has real `NSAlert`/`NSOpenPanel` (WebView.swift).
- **79** follow macOS appearance — **shipped this pass** (`app.js` theme block; system-follow until user toggles).
- Partial: **33** (rapid 1–2-word caption blocks, not comma-based), **36** (hook = top-ranked early candidates), **44** (fixed center 9:16 crop).

## ⛔ Not applicable on this hardware/stack — skip (with reason)
- **3** `vp9_videotoolbox` — that encoder does not exist in this ffmpeg (only `libvpx-vp9` software); and VideoToolbox benchmarked *slower* than x264 here (see AGENTS.md #5).
- **78** Touch Bar — this machine is `MacBookPro18,3` (2021 16″), which has no Touch Bar.
- **1 / 85** `nice`/P-core pinning — negligible on M1 unified memory; measure before adding.
- **6 / 8 / 16** Float32 banks / SharedArrayBuffer / WASM-SIMD audio — analysis runs in ffmpeg, not JS hot loops; no measured bottleneck. Premature.
- **91** "replace network with sockets" — already local: node `spawn` + stdio pipes, not TCP.
- **96** per-app audio capture — needs a system audio driver (BlackHole/loopback); out of scope for an editor.

## 🟢 QUEUED — buildable, worth doing (grouped by area, ~effort)
Ranked roughly best-value-first within each group. Each names the real seam to touch.

**Curation / ranking** (touch `lib/analyze.js`, `reactions.js`, `retention.js` — highest care; these change output quality)
- **30** adaptive loudness-z baseline for quiet recordings — scale the z threshold to the clip's own noise floor so calm talkers aren't missed. *M*
- **39** dead-space trim >400ms inside fast blocks — extend the existing silence map into the kept ranges. *M*
- **28** comedic lead-in — nudge clip **start earlier** when the transcript shows a setup sentence before a laugh spike. ⚠ never write relative offsets onto `clip.start` (guardrail #2) — compute a new absolute start. *M*
- **50 / 29 / 46** transcript keyword → metadata tags / emotion buckets / genre keyword profiles — all ride `RETENTION_TRIGGERS` + the heuristics file. *M*
- **26 / 27 / 34 / 35** overlap/echo/laughter-dedup/mic-bleed — need multi-track or richer audio features first; **spike before committing**. *L*

**Timeline UI/UX** (`public/app.js` `renderTracks`/`draw` + `style.css`; preserve `state.seqMap`)
- **53** inline waveforms on the green audio lane — precompute a downsampled peak array per clip, draw into `.tblk.speech`. *M*
- **54** frame thumbnails inside cobalt V1 clips — reuse `GET /api/thumb`. *M*
- **56** right-click context menu (split/mute/remove) on clips — new dark menu component. *M*
- **63** per-lane mute/solo → set an export-drop flag (must actually affect `exporter.js`, not be cosmetic). *M*
- **60 / 69** ruler markers / hover frame-preview popup. *M*
- **51 / 73** cmd+/− zoom + auto-center playhead — requires making the lanes horizontally scrollable first. *L*
- **19 / 61 / 68 / 75** translate3d compositing / animated reorder / depth shadows / richer empty-states — cheap polish. *S*

**Native shell** (`pepstudio-mac`, Swift — each needs an Xcode rebuild; can't verify headless)
- **98** system notification when an export finishes — `UNUserNotificationCenter`; small, high value. *S*
- **80 / 93 / 94** media-key transport / QuickLook in bin / window vibrancy. *M*
- **82 / 86 / 87 / 99** disk-space guard / App-Nap opt-out / menu-bar export monitor / RAM-scaled AI limits. *M*
- **95** update notifier (poll GitHub releases). *S*

**Perf / housekeeping** (mostly premature until real long-VOD usage exposes a bottleneck — profile first)
- **10 / 22** LRU eviction + fast integrity checks for `renders/`+`downloads/` — genuinely useful once real footage piles up. *M*
- **5 / 21** worker-thread thumbnail/audio fan-out — only if profiling shows single-thread stalls. *M*
- **12 / 17** stream-while-downloading VOD + resolution pick for vertical targets — real bandwidth/time win. *M*
- **4 / 7 / 9 / 11 / 13 / 14 / 15 / 18 / 23 / 24 / 25** — micro-opts; do **only** when a measurement demands it.

## Top 6 I'd build next
1. **30** adaptive z-baseline (quiet recordings) — biggest quality win.
2. **39** dead-space trim in fast blocks — pacing.
3. **98** native "export done" notification — cheap, satisfying.
4. **53** inline waveforms — the timeline reads pro.
5. **10** render-cache LRU eviction — needed once real VODs accumulate.
6. **63** mute/solo that truly drops tracks from export.

**Reality check:** the engine, ranking, export, PepAI, and both shells are done and verified on
synthetic footage. The single highest-value action is still **running a real gameplay VOD end-to-end** —
that will reveal which of the above actually matter, versus which are solutions to problems we don't have.
