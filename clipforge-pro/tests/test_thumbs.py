"""Thumbnail frame scoring, composition, and text fitting."""

from __future__ import annotations

import os

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from conftest import needs_quality

from cfp.config import ThumbStyle
from cfp.thumbs import (
    ASPECTS, Candidate, apply_scrim, build_thumb_ass, colorfulness, compose,
    contrast, draw_text_box, enhance, exposure, face_quality, fit_font_size,
    grade, measure_text, pick_diverse, score_frame, sharpness, spotlight,
    text_margin,
)


@pytest.fixture
def style():
    import dataclasses

    # Cutout enabled so the segmentation gates are exercised.
    return dataclasses.replace(ThumbStyle(), cutout=True)


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


def test_detail_separates_a_busy_frame_from_an_empty_one():
    """Regression: a flat, perfectly exposed horizon outscored a detailed
    street scene purely on exposure. Quality is not the same as interest."""
    from cfp.thumbs import detail

    flat = np.zeros((300, 500, 3), np.uint8)
    flat[:150] = 200                                  # two solid bands
    busy = _noise(300, 500, seed=9)
    assert detail(_gray(busy)) > detail(_gray(flat))


def test_an_empty_frame_loses_to_a_busy_one_of_similar_exposure():
    flat = np.full((300, 500, 3), 130, np.uint8)
    flat[:120] = 150
    busy = cv2.GaussianBlur(_noise(300, 500, seed=4), (3, 3), 0)
    assert score_frame(busy, None, gaming=True)[0] > score_frame(flat, None, gaming=True)[0]


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
    assert set(parts) == {
        "sharpness", "exposure", "contrast", "colorfulness", "detail", "face",
    }


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


def test_the_minimum_gap_is_honoured_when_quality_allows():
    """Equal-quality candidates: nothing competes with spacing, so the gap
    must hold exactly."""
    cands = [_cand(i * 0.1, 0.9) for i in range(60)]
    picked = pick_diverse(cands, 3, min_gap=2.0)
    times = sorted(c.time for c in picked)
    assert len(picked) == 3
    for a, b in zip(times, times[1:]):
        assert b - a >= 2.0


def test_quality_outranks_spacing():
    """Regression: a 6.7s gap on footage whose good frames sat in one stretch
    forced the third pick into a motion-blurred segment scoring 0.62 against
    a 1.00 best. The gap must give way, not the quality bar."""
    good = [_cand(16.0 + i * 0.5, 0.95) for i in range(20)]   # one good stretch
    bad = [_cand(2.0 + i * 0.5, 0.40) for i in range(10)]     # far away, poor
    picked = pick_diverse(good + bad, 3, min_gap=8.0)
    assert len(picked) == 3
    assert all(c.score > 0.9 for c in picked), [c.score for c in picked]


def test_weak_frames_are_accepted_only_when_nothing_better_exists():
    weak = [_cand(i * 2.0, 0.3) for i in range(5)]
    assert len(pick_diverse(weak, 3, min_gap=1.0)) == 3


def test_selection_returns_the_requested_count_even_when_crowded():
    cands = [_cand(i * 0.01, 1.0 - i * 0.01) for i in range(10)]
    assert len(pick_diverse(cands, 5, min_gap=100.0)) == 5


def test_the_highest_scoring_frame_is_always_first():
    cands = [_cand(0.0, 0.2), _cand(5.0, 0.9), _cand(10.0, 0.5)]
    assert pick_diverse(cands, 1, min_gap=1.0)[0].time == 5.0


# ----------------------------- composition --------------------------------- #

@pytest.mark.parametrize("aspect", list(ASPECTS))
def test_composition_hits_the_target_resolution(aspect):
    out = compose(_noise(720, 1280), None, aspect).image
    assert (out.shape[1], out.shape[0]) == ASPECTS[aspect]


def test_composition_crops_toward_the_face():
    frame = np.zeros((720, 1280, 3), np.uint8)
    frame[:, 1000:1200] = 255                      # bright patch on the right
    with_face = compose(frame, (1050, 300, 120, 120), "9:16").image
    centred = compose(frame, None, "9:16").image
    assert with_face.mean() > centred.mean()


def test_composition_stays_inside_the_frame_for_an_edge_face():
    out = compose(_noise(720, 1280), (0, 0, 80, 80), "9:16").image
    assert (out.shape[1], out.shape[0]) == ASPECTS["9:16"]


# ------------------------------ treatment ---------------------------------- #

def test_compose_reports_where_the_subject_landed():
    c = compose(_noise(720, 1280), (900, 300, 160, 160), "16:9")
    assert 0 <= c.center[0] <= c.image.shape[1]
    assert 0 <= c.center[1] <= c.image.shape[0]


