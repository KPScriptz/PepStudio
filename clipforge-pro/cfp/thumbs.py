"""Thumbnail generation: pick the best frame, then make it click.

Grabbing a frame at a fixed timestamp is the obvious approach and it is a
coin flip -- you land on a blink, a motion blur, a cut to black. Instead we
sample across the clip, score every candidate on the things that actually
make a thumbnail work at feed size, and keep the best few.

Frames come from the **source** video, not the rendered clip, so the
thumbnail is never polluted by burned-in captions and can be composed freely.

Pixels are handled in OpenCV; the text is burned by libass through ffmpeg,
because OpenCV's ``putText`` has no real outline control and thumbnail text
lives or dies on its outline.
"""

from __future__ import annotations

import logging
import math
import os
from dataclasses import dataclass, field

import numpy as np

from . import captions, proc
from .config import ThumbStyle
from .models import Thumbnail
from .titles import POWER_WORDS, wrap_thumbnail_text

log = logging.getLogger("cfp.thumbs")

ASPECTS = {"9:16": (1080, 1920), "16:9": (1280, 720), "1:1": (1080, 1080)}

SAMPLES_PER_SEC = 3.0
MAX_SAMPLES = 48
EDGE_TRIM = 0.08          # ignore the first/last 8%: transitions and fades
QUALITY_FLOOR = 0.75      # a variant must score at least this much of the best


@dataclass
class Candidate:
    time: float
    frame: object                      # BGR ndarray
    score: float = 0.0
    components: dict = field(default_factory=dict)
    face: tuple[float, float, float, float] | None = None


# --------------------------------------------------------------------------- #
# Frame quality
# --------------------------------------------------------------------------- #


def sharpness(gray) -> float:
    """Variance of the Laplacian. Low means motion blur or defocus."""
    import cv2

    value = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    return min(1.0, value / 400.0)


def exposure(gray) -> float:
    """Penalise frames that are crushed, blown out, or just flat grey."""
    mean = float(gray.mean())
    band = 1.0 - min(1.0, abs(mean - 130.0) / 130.0)
    clipped = float(((gray < 6) | (gray > 249)).mean())
    return max(0.0, band * (1.0 - min(1.0, clipped * 3.0)))


def contrast(gray) -> float:
    return min(1.0, float(gray.std()) / 60.0)


def colorfulness(bgr) -> float:
    """Hasler-Suesstrunk colourfulness. Vivid frames win the feed."""
    b, g, r = (bgr[:, :, i].astype(np.float32) for i in range(3))
    rg = r - g
    yb = 0.5 * (r + g) - b
    std_root = math.sqrt(float(rg.std()) ** 2 + float(yb.std()) ** 2)
    mean_root = math.sqrt(float(rg.mean()) ** 2 + float(yb.mean()) ** 2)
    return min(1.0, (std_root + 0.3 * mean_root) / 110.0)


def face_quality(face, width: int, height: int) -> float:
    """A big, roughly centred face is the single strongest thumbnail cue."""
    if not face:
        return 0.0
    x, y, fw, fh = face
    size = math.sqrt(max(1.0, fw * fh)) / max(1.0, min(width, height))
    # Ideal face occupies ~18-45% of the short edge.
    if size < 0.08:
        size_score = size / 0.08 * 0.4
    elif size <= 0.45:
        size_score = 0.6 + 0.4 * min(1.0, (size - 0.08) / 0.22)
    else:
        size_score = max(0.3, 1.0 - (size - 0.45) * 1.6)

    cx = (x + fw / 2.0) / max(1.0, width)
    cy = (y + fh / 2.0) / max(1.0, height)
    centred = (1.0 - min(1.0, abs(cx - 0.5) * 2.2)) * (1.0 - min(1.0, abs(cy - 0.42) * 1.8))
    return max(0.0, min(1.0, 0.65 * size_score + 0.35 * centred))


SPEECH_WEIGHTS = {
    "sharpness": 0.22, "exposure": 0.16, "contrast": 0.14,
    "colorfulness": 0.13, "face": 0.35,
}
GAMING_WEIGHTS = {
    "sharpness": 0.32, "exposure": 0.22, "contrast": 0.22,
    "colorfulness": 0.24, "face": 0.0,
}


