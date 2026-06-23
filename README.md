# ⚡ PepStudio

A **local, free, AI-assisted gameplay editor** for the Mac. Drop in an hour of raw
gameplay; it auto-finds the action and gives you a Premiere-style timeline to curate,
then exports a long-form cut, vertical shorts, captions, and thumbnails.

No cloud, no uploads, no watermarks, no monthly limits. Everything runs on your machine
with **FFmpeg** + **whisper.cpp**.

## Paste a link → publish-ready clips

Drop in a **YouTube or Twitch VOD link** (or a local file) and PepStudio downloads it with
`yt-dlp`, analyzes it, then gives you two one-click exports:

- **🎵 TikTok pack** — your top moments as vertical 1080×1920 clips with burned-in,
  Hormozi-style captions (each clip transcribed and perfectly aligned).
- **▶ YouTube cut** — a **cold-open hook** (your single best moment up front for
  retention) + a tight, dead-air-removed edit, with captions aligned to the final cut.

> Clip your own streams/VODs. Nothing is uploaded — every step runs locally.

## 👻 Phantasm — tag, don't delete

PepStudio doesn't blindly throw footage away. Dead space stays on the timeline as
**red "ghost" clips** until you decide to banish them — so a silent-but-epic stealth
play never gets auto-trashed.

Dual-engine detection:

- **Audio** — mic below **−35 dB for >1.5 s** → ghost (silence)
- **Video** — a **static screen held >3 s** (`freezedetect`) → ghost, *even when you're
  talking over it* (loading screens, lobbies, menus)

🟩 green = keep · 🟥 red = ghost · ⚠ = silent-but-moving (possible stealth play — check
before cutting). Adjacent ghosts are split by reason, so a loading screen and a stealth
play stay independently keepable. Hit **Banish all red** (or press `B`) to export the cut
from everything still green. Keys: `G` toggle keep/ghost, `V` verify (play 2 s), `B` banish.

## Install (desktop app)

PepStudio is a **native macOS app** (Electron) — its own window and dock icon, no
Terminal, no browser. The Node server runs embedded inside it.

1. Download `PepStudio-<version>-arm64.dmg` from the [Releases](../../releases) page.
2. Open it and drag **PepStudio** onto **Applications**.
3. **Right-click PepStudio → Open → Open** the first time (it isn't Apple-notarized).
4. It opens its own window with a setup splash, then the editor.

On first launch it pulls what it needs from the internet: **yt-dlp** (downloaded directly,
no Homebrew) and the **~141 MB speech model**. **FFmpeg with libass** and **whisper.cpp**
are used from your system if present, else installed via [Homebrew](https://brew.sh).
Electron bundles Node, so no separate Node install is required. Everything mutable
(downloads, renders, model) lives in `~/Library/Application Support/PepStudio`.

## Run from source (devs)

```bash
npm install
npm run electron     # the desktop app (embedded server + native window)
npm start            # or just the server → open http://localhost:4178 in a browser
```

Paste a **YouTube/Twitch URL** or the absolute path to a local file. Needs `ffmpeg` and
`whisper-cli` available (yt-dlp is auto-fetched). Nothing is uploaded — files are
processed in place.

## Captions: burn-in is on by default

Transcription always works. **Burning** captions into the pixels needs an FFmpeg built
with **libass**. Homebrew's core `ffmpeg` 8.x ships *without* it (the extras moved to a
separate formula), so:

```bash
brew install ffmpeg-full     # bottled, keg-only — does NOT touch your core ffmpeg
```

PepStudio's `lib/ff.js` auto-detects `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`, so the
`subtitles`/`drawtext` filters light up and exports burn the animated captions in. Set
`FFMPEG_PATH` to override. Without libass, PepStudio degrades gracefully and exports a
`captions.srt` for YouTube Studio / CapCut instead.

## Build the app

```bash
npm run dist                 # → dist/PepStudio-<version>-arm64.dmg (Electron desktop app)
```

## Tuning

Pass options in the Analyze request (`opts`) — defaults in `lib/analyze.js`:

| option | default | meaning |
|---|---|---|
| `silenceDb` | `-35` | dB below which audio counts as silence |
| `silenceMin` | `1.5` | min seconds of quiet to ghost it |
| `freezeDb` | `-50` | static-screen sensitivity (`freezedetect` noise floor) |
| `freezeMin` | `3` | min seconds of frozen video to ghost it |
| `threshold` | `0.30` | scene-change sensitivity (lower = more cuts) |
| `count` | `8` | how many highlights to surface |
| `clip` | `30` | default highlight length (seconds) |
| `minGap` | `18` | min spacing between highlights (seconds) |

## Project layout

```
server.js          Express API + video streaming + render endpoints
lib/ff.js          ffmpeg/ffprobe helpers (auto-prefers libass build), capability utils
lib/analyze.js     loudness, silence, scene cuts, freeze detection, Phantasm segmenter
lib/exporter.js    long cut / vertical shorts / thumbnail rendering
lib/captions.js    whisper.cpp transcription -> .ass (animated) + .srt
public/            the editor UI (vanilla JS, no build step)
electron/          desktop shell — embeds the server, native window, first-run setup
scripts/           legacy launcher packaging
renders/<id>/      exported mp4s, captions, thumbnails
```
