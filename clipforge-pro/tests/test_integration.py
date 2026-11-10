"""End-to-end runs against the generated footage.

These exercise the real ffmpeg/OpenCV path, so they are the slow tests. They
skip cleanly when the footage has not been generated.
"""

from __future__ import annotations

import json
import os
import subprocess

import pytest

from cfp.config import Settings
from cfp.pipeline import run
from conftest import needs_fixtures, needs_talking


def _probe(path: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-show_entries",
         "format=duration", "-print_format", "json", path],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    stream = data["streams"][0]
    return {
        "width": stream["width"],
        "height": stream["height"],
        "duration": float(data["format"]["duration"]),
    }


@needs_fixtures
def test_dry_run_picks_sane_clips(gameplay_path, ground_truth, tmp_path):
    result = run(Settings(
        source=gameplay_path, out_dir=str(tmp_path), clips=4,
        min_dur=15.0, max_dur=30.0, use_api=False, dry_run=True,
        cache_dir=str(tmp_path / "cache"),
    ))
    assert result.picks
    assert not result.clips                     # dry run renders nothing
    for pick in result.picks:
        assert 15.0 - 1e-6 <= pick.duration <= 30.0 + 1e-6
        assert 0 <= pick.start < pick.end <= ground_truth["duration"] + 1e-6
        assert pick.title and pick.reason and pick.hashtags
    for a, b in zip(result.picks, result.picks[1:]):
        assert not a.overlaps(b, tolerance=0.75)


@needs_fixtures
def test_gameplay_clips_cover_the_planted_explosions(gameplay_path, ground_truth, tmp_path):
    """The whole point of gaming mode: rank on chaos, not on words."""
    result = run(Settings(
        source=gameplay_path, out_dir=str(tmp_path), clips=4,
        min_dur=15.0, max_dur=30.0, use_api=False, dry_run=True,
        gaming=True, cache_dir=str(tmp_path / "cache"),
    ))
    covered = sum(
        1 for boom in ground_truth["explosions"]
        if any(p.start <= boom <= p.end for p in result.picks)
    )
    assert covered >= 3, f"only {covered}/4 explosions landed inside a clip"


@needs_fixtures
@pytest.mark.slow
def test_full_render_produces_playable_vertical_clips(gameplay_path, tmp_path):
    result = run(Settings(
        source=gameplay_path, out_dir=str(tmp_path), clips=2,
        min_dur=15.0, max_dur=20.0, use_api=False, gaming=True,
        cache_dir=str(tmp_path / "cache"), model="tiny.en",
    ))
    assert result.clips, f"nothing rendered; failures: {result.failed}"
    for clip in result.clips:
        assert os.path.exists(clip.path) and clip.bytes > 10000
        info = _probe(clip.path)
        assert (info["width"], info["height"]) == (1080, 1920)
        assert info["duration"] == pytest.approx(clip.pick.duration, abs=0.5)
        if clip.thumbnail:
            assert os.path.exists(clip.thumbnail)

    assert os.path.exists(os.path.join(str(tmp_path), "index.html"))
    with open(os.path.join(str(tmp_path), "clips.json"), encoding="utf-8") as fh:
        data = json.load(fh)
    assert data["clip_count"] == len(result.clips)
    for entry in data["clips"]:
        assert os.path.exists(os.path.join(str(tmp_path), entry["file"]))


@needs_talking
@pytest.mark.slow
def test_speech_footage_transcribes_and_follows_the_face(talking_path, tmp_path):
    result = run(Settings(
        source=talking_path, out_dir=str(tmp_path), clips=1,
        min_dur=8.0, max_dur=15.0, use_api=False, model="tiny.en",
        cache_dir=str(tmp_path / "cache"),
    ))
    assert result.transcript_words > 20, "expected real speech to be transcribed"
    assert not result.gaming, "dense speech must not be ranked as gameplay"
    assert result.clips
    assert _probe(result.clips[0].path)["width"] == 1080


@needs_fixtures
@pytest.mark.slow
def test_thumbnails_and_titles_are_produced_for_every_clip(gameplay_path, tmp_path):
    result = run(Settings(
        source=gameplay_path, out_dir=str(tmp_path), clips=2,
        min_dur=15.0, max_dur=20.0, use_api=False, gaming=True,
        cache_dir=str(tmp_path / "cache"), model="tiny.en",
        thumbs=2, preset="gaming",
    ))
    assert result.clips

    for clip in result.clips:
        pick = clip.pick
        assert pick.title_variants, "every clip needs title options"
        assert pick.title == pick.title_variants[0].text
        assert pick.thumbnail_text
        assert pick.platforms
        for data in pick.platforms.values():
            assert data["within_limit"]

        # 2 variants + clean + wide
        assert len(clip.thumbnails) == 4
        labels = {t.label for t in clip.thumbnails}
        assert {"thumb_1", "thumb_2", "thumb_clean", "thumb_wide"} == labels

        for shot in clip.thumbnails:
            assert os.path.exists(shot.path) and os.path.getsize(shot.path) > 2000
            info = _probe(shot.path)
            expected = (1280, 720) if shot.aspect == "16:9" else (1080, 1920)
            assert (info["width"], info["height"]) == expected
            assert pick.start <= shot.frame_time <= pick.end

    # The review page must reference the generated thumbnails.
    with open(os.path.join(str(tmp_path), "index.html"), encoding="utf-8") as fh:
        page = fh.read()
    first = result.clips[0].thumbnails[0]
    assert os.path.basename(first.path) in page
    assert "title options" in page

    with open(os.path.join(str(tmp_path), "clips.json"), encoding="utf-8") as fh:
        data = json.load(fh)
    entry = data["clips"][0]
    assert entry["thumbnails"] and entry["title_variants"]
    for shot in entry["thumbnails"]:
        assert os.path.exists(os.path.join(str(tmp_path), shot["file"]))


@needs_fixtures
def test_a_missing_source_fails_cleanly(tmp_path):
    from cfp.ingest import IngestError

    with pytest.raises(IngestError):
        run(Settings(source=str(tmp_path / "nope.mp4"), out_dir=str(tmp_path),
                     dry_run=True, cache_dir=str(tmp_path / "cache")))
