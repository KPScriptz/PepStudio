"""Reframing: crop geometry, path smoothing, and the filter it emits."""

from __future__ import annotations

import math
import re

import pytest

from cfp.config import TARGET_H, TARGET_W
from cfp.reframe import (
    CropPlan, _Detector, build_filter, interpolate_gaps, median_filter,
    piecewise_expression, smooth, thin_keyframes, vertical_crop_size,
)


def _eval(expr: str, t: float) -> float:
    """Evaluate an ffmpeg expression in Python, to check what we emit."""
    py = re.sub(r"\bif\(", "IF(", expr)
    py = re.sub(r"\blt\(", "LT(", py)
    return eval(py, {"IF": lambda c, a, b: a if c else b,
                     "LT": lambda a, b: a < b, "t": t})


# ----------------------------- geometry ----------------------------------- #

@pytest.mark.parametrize("w,h", [(1920, 1080), (1280, 720), (3840, 2160), (640, 480)])
def test_crop_is_9x16_and_fits_inside_the_frame(w, h):
    cw, ch = vertical_crop_size(w, h)
    assert cw <= w and ch <= h
    assert cw % 2 == 0 and ch % 2 == 0
    assert cw / ch == pytest.approx(TARGET_W / TARGET_H, abs=0.01)


def test_an_already_vertical_source_is_not_cropped():
    assert vertical_crop_size(1080, 1920) == (1080, 1920)


# ----------------------------- smoothing ---------------------------------- #

def test_interpolate_fills_interior_holes_linearly():
    assert interpolate_gaps([None, 2.0, None, None, 8.0, None]) == [2, 2, 4, 6, 8, 8]


def test_interpolate_returns_none_when_nothing_was_detected():
    assert interpolate_gaps([None, None]) is None


def test_median_filter_removes_a_single_frame_spike():
    assert median_filter([1, 1, 99, 1, 1]) == [1, 1, 1, 1, 1]


def test_smoothing_has_no_phase_lag():
    """An EMA trails what it follows; our kernel must not.

    Regression test: an alpha-0.18 EMA put the crop up to 150px behind a
    speaker panning at ~135 px/s, a third of the crop window.
    """
    fps = 4.0
    t = [i / fps for i in range(60)]
    true = [640 + 386 * math.sin(2 * math.pi * x / 18.0) for x in t]
    noisy = [v + (6 if i % 7 == 0 else -4 if i % 5 == 0 else 0)
             for i, v in enumerate(true)]
    out = smooth(median_filter(noisy))
    deviation = [abs(a - b) for a, b in zip(out, true)]
    assert max(deviation) < 60
    assert sum(deviation) / len(deviation) < 12


def test_smoothing_preserves_length_and_handles_short_input():
    for n in range(0, 9):
        assert len(smooth([float(i) for i in range(n)])) == n


def test_smoothing_a_constant_path_changes_nothing():
    assert smooth([100.0] * 20) == pytest.approx([100.0] * 20)


def test_thin_keyframes_respects_the_cap():
    times = [i * 0.25 for i in range(400)]
    xs = [float(i) for i in range(400)]
    kf = thin_keyframes(times, xs, limit=24)
    assert len(kf) <= 24
    assert kf[0][0] == times[0] and kf[-1][0] == times[-1]


# ---------------------------- expression ---------------------------------- #

def test_expression_interpolates_between_keyframes():
    kf = [(0.0, 100.0), (1.0, 200.0), (2.0, 150.0)]
    expr = piecewise_expression(kf)
    for t, want in [(0.0, 100), (0.5, 150), (1.0, 200), (1.5, 175), (2.0, 150)]:
        assert _eval(expr, t) == pytest.approx(want, abs=0.5)


def test_expression_holds_the_last_value_past_the_end():
    expr = piecewise_expression([(0.0, 10.0), (1.0, 20.0)])
    assert _eval(expr, 99.0) == pytest.approx(20.0)


def test_single_and_empty_keyframes_are_constants():
    assert _eval(piecewise_expression([(0.0, 42.0)]), 5.0) == pytest.approx(42.0)
    assert _eval(piecewise_expression([]), 5.0) == 0


def test_expression_matches_linear_interpolation_everywhere():
    kf = [(i * 0.5, 100.0 + 50.0 * math.sin(i)) for i in range(20)]
    expr = piecewise_expression(kf)

    def interp(t):
        if t <= kf[0][0]:
            return kf[0][1]
        if t >= kf[-1][0]:
            return kf[-1][1]
        for (t0, x0), (t1, x1) in zip(kf, kf[1:]):
            if t0 <= t <= t1:
                return x0 + (x1 - x0) * (t - t0) / (t1 - t0)
        return kf[-1][1]

    for i in range(200):
        t = i * 0.05
        assert _eval(expr, t) == pytest.approx(interp(t), abs=0.05)


# ------------------------------ filters ----------------------------------- #

def test_follow_filter_quotes_the_expression():
    """An unquoted comma starts a new filter and corrupts the graph."""
    plan = CropPlan(mode="follow", crop_w=404, crop_h=720,
                    keyframes=[(0.0, 10.0), (1.0, 20.0)])
    out = build_filter(plan)
    quoted = out.split("crop=404:720:")[1]
    assert quoted.startswith("'")
    assert "'" in quoted[1:]


def test_crop_never_receives_an_eval_option():
    """crop has no `eval` option; passing one is a hard ffmpeg error."""
    plan = CropPlan(mode="follow", crop_w=404, crop_h=720,
                    keyframes=[(0.0, 10.0), (1.0, 20.0)])
    assert "eval=" not in build_filter(plan)


def test_zoompan_is_never_used():
    """zoompan causes drop-frame stuttering; motion comes from crop."""
    for plan in (CropPlan(mode="follow", crop_w=404, crop_h=720,
                          keyframes=[(0.0, 1.0), (1.0, 2.0)]),
                 CropPlan(mode="blurfit"), CropPlan(mode="scale")):
        assert "zoompan" not in build_filter(plan)


@pytest.mark.parametrize("mode", ["follow", "blurfit", "scale"])
def test_every_mode_produces_the_target_resolution(mode):
    plan = CropPlan(mode=mode, crop_w=404, crop_h=720, keyframes=[(0.0, 5.0)])
    assert f"{TARGET_W}:{TARGET_H}" in build_filter(plan)


def test_sharpening_can_be_turned_off():
    plan = CropPlan(mode="blurfit")
    assert "unsharp" in build_filter(plan, sharpen=True)
    assert "unsharp" not in build_filter(plan, sharpen=False)


# --------------------------- face selection -------------------------------- #

def test_a_confident_small_face_beats_a_weak_large_one():
    """Regression: a 0.69-confidence false positive with a bigger box
    out-measured the real 0.93 speaker and pulled the crop 20% off centre."""
    picked = _Detector._pick([(314.0, 7820.0, 0.69), (550.0, 3445.0, 0.93)], 1080, None)
    assert picked == 550.0


def test_among_equally_confident_faces_the_largest_wins():
    assert _Detector._pick([(300.0, 9000.0, 0.95), (700.0, 3000.0, 0.94)], 1080, None) == 300.0


def test_continuity_keeps_the_lock_on_the_tracked_face():
    assert _Detector._pick(
        [(300.0, 9000.0, 0.95), (700.0, 3000.0, 0.94)], 1080, 700.0
    ) == 700.0


def test_a_lone_low_confidence_face_is_still_used():
    assert _Detector._pick([(400.0, 2000.0, 0.65)], 1080, None) == 400.0


def test_no_candidates_yields_none():
    assert _Detector._pick([], 1080, None) is None
