"""Stage 3 - cheap signal analysis: loudness, scene cuts, speech rate.

This is what lets ClipForge Pro rank *gameplay* footage, where there may be
almost no speech for the language model to read. A scream, an explosion or a
hard scene change is a retention signal in its own right.

Loudness is measured **two ways**, and the results are merged.

A rolling-baseline z-score finds "suddenly much louder than the last few
seconds" -- a gag, a jumpscare, a reaction -- and survives footage whose
overall level drifts. On its own it has a blind spot: a bang that lands in
the middle of loud speech raises its own baseline and scores low. On
reference footage an explosion during dialogue scored 1.83 local-z, below
several unremarkable windows, so no local threshold could ever recover it.

A whole-track z-score has the complementary blind spot (it only ever finds
the globally loudest moments) but it rated that same explosion 3.04 against a
2.96 ceiling elsewhere. Running both and merging catches each other's misses.
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass, field

import numpy as np

from . import proc
from .models import Peak, Transcript

log = logging.getLogger("cfp.signals")

SAMPLE_RATE = 16000
HOP = 0.25                 # seconds per loudness window
BASELINE_SECONDS = 12.0    # rolling window for the local baseline
SILENCE_DBFS = -70.0

LOUD_Z = 2.6               # z above the ROLLING baseline: "suddenly louder"
GLOBAL_Z = 2.8             # z above the WHOLE TRACK: "among the loudest"
# Measured on reference footage: real cuts scored 0.319-0.81 while the
# noisiest non-cut frame scored 0.082, so the old 0.35 sat inside the signal
# and dropped a genuine cut. 0.27 keeps a wide margin on both sides.
SCENE_THRESHOLD = 0.27
MIN_PEAK_GAP = 1.2         # seconds between reported loudness peaks

# Sustain the picture this long after a peak before cutting, so the physical
# gag lands instead of being clipped off. Carried over from ClipForge.
COMEDIC_TAIL_MS = 160

GAMING_WPS = 0.6           # below this words/sec we treat footage as gameplay


@dataclass
class Signals:
    duration: float
    has_audio: bool = True
    hop: float = HOP
    times: np.ndarray = field(default_factory=lambda: np.zeros(0))
    dbfs: np.ndarray = field(default_factory=lambda: np.zeros(0))
    loud_z: np.ndarray = field(default_factory=lambda: np.zeros(0))
    peaks: list[Peak] = field(default_factory=list)
    scene_cuts: list[float] = field(default_factory=list)
    words_per_sec: float = 0.0

    # ---------------- window queries used by the clip picker -------------- #

    def _slice(self, start: float, end: float) -> slice:
        if self.times.size == 0:
            return slice(0, 0)
        lo = int(np.searchsorted(self.times, max(0.0, start), "left"))
        hi = int(np.searchsorted(self.times, max(0.0, end), "right"))
        return slice(lo, max(lo, hi))

    def loudness_stats(self, start: float, end: float) -> tuple[float, float]:
        """(peak z, mean z) of loudness inside the window."""
        sl = self._slice(start, end)
        chunk = self.loud_z[sl]
        if chunk.size == 0:
            return 0.0, 0.0
        return float(np.max(chunk)), float(np.mean(chunk))

    def mean_dbfs(self, start: float, end: float) -> float:
        sl = self._slice(start, end)
        chunk = self.dbfs[sl]
        return float(np.mean(chunk)) if chunk.size else SILENCE_DBFS

    def peaks_between(self, start: float, end: float) -> list[Peak]:
        return [p for p in self.peaks if start <= p.time < end]

    def cuts_between(self, start: float, end: float) -> list[float]:
        return [t for t in self.scene_cuts if start <= t < end]

    def to_json(self) -> dict:
        return {
            "duration": round(self.duration, 3),
            "has_audio": self.has_audio,
            "words_per_sec": round(self.words_per_sec, 3),
            "scene_cuts": [round(t, 3) for t in self.scene_cuts],
            "peaks": [p.to_json() for p in self.peaks],
        }


# --------------------------------------------------------------------------- #
# Audio loudness
# --------------------------------------------------------------------------- #


def read_audio(path: str, *, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Decode the audio track to mono float32 via ffmpeg -> numpy."""
    proc.require("ffmpeg")
    argv = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-i", path,
        "-vn", "-ac", "1", "-ar", str(sample_rate),
        "-f", "f32le", "-",
    ]
    try:
        raw = proc.run(argv, nice=True, stdout_bytes=True).stdout
    except proc.ProcError as exc:
        log.warning("could not read audio from %s: %s", path, exc)
        return np.zeros(0, dtype=np.float32)
    if not raw:
        return np.zeros(0, dtype=np.float32)
    # Truncate a partial trailing frame rather than letting numpy raise.
    usable = len(raw) - (len(raw) % 4)
    return np.frombuffer(raw[:usable], dtype="<f4")


