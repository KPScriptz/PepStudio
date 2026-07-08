# AGENTS.md — PepStudio / clipforge

Operational brief for coding agents (Codex, etc.). This is the **web app + engine**
(`KPScriptz/clipforge`). The native macOS shell is a separate repo,
`KPScriptz/pepstudio-mac` (Swift/WKWebView wrapper that boots this server and loads it).
For the full feature/recovery history and design rationale, read **CLAUDE.md** — this
file is the operational essentials. When they overlap, both must stay true; update both.

PepStudio turns a local gameplay VOD into vertical shorts + a YouTube cut, 100% locally:
analyze (silence/scene/loudness) → rank funny moments (whisper + reaction scoring) →
optional PepAI titles/tuning (local Ollama) → FFmpeg export. Nothing is uploaded.

---

## Run it

```bash
npm start                     # = node server.js ; serves http://localhost:4178
# PORT=4178 is the convention (the native shell and preview both expect it)
```

Node **22** required (uses global fetch, top-level await). Vanilla ES modules, Express,
**zero runtime npm deps for the core** — it shells out to CLI tools.

### Toolchain (the app spawns these; it does NOT bundle them)
| tool | used for | if missing |
|---|---|---|
| `ffmpeg`/`ffprobe` | all analyze + export | export/analyze 500s; nothing else works |
| libass-enabled ffmpeg | burning captions into pixels | degrades to a `.srt` sidecar (see `canBurnCaptions()`) |
| `whisper-cli` (whisper.cpp) | transcription, funny-rank | `/api/highlights/funny` 400s; analyze still works |
| `yt-dlp` | YouTube/Twitch import | `/api/import-url` 500s; local files still work |
| `ollama` + `pepstudio-brain` | PepAI titles + console | every PepAI call returns null → heuristic fallback (never crashes) |

**Key point for sandboxed agents:** the app is written to **degrade gracefully** when
tools are absent — `/api/status` reports what's available and the UI hides/relabels
accordingly. So in a fresh cloud sandbox without the toolchain you can still boot the
server, load the UI, edit code, and syntax-check (`node --check <file>`), but you cannot
run a real analyze→export. Don't "fix" a 400/503 that is just a missing local tool.
On the owner's Mac the toolchain lives in `~/.local/{node,bin}` and `ollama` serves on
`:11434` via a LaunchAgent. `pepstudio-brain` is a tuned llama3.2:3b (see `./Modelfile`;
rebuild with `ollama create pepstudio-brain -f Modelfile`).

---

## Architecture

- **`server.js`** — Express API + static host. Routes: `/api/analyze`, `/api/analysis/:id`,
  `/api/highlights/funny`, `/api/pepai/enhance`, `/api/pepai/chat`, `/api/export/{tiktok,sequence}`,
  `/api/import-url`, `/api/video`, `/api/thumb`, `/api/reveal`, `/api/status`, EDL/XML.
- **`lib/`** — `analyze.js` (audio+video passes, Phantasm), `captions.js` (whisper),
  `reactions.js` (funny scoring), `retention.js` (loads `data/gaming_heuristics.json`;
  `hookPenalty`/`triggerBoost`/`pacingTag`), `trainer.js` (daily EMA self-tuner),
  `pepai.js` (Ollama titles + `chatWithPepAI`), `titles.js` (heuristic fallback),
  `exporter.js` (all FFmpeg), `ff.js` (ffmpeg/ffprobe helpers + `videoEncodeArgs()`),
  `zooms.js` (emphasis punch-ins), `trim.js`, `fetch.js` (yt-dlp), `interchange.js` (EDL/FCP7 XML).
- **`public/`** — `index.html` (4-pane NLE: picker overlay + workspace), `app.js` (~1200 lines,
  all UI logic), `style.css` (layered theme system). No build step; edit and reload.

### Data model (do not drift from these field names)
- **highlight/clip**: `{ id, start, end, score, audioScore, reactionScore, keep, title,
  automation?: { bgMusic?:{path,volume}, sfxTrack?:[{time,volume}] }, overlays?:[{type:'text'|'broll', startTime, endTime, content}] }`
- `start`/`end` are **absolute source-video seconds** — see guardrail below.
- `score` is relative (funny rank); tiers in the timeline are hot/warm/cool = top-20%/50%/rest.
  `audioScore` is a small z-ish number (~0–3), **not** 0–100.