def test_tone_curve_is_monotonic():
    from cfp.thumbs import tone_curve

    lut = tone_curve(0.34, 1.12)
    assert np.all(np.diff(lut.astype(int)) >= 0)
    assert lut[0] == 0 and lut[-1] == 255


def test_spotlight_darkens_the_corners_more_than_the_centre(style):
    img = np.full((400, 400, 3), 180, np.uint8)
    out = spotlight(img, (200.0, 200.0), style)
    assert out[200, 200].mean() > out[5, 5].mean()


def test_the_text_box_only_covers_its_rect(style):
    img = np.full((200, 200, 3), 200, np.uint8)
    out = draw_text_box(img, (50, 50, 150, 150), style)
    assert out[100, 100].mean() < 120
    assert out[10, 10].mean() == pytest.approx(200, abs=1)


def test_enhancement_stays_in_range_and_lifts_saturation(style):
    img = _noise(200, 200, seed=3)
    out = enhance(img, style)
    assert out.dtype == np.uint8 and out.shape == img.shape
    assert 0 <= int(out.min()) and int(out.max()) <= 255


def test_a_neutral_style_changes_nothing_much(style):
    import dataclasses

    flat = dataclasses.replace(
        style, saturation=1.0, contrast=1.0, vignette=0.0,
        s_curve=0.0, split_tone=0.0,
    )
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


# ------------------- against footage of known quality ---------------------- #

def _frame_at(path: str, t: float):
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "f.png")
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{t:.2f}",
             "-i", path, "-frames:v", "1", out], check=True,
        )
        return cv2.imread(out)


@needs_quality
def test_bad_frames_score_below_good_ones(quality_path, quality_truth):
    """Dark, motion-blurred and washed-out segments must lose to clean ones.

    A frame grabbed at a fixed timestamp has no idea which of these it is
    landing on; this is the whole reason the picker exists.
    """
    scores = {}
    for seg in quality_truth["segments"]:
        mid = (seg["start"] + seg["end"]) / 2.0
        frame = _frame_at(quality_path, mid)
        assert frame is not None
        scores[seg["name"]] = score_frame(frame, None, gaming=True)[0]

    worst_good = min(scores[n] for n in quality_truth["good"])
    best_bad = max(scores[n] for n in quality_truth["bad"])
    assert worst_good > best_bad, scores
    assert scores["dark"] < worst_good
    assert scores["blurry"] < worst_good


@needs_quality
def test_the_picker_only_keeps_frames_from_good_segments(quality_path, quality_truth, tmp_path):
    from cfp.thumbs import make_thumbnails

    good = {s["name"] for s in quality_truth["segments"]} & set(quality_truth["good"])
    ranges = [
        (s["start"], s["end"]) for s in quality_truth["segments"] if s["name"] in good
    ]

    shots = make_thumbnails(
        quality_path, start=0.0, end=40.0, out_dir=str(tmp_path),
        basename="q", text="ABSOLUTELY RIDICULOUS", style=ThumbStyle(),
        workdir=str(tmp_path), count=3, wide=False, clean=False, gaming=True,
    )
    assert shots
    for shot in shots:
        assert any(lo <= shot.frame_time <= hi for lo, hi in ranges), (
            f"{shot.label} came from a low-quality segment at {shot.frame_time:.1f}s"
        )
        assert os.path.exists(shot.path)


def test_a_rectangular_mask_is_not_accepted_as_a_cutout(style, monkeypatch):
    """Regression: GrabCut can return its seed region almost unchanged. A
    filled rectangle composited with a stroke looks like a pasted photo, not
    a cut-out subject, so it must be rejected and fall back."""
    import cfp.thumbs as mod

    frame = _noise(400, 400, seed=2)

    def fake_grabcut(img, mask, rect, bgd, fgd, iters, mode):
        mask[:] = cv2.GC_PR_FGD          # everything is foreground

    monkeypatch.setattr(cv2, "grabCut", fake_grabcut)
    assert mod.cutout(frame, (150.0, 100.0, 60.0, 70.0), style) is None


def test_a_genuine_subject_shape_is_accepted(style, monkeypatch):
    import cfp.thumbs as mod

    frame = _noise(400, 400, seed=3)

    def fake_grabcut(img, mask, rect, bgd, fgd, iters, mode):
        mask[:] = cv2.GC_BGD
        h, w = mask.shape[:2]
        cv2.circle(mask, (w // 2, h // 2), int(min(h, w) * 0.34), cv2.GC_FGD, -1)

    monkeypatch.setattr(cv2, "grabCut", fake_grabcut)
    alpha = mod.cutout(frame, (150.0, 100.0, 60.0, 70.0), style)
    assert alpha is not None and alpha.max() > 200


def test_a_tiny_face_is_not_cut_out(style):
    from cfp.thumbs import cutout

    assert cutout(_noise(400, 400), (10.0, 10.0, 8.0, 8.0), style) is None