def score_frame(bgr, face=None, *, gaming: bool = False) -> tuple[float, dict]:
    import cv2

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]
    parts = {
        "sharpness": sharpness(gray),
        "exposure": exposure(gray),
        "contrast": contrast(gray),
        "colorfulness": colorfulness(bgr),
        "face": face_quality(face, w, h),
    }
    weights = GAMING_WEIGHTS if gaming else SPEECH_WEIGHTS
    # With no face found in speech mode, renormalise so a good frame is not
    # permanently capped at 65%.
    if not gaming and parts["face"] <= 0.0:
        weights = GAMING_WEIGHTS
    total = sum(parts[k] * weights.get(k, 0.0) for k in parts)
    scale = sum(weights.values()) or 1.0
    return total / scale, parts


# --------------------------------------------------------------------------- #
# Candidate selection
# --------------------------------------------------------------------------- #


def collect_candidates(
    video: str,
    start: float,
    end: float,
    *,
    detector=None,
    gaming: bool = False,
    samples_per_sec: float = SAMPLES_PER_SEC,
) -> list[Candidate]:
    """Sample the clip range and score every frame."""
    import cv2

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        log.warning("could not open %s for thumbnail sampling", video)
        return []

    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    if not (0.0 < fps < 1000.0):
        fps = 30.0

    span = max(0.1, end - start)
    trim = span * EDGE_TRIM
    first, last = start + trim, end - trim
    wanted = max(1, min(MAX_SAMPLES, int(span * samples_per_sec)))
    stride = max(1, int(round(((last - first) * fps) / wanted)))

    begin_frame = int(round(first * fps))
    total = int(round((last - first) * fps))
    cap.set(cv2.CAP_PROP_POS_FRAMES, begin_frame)

    out: list[Candidate] = []
    try:
        for offset in range(max(1, total) + 1):
            if not cap.grab():
                break
            if offset % stride:
                continue
            ok, frame = cap.retrieve()
            if not ok or frame is None:
                continue
            face = None
            if detector is not None and not gaming:
                face = _detect_box(detector, frame)
            score, parts = score_frame(frame, face, gaming=gaming)
            out.append(
                Candidate(time=first + offset / fps, frame=frame,
                          score=score, components=parts, face=face)
            )
    finally:
        cap.release()
    return out


def _detect_box(detector, frame):
    """Full face box from the shared detector, not just its centre."""
    try:
        if getattr(detector, "kind", "") == "yunet":
            h, w = frame.shape[:2]
            detector.impl.setInputSize((w, h))
            _, faces = detector.impl.detect(frame)
            if faces is None or len(faces) == 0:
                return None
            best = max(faces, key=lambda f: float(f[-1]) * math.sqrt(float(f[2]) * float(f[3])))
            return (float(best[0]), float(best[1]), float(best[2]), float(best[3]))
        if getattr(detector, "kind", "") == "haar":
            import cv2

            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            boxes = detector.impl.detectMultiScale(gray, 1.1, 5, minSize=(48, 48))
            if len(boxes) == 0:
                return None
            x, y, w, h = max(boxes, key=lambda b: int(b[2]) * int(b[3]))
            return (float(x), float(y), float(w), float(h))
    except Exception as exc:  # noqa: BLE001 - never fail a render over this
        log.debug("thumbnail face detection failed: %s", exc)
    return None


def pick_diverse(
    candidates: list[Candidate], count: int, *,
    min_gap: float = 0.0, floor: float = QUALITY_FLOOR,
) -> list[Candidate]:
    """Highest scoring frames, spaced out so variants don't look identical.

    **Quality outranks spacing.** Honouring the gap first is the obvious
    implementation and it ships blurry thumbnails: on footage whose good
    frames sit in one stretch, the third pick gets pushed out of that stretch
    and into a motion-blurred segment scoring 0.62 against a 1.00 best. So a
    candidate must clear a fraction of the best score to be eligible at all,
    and when the gap cannot be met we shrink the gap rather than reach for a
    worse frame.
    """
    if not candidates:
        return []
    ranked = sorted(candidates, key=lambda c: -c.score)
    best = ranked[0].score
    threshold = best * floor

    def gather(gap: float, limit: float) -> list[Candidate]:
        out: list[Candidate] = []
        for cand in ranked:
            if len(out) >= count:
                break
            if cand.score < limit:
                continue
            if any(abs(cand.time - c.time) < gap for c in out):
                continue
            out.append(cand)
        return out

    chosen = gather(min_gap, threshold)

    # Short? Relax the SPACING first -- a near-duplicate of a good frame
    # still beats a sharp-looking crop of a bad one.
    gap = min_gap
    while len(chosen) < count and gap > 0.05:
        gap /= 2.0
        chosen = gather(gap, threshold)

    # Only once spacing is exhausted do we accept weaker frames.
    if len(chosen) < count:
        chosen = gather(0.0, 0.0)
    return chosen


