"""Filter-graph assembly and the review deliverables."""

from __future__ import annotations

import json
import os
import re

import pytest

from cfp.models import ClipPick, RenderedClip
from cfp.reframe import CropPlan
from cfp.render import _slug, build_video_graph, escape_filter_path
from cfp.review import ReviewMeta, render_index_html, write_review


# ------------------------------- render ----------------------------------- #

def test_filter_paths_are_escaped():
    out = escape_filter_path("/tmp/a:b/c'd.ass")
    assert "\\:" in out and "\\'" in out


def test_graph_is_wired_from_source_to_output_label():
    for mode in ("follow", "blurfit", "scale"):
        plan = CropPlan(mode=mode, crop_w=404, crop_h=720, keyframes=[(0.0, 5.0)])
        graph = build_video_graph(plan, None, sharpen=True)
        assert graph.startswith("[0:v]")
        assert graph.endswith("[vout]")


def test_captions_are_burned_after_sharpening():
    """Sharpening after the burn rings the glyph edges."""
    plan = CropPlan(mode="blurfit")
    graph = build_video_graph(plan, "/tmp/x.ass", sharpen=True)
    assert graph.index("unsharp") < graph.index("ass=")


def test_the_subtitle_filter_is_omitted_without_captions():
    graph = build_video_graph(CropPlan(mode="scale"), None, sharpen=False)
    assert "ass=" not in graph


def test_blurfit_graph_has_balanced_internal_labels():
    graph = build_video_graph(CropPlan(mode="blurfit"), None, sharpen=False)
    produced = set(re.findall(r"\[(__\w+)\]", graph))
    for label in produced:
        assert graph.count(f"[{label}]") == 2      # produced once, consumed once


def test_slugs_are_filesystem_safe():
    assert _slug("He FLEW into the Helicopter!!") == "he-flew-into-the-helicopter"
    assert _slug("") == "clip"
    assert "/" not in _slug("a/b\\c")
    assert len(_slug("x" * 200)) <= 40


# ------------------------------- review ----------------------------------- #

def _clip(title="A title", score=90, idx=1, tags=None):
    pick = ClipPick(
        10.0, 30.0, title=title, hook="HOOK", score=score,
        reason="because it is loud", hashtags=tags or ["#a", "#b"], index=idx,
    )
    return RenderedClip(pick=pick, path=f"/o/clip_{idx:02d}.mp4",
                        thumbnail=f"/o/clip_{idx:02d}.jpg", bytes=1234)


def test_html_escapes_markup_in_titles():
    html = render_index_html(
        [_clip(title="<script>alert(1)</script>")],
        ReviewMeta(source="s", duration=60.0), [],
    )
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;" in html


def test_copy_buttons_carry_escaped_attributes_not_inline_js():
    nasty = 'He said "stop" & <left>'
    html = render_index_html([_clip(title=nasty)], ReviewMeta(source="s"), [])
    assert "onclick=" not in html
    attrs = re.findall(r'data-copy="([^"]*)"', html)
    assert len(attrs) == 3                 # title, tags, caption
    assert "&quot;" in attrs[0]


def test_clips_and_posters_are_referenced_relatively():
    html = render_index_html([_clip()], ReviewMeta(source="s"), [])
    assert 'src="clip_01.mp4"' in html
    assert 'poster="clip_01.jpg"' in html
    assert "/o/" not in html


def test_failures_are_surfaced_on_the_page():
    html = render_index_html(
        [_clip()], ReviewMeta(source="s"),
        [{"clip": 3, "start": 5.0, "end": 9.0, "error": "ffmpeg exploded"}],
    )
    assert "ffmpeg exploded" in html
    assert "1 clip(s) failed" in html


def test_an_empty_result_still_renders():
    html = render_index_html([], ReviewMeta(source="s"), [])
    assert "No clips were rendered" in html


def test_score_tiers_are_applied():
    html = render_index_html(
        [_clip(score=90, idx=1), _clip(score=70, idx=2), _clip(score=20, idx=3)],
        ReviewMeta(source="s"), [],
    )
    for tier in ("hot", "warm", "cool"):
        assert f'score {tier}' in html


def test_write_review_emits_both_files(tmp_path):
    meta = ReviewMeta(source="/x/in.mp4", title="T", duration=90.0,
                      picked_by="claude", encoder="libx264", preset="brand",
                      model="claude-opus-5-5", transcript_words=120)
    jpath, hpath = write_review(str(tmp_path), [_clip()], meta, [])
    assert os.path.exists(jpath) and os.path.exists(hpath)
    data = json.loads(open(jpath, encoding="utf-8").read())
    assert data["clip_count"] == 1
    assert data["selection"]["picked_by"] == "claude"
    assert data["clips"][0]["duration"] == pytest.approx(20.0)
    assert data["clips"][0]["file"] == "clip_01.mp4"
    assert data["generator"] == "ClipForge Pro"


def test_clips_json_records_failures(tmp_path):
    failed = [{"clip": 2, "start": 1.0, "end": 2.0, "error": "nope"}]
    jpath, _ = write_review(str(tmp_path), [], ReviewMeta(source="s"), failed)
    assert json.loads(open(jpath, encoding="utf-8").read())["failed"] == failed
