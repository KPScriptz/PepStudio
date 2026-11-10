"""Stage 2 - speech to word-level timestamps, with an on-disk cache.

Two deliberate choices:

* **Greedy decoding** (``beam_size=1``, ``best_of=1``) rather than
  whisper's beam-5/best-of-5 default. For 1-3 word captions and keyword-level
  clip ranking, beam search buys nothing measurable and costs 2-3x the time.
* **Content-addressed cache.** The key is a hash of the resolved path, its
  mtime and size, plus every setting that changes the output. Editing the
  source invalidates it automatically; re-running the same job is free.
* **We decode the audio ourselves, with ffmpeg.** faster-whisper will happily
  open a path, but internally that goes through PyAV -- and PyAV 19 removed
  the ``metadata_errors`` kwarg that faster-whisper 1.2.1 still passes, so
  that path raises ``TypeError`` on a current install. Handing whisper a
  float32 numpy array instead sidesteps PyAV completely, lets ffmpeg deal
  with awkward containers, and lets the pipeline decode the audio once and
  share it with the signal pass.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os

import numpy as np

from .models import Segment, Transcript, Word

SAMPLE_RATE = 16000

log = logging.getLogger("cfp.transcribe")

CACHE_VERSION = 1


def resolve_device(preference: str = "auto") -> tuple[str, str]:
    """Pick (device, compute_type). ``auto`` uses CUDA when it really exists."""
    pref = (preference or "auto").strip().lower()
    if pref == "cpu":
        return "cpu", "int8"

    count = 0
    try:
        import ctranslate2

        count = int(ctranslate2.get_cuda_device_count())
    except Exception as exc:  # noqa: BLE001 - any failure means "no usable GPU"
        log.debug("CUDA probe failed (%s); using CPU", exc)
        count = 0

    if pref == "cuda":
        if count <= 0:
            log.warning("--device cuda was requested but no CUDA device is visible; using CPU")
            return "cpu", "int8"
        return "cuda", "float16"

    if count > 0:
        log.info("CUDA device found (%d); transcribing on GPU", count)
        return "cuda", "float16"
    return "cpu", "int8"


def cache_key(
    path: str,
    model: str,
    language: str | None,
    *,
    vad: bool = True,
    greedy: bool = True,
) -> str:
    try:
        st = os.stat(path)
        stamp = f"{st.st_size}:{int(st.st_mtime)}"
    except OSError:
        stamp = "0:0"
    raw = "|".join(
        [
            f"v{CACHE_VERSION}",
            os.path.abspath(path),
            stamp,
            model,
            language or "auto",
            f"vad={int(vad)}",
            f"greedy={int(greedy)}",
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _cache_file(cache_dir: str, key: str) -> str:
    return os.path.join(cache_dir, "transcripts", f"{key}.json")


def load_cached(cache_dir: str, key: str) -> Transcript | None:
    path = _cache_file(cache_dir, key)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if int(data.get("version") or 0) != CACHE_VERSION:
        return None
    try:
        return Transcript.from_json(data)
    except (KeyError, TypeError, ValueError):
        return None


def save_cached(cache_dir: str, key: str, transcript: Transcript) -> None:
    path = _cache_file(cache_dir, key)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(transcript.to_json(), fh)
        os.replace(tmp, path)  # atomic: never serve a half-written cache entry
    except OSError as exc:
        log.debug("could not write transcript cache: %s", exc)


def transcribe(
    path: str,
    *,
    model: str = "base.en",
    language: str | None = None,
    device: str = "auto",
    compute_type: str | None = None,
    cache_dir: str,
    use_cache: bool = True,
    vad: bool = True,
    samples: "np.ndarray | None" = None,
) -> Transcript:
    """Transcribe ``path``, returning word-level timings.

    ``samples`` may carry audio already decoded to mono float32 at 16 kHz
    (see :func:`cfp.signals.read_audio`), avoiding a second decode.
    """
    key = cache_key(path, model, language, vad=vad)
    if use_cache:
        cached = load_cached(cache_dir, key)
        if cached is not None:
            log.info("transcript cache hit (%d words)", cached.word_count)
            return cached

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise RuntimeError(
            "faster-whisper is not installed; `pip install faster-whisper`"
        ) from exc

    dev, ctype = resolve_device(device)
    if compute_type:
        ctype = compute_type

    if samples is None:
        from .signals import read_audio

        samples = read_audio(path, sample_rate=SAMPLE_RATE)
    if samples is None or getattr(samples, "size", 0) == 0:
        raise RuntimeError(f"no decodable audio in {path}")
    # ctranslate2 needs a writable, contiguous float32 buffer; read_audio
    # returns a read-only view over the ffmpeg output.
    audio = np.ascontiguousarray(samples, dtype=np.float32)

    log.info(
        "transcribing with %s on %s (%s), %.1fs of audio",
        model, dev, ctype, audio.size / SAMPLE_RATE,
    )
    whisper = WhisperModel(model, device=dev, compute_type=ctype)

    segments_iter, info = whisper.transcribe(
        audio,
        language=language,
        word_timestamps=True,
        beam_size=1,
        best_of=1,
        condition_on_previous_text=False,
        vad_filter=vad,
    )

    words: list[Word] = []
    segments: list[Segment] = []
    for seg in segments_iter:
        text = (seg.text or "").strip()
        if text:
            segments.append(Segment(float(seg.start), float(seg.end), text))
        for w in (getattr(seg, "words", None) or []):
            token = (w.word or "").strip()
            if not token:
                continue
            start = float(w.start)
            end = float(w.end)
            if end <= start:
                end = start + 0.04  # guard against zero-length tokens
            words.append(Word(start, end, token))

    words.sort(key=lambda w: w.start)
    transcript = Transcript(
        words=words,
        segments=segments,
        language=str(getattr(info, "language", "") or language or ""),
        duration=float(
            getattr(info, "duration", 0.0) or (audio.size / SAMPLE_RATE)
        ),
        model=model,
    )
    log.info(
        "transcribed: %d words, %d segments, language=%s",
        transcript.word_count, len(transcript.segments), transcript.language,
    )
    if use_cache:
        save_cached(cache_dir, key, transcript)
    return transcript
