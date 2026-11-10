"""The ASS writer. A malformed header here makes libass leak text into the
picture, so the format contract is asserted explicitly."""

from __future__ import annotations

import pytest

from cfp.captions import (
    EVENT_FORMAT, ass_time, build_ass, escape_text, group_words,
    inline_colour, render_group, strip_punctuation, CaptionGroup,
)
from cfp.config import CaptionStyle
from cfp.models import Word


def test_events_format_has_all_ten_fields():
    assert len(EVENT_FORMAT.split(",")) == 10


def test_every_dialogue_row_matches_the_format_arity(words):
    out = build_ass(words, style=CaptionStyle(), clip_start=0.0, clip_end=10.0)
    rows = [l for l in out.splitlines() if l.startswith("Dialogue:")]
    assert rows
    for row in rows:
        # 9 commas before the free-text field.
        assert len(row[len("Dialogue: "):].split(",", 9)) == 10


@pytest.mark.parametrize(
    "seconds,expected",
    [
        (0.0, "0:00:00.00"),
        (1.5, "0:00:01.50"),
        (61.25, "0:01:01.25"),
        (3661.0, "1:01:01.00"),
        (59.999, "0:01:00.00"),      # rounding must carry, not print .100
    ],
)
def test_ass_time(seconds, expected):
    assert ass_time(seconds) == expected


def test_ass_time_never_emits_hundred_centiseconds():
    for i in range(0, 20000):
        assert ".100" not in ass_time(i * 0.0137)


def test_escape_text_neutralises_override_braces():
    assert escape_text("a {b} c") == "a (b) c"
    assert "\\" not in escape_text("back\\slash")
    assert escape_text("line\nbreak") == "line break"


def test_inline_colour_drops_alpha_and_keeps_bgr():
    assert inline_colour("&H0000D6FF") == "&H00D6FF&"
    assert inline_colour("&H00FFFFFF") == "&HFFFFFF&"


def test_strip_punctuation_keeps_inner_apostrophes():
    assert strip_punctuation("insane!") == "insane"
    assert strip_punctuation("don't") == "don't"
    assert strip_punctuation("...wait?") == "wait"


def test_groups_respect_words_per_frame():
    ws = [Word(i * 0.3, i * 0.3 + 0.25, f"w{i}") for i in range(9)]
    for per in (1, 2, 3):
        groups = group_words(ws, per_frame=per)
        assert all(len(g.words) <= per for g in groups)
        assert sum(len(g.words) for g in groups) == len(ws)


def test_group_breaks_on_long_pause():
    ws = [Word(0, 0.3, "a"), Word(0.3, 0.6, "b"), Word(5.0, 5.3, "c")]
    assert len(group_words(ws, per_frame=3)) == 2


def test_exactly_one_word_is_highlighted_per_row():
    style = CaptionStyle()
    group = CaptionGroup([Word(0, 0.3, "one"), Word(0.3, 0.6, "two")])
    for active in (0, 1):
        text = render_group(group, active, style)
        assert text.count(inline_colour(style.highlight_color)) == 1
        assert f"\\fscx{style.pop_scale}" in text


def test_hook_only_covers_the_opening_seconds():
    style = CaptionStyle()
    out = build_ass(
        [Word(5.0, 5.4, "later")], style=style,
        clip_start=0.0, clip_end=30.0, hook="WATCH THIS",
    )
    hooks = [l for l in out.splitlines() if ",Hook," in l]
    assert len(hooks) == 1
    assert ass_time(style.hook_seconds) in hooks[0]


def test_words_are_clipped_to_the_clip_window():
    ws = [Word(0.0, 1.0, "before"), Word(12.0, 12.5, "inside"), Word(99.0, 99.5, "after")]
    out = build_ass(ws, style=CaptionStyle(), clip_start=10.0, clip_end=20.0)
    assert "INSIDE" in out
    assert "BEFORE" not in out and "AFTER" not in out


def test_no_dialogue_row_has_a_non_positive_duration(words):
    out = build_ass(words, style=CaptionStyle(), clip_start=0.0, clip_end=6.0)
    for row in (l for l in out.splitlines() if l.startswith("Dialogue:")):
        parts = row.split(",")
        assert parts[1] != parts[2]


def test_uppercase_is_configurable():
    import dataclasses

    ws = [Word(0, 0.4, "quiet")]
    lower = dataclasses.replace(CaptionStyle(), uppercase=False)
    assert "quiet" in build_ass(ws, style=lower, clip_start=0, clip_end=2)
    assert "QUIET" in build_ass(ws, style=CaptionStyle(), clip_start=0, clip_end=2)
