PepStudio 1.2 — **the first Windows release**, built and smoke-tested on a real Windows machine rather than cross-compiled and hoped for.

## Windows support

PepStudio shells out to FFmpeg, FFprobe and whisper.cpp, and all of that plumbing was macOS-only: it built the PATH with `:` separators, looked up tools with the POSIX shell builtin `command -v`, downloaded the macOS build of yt-dlp, and fell back to Homebrew. A Windows build would have installed, launched, and then died the moment you analyzed a file.

That layer has been rewritten to make the platform decisions explicit and testable. Several of the bugs it fixed fail *silently* rather than loudly — the render appears to succeed and the output is wrong:

- **Concat list files.** FFmpeg's concat demuxer treats a backslash as an escape character, so every Windows temp path resolved to garbage mid-render.
- **Subtitle and font paths.** Windows needs the drive colon escaped *and* forward slashes, or the subtitle file never opens and the captions just aren't there.
- **Text overlays.** The `drawtext` fonts were five hardcoded macOS system paths, so every text render failed on the common Windows FFmpeg builds.

Plus the loud ones: PATH assembly, tool lookup, `-hwaccel videotoolbox`, and a hard crash in `~` path expansion (Windows has no `HOME`).

Every push now runs the unit suites on Windows, Linux and macOS, and drives the real analyze → export pipeline on a Windows runner. **This installer only exists because that pipeline passed there.**

### Before you install

- **Install FFmpeg first** — `winget install Gyan.FFmpeg` (or `scoop install ffmpeg`). PepStudio reports what's missing if it can't find it. There's no package manager it can assume on Windows, so it won't install things behind your back.
- Captions and moment-ranking additionally need whisper.cpp on your PATH. Everything else works without it.
- The installer is **not code-signed**, so SmartScreen will warn on first run. Click **More info → Run anyway**. Signing needs a paid Authenticode certificate.

## Dynamic cut length

The 8–10 minute target is gone. A cut is now exactly as long as the footage deserves and not one second longer — length is purely a function of how much material clears the quality bar, with no time ceiling at all.

- 68-minute stream with 4 minutes of gold → a **4-minute** cut.
- The **same** 68-minute stream with 25 minutes of gold → the full **25-minute** epic.
- 3-hour VOD with 45 minutes of gold → **45 minutes**.

A **How picky** slider sets the bar: a moment must score at least that fraction of the VOD's best moment to survive. Raise it to be ruthless, lower it to keep more. The planned length, the reason, and how many moments cleared the bar are shown live before anything renders — changing the blueprint or the bar re-costs it instantly.

If the ranking produces flat scores it says so rather than quietly emitting a three-hour "cut".

## Also in this release

- **Transcript-driven editing** — click a word to seek, strike a run of words to cut exactly those frames. Cmd+Z restores them.
- **Magnetic snapping** (`S` to toggle, `Alt` to suspend) against the playhead, markers, In/Out and every other clip edge, with a guide line showing what it locked onto.
- **Delete** ghosts a clip; **Shift+Backspace** ripple-deletes it from the sequence.
- Continuous **pause floor** and **noise floor** sliders for micro-cut pacing.
- Narrow clips are draggable again — at full zoom on a long VOD a 15-second clip is about 5px wide, and its body used to be unreachable.

## Install

**Windows** — download the `.exe`, run it, click through the SmartScreen warning. A portable `.zip` is included if you'd rather not install.

**macOS** — see the [v1.1.0 release](https://github.com/KPScriptz/PepStudio/releases/tag/v1.1.0) for the Apple Silicon DMG.