# --------------------------------------------------------------------------- #
# Composition and treatment
# --------------------------------------------------------------------------- #


def compose(frame, face, aspect: str = "9:16"):
    """Crop to ``aspect`` around the subject, then scale to target size."""
    import cv2

    tw, th = ASPECTS.get(aspect, ASPECTS["9:16"])
    h, w = frame.shape[:2]
    target_ar = tw / th

    if w / max(1, h) > target_ar:
        ch, cw = h, int(round(h * target_ar))
    else:
        cw, ch = w, int(round(w / target_ar))
    cw, ch = max(2, min(w, cw)), max(2, min(h, ch))

    if face:
        fx, fy, fw, fh = face
        cx, cy = fx + fw / 2.0, fy + fh / 2.0
    else:
        cx, cy = w / 2.0, h / 2.0

    x = int(round(min(max(0.0, cx - cw / 2.0), w - cw)))
    # Sit the face in the upper third: headroom reads as composed, not cropped.
    y_target = cy - ch * 0.38 if face else (h - ch) / 2.0
    y = int(round(min(max(0.0, y_target), h - ch)))

    crop = frame[y:y + ch, x:x + cw]
    return cv2.resize(crop, (tw, th), interpolation=cv2.INTER_LANCZOS4)


def enhance(img, style: ThumbStyle):
    """Modest saturation/contrast lift plus a vignette."""
    import cv2

    out = img
    if abs(style.saturation - 1.0) > 1e-3:
        hsv = cv2.cvtColor(out, cv2.COLOR_BGR2HSV).astype(np.float32)
        hsv[:, :, 1] = np.clip(hsv[:, :, 1] * style.saturation, 0, 255)
        out = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)

    if abs(style.contrast - 1.0) > 1e-3:
        out = np.clip(
            (out.astype(np.float32) - 128.0) * style.contrast + 128.0, 0, 255
        ).astype(np.uint8)

    if style.vignette > 0:
        h, w = out.shape[:2]
        yy, xx = np.mgrid[0:h, 0:w]
        dx = (xx - w / 2.0) / (w / 2.0)
        dy = (yy - h / 2.0) / (h / 2.0)
        radius = np.sqrt(dx * dx + dy * dy) / math.sqrt(2.0)
        mask = 1.0 - style.vignette * np.clip(radius, 0.0, 1.0) ** 2
        out = np.clip(out.astype(np.float32) * mask[:, :, None], 0, 255).astype(np.uint8)
    return out


def apply_scrim(img, style: ThumbStyle):
    """Darken the bottom so text has something to sit on."""
    if style.scrim <= 0:
        return img
    h, w = img.shape[:2]
    band = max(1, int(h * style.scrim_height))
    ramp = (np.linspace(0.0, 1.0, band) ** 1.6) * style.scrim
    mask = np.ones(h, dtype=np.float32)
    mask[h - band:] = 1.0 - ramp
    return np.clip(
        img.astype(np.float32) * mask[:, None, None], 0, 255
    ).astype(np.uint8)


# --------------------------------------------------------------------------- #
# Text
# --------------------------------------------------------------------------- #


def text_margin(width: int) -> int:
    return max(24, int(round(width * 0.045)))


