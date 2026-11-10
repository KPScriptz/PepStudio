"""Subprocess plumbing for ffmpeg / ffprobe / yt-dlp.

Rules enforced here, learned the hard way in ClipForge:

* **Never use a shell.** Every call passes an argument *list* to
  ``subprocess``. A filename containing backticks or ``$()`` can therefore
  never be interpreted. Do not "simplify" this into ``shell=True``.
* **Deprioritise children.** Encoders are prefixed with ``nice -n 5`` so a
  long render cannot starve the parent process. We use the ``nice`` binary
  rather than ``preexec_fn=os.nice`` because ``preexec_fn`` is documented as
  unsafe in the presence of threads, and we render clips on a thread pool.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass

log = logging.getLogger("cfp.proc")

NICE_LEVEL = int(os.environ.get("CFP_NICE", "5"))


class ToolMissing(RuntimeError):
    """A required external binary is not on PATH."""


class ProcError(RuntimeError):
    """An external command exited non-zero."""

    def __init__(self, argv: list[str], returncode: int, stderr: str):
        self.argv = argv
        self.returncode = returncode
        self.stderr = stderr
        tail = "\n".join(stderr.strip().splitlines()[-12:])
        super().__init__(f"{argv[0]} exited {returncode}\n{tail}")


def which(name: str) -> str | None:
    return shutil.which(name)


def require(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise ToolMissing(
            f"{name!r} was not found on PATH. Install it and try again "
            f"(ffmpeg/ffprobe: https://ffmpeg.org/download.html)."
        )
    return path


def _nice_prefix() -> list[str]:
    if NICE_LEVEL <= 0:
        return []
    nice = shutil.which("nice")
    return [nice, "-n", str(NICE_LEVEL)] if nice else []


def run(
    argv: list[str],
    *,
    nice: bool = True,
    capture: bool = True,
    timeout: float | None = None,
    check: bool = True,
    stdout_bytes: bool = False,
) -> subprocess.CompletedProcess:
    """Run ``argv`` with no shell. Raises :class:`ProcError` on failure."""
    full = (_nice_prefix() if nice else []) + [str(a) for a in argv]
    log.debug("run: %s", " ".join(full))
    proc = subprocess.run(
        full,
        stdout=subprocess.PIPE if (capture or stdout_bytes) else None,
        stderr=subprocess.PIPE if capture else None,
        timeout=timeout,
        check=False,
    )
    if check and proc.returncode != 0:
        stderr = (proc.stderr or b"").decode("utf-8", "replace")
        raise ProcError(full, proc.returncode, stderr)
    return proc


# --------------------------------------------------------------------------- #
# ffprobe
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class MediaInfo:
    path: str
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool
    has_video: bool
    vcodec: str = ""

    @property
    def aspect(self) -> float:
        return (self.width / self.height) if self.height else 0.0

    @property
    def is_vertical(self) -> bool:
        return self.height > self.width


def probe(path: str) -> MediaInfo:
    """Read stream metadata with ffprobe (JSON output, no shell)."""
    require("ffprobe")
    out = run(
        [
            "ffprobe", "-v", "error",
            "-print_format", "json",
            "-show_format", "-show_streams",
            path,
        ],
        nice=False,
    ).stdout
    data = json.loads(out.decode("utf-8", "replace") or "{}")

    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = 0.0
    fmt = data.get("format") or {}
    for candidate in (fmt.get("duration"), (video or {}).get("duration")):
        try:
            duration = float(candidate)
            if duration > 0:
                break
        except (TypeError, ValueError):
            continue

    fps = 30.0
    if video:
        raw = video.get("avg_frame_rate") or video.get("r_frame_rate") or "30/1"
        try:
            num, _, den = raw.partition("/")
            den_f = float(den) if den else 1.0
            fps = (float(num) / den_f) if den_f else 30.0
        except (TypeError, ValueError, ZeroDivisionError):
            fps = 30.0
        if not (0 < fps < 1000):
            fps = 30.0

    return MediaInfo(
        path=path,
        duration=max(0.0, duration),
        width=int((video or {}).get("width") or 0),
        height=int((video or {}).get("height") or 0),
        fps=fps,
        has_audio=audio is not None,
        has_video=video is not None,
        vcodec=str((video or {}).get("codec_name") or ""),
    )


def free_gib(path: str) -> float:
    """Free space on the filesystem holding ``path``, in GiB."""
    target = path
    while target and not os.path.exists(target):
        parent = os.path.dirname(target)
        if parent == target:
            break
        target = parent
    try:
        st = os.statvfs(target or ".")
    except OSError:
        return float("inf")  # never block a render on a statvfs failure
    return (st.f_bavail * st.f_frsize) / (1024 ** 3)
