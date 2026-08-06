PepStudio 1.3.1 — **one download, nothing to install.**

FFmpeg, FFprobe and whisper.cpp now ship inside the app. Unzip, run `PepStudio.exe`, drop in a video. No `winget`, no PATH setup, no separate installs.

The bundled build includes libass, so caption burn-in works, and whisper is included too — so ranking moments and generating captions work out of the box, not just analyze and export.

The only thing still fetched on first run is the ~141 MB speech model, downloaded automatically in the background with a progress indicator. Nothing for you to do.

## Everything from 1.3

- **Retention critic** — audits a cut before rendering: speech density, gaps with no cut or effect, dead air that survived into a kept clip, weak cold opens. On a real 68-minute VOD it found 54 seconds of un-purged dead air (22% of the runtime).
- **Retention learning loop** — feed it your YouTube Studio retention CSV and viewer drop-offs become bounded adjustments to how moments are ranked. Cliffs it can't explain are ignored rather than guessed at.
- **Benchmarking** — find which uploads genuinely overperformed (against the channel's own median, which the mean can't do), and compare pacing: cuts per minute, words per minute, silence ratio.
- **Dynamic cut length** — the cut is as long as the footage deserves. 4 minutes of gold gives 4 minutes; 25 minutes of gold gives 25.
- **Transcript editing, magnetic snapping, ripple delete, pacing sliders.**

## Install

Download the zip, unzip anywhere, run `PepStudio.exe`.

Windows will warn that the app is unsigned — **More info → Run anyway**. Code signing needs a paid certificate.

An installer `.exe` is also attached if you prefer a Start Menu entry.

**macOS:** see [v1.1.0](https://github.com/KPScriptz/PepStudio/releases/tag/v1.1.0) for the Apple Silicon DMG (FFmpeg via Homebrew there).
