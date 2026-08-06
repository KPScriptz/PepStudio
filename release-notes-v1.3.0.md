PepStudio 1.3 — the editor now checks its own work, and learns from real viewers.

## Retention critic

Every cut map can be audited **before** it reaches FFmpeg. Deliberately not an AI call: every rule is a measurement over data the app already has, so it costs nothing, adds no delay, and returns the same verdict every time.

It checks sustained speech density, gaps with no cut/zoom/overlay/SFX, dead air that survived into a kept clip, and a weak cold open — returning a pass/fail, a score, and a specific fix per issue.

Run against a real 68-minute VOD cut, it found **54 seconds of un-purged dead air (22% of the runtime)** and a 74-second opening at 0.53 words/sec. Those were real defects, not test cases.

Everything is measured in *output* time, so a long gap in the source between two adjacent kept clips isn't counted — the viewer never experiences it.

## Retention learning loop

Export your audience-retention CSV from YouTube Studio and PepStudio will turn viewer drop-offs into bounded adjustments to how it ranks moments.

Each cliff is attributed using the critic's findings at that timestamp — dead air becomes "boring filler", a long stretch with no interrupt becomes "pacing", a drop on a cut boundary becomes "bad timing". **A cliff it can't explain produces nothing**, because a wrong signal is worse than no signal.

Nothing is applied automatically. Rows are recorded; applying them stays a separate, explicit step.

## Benchmarking

Find which of a channel's uploads genuinely overperformed (measured against that channel's own median, which — unlike the mean — isn't skewed by the hits you're looking for), then compare structural pacing: cuts per minute, words per minute, silence ratio, longest gap without a cut.

Any suggested changes are small, bounded, explained, and never applied on their own.

## Fixes

- **First-launch hang.** The status endpoint could throw and never reply, leaving the UI on a blank loading state forever. Most likely to hit a fresh install with FFmpeg missing — i.e. new Windows users. Every probe is now individually guarded.
- **A silently dead learning loop.** The feedback cursor is a line count, so a rotated or truncated log left it pointing past the end of the file — every future correction would have been ignored forever while reporting "no new corrections". It now detects this and recovers.

## Windows

The end-to-end pipeline (analyze → export → vertical render) is verified on a real Windows machine in CI.

**Install FFmpeg first:** `winget install Gyan.FFmpeg`. PepStudio tells you what's missing rather than failing quietly. Captions and moment-ranking additionally want whisper.cpp on your PATH.

The installer isn't code-signed, so SmartScreen will warn on first run — **More info → Run anyway**.

**macOS:** see [v1.1.0](https://github.com/KPScriptz/PepStudio/releases/tag/v1.1.0) for the Apple Silicon DMG.