def _rolling_baseline(values: np.ndarray, win: int) -> tuple[np.ndarray, np.ndarray]:
    """Centred rolling mean and std, computed with cumulative sums."""
    n = values.size
    if n == 0:
        return values, values
    win = max(3, min(win | 1, n if n % 2 else n - 1))  # odd, and <= n
    half = win // 2
    padded = np.pad(values, (half, half), mode="edge")
    csum = np.cumsum(np.insert(padded, 0, 0.0))
    csum2 = np.cumsum(np.insert(padded * padded, 0, 0.0))
    mean = (csum[win:] - csum[:-win]) / win
    meansq = (csum2[win:] - csum2[:-win]) / win
    var = np.maximum(meansq - mean * mean, 0.0)
    return mean[:n], np.sqrt(var)[:n]


def loudness_curve(
    samples: np.ndarray,
    *,
    sample_rate: int = SAMPLE_RATE,
    hop: float = HOP,
) -> tuple[np.ndarray, np.ndarray]:
    """Per-window RMS in dBFS, plus the window centre times."""
    if samples.size == 0:
        return np.zeros(0), np.zeros(0)
    step = max(1, int(round(hop * sample_rate)))
    usable = (samples.size // step) * step
    if usable == 0:
        return np.zeros(0), np.zeros(0)
    frames = samples[:usable].reshape(-1, step).astype(np.float64)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    dbfs = 20.0 * np.log10(np.maximum(rms, 1e-7))
    dbfs = np.maximum(dbfs, SILENCE_DBFS)
    times = (np.arange(frames.shape[0]) + 0.5) * hop
    return dbfs, times


def global_z(dbfs: np.ndarray) -> np.ndarray:
    """How loud each window is relative to the entire track."""
    if dbfs.size == 0:
        return dbfs
    std = float(dbfs.std())
    return (dbfs - float(dbfs.mean())) / max(std, 1e-6)


def merge_peaks(peaks: list[Peak], *, min_gap: float = MIN_PEAK_GAP) -> list[Peak]:
    """Combine peak lists, keeping the strongest within each ``min_gap``."""
    kept: list[Peak] = []
    for peak in sorted(peaks, key=lambda p: -p.score):
        if any(abs(peak.time - k.time) < min_gap for k in kept):
            continue
        kept.append(peak)
    kept.sort(key=lambda p: p.time)
    return kept


def local_z(dbfs: np.ndarray, *, hop: float = HOP) -> np.ndarray:
    """How loud each window is relative to its own neighbourhood."""
    if dbfs.size == 0:
        return dbfs
    win = max(3, int(round(BASELINE_SECONDS / max(hop, 1e-6))))
    mean, std = _rolling_baseline(dbfs, win)
    # A noise floor on std keeps near-silent stretches from exploding into
    # huge z-scores on a single faint sound.
    std = np.maximum(std, 1.5)
    return (dbfs - mean) / std


def find_peaks(
    z: np.ndarray,
    times: np.ndarray,
    *,
    threshold: float = LOUD_Z,
    min_gap: float = MIN_PEAK_GAP,
    kind: str = "loudness",
) -> list[Peak]:
    """Local maxima above ``threshold``, thinned to one per ``min_gap``."""
    if z.size == 0:
        return []
    order = np.argsort(z)[::-1]
    chosen: list[int] = []
    for idx in order:
        if z[idx] < threshold:
            break
        t = times[idx]
        if any(abs(t - times[j]) < min_gap for j in chosen):
            continue
        chosen.append(int(idx))
    chosen.sort(key=lambda i: times[i])
    return [Peak(time=float(times[i]), score=float(z[i]), kind=kind) for i in chosen]


# --------------------------------------------------------------------------- #
# Scene cuts
# --------------------------------------------------------------------------- #

_PTS_RE = re.compile(r"pts_time:([0-9]+(?:\.[0-9]+)?)")


def detect_scene_cuts(
    path: str,
    *,
    threshold: float = SCENE_THRESHOLD,
    analysis_fps: int = 10,
    analysis_width: int = 320,
) -> list[float]:
    """Timestamps where the picture changes a lot.

    Detection runs on a downscaled, frame-dropped copy -- full-resolution
    scene detection on a long video costs minutes and buys nothing, since we
    only need cut *locations*.
    """
    proc.require("ffmpeg")
    graph = (
        f"fps={analysis_fps},scale={analysis_width}:-2,"
        f"select='gt(scene,{threshold})',metadata=print:file=-"
    )
    argv = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-i", path, "-an", "-filter_complex", graph, "-f", "null", "-",
    ]
    try:
        out = proc.run(argv, nice=True).stdout.decode("utf-8", "replace")
    except proc.ProcError as exc:
        log.warning("scene detection failed, continuing without cuts: %s", exc)
        return []
    cuts = sorted({round(float(m), 3) for m in _PTS_RE.findall(out)})
    log.info("scene cuts: %d", len(cuts))
    return cuts


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #


