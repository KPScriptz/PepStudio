"""Stage 1 - get a local video file, from a path or a URL."""

from __future__ import annotations

import glob
import json
import logging
import os
import sys
from dataclasses import dataclass

from . import proc
from .proc import MediaInfo

log = logging.getLogger("cfp.ingest")

VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".ts", ".mpg", ".mpeg", ".wmv"}


class IngestError(RuntimeError):
    pass


@dataclass
class Source:
    info: MediaInfo
    title: str = ""
    origin: str = ""        # the path or URL the user gave
    downloaded: bool = False

    @property
    def path(self) -> str:
        return self.info.path


def is_url(source: str) -> bool:
    return source.strip().lower().startswith(("http://", "https://"))


def _ytdlp_argv() -> list[str]:
    """Prefer the console script; fall back to the importable module."""
    binary = proc.which("yt-dlp")
    if binary:
        return [binary]
    try:
        import yt_dlp  # noqa: F401
    except ImportError as exc:
        raise IngestError(
            "a URL was given but yt-dlp is not available; install it with "
            "`pip install yt-dlp`"
        ) from exc
    return [sys.executable, "-m", "yt_dlp"]


def download(url: str, workdir: str, *, max_height: int = 1080) -> Source:
    """Fetch ``url`` into ``workdir`` with yt-dlp."""
    os.makedirs(workdir, exist_ok=True)
    template = os.path.join(workdir, "source.%(ext)s")
    fmt = (
        f"bv*[height<={max_height}]+ba/"
        f"b[height<={max_height}]/bv*+ba/b"
    )
    argv = _ytdlp_argv() + [
        "--no-playlist",
        "--no-progress",
        "--write-info-json",
        "--merge-output-format", "mp4",
        "-f", fmt,
        "-o", template,
        url,
    ]
    log.info("downloading %s", url)
    try:
        proc.run(argv, nice=True, timeout=None)
    except proc.ProcError as exc:
        raise IngestError(f"yt-dlp could not download {url}:\n{exc}") from exc

    candidates = [
        p for p in glob.glob(os.path.join(workdir, "source.*"))
        if os.path.splitext(p)[1].lower() in VIDEO_EXT
    ]
    if not candidates:
        raise IngestError(f"yt-dlp reported success but produced no video in {workdir}")
    path = max(candidates, key=lambda p: os.path.getsize(p))

    title = ""
    for meta in glob.glob(os.path.join(workdir, "source.info.json")):
        try:
            with open(meta, "r", encoding="utf-8") as fh:
                title = str(json.load(fh).get("title") or "")
        except (OSError, ValueError):
            pass
        break

    info = proc.probe(path)
    return Source(info=info, title=title, origin=url, downloaded=True)


def open_local(path: str) -> Source:
    expanded = os.path.abspath(os.path.expanduser(path))
    if not os.path.exists(expanded):
        raise IngestError(f"no such file: {path}")
    if os.path.isdir(expanded):
        raise IngestError(f"{path} is a directory, not a video file")
    info = proc.probe(expanded)
    title = os.path.splitext(os.path.basename(expanded))[0]
    return Source(info=info, title=title, origin=path, downloaded=False)


def ingest(source: str, workdir: str, *, max_height: int = 1080) -> Source:
    """Resolve ``source`` (path or URL) to a local, probed video file."""
    src = download(source, workdir, max_height=max_height) if is_url(source) else open_local(source)

    if not src.info.has_video:
        raise IngestError(
            f"{src.path} has no video stream; ClipForge Pro needs video to reframe"
        )
    if src.info.duration <= 0:
        raise IngestError(f"could not determine the duration of {src.path}")
    log.info(
        "source: %s (%.1fs, %dx%d @ %.2ffps, audio=%s)",
        os.path.basename(src.path), src.info.duration,
        src.info.width, src.info.height, src.info.fps, src.info.has_audio,
    )
    return src
