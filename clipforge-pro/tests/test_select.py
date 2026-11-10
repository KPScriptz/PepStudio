"""Clip selection: boundary snapping, scoring, and the Claude path (mocked)."""

from __future__ import annotations

import types

import pytest

from cfp.config import get_preset
from cfp.models import ClipPick, Peak, Transcript, Word
from cfp.select import (
    ClipSelectionError, build_sentences, build_transcript_block, count_filler,
    count_triggers, pick_heuristic, pick_with_claude, select_clips,
    snap_to_cuts, snap_to_sentences, synthesize_hashtags, synthesize_title,
    _enforce_window, _validate_suggestions,
)
from cfp.signals import Signals


# ----------------------------- sentences ---------------------------------- #

def test_sentences_split_on_terminal_punctuation(transcript):
    sents = build_sentences(transcript)
    assert len(sents) >= 3
    assert sents[0].text.endswith(".")


def test_sentences_split_on_a_long_pause():
    ws = [Word(0, 0.3, "one"), Word(0.3, 0.6, "two"), Word(9.0, 9.3, "three")]
    assert len(build_sentences(Transcript(words=ws))) == 2


def test_no_sentences_without_words():
    assert build_sentences(Transcript()) == []


# ------------------------------ windows ----------------------------------- #

@pytest.mark.parametrize("start,end", [(0, 5), (10, 200), (-5, 20), (95, 99)])
def test_enforce_window_always_respects_bounds(start, end):
    s, e = _enforce_window(start, end, 15.0, 60.0, 100.0)
    assert 0 <= s < e <= 100.0
    assert 15.0 - 1e-6 <= e - s <= 60.0 + 1e-6


def test_enforce_window_backs_up_at_the_end_of_the_source():
    s, e = _enforce_window(95.0, 99.0, 15.0, 60.0, 100.0)
    assert e == pytest.approx(100.0)
    assert e - s == pytest.approx(15.0)


def test_snap_moves_onto_sentence_boundaries(transcript):
    sents = build_sentences(transcript)
    s, e = snap_to_sentences(0.4, 3.0, sents, min_dur=0.5, max_dur=20.0, duration=30.0)
    assert s == pytest.approx(sents[0].start)
    assert any(abs(e - x.end) < 1e-6 for x in sents)


def test_snap_is_a_no_op_without_speech():
    s, e = snap_to_sentences(10.0, 40.0, [], min_dur=15.0, max_dur=60.0, duration=100.0)
    assert (s, e) == (10.0, 40.0)


def test_snap_to_cuts_prefers_a_nearby_cut():
    s, e = snap_to_cuts(
        14.4, 44.2, [0.0, 15.0, 30.0, 45.0],
        min_dur=15.0, max_dur=60.0, duration=90.0,
    )
    assert s == pytest.approx(15.0)
    assert e == pytest.approx(45.0)


def test_snap_to_cuts_ignores_distant_cuts():
    s, e = snap_to_cuts(
        40.0, 60.0, [0.0, 90.0], min_dur=15.0, max_dur=60.0, duration=120.0,
    )
    assert (s, e) == (40.0, 60.0)


# ------------------------------ scoring ----------------------------------- #

def test_trigger_and_filler_counting():
    assert count_triggers("that was insane and absolutely crazy") == 2
    assert count_triggers("nothing notable here") == 0
    assert count_filler("okay guys so basically welcome back") == 3


def test_title_avoids_banned_generic_words():
    title = synthesize_title("This gameplay episode is insane.", {}, gaming=True)
    low = title.lower()
    assert "gameplay" not in low and "episode" not in low


def test_title_is_capped_at_55_characters():
    long = "word " * 60
    assert len(synthesize_title(long, {}, gaming=False)) <= 56


def test_preset_hashtags_are_always_forced():
    preset = get_preset("pepercollectibles")
    tags = synthesize_hashtags("a totally normal sentence", preset, gaming=False)
    assert "#pepercollectibles" in tags


def test_hashtags_are_deduplicated():
    tags = synthesize_hashtags("insane insane insane", get_preset("gaming"), gaming=True)
    assert len(tags) == len(set(tags))


# ---------------------------- heuristic path ------------------------------ #

def _signals(duration=120.0, peaks=(), cuts=()):
    sig = Signals(duration=duration, has_audio=True)
    sig.peaks = [Peak(time=t, score=4.0, kind="loudness") for t in peaks]
    sig.scene_cuts = list(cuts)
    return sig


def test_heuristic_returns_non_overlapping_clips_in_range():
    sig = _signals(peaks=(20.0, 50.0, 90.0), cuts=(15.0, 45.0, 75.0))
    picks = pick_heuristic(
        None, sig, count=3, min_dur=15.0, max_dur=30.0,
        duration=120.0, gaming=True,
    )
    assert 1 <= len(picks) <= 3
    for p in picks:
        assert 15.0 - 1e-6 <= p.duration <= 30.0 + 1e-6
        assert 0 <= p.start < p.end <= 120.0
    for a, b in zip(picks, picks[1:]):
        assert not a.overlaps(b, tolerance=0.75)


def test_heuristic_works_with_no_speech_at_all():
    """Gaming mode must still produce clips from audio spikes alone."""
    sig = _signals(peaks=(30.0, 60.0))
    picks = pick_heuristic(
        None, sig, count=2, min_dur=15.0, max_dur=30.0,
        duration=120.0, gaming=True,
    )
    assert picks
    assert all(p.reason for p in picks)


def test_heuristic_prefers_loud_moments_over_silence():
    sig = _signals(duration=200.0, peaks=(150.0,))
    picks = pick_heuristic(
        None, sig, count=1, min_dur=15.0, max_dur=30.0,
        duration=200.0, gaming=True,
    )
    assert picks[0].start <= 150.0 <= picks[0].end


