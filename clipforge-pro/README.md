# ClipForge Pro

Turn long videos into vertical short-form clips — **locally, unlimited, and without a watermark**.

A self-hosted alternative to Opus Clip. It transcribes your footage, finds the moments worth
clipping, reframes them to 1080×1920 following the speaker, burns in word-by-word captions,
and hands you an MP4 per clip plus a review page.

```bash
cfp stream.mp4 --clips 8 --prompt "funniest moments"
```

---

## Why this instead of Opus Clip

| | Opus Clip | ClipForge Pro |
|---|---|---|
| Cost per clip | Credits | None — it's your CPU/GPU |
| Volume | Plan-limited | Unlimited |
| Watermark | On free tiers | Never |
| Your footage | Uploaded to a server | Never leaves the machine |
| What to look for | Fixed heuristics | `--prompt "the parts where he rage quits"` |
| Why a clip was picked | Opaque score | A written reason per clip |
| Gameplay with no talking | Poorly handled | First-class: ranks on audio/visual chaos |
| Works offline | No | Yes (after first model download) |

---

## Install

Requires **Python 3.10+** and **ffmpeg** (with `libass` for captions) on your `PATH`.

```bash
git clone https://github.com/KPScriptz/PepStudio.git
cd PepStudio/clipforge-pro
python -m venv .venv && source .venv/bin/activate
pip install -e .
```

