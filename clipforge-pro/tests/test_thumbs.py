"""Thumbnail frame scoring, composition, and text fitting."""

from __future__ import annotations

import os

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from cfp.config import ThumbStyle
from cfp.thumbs import (
    ASPECTS, Candidate, apply_scrim, build_thumb_ass, colorfulness, compose,
    contrast, enhance, exposure, face_quality, fit_font_size, measure_text,
    pick_diverse, score_frame, sharpness, text_margin,
)


@pytest.fixture
def style():
    return ThumbStyle()


def _noise(h=360, w=640, seed=0):
    return np.random.default_rng(seed).integers(0, 255, (h, w, 3), dtype=np.uint8)


def _gray(img):
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


# ------------------------------ components -------------------------------- #

def test_blur_scores_far_below_sharp():
    sharp = _noise()
    blurred = cv2.GaussianBlur(sharp, (31, 31), 0)
    assert sharpness(_gray(sharp)) > 0.9
    assert sharpness(_gray(blurred)) < 0.1


def test_crushed_and_blown_frames_score_badly():
    black = np.zeros((200, 200, 3), np.uint8)
    white = np.full((200, 200, 3), 255, np.uint8)
    mid = np.full((200, 200, 3), 130, np.uint8)
    assert exposure(_gray(black)) < 0.05
    assert exposure(_gray(white)) < 0.05
    assert exposure(_gray(mid)) > 0.9


def test_flat_frames_have_no_contrast():
    flat = np.full((200, 200, 3), 120, np.uint8)
    assert contrast(_gray(flat)) < 0.05
    assert contrast(_gray(_noise())) > 0.5


def test_vivid_frames_beat_grey_ones():
    grey = np.full((200, 200, 3), 128, np.uint8)
    vivid = np.zeros((200, 200, 3), np.uint8)
    vivid[:, :, 2] = 255
    vivid[:100, :, 1] = 255
    assert colorfulness(grey) < 0.05
    assert colorfulness(vivid) > 0.5


@pytest.mark.parametrize("box,better", [
    (((440, 700, 200, 200)), ((10, 10, 20, 20))),      # big centred > tiny corner
])
def test_face_quality_prefers_a_big_centred_face(box, better):
    assert face_quality(box, 1280, 1920) > face_quality(better, 1280, 1920)


def test_no_face_scores_zero():
    assert face_quality(None, 1280, 1920) == 0.0


def test_an_enormous_face_is_not_ideal_either():
    huge = face_quality((0, 0, 1200, 1200), 1280, 1920)
    good = face_quality((440, 700, 300, 300), 1280, 1920)
    assert good > huge


# -------------------------------- scoring ---------------------------------- #

def test_score_is_bounded_and_reports_components():
    score, parts = score_frame(_noise(), None, gaming=True)
    assert 0.0 <= score <= 1.0
    assert set(parts) == {"sharpness", "exposure", "contrast", "colorfulness", "face"}


def test_a_faceless_frame_is_not_permanently_capped():
    """With no face found, the face weight must be redistributed or every
    frame in a faceless clip tops out at ~65%."""
    frame = np.full((360, 640, 3), 130, np.uint8)
    frame[:, :320] = (30, 200, 240)
    speech, _ = score_frame(frame, None, gaming=False)
    gaming, _ = score_frame(frame, None, gaming=True)
    assert speech == pytest.approx(gaming, abs=1e-6)


def test_a_sharp_vivid_frame_outscores_a_black_one():
    black = np.zeros((360, 640, 3), np.uint8)
    good = _noise()
    assert score_frame(good, None, gaming=True)[0] > score_frame(black, None, gaming=True)[0]


# ------------------------------ selection ---------------------------------- #

def _cand(t, score):
    return Candidate(time=t, frame=None, score=score)


def test_diverse_picks_respect_the_minimum_gap():
    cands = [_cand(i * 0.1, 1.0 - i * 0.01) for i in range(60)]
    picked = pick_diverse(cands, 3, min_gap=2.0)
    times = sorted(c.time for c in picked)
    assert len(picked) == 3
    for a, b in zip(times, times[1:]):
        assert b - a >= 2.0


def test_selection_returns_the_requested_count_even_when_crowded():
    cands = [_cand(i * 0.01, 1.0 - i * 0.01) for i in range(10)]
    assert len(pick_diverse(cands, 5, min_gap=100.0)) == 5


def test_the_highest_scoring_frame_is_always_first():
    cands = [_cand(0.0, 0.2), _cand(5.0, 0.9), _cand(10.0, 0.5)]
    assert pick_diverse(cands, 1, min_gap=1.0)[0].time == 5.0


# ----------------------------- composition --------------------------------- #

@pytest.mark.parametrize("aspect", list(ASPECTS))
def test_composition_hits_the_target_resolution(aspect):
    out = compose(_noise(720, 1280), None, aspect)
    assert (out.shape[1], out.shape[0]) == ASPECTS[aspect]