def test_every_pick_explains_itself():
    sig = _signals(peaks=(40.0,))
    for p in pick_heuristic(None, sig, count=2, min_dur=15.0, max_dur=30.0,
                            duration=120.0, gaming=True):
        assert p.reason and p.reason.endswith(".")


# ------------------------------ Claude path -------------------------------- #

class _FakeMessages:
    def __init__(self, payload, stop_reason="end_turn", raises=None):
        self.payload, self.stop_reason, self.raises = payload, stop_reason, raises
        self.calls = []

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        if self.raises:
            raise self.raises
        return types.SimpleNamespace(
            parsed_output=self.payload, stop_reason=self.stop_reason,
            stop_details=None, content=[],
        )


class _FakeClient:
    def __init__(self, *a, **kw):
        self.messages = _FakeMessages(*a, **kw)


def _payload(clips):
    return {"clips": clips}


def _clip(start, end, score=90):
    return {
        "start_seconds": start, "end_seconds": end,
        "title": "A title", "hook": "A HOOK", "virality_score": score,
        "reason": "because", "hashtags": ["#one", "two"],
    }


def test_claude_picks_are_parsed_and_normalised(transcript):
    client = _FakeClient(_payload([_clip(1.0, 4.0)]))
    picks = pick_with_claude(
        transcript, Signals(duration=60.0), count=3,
        min_dur=2.0, max_dur=20.0, duration=60.0, client=client,
    )
    assert len(picks) == 1
    assert picks[0].picked_by == "claude"
    assert picks[0].hashtags == ["#one", "#two"]     # '#' is added


def test_claude_suggestions_are_clamped_to_the_duration_window(transcript):
    client = _FakeClient(_payload([_clip(0.0, 500.0)]))
    picks = pick_with_claude(
        transcript, Signals(duration=60.0), count=1,
        min_dur=5.0, max_dur=20.0, duration=60.0, client=client,
    )
    assert picks[0].duration <= 20.0 + 1e-6
    assert picks[0].end <= 60.0


def test_overlapping_claude_suggestions_are_dropped(transcript):
    client = _FakeClient(_payload([_clip(0.0, 10.0, 90), _clip(1.0, 11.0, 80)]))
    picks = pick_with_claude(
        transcript, Signals(duration=60.0), count=5,
        min_dur=5.0, max_dur=20.0, duration=60.0, client=client,
    )
    assert len(picks) == 1


def test_reversed_and_out_of_range_suggestions_are_dropped(transcript):
    bad = [_clip(20.0, 10.0), _clip(500.0, 520.0), {"title": "no times"}]
    client = _FakeClient(_payload(bad))
    with pytest.raises(ClipSelectionError):
        pick_with_claude(
            transcript, Signals(duration=60.0), count=5,
            min_dur=5.0, max_dur=20.0, duration=60.0, client=client,
        )


def test_a_refusal_falls_back_to_a_second_model(transcript):
    client = _FakeClient(_payload([_clip(1.0, 5.0)]), stop_reason="refusal")
    with pytest.raises(ClipSelectionError):
        pick_with_claude(
            transcript, Signals(duration=60.0), count=1,
            min_dur=2.0, max_dur=20.0, duration=60.0, client=client,
        )
    # Both the primary and the fallback model were attempted.
    assert len({c["model"] for c in client.messages.calls}) == 2


def test_select_clips_degrades_to_heuristic_when_the_api_fails(transcript):
    client = _FakeClient(None, raises=RuntimeError("network is down"))
    sig = _signals(duration=120.0, peaks=(30.0,))
    picks = select_clips(
        transcript, sig, count=2, min_dur=15.0, max_dur=30.0,
        duration=120.0, gaming=False, client=client,
    )
    assert picks and all(p.picked_by == "heuristic" for p in picks)


def test_select_clips_uses_the_heuristic_without_a_key(monkeypatch, transcript):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    sig = _signals(duration=120.0, peaks=(30.0,))
    picks = select_clips(
        transcript, sig, count=2, min_dur=15.0, max_dur=30.0,
        duration=120.0, gaming=False,
    )
    assert picks and picks[0].picked_by == "heuristic"


def test_forced_preset_hashtags_survive_the_claude_path(transcript):
    client = _FakeClient(_payload([_clip(1.0, 5.0)]))
    picks = pick_with_claude(
        transcript, Signals(duration=60.0), count=1,
        min_dur=2.0, max_dur=20.0, duration=60.0,
        client=client, preset=get_preset("pepercollectibles"),
    )
    assert "#pepercollectibles" in picks[0].hashtags


def test_transcript_block_respects_its_character_budget(transcript):
    sents = build_sentences(transcript)
    assert len(build_transcript_block(sents, budget=40)) <= 40


def test_the_prompt_is_forwarded_to_the_model(transcript):
    client = _FakeClient(_payload([_clip(1.0, 5.0)]))
    pick_with_claude(
        transcript, Signals(duration=60.0), count=1, min_dur=2.0,
        max_dur=20.0, duration=60.0, client=client, prompt="funniest moments",
    )
    body = client.messages.calls[0]["messages"][0]["content"]
    assert "funniest moments" in body


def test_forced_tool_choice_is_never_sent(transcript):
    """Forced tool_choice returns HTTP 400 on current models."""
    client = _FakeClient(_payload([_clip(1.0, 5.0)]))
    pick_with_claude(
        transcript, Signals(duration=60.0), count=1,
        min_dur=2.0, max_dur=20.0, duration=60.0, client=client,
    )
    assert "tool_choice" not in client.messages.calls[0]
    assert "output_config" in client.messages.calls[0]