def speech_density(transcript: Transcript, duration: float) -> float:
    if duration <= 0:
        return 0.0
    return transcript.word_count / duration


def analyse(
    path: str,
    *,
    duration: float,
    transcript: Transcript | None = None,
    has_audio: bool = True,
    loud_z: float = LOUD_Z,
    global_thr: float = GLOBAL_Z,
    scene_threshold: float = SCENE_THRESHOLD,
    scenes: bool = True,
    samples: "np.ndarray | None" = None,
) -> Signals:
    """Run every signal pass over ``path``.

    ``samples`` may carry audio already decoded by :func:`read_audio`, so a
    caller that also transcribes does not decode the track twice.
    """
    sig = Signals(duration=duration, has_audio=has_audio)

    if has_audio:
        if samples is None:
            samples = read_audio(path)
        dbfs, times = loudness_curve(samples)
        sig.dbfs, sig.times = dbfs, times
        sig.loud_z = local_z(dbfs)
        relative = find_peaks(sig.loud_z, times, threshold=loud_z, kind="loudness")
        absolute = find_peaks(
            global_z(dbfs), times, threshold=global_thr, kind="loudness_global"
        )
        sig.peaks = merge_peaks(relative + absolute)
        log.info(
            "loudness: %d windows, %d spikes (%d relative, %d absolute)",
            dbfs.size, len(sig.peaks), len(relative), len(absolute),
        )
    else:
        log.info("source has no audio track; skipping loudness analysis")

    if scenes:
        sig.scene_cuts = detect_scene_cuts(path, threshold=scene_threshold)

    if transcript is not None:
        sig.words_per_sec = speech_density(transcript, duration)

    return sig


def looks_like_gameplay(sig: Signals, transcript: Transcript | None) -> bool:
    """Heuristic: sparse speech means rank on audio/visual chaos instead."""
    if transcript is None or not transcript.words:
        return True
    return speech_density(transcript, max(sig.duration, 1e-6)) < GAMING_WPS