def test_composition_crops_toward_the_face():
    frame = np.zeros((720, 1280, 3), np.uint8)
    frame[:, 1000:1200] = 255                      # bright patch on the right
    with_face = compose(frame, (1050, 300, 120, 120), "9:16")
    centred = compose(frame, None, "9:16")
    assert with_face.mean() > centred.mean()


def test_composition_stays_inside_the_frame_for_an_edge_face():
    out = compose(_noise(720, 1280), (0, 0, 80, 80), "9:16")
    assert (out.shape[1], out.shape[0]) == ASPECTS["9:16"]


# ------------------------------ treatment ---------------------------------- #

def test_enhancement_stays_in_range_and_lifts_saturation(style):
    img = _noise(200, 200, seed=3)
    out = enhance(img, style)
    assert out.dtype == np.uint8 and out.shape == img.shape
    assert 0 <= int(out.min()) and int(out.max()) <= 255


def test_a_neutral_style_changes_nothing_much(style):
    import dataclasses

    flat = dataclasses.replace(style, saturation=1.0, contrast=1.0, vignette=0.0)
    img = _noise(120, 120, seed=5)
    assert np.array_equal(enhance(img, flat), img)


def test_the_scrim_darkens_the_bottom_only(style):
    img = np.full((400, 200, 3), 200, np.uint8)
    out = apply_scrim(img, style)
    assert out[:40].mean() == pytest.approx(200, abs=1)
    assert out[-5:].mean() < 120


def test_a_zero_scrim_is_a_no_op(style):
    import dataclasses

    img = np.full((100, 100, 3), 180, np.uint8)
    assert np.array_equal(apply_scrim(img, dataclasses.replace(style, scrim=0.0)), img)


# --------------------------------- text ------------------------------------ #

def test_thumb_ass_uses_the_full_event_format(style):
    out = build_thumb_ass(["IT", "EXPLODED"], style, 1080, 1920)
    fmt = [l for l in out.splitlines() if l.startswith("Format:")][1]
    assert len(fmt.split("Format: ")[1].split(",")) == 10


def test_power_words_get_the_accent_colour(style):
    out = build_thumb_ass(["IT EXPLODED"], style, 1080, 1920)
    assert "00D6FF" in out                        # brand yellow, BGR


def test_play_width_widens_the_canvas_without_resizing_glyphs(style):
    normal = build_thumb_ass(["WORD"], style, 1080, 1920, size=100)
    wide = build_thumb_ass(["WORD"], style, 1080, 1920, size=100, play_width=3240)
    assert "PlayResX: 1080" in normal
    assert "PlayResX: 3240" in wide
    assert "PlayResY: 1920" in wide              # font scale reference unchanged


def test_braces_in_thumbnail_text_cannot_open_an_override_block(style):
    out = build_thumb_ass(["{\\fs200}HACK"], style, 1080, 1920)
    event = [l for l in out.splitlines() if l.startswith("Dialogue:")][0]
    assert "\\fs200" not in event


@pytest.mark.parametrize("size", [1080, 1280])
def test_measurement_sees_past_the_frame_edge(style, tmp_path, size):
    """Regression: measuring on a canvas the same width as the target makes
    clipped text report exactly the frame width, so overflow is invisible."""
    huge = int(1920 * 0.105)
    width, height = (1080, 1920) if size == 1080 else (1280, 720)
    measured, _ = measure_text(["NOBODY TELLS"], style, width, height, huge, str(tmp_path))
    assert measured > 0
    if width == 1080:
        assert measured > width, "overflow must be reported beyond the frame width"


def test_fitted_text_always_fits(style, tmp_path):
    for lines in (["NOBODY TELLS"], ["THING", "NOBODY TELLS"], ["NO WAY"]):
        for width, height in ((1080, 1920), (1280, 720)):
            size = fit_font_size(lines, style, width, height, str(tmp_path))
            measured, _ = measure_text(lines, style, width, height, size, str(tmp_path))
            usable = width - 2 * text_margin(width)
            assert 0 < measured <= usable, f"{lines} at {width}x{height}"


def test_fitting_grows_text_that_would_be_needlessly_small(style, tmp_path):
    """A thumbnail works harder when its words run nearly edge to edge."""
    lines = ["NO WAY"]
    size = fit_font_size(lines, style, 1080, 1920, str(tmp_path))
    measured, _ = measure_text(lines, style, 1080, 1920, size, str(tmp_path))
    usable = 1080 - 2 * text_margin(1080)
    assert measured > usable * 0.75


def test_fit_falls_back_without_a_measurement(style, tmp_path, monkeypatch):
    import cfp.thumbs as mod

    monkeypatch.setattr(mod, "measure_text", lambda *a, **k: (0, 0))
    assert mod.fit_font_size(["SOME TEXT"], style, 1080, 1920, str(tmp_path)) > 16