ffmpeg: `brew install ffmpeg` (macOS), `sudo apt install ffmpeg` (Debian/Ubuntu),
or [ffmpeg.org/download](https://ffmpeg.org/download.html) (Windows).

Optional: set `ANTHROPIC_API_KEY` to have Claude choose the clips. **Without a key everything
still works** — the built-in heuristic takes over automatically.

---

## Quick start

```bash
cfp podcast.mp4 --clips 8 --prompt "the most surprising moments"
```

```bash
cfp https://youtube.com/watch?v=... --clips 5 --preset pepercollectibles
```

```bash
cfp gameplay.mkv --gaming --no-api --clips 10
```

Then open `out/index.html`.

Output folder:

```
out/
├── index.html                     review page: previews, scores, copy buttons
├── clips.json                     every clip with timings, scores, reasons, tags
├── clip_01_he-flew-into-the-....mp4
├── clip_01_he-flew-into-the-....jpg
└── ...
```

---

## How it works

1. **Ingest** — a local file, or any URL `yt-dlp` can fetch.
2. **Transcribe** — faster-whisper with word-level timestamps. Uses CUDA when a GPU is
   genuinely present, else CPU int8. Cached to JSON, keyed by file content + settings, so a
   re-run costs nothing.
3. **Signals** — loudness spikes (ffmpeg → numpy), scene cuts, speech rate.
4. **Pick clips** — the timestamped transcript and the signal peaks go to Claude, which
   returns structured JSON: start, end, hook, title, virality score, reason, hashtags.
   Boundaries are then snapped to sentence ends and clamped to 15–60 s.
   **No API key? A heuristic picker scores the same signals locally.**
5. **Reframe** — OpenCV YuNet (falling back to Haar) tracks the speaker; a smoothed crop path
   follows them. Gameplay, or anything with no face, gets a blurred-background fit so nothing
   important is cropped away.
6. **Captions** — ASS subtitles, 1–3 words at a time, the active word highlighted with a pop.
   Optional hook text over the first 3 seconds.
7. **Export** — one MP4 per clip, rendered in parallel, plus `clips.json` and `index.html`.

### Gaming mode

If speech is sparse (< 0.6 words/sec) ClipForge switches to ranking on **audio spikes and
scene changes** instead of dialogue, so footage where nobody talks still produces clips.
Force it with `--gaming`, or force it off with `--no-gaming`.

### Hardware encoding

The encoder is **probed, not assumed**. Distro ffmpeg builds list `h264_nvenc` and `h264_qsv`
on machines with no such hardware, so ClipForge actually encodes a few frames with each
candidate and keeps the first that works (NVENC → QuickSync → AMF → VideoToolbox → libx264).
The result is cached. Override with `--encoder nvenc` or `CFP_ENCODER=libx264`.

> Hardware encoding frees the CPU for the concurrent whisper and OpenCV work. It is not always
> *faster* end to end — this pipeline is often filter-bound, where a well-tuned `libx264
> veryfast` can match or beat it. Benchmark your own footage before assuming.

---

## CLI

```
cfp SOURCE [options]

  -n, --clips N           how many clips (default 8)
  -p, --prompt TEXT       what to look for
  -o, --out DIR           output directory (default ./out)

transcription
  --model NAME            faster-whisper model (default base.en)
  --language CODE         force a language
  --device auto|cuda|cpu  auto uses the GPU only if one really exists
  --no-cache              ignore the transcript cache

selection
  --min-dur / --max-dur   clip length bounds (default 15 / 60)
  --gaming / --no-gaming  force audio-spike or speech-led ranking
  --no-api                skip Claude, use the heuristic
  --api-key KEY           default: $ANTHROPIC_API_KEY
  --api-model ID          default: claude-opus-5-5

render
  --preset NAME           brand | gaming | pepercollectibles | plain
  --no-captions           don't burn subtitles
  --no-hook               no hook text over the opening
  --encoder NAME          auto | libx264 | nvenc | qsv | amf | videotoolbox
  -j, --jobs N            parallel clip renders (default: auto)
  --crf N                 quality, lower is better (default 20)

other
  --dry-run               pick clips and print them, render nothing
  --min-free-gib N        refuse to render below this much free disk
  -v / -q                 verbose / quiet
```

### Presets

| Preset | Captions | Forced hashtags |
|---|---|---|
| `brand` *(default)* | Yellow highlight, navy outline | — |
| `gaming` | Larger, lower, 2 words a frame | `#gaming #gamingclips` |
| `pepercollectibles` | Brand look | `#pepercollectibles` |
| `plain` | White on black, mixed case | — |

Presets live in `cfp/config.py` — add your own by copying an entry in `PRESETS`.

### Environment variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Enables Claude-based clip selection |
| `CFP_ENCODER` | Force an encoder |
| `CFP_CACHE_DIR` | Where transcripts, models and probes are cached |
| `CFP_NICE` | Subprocess niceness (default 5, `0` disables) |
| `CFP_YUNET_MODEL` | Path to a YuNet ONNX |
| `CFP_HAAR_CASCADE` | Path to a Haar cascade XML |

---

## Tests

No video files are committed. Generate the footage first — it is synthesised from ffmpeg's own
sources and its `flite` speech synth, so the loudness spikes and scene cuts are at **known**
timestamps the tests assert against:

```bash
python scripts/make_fixtures.py tests/data
```

```bash
pytest -m "not slow"
```

```bash
pytest
```

142 tests. The fast suite runs in ~15 s and skips cleanly if the footage is absent; `-m slow`
adds two real end-to-end renders.

---

## Notes, limits, and things that bite

- **`crop` has no `eval` option.** Its `x`/`y` expressions are re-evaluated every frame
  automatically. Passing `eval=frame` to it is a hard "Option not found" error. (`scale`,
  `overlay` and `pad` *do* take `eval`.)
- **`zoompan` is never used** — it causes drop-frame stuttering. Camera motion comes from a
  `crop` whose `x` is a function of `t`.
- **The `[Events] Format:` line must list all ten fields.** A short one makes libass misparse
  every row after it and leak text into the picture.
- **Expressions containing commas must be single-quoted** inside a filter graph, or the comma
  starts a new filter and silently corrupts the chain.
- **Face tracking smooths with a zero-phase kernel, not an EMA.** An EMA trails whatever it
  follows; measured on a speaker panning at ~135 px/s it put the crop 150 px behind the face.
- **Face selection weighs confidence, not just box size.** A low-confidence false positive with
  a bigger box will otherwise hijack the crop.
- **faster-whisper is fed a numpy array, not a path.** Its internal decode goes through PyAV,
  and PyAV 19 removed the `metadata_errors` kwarg faster-whisper still passes, so the path API
  raises `TypeError` on a current install. We decode with ffmpeg instead.
- **OpenCV 5 removed `CascadeClassifier`** and ships no cascade data, so the Haar fallback
  doesn't exist there. Hence the `<5` pin. The code degrades to a blurred fit on 5.x.
- **Clips never overlap** and are always clamped to `[min-dur, max-dur]` and to the source,
  no matter what the model suggests.
- **One bad clip doesn't sink the batch** — failures are isolated, reported in `clips.json`
  and shown on the review page.

### Not verified on this machine

Built and tested on Linux with CPU inference and software encoding. These paths are
implemented and unit-tested with mocks, but have **not** been exercised against real hardware
here, so try them on your own box before relying on them:

- CUDA transcription (`--device cuda`)
- NVENC / QuickSync / AMF / VideoToolbox encoding
- Live Claude API selection (no API key was available; the request/response handling is
  covered by mocked tests, including refusal fallback and schema validation)
- VAAPI is deliberately **not** implemented — it needs its own upload/download filter chain,
  and a half-working path is worse than none.

## License

MIT
