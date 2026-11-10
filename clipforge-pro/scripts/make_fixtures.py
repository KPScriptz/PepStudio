#!/usr/bin/env python3
"""Generate reproducible test footage for ClipForge Pro.

No video files are committed to the repo. This script synthesises them from
ffmpeg's own generators plus ffmpeg's ``flite`` text-to-speech, so the test
footage has **known ground truth**: we choose exactly where the loudness
spikes and scene cuts land, then assert the analysis pass finds them.

    python scripts/make_fixtures.py tests/data

Produces:
  gameplay.mp4 - 90s, 6 hard scene changes, sparse speech, 4 loud "explosions"
  talking.mp4  - 45s, a face tracking left-to-right, continuous speech
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import subprocess
import sys
import urllib.request
import wave

SR = 16000

# A face image for talking.mp4. Fetched on demand rather than committed, so the
# repository carries no third-party photography.
FACE_URL = (
    "https://raw.githubusercontent.com/opencv/opencv/4.x/samples/data/messi5.jpg"
)

# Ground truth, asserted by the test suite.
EXPLOSIONS = [12.5, 31.0, 54.2, 68.0]
SCENE_SOURCES = [
    "testsrc2=size=1280x720:rate=30",
    "mandelbrot=size=1280x720:rate=30",
    "life=size=1280x720:rate=30:mold=10:ratio=0.1",
    "rgbtestsrc=size=1280x720:rate=30",
    "smptebars=size=1280x720:rate=30",
    "cellauto=size=1280x720:rate=30",
]
SEGMENT = 15.0
GAMEPLAY_DURATION = SEGMENT * len(SCENE_SOURCES)
SCENE_CUTS = [SEGMENT * i for i in range(1, len(SCENE_SOURCES))]

SPEECH = [
    (3.0, "slt", "Okay guys so basically welcome back to the channel."),
    (26.0, "awb", "Oh my god. Watch this. He just flew into the helicopter."),
    (50.0, "slt", "That was absolutely insane. I cannot believe that worked."),
    (64.0, "rms", "No way. No way! Did you see that explosion?"),
]
# Five segments of deliberately different image quality, so the thumbnail
# frame picker can be tested against known-good and known-bad footage.
QUALITY_SEGMENTS = [
    ("dark",   "mandelbrot=size=1280x720:rate=30", "eq=brightness=-0.42:saturation=0.5"),
    ("blurry", "mandelbrot=size=1280x720:rate=30:start_scale=2.0", "gblur=sigma=9"),
    ("vivid",  "mandelbrot=size=1280x720:rate=30:start_scale=0.8", "eq=saturation=1.55:contrast=1.3"),
    ("sharp",  "testsrc2=size=1280x720:rate=30", "eq=saturation=1.0"),
    ("faded",  "mandelbrot=size=1280x720:rate=30", "eq=brightness=-0.30:contrast=0.35"),
]
QUALITY_SEG = 8.0
QUALITY_SPEECH = [
    (1.0, "slt", "Okay so I just got into the new Vice City map and this is already insane."),
    (10.0, "awb", "Watch what happens when I take this supercar off the ramp."),
    (17.5, "awb", "Oh my god. He just flew straight into the helicopter and it exploded."),
    (26.0, "slt", "That was absolutely ridiculous. I have never seen physics do that before."),
]
QUALITY_EXPLOSIONS = [19.4, 21.0]

TALKING_SCRIPT = (
    "Okay so here is the thing nobody tells you about collecting. "
    "The single most valuable card in this entire box is worth more than my car. "
    "I opened it last week and I genuinely screamed. "
    "Let me show you exactly what happened and why it matters so much."
)


def run(argv: list[str]) -> None:
    subprocess.run(argv, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def flite(text: str, voice: str, out: str) -> None:
    text = text.replace("'", "")
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"flite=text='{text}':voice={voice}",
        "-ar", str(SR), "-ac", "1", out,
    ])


def read_wav(path: str) -> list[float]:
    with wave.open(path, "rb") as fh:
        frames = fh.readframes(fh.getnframes())
        width = fh.getsampwidth()
    if width != 2:
        raise RuntimeError(f"expected 16-bit wav, got {width * 8}-bit")
    ints = struct.unpack(f"<{len(frames) // 2}h", frames)
    return [v / 32768.0 for v in ints]


def write_wav(path: str, samples: list[float]) -> None:
    with wave.open(path, "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(SR)
        clipped = (max(-1.0, min(1.0, s)) for s in samples)
        fh.writeframes(b"".join(struct.pack("<h", int(s * 32767)) for s in clipped))


def mix(base: list[float], add: list[float], at: float, gain: float = 1.0) -> None:
    start = int(at * SR)
    for i, v in enumerate(add):
        j = start + i
        if 0 <= j < len(base):
            base[j] += v * gain


def explosion(duration: float = 0.55, seed: int = 1) -> list[float]:
    """A short, loud, decaying noise burst."""
    import random

    rng = random.Random(seed)
    n = int(duration * SR)
    out = []
    lp = 0.0
    for i in range(n):
        white = rng.uniform(-1.0, 1.0)
        lp = 0.75 * lp + 0.25 * white          # crude low-pass for weight
        env = (1.0 - i / n) ** 1.8
        out.append((0.75 * lp + 0.25 * white) * env)
    return out


def build_gameplay(outdir: str, tmp: str) -> str:
    audio = [0.0] * int(GAMEPLAY_DURATION * SR)
    # Low room tone so the rolling baseline has something to sit on.
    import random

    rng = random.Random(7)
    for i in range(len(audio)):
        audio[i] = rng.uniform(-0.012, 0.012)

    for idx, (at, voice, text) in enumerate(SPEECH):
        wav = os.path.join(tmp, f"speech{idx}.wav")
        flite(text, voice, wav)
        mix(audio, read_wav(wav), at, gain=0.55)

    for idx, at in enumerate(EXPLOSIONS):
        mix(audio, explosion(seed=idx + 1), at, gain=0.95)

    wav_path = os.path.join(tmp, "gameplay.wav")
    write_wav(wav_path, audio)

    # One concat-able segment per visual source => hard, unambiguous cuts.
    parts = []
    for idx, src in enumerate(SCENE_SOURCES):
        part = os.path.join(tmp, f"seg{idx}.mp4")
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", src, "-t", str(SEGMENT),
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
            "-pix_fmt", "yuv420p", part,
        ])
        parts.append(part)

    listing = os.path.join(tmp, "concat.txt")
    with open(listing, "w", encoding="utf-8") as fh:
        for part in parts:
            fh.write(f"file '{os.path.abspath(part)}'\n")

    silent = os.path.join(tmp, "gameplay_silent.mp4")
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", silent,
    ])

    out = os.path.join(outdir, "gameplay.mp4")
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", silent, "-i", wav_path,
        "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", out,
    ])
    return out


def build_talking(outdir: str, tmp: str, face: str) -> str:
    duration = 45.0
    wav = os.path.join(tmp, "talk_raw.wav")
    flite(TALKING_SCRIPT, "slt", wav)

    samples = read_wav(wav)
    audio = [0.0] * int(duration * SR)
    # Repeat the speech so the whole 45s has words in it.
    at = 1.0
    while at * SR < len(audio) - len(samples):
        mix(audio, samples, at, gain=0.8)
        at += len(samples) / SR + 1.2
    wav_path = os.path.join(tmp, "talking.wav")
    write_wav(wav_path, audio)

    # Face drifts left -> right -> left so the crop path has to follow it.
    graph = (
        "[0:v]scale=1280:720,setsar=1[bg];"
        "[1:v]scale=360:-2[fg];"
        "[bg][fg]overlay="
        "x='(main_w-overlay_w)*(0.5+0.42*sin(2*PI*t/18))':"
        "y='(main_h-overlay_h)/2':eval=frame[v]"
    )
    out = os.path.join(outdir, "talking.mp4")
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"color=c=0x202a38:size=1280x720:rate=30",
        "-loop", "1", "-i", face,
        "-i", wav_path,
        "-filter_complex", graph,
        "-map", "[v]", "-map", "2:a",
        "-t", str(duration),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", out,
    ])
    return out


def build_quality(outdir: str, tmp: str) -> str:
    """Gameplay-style footage whose frame quality varies by segment."""
    import random

    parts = []
    for i, (_name, src, filt) in enumerate(QUALITY_SEGMENTS):
        part = os.path.join(tmp, f"q{i}.mp4")
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", src, "-t", str(QUALITY_SEG), "-vf", filt,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p", part,
        ])
        parts.append(part)

    listing = os.path.join(tmp, "quality.txt")
    with open(listing, "w", encoding="utf-8") as fh:
        for part in parts:
            fh.write(f"file '{os.path.abspath(part)}'\n")
    silent = os.path.join(tmp, "quality_silent.mp4")
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", silent])

    rng = random.Random(3)
    total = int(QUALITY_SEG * len(QUALITY_SEGMENTS) * SR)
    audio = [rng.uniform(-0.012, 0.012) for _ in range(total)]
    for i, (at, voice, text) in enumerate(QUALITY_SPEECH):
        wav = os.path.join(tmp, f"q_sp{i}.wav")
        flite(text, voice, wav)
        mix(audio, read_wav(wav), at, gain=0.6)
    for i, at in enumerate(QUALITY_EXPLOSIONS):
        mix(audio, explosion(seed=i + 11), at, gain=0.95)
    wav_path = os.path.join(tmp, "quality.wav")
    write_wav(wav_path, audio)

    out = os.path.join(outdir, "quality.mp4")
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-i", silent, "-i", wav_path, "-c:v", "copy", "-c:a", "aac",
         "-b:a", "128k", "-shortest", out])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("outdir", nargs="?", default="tests/data")
    ap.add_argument("--face", default=None, help="face image for talking.mp4")
    args = ap.parse_args()

    outdir = os.path.abspath(args.outdir)
    os.makedirs(outdir, exist_ok=True)
    tmp = os.path.join(outdir, "_tmp")
    os.makedirs(tmp, exist_ok=True)

    face = args.face or os.path.join(outdir, "face.jpg")
    if not os.path.exists(face):
        try:
            print(f"fetching a face image -> {face}", file=sys.stderr)
            urllib.request.urlretrieve(FACE_URL, face)   # noqa: S310 - fixed URL
        except Exception as exc:  # noqa: BLE001
            print(f"note: could not fetch a face image ({exc})", file=sys.stderr)

    made = {
        "gameplay": build_gameplay(outdir, tmp),
        "quality": build_quality(outdir, tmp),
    }
    if os.path.exists(face):
        made["talking"] = build_talking(outdir, tmp, face)
    else:
        print("note: no face image, skipping talking.mp4", file=sys.stderr)

    truth = {
        "quality": {
            "segment_seconds": QUALITY_SEG,
            "segments": [
                {"name": name, "start": i * QUALITY_SEG, "end": (i + 1) * QUALITY_SEG}
                for i, (name, _s, _f) in enumerate(QUALITY_SEGMENTS)
            ],
            "good": ["vivid", "sharp"],
            "bad": ["dark", "blurry", "faded"],
        },
        "gameplay": {
            "duration": GAMEPLAY_DURATION,
            "explosions": EXPLOSIONS,
            "scene_cuts": SCENE_CUTS,
            "speech_starts": [s[0] for s in SPEECH],
        }
    }
    with open(os.path.join(outdir, "ground_truth.json"), "w", encoding="utf-8") as fh:
        json.dump(truth, fh, indent=2)

    for name, path in made.items():
        print(f"{name}: {path} ({os.path.getsize(path) / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