- **state** (in `app.js`): `state.highlights` (array), `state.selSeg` (selected id),
  `state.seqMap = { items:[{h,s,d}], total }` — the source-time↔sequence-position map the
  playhead and the drag-scrub both read. `renderTracks()` rebuilds it; don't bypass it.

---

## Guardrails (breaking these has bitten us before)

1. **Never rename/remove the wired DOM IDs.** `app.js` attaches ~59 listeners to IDs in
   `index.html` (`#funnyBtn #player #hlList #analyzeBtn #editor #pathInput #importBar
   #recentsGrid #timeline #banishBtn #seqExportBtn #trackLanes #pepaiChat* #themeToggle …`).
   **Grep the ID in `app.js` before touching any element.** `#importBar` is the import
   *container* (`<section>`), not an input. Restructure by relocating/hiding nodes, never
   by re-declaring the tree.
2. **Never overwrite `clip.start`/`clip.end`** with relative timeline offsets. They are
   absolute source positions used for frame-accurate extraction.
3. **No FFmpeg `zoompan`** (drop-frame stutter). Emphasis zooms use `scale='...':eval=frame`
   + a constant center `crop` (see `zooms.js`).
4. **Libass subtitle `[Events] Format:`** must stay a full 10-field line or text bleeds.
5. **Encoder default is `libx264`** — benchmarked faster than VideoToolbox on this
   filter-bound M-series pipeline. `PEP_ENCODER=vt` opts into hardware. Logic in
   `ff.js videoEncodeArgs()`; don't flip the default without re-benchmarking.
6. **Keep BOTH themes correct** (`[data-theme="dark"]` = flat CHROME-DEEP charcoal;
   `[data-theme="light"]` = Liquid Glass). Dark timeline lanes use an intentional
   FCP-magnetic geometry (unequal lane heights 22/40/22/22/22 with matching `.trk` rows) —
   that is by design, not a bug.
7. **No emojis in the UI** — SVG icons only.
8. **Two LaunchAgents, distinct roles:** `com.pepstudio.ollama` keeps the LLM alive;
   `com.pepstudio.trainer` runs the daily 8AM tuning pass. Don't conflate them.
9. **This is Apple Silicon macOS.** Do not add NVENC/CUDA/Direct3D/AVX-512/HugeTLB code —
   it's dead weight here.

### PepAI console tuning (`/api/pepai/chat`)
Chat may end a reply with `[MUTATION]{...}` (or a `key=value` dialect from small models).
The server **whitelists + clamps** keys (`targetPacingInterval` 0.5–3, `loudnessThresholdZ`
1.5–4, `comedicDelayTailMs` 40–400, `triggerWeight` 0–2, `hookPenalty` −4–0, `addTriggers`≤12)
and merges into `data/gaming_heuristics.json`, which the ranker hot-reloads. Chat can touch
**only** that file — never clips, never other state. Keep it that way.

---

## Verify your change

- Always `node --check <file>` after editing JS. `npm test` runs `test/zooms.test.js`.
- Boot `npm start`, open `http://localhost:4178`. The project picker shows first;
  "＋ New Project" → paste a local path → Analyze. With the toolchain present, a full
  pass is analyze → "Rank funny moments" → Publish → TikTok pack (1080×1920 mp4 in `renders/`).
- CSS/DOM changes: confirm the ~59 IDs still resolve and both themes still read correctly.
- The owner's workflow is: implement → verify in a browser preview (screenshot + DOM
  assertions) → relaunch the native app if Swift changed → commit + push. Match it.

See **BACKLOG.md** for the vetted, prioritized feature queue (what to build next, what NOT to).

## Current state (2026-07-02)
Feature-complete and verified end-to-end on synthetic footage: 4-pane NLE, project
picker/recents, native drag-drop + NSOpenPanel file dialog, analyze/Phantasm, funny-rank,
parallel TikTok pack export (loudnorm + pre-burn sharpen), YouTube cut, EDL/FCP7 XML,
PepAI titles + action-first AI Assistant (one-click actions wired to real pipelines: Remove Dead Air->banish, Rank->funny, Captions, Create Shorts->tiktok; real status+suggestions; NL chat demoted to Advanced Prompt), daily self-tuning trainer, Curate/Publish tabs,
FCP-magnetic timeline (V1 filmstrip thumbnails via /api/thumb, A1 audio waveforms from state.proj.envelope .v, click-to-select clips, HH:MM:SS:FF timecode). **Never yet run on a real gameplay VOD** — that's the outstanding
real-world test. Both repos clean and pushed.
