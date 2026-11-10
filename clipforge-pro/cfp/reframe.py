"""Stage 5 - reframe landscape footage to a 1080x1920 vertical.

Two strategies:

* **Follow the speaker.** Sample frames across the clip, detect faces with
  OpenCV's YuNet (falling back to a Haar cascade), smooth the resulting
  centre-x track, and emit a single ``crop`` whose ``x`` follows that path.
* **Blurred-background fit.** For gameplay, or when no face is found, scale
  the whole frame to fit the width and sit it over a blurred, zoomed copy of
  itself. Nothing important gets cropped away.

Two hard rules, both learned from shipped regressions:

1. **Never use ``zoompan``.** It causes heavy drop-frame stuttering. Motion
   comes from a ``crop`` whose ``x`` expression is a function of ``t``.
   ``crop`` re-evaluates ``x``/``y`` for every frame on its own and has **no**
   ``eval`` option -- passing ``eval=frame`` to it is an "Option not found"
   hard error. (``scale``, ``overlay`` and ``pad`` do take ``eval``; ``crop``
   does not. Verified against ffmpeg 6.1.)
2. **Single-quote any expression containing a comma.** In a filter graph a
   bare comma starts the next filter, so ``if(lt(t,1),a,b)`` unquoted
   silently corrupts the graph.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

from .config import TARGET_H, TARGET_W

log = logging.getLogger("cfp.reframe")

SAMPLE_FPS = 4.0             # face-detection samples per second
MIN_DETECTION_RATE = 0.22    # below this we stop pretending there is a face
MIN_FACE_CONF = 0.75         # a confident detection beats a merely large one
CONF_MARGIN = 0.15           # how far below the best confidence we still accept
CONTINUITY = 3.0             # how strongly to prefer the previously tracked face
MAX_KEYFRAMES = 24           # keeps the crop expression a sane length
SMOOTH_WINDOW = 7            # samples in the zero-phase smoothing kernel
MEDIAN_WINDOW = 5
BLUR_SIGMA = 28

# Inside the package, so it survives `pip install`.
ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
YUNET_URL = (
    "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/"
    "models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
)


@dataclass
class CropPlan:
    """How to get from the source frame to 1080x1920."""

    mode: str                                  # follow | blurfit | scale
    crop_w: int = 0
    crop_h: int = 0
    keyframes: list[tuple[float, float]] = field(default_factory=list)
    detection_rate: float = 0.0
    faces_found: int = 0
    samples: int = 0

    def describe(self) -> str:
        if self.mode == "follow":
            return (
                f"face-following crop {self.crop_w}x{self.crop_h} "
                f"({self.faces_found}/{self.samples} frames had a face, "
                f"{len(self.keyframes)} keyframes)"
            )
        if self.mode == "blurfit":
            return "blurred-background fit (no face track)"
        return "direct scale (source is already vertical)"


# --------------------------------------------------------------------------- #
# Detector loading
# --------------------------------------------------------------------------- #


def yunet_model_path(cache_dir: str | None = None, *, download: bool = True) -> str | None:
    """Find the YuNet ONNX, fetching it into the cache if need be."""
    env = os.environ.get("CFP_YUNET_MODEL")
    candidates = [env] if env else []
    candidates.append(os.path.join(ASSETS, "yunet.onnx"))
    if cache_dir:
        candidates.append(os.path.join(cache_dir, "yunet.onnx"))

    for path in candidates:
        if path and os.path.isfile(path) and os.path.getsize(path) > 10000:
            return path

    if not (download and cache_dir):
        return None
    target = os.path.join(cache_dir, "yunet.onnx")
    try:
        import urllib.request

        os.makedirs(cache_dir, exist_ok=True)
        log.info("downloading the YuNet face model (one time)")
        tmp = target + ".part"
        urllib.request.urlretrieve(YUNET_URL, tmp)   # noqa: S310 - fixed URL
        if os.path.getsize(tmp) < 10000:
            os.remove(tmp)
            return None
        os.replace(tmp, target)
        return target
    except Exception as exc:  # noqa: BLE001 - detection is optional
        log.warning("could not download the YuNet model: %s", exc)
        return None


class _Detector:
    """YuNet if available, else a Haar cascade, else nothing."""

    def __init__(self, width: int, height: int, cache_dir: str | None = None):
        import cv2

        self.cv2 = cv2
        self.kind = "none"
        self.impl = None

        model = yunet_model_path(cache_dir)
        if model and hasattr(cv2, "FaceDetectorYN"):
            try:
                self.impl = cv2.FaceDetectorYN.create(
                    model, "", (width, height), 0.6, 0.3, 5000
                )
                self.kind = "yunet"
                return
            except Exception as exc:  # noqa: BLE001
                log.warning("YuNet failed to initialise (%s); trying Haar", exc)

        # OpenCV 5 removed CascadeClassifier entirely, so this may be absent.
        cascade_cls = getattr(cv2, "CascadeClassifier", None)
        if cascade_cls is None:
            log.info(
                "no Haar cascade support in OpenCV %s; falling back to a "
                "blurred-background fit", cv2.__version__,
            )
            return
        for path in self._haar_paths():
            if path and os.path.isfile(path):
                clf = cascade_cls(path)
                if not clf.empty():
                    self.impl = clf
                    self.kind = "haar"
                    return
        log.info("no face detector available; using a blurred-background fit")

    def _haar_paths(self) -> list[str]:
        out = []
        env = os.environ.get("CFP_HAAR_CASCADE")
        if env:
            out.append(env)
        data = getattr(self.cv2, "data", None)
        base = getattr(data, "haarcascades", None) if data else None
        if base:
            out.append(os.path.join(base, "haarcascade_frontalface_default.xml"))
            out.append(os.path.join(base, "haarcascade_frontalface_alt2.xml"))
        out.append(os.path.join(ASSETS, "haarcascade_frontalface_default.xml"))
        return out

    def centre_x(self, frame, previous: float | None = None) -> float | None:
        """Centre-x of the speaker's face, or None.

        Picking the **largest** box is the obvious choice and it is wrong.
        Crowds, posters and background extras produce large low-confidence
        boxes; in testing a 0.69-confidence false positive out-measured the
        real 0.93-confidence speaker and dragged the crop 20%% off centre.

        So candidates are scored on confidence AND size, then discounted by
        distance from wherever the face was on the previous sample. That last
        term is what stops the crop ping-ponging between two people.
        """
        if self.impl is None:
            return None
        try:
            width = float(frame.shape[1])
            candidates: list[tuple[float, float, float]] = []   # cx, area, conf

            if self.kind == "yunet":
                h, w = frame.shape[:2]
                self.impl.setInputSize((w, h))
                _, faces = self.impl.detect(frame)
                if faces is None or len(faces) == 0:
                    return None
                for f in faces:
                    bw, bh = float(f[2]), float(f[3])
                    candidates.append(
                        (float(f[0]) + bw / 2.0, max(1.0, bw * bh), float(f[-1]))
                    )
            else:
                gray = self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2GRAY)
                boxes = self.impl.detectMultiScale(gray, 1.1, 5, minSize=(48, 48))
                if len(boxes) == 0:
                    return None
                # Haar reports no confidence, so every box scores 1.0 and the
                # size/continuity terms do the work.
                for bx, _, bw, bh in boxes:
                    candidates.append(
                        (float(bx) + float(bw) / 2.0, max(1.0, float(bw) * float(bh)), 1.0)
                    )

            return self._pick(candidates, width, previous)
        except Exception as exc:  # noqa: BLE001 - a bad frame must not abort
            log.debug("face detection error: %s", exc)
            return None

    @staticmethod
    def _pick(
        candidates: list[tuple[float, float, float]],
        width: float,
        previous: float | None,
    ) -> float | None:
        if not candidates:
            return None

        # Drop weak detections, but only when a confident one is present --
        # otherwise a genuinely marginal lone face would be discarded. A
        # 0.69 box sitting next to a 0.93 box is almost always spurious.
        best_conf = max(c[2] for c in candidates)
        floor = max(MIN_FACE_CONF, best_conf - CONF_MARGIN)
        pool = [c for c in candidates if c[2] >= floor] or candidates

        best_cx, best_score = None, -1.0
        for cx, area, conf in pool:
            score = conf * (area ** 0.5)
            if previous is not None and width > 0:
                # A face a full frame-width from the last one scores a quarter.
                score /= 1.0 + CONTINUITY * abs(cx - previous) / width
            if score > best_score:
                best_cx, best_score = cx, score
        return best_cx


# --------------------------------------------------------------------------- #
# Path smoothing
# --------------------------------------------------------------------------- #


def interpolate_gaps(values: list[float | None]) -> list[float] | None:
    """Fill ``None`` holes by linear interpolation between known samples."""
    known = [i for i, v in enumerate(values) if v is not None]
    if not known:
        return None
    out: list[float] = []
    for i, v in enumerate(values):
        if v is not None:
            out.append(float(v))
            continue
        before = [k for k in known if k < i]
        after = [k for k in known if k > i]
        if before and after:
            a, b = before[-1], after[0]
            va, vb = float(values[a]), float(values[b])
            out.append(va + (vb - va) * (i - a) / (b - a))
        elif before:
            out.append(float(values[before[-1]]))
        else:
            out.append(float(values[after[0]]))
    return out


def median_filter(values: list[float], window: int = MEDIAN_WINDOW) -> list[float]:
    """Kill single-frame detection jumps before smoothing."""
    if window <= 1 or len(values) <= 2:
        return list(values)
    half = max(1, window // 2)
    out = []
    for i in range(len(values)):
        lo = max(0, i - half)
        hi = min(len(values), i + half + 1)
        chunk = sorted(values[lo:hi])
        out.append(chunk[len(chunk) // 2])
    return out


def smooth(values: list[float], window: int = SMOOTH_WINDOW) -> list[float]:
    """Centred triangular moving average -- zero phase, so no tracking lag.

    This deliberately is **not** an exponential moving average. An EMA (even
    run forwards then backwards) is a causal filter: it trails whatever it is
    following. Measured on a speaker panning across frame at ~135 px/s, an
    alpha of 0.18 put the crop up to 150 px behind the face -- more than a
    third of a 404 px crop window, enough to push the head to the edge of
    frame. A centred kernel is symmetric in time, so it attenuates jitter
    without shifting the path it is smoothing.
    """
    n = len(values)
    if n == 0:
        return []
    window = max(1, min(window | 1, n if n % 2 else n - 1))
    if window <= 1:
        return list(values)

    half = window // 2
    # Triangular weights: smoother roll-off than a box, still zero phase.
    weights = [float(half + 1 - abs(k - half)) for k in range(window)]
    total = sum(weights)

    out: list[float] = []
    for i in range(n):
        acc = 0.0
        for k, weight in enumerate(weights):
            j = min(n - 1, max(0, i + k - half))   # clamp = edge padding
            acc += values[j] * weight
        out.append(acc / total)
    return out


def thin_keyframes(
    times: list[float], xs: list[float], limit: int = MAX_KEYFRAMES
) -> list[tuple[float, float]]:
    if not times:
        return []
    if len(times) <= limit:
        return list(zip(times, xs))
    step = (len(times) - 1) / (limit - 1)
    picked = [min(len(times) - 1, int(round(i * step))) for i in range(limit)]
    seen: list[int] = []
    for i in picked:
        if i not in seen:
            seen.append(i)
    return [(times[i], xs[i]) for i in seen]


# --------------------------------------------------------------------------- #
# Planning
# --------------------------------------------------------------------------- #


def vertical_crop_size(width: int, height: int) -> tuple[int, int]:
    """The largest 9:16 window that fits inside the source frame."""
    if width <= 0 or height <= 0:
        return TARGET_W, TARGET_H
    crop_w = int(round(height * TARGET_W / TARGET_H))
    crop_h = height
    if crop_w > width:
        crop_w = width
        crop_h = int(round(width * TARGET_H / TARGET_W))
    return max(2, crop_w - crop_w % 2), max(2, crop_h - crop_h % 2)


def _sample_face_track(
    cap, cv2, detector, start: float, span: float, *, sample_fps: float
) -> tuple[list[float], list[float | None]]:
    """Sample face positions with *accurate* timestamps.

    Seeking per sample with ``CAP_PROP_POS_MSEC`` is tempting and wrong: the
    seek lands on the nearest keyframe, so a detection gets attributed to a
    time it did not come from. On fast camera movement that time error reads
    as tracking lag no amount of smoothing can fix -- it put the speaker 25%%
    off centre in testing.

    So: seek once, then walk frames in order and derive each timestamp from
    the frame index. ``grab()`` skips the colour conversion for frames we are
    not going to run detection on, which keeps the walk cheap.
    """
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    if not (0.0 < fps < 1000.0):
        fps = 30.0
    stride = max(1, int(round(fps / max(0.1, sample_fps))))

    start_frame = int(round(start * fps))
    total_frames = int(round(span * fps))
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

    times: list[float] = []
    raw: list[float | None] = []
    previous: float | None = None
    try:
        for offset in range(total_frames + 1):
            if not cap.grab():
                break
            if offset % stride:
                continue
            ok, frame = cap.retrieve()
            times.append(offset / fps)
            found = (
                detector.centre_x(frame, previous) if ok and frame is not None else None
            )
            if found is not None:
                previous = found
            raw.append(found)
    finally:
        cap.release()

    if not times:                      # unreadable range: one centred sample
        times, raw = [0.0], [None]
    return times, raw


def plan_crop(
    path: str,
    start: float,
    end: float,
    *,
    width: int,
    height: int,
    gaming: bool = False,
    cache_dir: str | None = None,
    sample_fps: float = SAMPLE_FPS,
) -> CropPlan:
    """Decide how to reframe ``[start, end)`` of ``path``."""
    if height > 0 and width > 0 and width / height <= (TARGET_W / TARGET_H) + 0.01:
        return CropPlan(mode="scale")

    crop_w, crop_h = vertical_crop_size(width, height)

    if gaming:
        log.info("gaming mode: using a blurred-background fit, skipping face detection")
        return CropPlan(mode="blurfit", crop_w=crop_w, crop_h=crop_h)

    try:
        import cv2
    except ImportError:
        log.warning("OpenCV is not installed; using a blurred-background fit")
        return CropPlan(mode="blurfit", crop_w=crop_w, crop_h=crop_h)

    detector = _Detector(width, height, cache_dir)
    if detector.impl is None:
        return CropPlan(mode="blurfit", crop_w=crop_w, crop_h=crop_h)

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        log.warning("could not open %s for face detection", path)
        return CropPlan(mode="blurfit", crop_w=crop_w, crop_h=crop_h)

    span = max(0.0, end - start)
    times, raw = _sample_face_track(
        cap, cv2, detector, start, span, sample_fps=sample_fps
    )

    found = sum(1 for v in raw if v is not None)
    rate = found / max(1, len(raw))
    log.info(
        "face detection (%s): %d/%d samples (%.0f%%)",
        detector.kind, found, len(raw), rate * 100,
    )

    if rate < MIN_DETECTION_RATE:
        return CropPlan(
            mode="blurfit", crop_w=crop_w, crop_h=crop_h,
            detection_rate=rate, faces_found=found, samples=len(raw),
        )

    filled = interpolate_gaps(raw)
    if filled is None:
        return CropPlan(
            mode="blurfit", crop_w=crop_w, crop_h=crop_h,
            detection_rate=rate, faces_found=found, samples=len(raw),
        )

    centres = smooth(median_filter(filled))
    # Convert face centre -> crop left edge, kept inside the frame.
    max_x = max(0, width - crop_w)
    lefts = [max(0.0, min(float(max_x), c - crop_w / 2.0)) for c in centres]
    # _sample_face_track already returns clip-relative times, which is what
    # ffmpeg needs: it sees a trimmed input starting at t=0.
    rel = list(times)

    return CropPlan(
        mode="follow",
        crop_w=crop_w,
        crop_h=crop_h,
        keyframes=thin_keyframes(rel, lefts),
        detection_rate=rate,
        faces_found=found,
        samples=len(raw),
    )


# --------------------------------------------------------------------------- #
# Filter graph emission
# --------------------------------------------------------------------------- #


def piecewise_expression(keyframes: list[tuple[float, float]]) -> str:
    """A linear-interpolation-over-time expression for ffmpeg.

    Contains commas, so the caller MUST wrap it in single quotes inside the
    filter graph.
    """
    if not keyframes:
        return "0"
    if len(keyframes) == 1:
        return f"{keyframes[0][1]:.2f}"

    expr = f"{keyframes[-1][1]:.2f}"
    for (t0, x0), (t1, x1) in reversed(list(zip(keyframes, keyframes[1:]))):
        span = max(1e-6, t1 - t0)
        slope = (x1 - x0) / span
        segment = f"({x0:.2f}+{slope:.4f}*(t-{t0:.4f}))"
        expr = f"if(lt(t,{t1:.4f}),{segment},{expr})"
    return expr


def build_filter(plan: CropPlan, *, sharpen: bool = True) -> str:
    """The video filter chain that produces a 1080x1920 frame.

    Returns a chain operating on the current video stream, with no pad labels;
    the renderer splices it into the wider graph.
    """
    sharp = ",unsharp=5:5:0.45:5:5:0.0" if sharpen else ""

    if plan.mode == "scale":
        return (
            f"scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=decrease:flags=lanczos,"
            f"pad={TARGET_W}:{TARGET_H}:(ow-iw)/2:(oh-ih)/2,setsar=1{sharp}"
        )

    if plan.mode == "follow":
        expr = piecewise_expression(plan.keyframes)
        # The expression holds commas, so it MUST stay single-quoted. No
        # eval=frame here: crop has no such option and re-evaluates anyway.
        return (
            f"crop={plan.crop_w}:{plan.crop_h}:'{expr}':0,"
            f"scale={TARGET_W}:{TARGET_H}:flags=lanczos,setsar=1{sharp}"
        )

    # blurfit: contained frame over a blurred, filled copy of itself.
    return (
        f"split=2[__bg][__fg];"
        f"[__bg]scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=increase:flags=bilinear,"
        f"crop={TARGET_W}:{TARGET_H},gblur=sigma={BLUR_SIGMA}[__bgb];"
        f"[__fg]scale={TARGET_W}:-2:flags=lanczos[__fgs];"
        f"[__bgb][__fgs]overlay=(W-w)/2:(H-h)/2,setsar=1{sharp}"
    )
