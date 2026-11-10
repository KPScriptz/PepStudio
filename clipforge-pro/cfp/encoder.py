"""Hardware H.264 encoder auto-detection.

The important lesson, carried over from ClipForge: **an encoder appearing in
``ffmpeg -encoders`` does not mean it works.** Distro ffmpeg builds ship
``h264_nvenc`` and ``h264_qsv`` compiled in on machines with no NVIDIA card
and no ``/dev/dri`` at all. Listing is a build-time fact; availability is a
runtime fact. So we *probe*: actually encode a handful of frames with each
candidate and keep the first that exits clean.

The probe costs well under a second and the answer is cached on disk, keyed by
the ffmpeg binary's identity, so a repeat run pays nothing.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
from dataclasses import dataclass

from . import proc

log = logging.getLogger("cfp.encoder")

PROBE_TIMEOUT = 25.0


@dataclass(frozen=True)
class Encoder:
    """A usable video encoder plus how to ask it for a quality level."""

    name: str              # ffmpeg encoder name
    kind: str              # nvenc | qsv | amf | videotoolbox | software
    label: str

    @property
    def is_hardware(self) -> bool:
        return self.kind != "software"

    def video_args(self, crf: int) -> list[str]:
        """Quality/preset flags. Each family spells this differently."""
        crf = max(0, min(51, int(crf)))
        if self.kind == "nvenc":
            return [
                "-preset", "p5", "-tune", "hq",
                "-rc", "vbr", "-cq", str(crf), "-b:v", "0",
                "-pix_fmt", "yuv420p",
            ]
        if self.kind == "qsv":
            return [
                "-preset", "veryfast",
                "-global_quality", str(crf), "-look_ahead", "0",
                "-pix_fmt", "nv12",
            ]
        if self.kind == "amf":
            return [
                "-quality", "balanced", "-rc", "cqp",
                "-qp_i", str(crf), "-qp_p", str(crf),
                "-pix_fmt", "yuv420p",
            ]
        if self.kind == "videotoolbox":
            # VideoToolbox takes 1..100 where *higher* is better quality,
            # the opposite direction to CRF.
            q = max(1, min(100, round((51 - crf) / 51 * 100)))
            return ["-q:v", str(q), "-pix_fmt", "yuv420p"]
        return [
            "-preset", "veryfast", "-crf", str(crf),
            "-pix_fmt", "yuv420p",
        ]

    def as_args(self, crf: int) -> list[str]:
        return ["-c:v", self.name] + self.video_args(crf)


SOFTWARE = Encoder("libx264", "software", "libx264 (software)")

# Priority order. Hardware first -- it frees the CPU for the concurrent
# whisper/OpenCV work that runs alongside a render.
CANDIDATES: tuple[Encoder, ...] = (
    Encoder("h264_nvenc", "nvenc", "NVENC (NVIDIA)"),
    Encoder("h264_qsv", "qsv", "QuickSync (Intel)"),
    Encoder("h264_amf", "amf", "AMF (AMD)"),
    Encoder("h264_videotoolbox", "videotoolbox", "VideoToolbox (Apple)"),
    SOFTWARE,
)

BY_NAME = {e.name: e for e in CANDIDATES}
BY_KIND = {e.kind: e for e in CANDIDATES}


def list_compiled(ffmpeg: str = "ffmpeg") -> set[str]:
    """Encoder names ffmpeg was *built* with (necessary, not sufficient)."""
    try:
        out = proc.run([ffmpeg, "-hide_banner", "-encoders"], nice=False).stdout
    except (proc.ProcError, proc.ToolMissing, OSError):
        return set()
    names: set[str] = set()
    for line in out.decode("utf-8", "replace").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0][:1] in "VAS" and len(parts[0]) == 6:
            names.add(parts[1])
    return names


def probe_encoder(enc: Encoder, ffmpeg: str = "ffmpeg") -> bool:
    """Encode a few synthetic frames. True only if ffmpeg exits 0."""
    argv = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15",
        "-frames:v", "5",
        "-c:v", enc.name,
    ] + enc.video_args(28) + ["-f", "null", "-"]
    try:
        result = proc.run(argv, nice=False, timeout=PROBE_TIMEOUT, check=False)
    except subprocess.TimeoutExpired:
        log.debug("encoder probe timed out: %s", enc.name)
        return False
    except (proc.ToolMissing, OSError):
        return False
    ok = result.returncode == 0
    if not ok:
        tail = (result.stderr or b"").decode("utf-8", "replace").strip()
        log.debug("encoder probe failed: %s: %s", enc.name, tail[-200:])
    return ok


def _cache_path(cache_dir: str, ffmpeg: str) -> str:
    try:
        st = os.stat(ffmpeg)
        ident = f"{ffmpeg}:{st.st_size}:{int(st.st_mtime)}"
    except OSError:
        ident = ffmpeg
    digest = hashlib.sha1(ident.encode()).hexdigest()[:16]
    return os.path.join(cache_dir, f"encoder-{digest}.json")


def detect(
    cache_dir: str,
    *,
    requested: str = "auto",
    use_cache: bool = True,
) -> Encoder:
    """Resolve the encoder to use.

    ``requested`` may be ``auto``, an ffmpeg encoder name (``h264_nvenc``), or
    a family (``nvenc``, ``qsv``, ``amf``, ``videotoolbox``, ``software``).
    Anything explicit is honoured without probing, so a user can force a path
    we would not have chosen.
    """
    requested = (os.environ.get("CFP_ENCODER") or requested or "auto").strip()

    if requested and requested != "auto":
        enc = BY_NAME.get(requested) or BY_KIND.get(requested.lower())
        if enc is None:
            known = ", ".join(sorted(set(BY_NAME) | set(BY_KIND)))
            raise KeyError(f"unknown encoder {requested!r}; try one of: auto, {known}")
        log.info("encoder: %s (forced)", enc.label)
        return enc

    ffmpeg = proc.require("ffmpeg")
    path = _cache_path(cache_dir, ffmpeg)

    if use_cache:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                name = json.load(fh).get("encoder")
            if name in BY_NAME:
                log.info("encoder: %s (cached)", BY_NAME[name].label)
                return BY_NAME[name]
        except (OSError, ValueError, AttributeError):
            pass

    compiled = list_compiled(ffmpeg)
    chosen = SOFTWARE
    for enc in CANDIDATES:
        if enc is SOFTWARE:
            break
        if enc.name not in compiled:
            log.debug("encoder %s not compiled in", enc.name)
            continue
        if probe_encoder(enc, ffmpeg):
            chosen = enc
            break
        log.debug("encoder %s compiled but unusable on this machine", enc.name)

    log.info("encoder: %s (probed)", chosen.label)
    try:
        os.makedirs(cache_dir, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"encoder": chosen.name, "kind": chosen.kind}, fh)
        os.replace(tmp, path)
    except OSError:
        pass  # caching is best-effort and must never fail a run
    return chosen
