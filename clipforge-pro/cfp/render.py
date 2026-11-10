"""Stage 7/8 - render each clip to a 1080x1920 MP4, in parallel.

Design notes:

* **One ffmpeg pass per clip.** Trim, reframe, sharpen, burn captions,
  normalise loudness and encode all happen in a single graph. An earlier
  design rendered an intermediate file and re-encoded to burn subtitles,
  which doubled the video encode for no benefit.
* **Partial success.** Each clip is isolated. One bad clip returns in
  ``failed`` and the rest of the batch still lands on disk; only an
  all-failed batch raises.
* **Bounded concurrency.** Clip renders are independent, but each ffmpeg is
  itself multi-threaded, so we cap workers well below the core count.
  Oversubscribing makes the whole pack slower.
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from . import captions, proc, reframe
from .config import TARGET_H, TARGET_W, Preset, Settings
from .encoder import Encoder
from .models import ClipPick, RenderedClip, Transcript

log = logging.getLogger("cfp.render")


class DiskSpaceError(RuntimeError):
    pass


@dataclass
class RenderReport:
    rendered: list[RenderedClip] = field(default_factory=list)
    failed: list[dict] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return bool(self.rendered)


def escape_filter_path(path: str) -> str:
    """Escape a path for use inside an ffmpeg filter argument."""
    out = path.replace("\\", "\\\\")
    for ch in (":", "'", "[", "]", ",", ";"):
        out = out.replace(ch, "\\" + ch)
    return out


def build_video_graph(plan: reframe.CropPlan, ass_path: str | None, *, sharpen: bool) -> str:
    """The complete ``-filter_complex`` for one clip."""
    chain = reframe.build_filter(plan, sharpen=sharpen)
    graph = f"[0:v]{chain}"
    if ass_path:
        # Sharpen happens inside `chain`, i.e. BEFORE the burn -- sharpening
        # after it rings the glyph edges and looks cheap.
        graph += f",ass=f='{escape_filter_path(ass_path)}'"
    return graph + "[vout]"


def render_clip(
    source: str,
    pick: ClipPick,
    out_path: str,
    *,
    encoder: Encoder,
    settings: Settings,
    preset: Preset,
    transcript: Transcript | None,
    width: int,
    height: int,
    has_audio: bool,
    gaming: bool,
    workdir: str,
) -> RenderedClip:
    """Render a single clip. Raises on failure."""
    started = time.time()
    duration = max(0.1, pick.duration)

    plan = reframe.plan_crop(
        source, pick.start, pick.end,
        width=width, height=height, gaming=gaming,
        cache_dir=settings.cache_dir,
    )
    log.info("clip %02d: %s", pick.index, plan.describe())

    ass_path = None
    if settings.captions and transcript is not None and transcript.words:
        content = captions.build_ass(
            transcript.words,
            style=preset.style,
            clip_start=pick.start,
            clip_end=pick.end,
            hook=pick.hook if settings.hook else "",
        )
        ass_path = os.path.join(workdir, f"clip_{pick.index:03d}.ass")
        captions.write_ass(ass_path, content)

    graph = build_video_graph(plan, ass_path, sharpen=settings.sharpen)

    argv = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-ss", f"{pick.start:.3f}", "-i", source,
        "-t", f"{duration:.3f}",
        "-filter_complex", graph,
        "-map", "[vout]",
    ]
    if has_audio:
        argv += ["-map", "0:a:0"]
        if settings.loudnorm:
            # Single-pass loudnorm to the -16 LUFS mobile target.
            argv += ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"]
        argv += ["-c:a", "aac", "-b:a", settings.audio_bitrate, "-ar", "48000"]
    else:
        argv += ["-an"]

    argv += encoder.as_args(settings.crf)
    argv += ["-movflags", "+faststart", out_path]

    proc.run(argv, nice=True)

    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        raise proc.ProcError(argv, 1, "ffmpeg produced no output file")

    thumb = ""
    try:
        thumb = grab_thumbnail(out_path, out_path.rsplit(".", 1)[0] + ".jpg")
    except Exception as exc:  # noqa: BLE001 - a thumbnail is not worth failing over
        log.debug("thumbnail failed for clip %d: %s", pick.index, exc)

    return RenderedClip(
        pick=pick,
        path=out_path,
        thumbnail=thumb,
        width=TARGET_W,
        height=TARGET_H,
        bytes=os.path.getsize(out_path),
        render_seconds=time.time() - started,
    )


def grab_thumbnail(video: str, out_path: str, *, at: float = 1.0, width: int = 480) -> str:
    """Extract a poster frame. Written to a temp file, then renamed, so a
    half-written JPEG is never served."""
    tmp = out_path + ".part.jpg"
    argv = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-ss", f"{at:.2f}", "-i", video,
        "-frames:v", "1",
        "-vf", f"scale={width}:-2:flags=lanczos",
        "-q:v", "4", tmp,
    ]
    proc.run(argv, nice=True)
    os.replace(tmp, out_path)
    return out_path


def render_all(
    source: str,
    picks: list[ClipPick],
    *,
    settings: Settings,
    encoder: Encoder,
    preset: Preset,
    transcript: Transcript | None,
    width: int,
    height: int,
    has_audio: bool,
    gaming: bool,
) -> RenderReport:
    """Render every pick, concurrently, isolating failures."""
    out_dir = os.path.abspath(settings.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    free = proc.free_gib(out_dir)
    if free < settings.min_free_gib:
        raise DiskSpaceError(
            f"only {free:.1f} GiB free on the render volume; "
            f"{settings.min_free_gib:.1f} GiB required. "
            f"Free some space or lower --min-free-gib."
        )

    report = RenderReport()
    if not picks:
        return report

    workers = min(settings.resolved_jobs(), len(picks))
    workdir = tempfile.mkdtemp(prefix="cfp-render-")
    log.info("rendering %d clips with %d worker(s) using %s",
             len(picks), workers, encoder.label)

    def one(pick: ClipPick) -> tuple[ClipPick, RenderedClip | None, str]:
        name = f"clip_{pick.index:02d}_{_slug(pick.title)}.mp4"
        out_path = os.path.join(out_dir, name)
        try:
            clip = render_clip(
                source, pick, out_path,
                encoder=encoder, settings=settings, preset=preset,
                transcript=transcript, width=width, height=height,
                has_audio=has_audio, gaming=gaming, workdir=workdir,
            )
            return pick, clip, ""
        except Exception as exc:  # noqa: BLE001 - isolate this clip only
            log.error("clip %02d failed: %s", pick.index, exc)
            return pick, None, str(exc)

    try:
        if workers <= 1:
            results = [one(p) for p in picks]
        else:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                results = list(pool.map(one, picks))
    finally:
        if not settings.keep_temp:
            shutil.rmtree(workdir, ignore_errors=True)
        else:
            log.info("kept intermediates in %s", workdir)

    for pick, clip, error in results:
        if clip is not None:
            report.rendered.append(clip)
        else:
            report.failed.append(
                {"clip": pick.index, "start": pick.start, "end": pick.end, "error": error}
            )

    report.rendered.sort(key=lambda c: c.pick.index)
    log.info("rendered %d/%d clips", len(report.rendered), len(picks))
    return report


def _slug(text: str, limit: int = 40) -> str:
    import re

    slug = re.sub(r"[^\w]+", "-", (text or "clip").lower()).strip("-")
    return (slug[:limit].rstrip("-") or "clip")
