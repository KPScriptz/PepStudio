"""The end-to-end pipeline: ingest -> transcribe -> signals -> pick -> render."""

from __future__ import annotations

import logging
import os
import tempfile
import time
from dataclasses import dataclass, field

from . import encoder as encoder_mod
from . import ingest, render, review, select, signals, transcribe
from .config import Settings
from .models import ClipPick, RenderedClip, Transcript

log = logging.getLogger("cfp.pipeline")


@dataclass
class Result:
    source: str
    clips: list[RenderedClip] = field(default_factory=list)
    picks: list[ClipPick] = field(default_factory=list)
    failed: list[dict] = field(default_factory=list)
    clips_json: str = ""
    index_html: str = ""
    out_dir: str = ""
    elapsed: float = 0.0
    picked_by: str = "heuristic"
    gaming: bool = False
    encoder: str = ""
    transcript_words: int = 0


def run(settings: Settings) -> Result:
    started = time.time()
    out_dir = os.path.abspath(settings.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(settings.cache_dir, exist_ok=True)

    # 1. Ingest ------------------------------------------------------------- #
    download_dir = os.path.join(settings.cache_dir, "downloads")
    src = ingest.ingest(settings.source, download_dir)
    info = src.info

    # 2. Transcribe --------------------------------------------------------- #
    # Decode the audio once here and share it with the signal pass below.
    samples = signals.read_audio(src.path) if info.has_audio else None
    if samples is not None and samples.size == 0:
        log.warning("the audio track could not be decoded; continuing without it")
        samples = None

    transcript: Transcript | None = None
    if samples is not None:
        try:
            transcript = transcribe.transcribe(
                src.path,
                model=settings.model,
                language=settings.language,
                device=settings.device,
                compute_type=settings.compute_type,
                cache_dir=settings.cache_dir,
                samples=samples,
            )
        except Exception as exc:  # noqa: BLE001 - a clip run can survive this
            log.warning("transcription failed, continuing on signals alone: %s", exc)
    else:
        log.info("no audio track; skipping transcription")

    # 3. Signals ------------------------------------------------------------ #
    sig = signals.analyse(
        src.path,
        duration=info.duration,
        transcript=transcript,
        has_audio=info.has_audio,
        samples=samples,
    )

    gaming = (
        signals.looks_like_gameplay(sig, transcript)
        if settings.gaming is None
        else bool(settings.gaming)
    )
    log.info(
        "mode: %s (%.2f words/sec)",
        "gaming / audio-spike ranking" if gaming else "speech-led ranking",
        sig.words_per_sec,
    )

    # 4. Select ------------------------------------------------------------- #
    preset = settings.resolved_preset()
    picks = select.select_clips(
        transcript, sig,
        count=settings.clips,
        min_dur=settings.min_dur,
        max_dur=settings.max_dur,
        duration=info.duration,
        gaming=gaming,
        prompt=settings.prompt,
        use_api=settings.use_api,
        api_key=settings.api_key,
        api_model=settings.api_model,
        preset=preset,
    )
    picked_by = picks[0].picked_by if picks else "heuristic"
    log.info("selected %d clip(s) via %s", len(picks), picked_by)

    result = Result(
        source=src.path,
        picks=picks,
        out_dir=out_dir,
        picked_by=picked_by,
        gaming=gaming,
        transcript_words=transcript.word_count if transcript else 0,
    )

    if settings.dry_run:
        log.info("dry run: stopping before rendering")
        result.elapsed = time.time() - started
        return result

    # 5. Render ------------------------------------------------------------- #
    enc = encoder_mod.detect(settings.cache_dir, requested=settings.encoder)
    result.encoder = enc.label

    report = render.render_all(
        src.path, picks,
        settings=settings, encoder=enc, preset=preset,
        transcript=transcript,
        width=info.width, height=info.height,
        has_audio=info.has_audio, gaming=gaming,
    )
    result.clips = report.rendered
    result.failed = report.failed

    # 6. Review ------------------------------------------------------------- #
    meta = review.ReviewMeta(
        source=src.origin or src.path,
        title=src.title,
        duration=info.duration,
        picked_by=picked_by,
        gaming=gaming,
        encoder=enc.label,
        preset=preset.name,
        prompt=settings.prompt or "",
        model=settings.api_model if picked_by == "claude" else "",
        transcript_words=result.transcript_words,
    )
    result.clips_json, result.index_html = review.write_review(
        out_dir, report.rendered, meta, report.failed
    )
    result.elapsed = time.time() - started
    return result