def build_thumb_ass(
    lines: list[str], style: ThumbStyle, width: int, height: int,
    size: int | None = None, play_width: int | None = None,
) -> str:
    """A one-event ASS file sized to this exact image.

    ``play_width`` widens the script canvas without touching PlayResY, which
    is what font size is relative to. Glyphs therefore keep the same pixel
    size while gaining room to spill into -- used by :func:`measure_text`.
    """
    if size is None:
        size = max(12, int(round(height * style.size_ratio)))
    margin = text_margin(width)
    canvas_w = int(play_width or width)
    bold = -1 if style.bold else 0
    accent = captions.inline_colour(style.accent)
    base = captions.inline_colour(style.color)

    rendered: list[str] = []
    for line in lines:
        words = []
        for word in line.split():
            clean = captions.escape_text(word.upper() if style.uppercase else word)
            if not clean:
                continue
            stripped = "".join(ch for ch in word.lower() if ch.isalpha())
            if stripped in POWER_WORDS:
                words.append(f"{{\\1c{accent}}}{clean}{{\\1c{base}}}")
            else:
                words.append(clean)
        if words:
            rendered.append(" ".join(words))

    text = "\\N".join(rendered)
    return "\n".join([
        "[Script Info]",
        "; ClipForge Pro thumbnail",
        "ScriptType: v4.00+",
        f"PlayResX: {canvas_w}",
        f"PlayResY: {height}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        f"Format: {captions.STYLE_FORMAT}",
        (
            f"Style: Thumb,{style.font},{size},{style.color},{style.color},"
            f"{style.outline_color},&H64000000,{bold},0,0,0,100,100,0,0,1,"
            f"{style.outline},{style.shadow},2,{margin},{margin},"
            f"{style.margin_v},1"
        ),
        "",
        "[Events]",
        f"Format: {captions.EVENT_FORMAT}",
        f"Dialogue: 0,0:00:00.00,0:00:10.00,Thumb,,0,0,0,,{text}",
    ]) + "\n"


def measure_text(
    lines: list[str], style: ThumbStyle, width: int, height: int,
    size: int, workdir: str, pad: int = 3,
) -> tuple[int, int]:
    """Render the text alone on black and read back its bounding box.

    libass is the only thing that knows how wide a string will actually be
    (font metrics, kerning, the outline), and there is no Python binding for
    it here. Rendering a throwaway frame and measuring the pixels is exact,
    costs about 30ms, and needs no extra dependency. Estimating from a
    characters x em-width guess is what let the text run off the edge.
    """
    from .render import escape_filter_path

    # Measure on a WIDER canvas. On a canvas the same width as the target,
    # text that overflows is clipped by the frame, so its bounding box reads
    # as exactly the frame width -- indistinguishable from text that fits
    # perfectly, and the correction loop never converges.
    canvas_w = max(width + 2, width * max(1, pad))
    ass_path = os.path.join(workdir, "measure.ass")
    captions.write_ass(
        ass_path,
        build_thumb_ass(lines, style, width, height, size=size, play_width=canvas_w),
    )
    try:
        raw = proc.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "lavfi", "-i", f"color=black:s={canvas_w}x{height}",
            "-frames:v", "1",
            "-vf", f"ass=f='{escape_filter_path(ass_path)}'",
            "-f", "rawvideo", "-pix_fmt", "gray", "-",
        ], nice=True, stdout_bytes=True).stdout
    except Exception as exc:  # noqa: BLE001 - fall back to the estimate
        log.debug("text measurement failed: %s", exc)
        return 0, 0

    expected = canvas_w * height
    if len(raw) < expected:
        return 0, 0
    frame = np.frombuffer(raw[:expected], dtype=np.uint8).reshape(height, canvas_w)
    mask = frame > 24
    cols = np.where(mask.any(axis=0))[0]
    rows = np.where(mask.any(axis=1))[0]
    if cols.size == 0 or rows.size == 0:
        return 0, 0
    return int(cols[-1] - cols[0] + 1), int(rows[-1] - rows[0] + 1)


def fit_font_size(
    lines: list[str], style: ThumbStyle, width: int, height: int, workdir: str,
) -> int:
    """Largest size whose text still fits the frame, measured not guessed.

    This both shrinks text that would overflow and GROWS text that is
    needlessly small -- a thumbnail works harder when its words run nearly
    edge to edge.
    """
    if not lines:
        return max(12, int(round(height * style.size_ratio)))

    usable_w = width - 2 * text_margin(width)
    usable_h = height * 0.32
    size = max(16, int(round(height * style.size_ratio)))

    measured_w, measured_h = measure_text(lines, style, width, height, size, workdir)
    if measured_w <= 0 or measured_h <= 0:
        # Measurement unavailable: fall back to a conservative estimate.
        longest = max(len(line) for line in lines) or 1
        return max(16, int(usable_w / (0.68 * longest)))

    # Vertical clipping would saturate the measured height, so fall back to
    # an analytic block height when it looks saturated.
    if measured_h >= height - 2:
        measured_h = int(len(lines) * size * 1.25)

    scale = min(usable_w / measured_w, usable_h / max(1, measured_h))
    size = max(16, int(size * scale))

    # One verification pass: glyph metrics are not perfectly linear in size.
    check_w, _ = measure_text(lines, style, width, height, size, workdir)
    if check_w > usable_w and check_w > 0:
        size = max(16, int(size * usable_w / check_w * 0.99))
    return size


def burn_text(image_path: str, ass_path: str, out_path: str) -> str:
    """libass over the still. Atomic rename so no half-written JPEG is served."""
    from .render import escape_filter_path

    tmp = out_path + ".part.jpg"
    proc.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", image_path,
        "-vf", f"ass=f='{escape_filter_path(ass_path)}'",
        "-frames:v", "1", "-q:v", "2", tmp,
    ], nice=True)
    os.replace(tmp, out_path)
    return out_path


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #


def make_thumbnails(
    source: str,
    *,
    start: float,
    end: float,
    out_dir: str,
    basename: str,
    text: str,
    style: ThumbStyle,
    workdir: str,
    count: int = 3,
    wide: bool = True,
    clean: bool = True,
    with_text: bool = True,
    detector=None,
    gaming: bool = False,
) -> list[Thumbnail]:
    """Produce the thumbnail set for one clip."""
    import cv2

    candidates = collect_candidates(
        source, start, end, detector=detector, gaming=gaming
    )
    if not candidates:
        log.warning("no thumbnail candidates for %s", basename)
        return []

    span = max(0.1, end - start)
    wanted = max(1, count)
    best = pick_diverse(candidates, wanted, min_gap=span / (wanted * 2.0))
    lines = wrap_thumbnail_text(text, max_chars=style.max_chars_per_line) if text else []
    sizes: dict[str, int] = {}          # one measurement per aspect, reused

    out: list[Thumbnail] = []

    def render(cand: Candidate, aspect: str, label: str, draw_text: bool) -> None:
        img = enhance(compose(cand.frame, cand.face, aspect), style)
        height, width = img.shape[:2]
        path = os.path.join(out_dir, f"{basename}_{label}.jpg")
        try:
            if draw_text and lines:
                if aspect not in sizes:
                    sizes[aspect] = fit_font_size(
                        lines, style, width, height, workdir
                    )
                img = apply_scrim(img, style)
                still = os.path.join(workdir, f"{basename}_{label}.png")
                cv2.imwrite(still, img)
                ass_path = os.path.join(workdir, f"{basename}_{label}.ass")
                captions.write_ass(
                    ass_path,
                    build_thumb_ass(lines, style, width, height, size=sizes[aspect]),
                )
                burn_text(still, ass_path, path)
            else:
                tmp = path + ".part.jpg"
                cv2.imwrite(tmp, img, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
                os.replace(tmp, path)
        except Exception as exc:  # noqa: BLE001 - a thumbnail must never fail a clip
            log.warning("thumbnail %s failed: %s", label, exc)
            return
        out.append(Thumbnail(
            path=path, frame_time=cand.time, score=int(round(cand.score * 100)),
            aspect=aspect, has_text=draw_text and bool(lines), label=label,
            components=cand.components,
        ))

    for i, cand in enumerate(best, 1):
        render(cand, "9:16", f"thumb_{i}", with_text)
    if clean:
        render(best[0], "9:16", "thumb_clean", False)
    if wide:
        render(best[0], "16:9", "thumb_wide", with_text)

    log.info(
        "clip %s: %d thumbnails, best frame at %.2fs (score %d)",
        basename, len(out), best[0].time, int(round(best[0].score * 100)),
    )
    return out
