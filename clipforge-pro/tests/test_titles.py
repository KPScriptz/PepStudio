"""Title generation, CTR scoring, and platform packaging."""

from __future__ import annotations

import pytest

from cfp.config import get_preset
from cfp.models import ClipPick
from cfp.titles import (
    BANNED, MAX_TITLE, PLATFORMS, enrich_picks, generate_titles,
    has_adjacent_duplicate, key_phrase, key_phrase_pair, package,
    plausible_noun, punchiest_sentence, score_title, thumbnail_text,
    title_case, trim, wrap_thumbnail_text,
)

HELI = ("Oh my god. Watch this. He just flew straight into the helicopter "
        "and it exploded. That was absolutely insane.")
CARD = ("The single most valuable card in this entire box is worth more than "
        "my car. I opened it last week and I genuinely screamed.")


# ---------------------------- phrase mining -------------------------------- #

def test_subject_is_a_noun_not_a_verb_phrase():
    """Regression: the longest-run extractor returned "flew straight",
    producing titles like "Never Do This With Flew Straight"."""
    bare, with_det = key_phrase_pair(punchiest_sentence(HELI))
    assert bare == "helicopter"
    assert with_det == "the helicopter"


def test_adjectives_stay_inside_a_noun_phrase():
    bare, _ = key_phrase_pair(punchiest_sentence(CARD))
    assert "card" in bare.lower()
    assert len(bare.split()) > 1          # "single most valuable card"


def test_plausible_noun_rejects_bare_adjectives():
    assert not plausible_noun("insane")
    assert not plausible_noun("absolutely")
    assert plausible_noun("helicopter")
    assert plausible_noun("insane helicopter")


def test_adjacent_duplicate_detection():
    assert has_adjacent_duplicate("The Most Insane Insane I've Seen")
    assert not has_adjacent_duplicate("The Most Insane Helicopter")


def test_title_case_keeps_small_words_lowercase_inside():
    assert title_case("what happened with the helicopter") == "What Happened with the Helicopter"


def test_trim_never_exceeds_the_limit():
    assert len(trim("word " * 40, 50)) <= 50


# ------------------------------ scoring ------------------------------------ #

def test_specificity_does_not_depend_on_capitalisation():
    """Titles are Title Cased, so counting capitals as proper nouns scores
    every candidate identically and tells you nothing."""
    lower = score_title("what happened with the red helicopter")[0]
    cased = score_title("What Happened With The Red Helicopter")[0]
    assert abs(lower - cased) <= 1


def test_emotional_words_raise_the_score():
    plain = score_title("A moment from the stream")[0]
    charged = score_title("The Most Brutal Pull Rate I've Seen")[0]
    assert charged > plain


def test_generic_category_words_are_punished():
    good = score_title("Nobody Expected the Helicopter")[0]
    generic = score_title("Nobody Expected the Gameplay Episode")[0]
    assert generic < good


def test_shouting_and_punctuation_pile_ups_are_punished():
    calm = score_title("This Changed Everything")[0]
    shouty = score_title("THIS CHANGED EVERYTHING NOW")[0]
    bangs = score_title("This Changed Everything!!!")[0]
    assert shouty < calm
    assert bangs < calm


def test_repetition_is_punished():
    clean = score_title("The Most Insane Helicopter I've Seen")[0]
    repeated = score_title("The Most Insane Insane I've Seen")[0]
    assert repeated < clean


def test_vague_nouns_are_punished():
    assert score_title("The Craziest Pull Rate")[0] > score_title("The Craziest Thing")[0]


def test_overlong_titles_lose_points():
    assert score_title("x" * 120)[0] < score_title("A Clear Specific Title")[0]


def test_a_truncated_title_loses_to_its_clean_rewrite():
    """Regression: three variants tied at 64 and the ellipsis-truncated one
    won the tie purely on insertion order."""
    clean = score_title("Watch What Happened When I Take This Super Car")[0]
    cut = score_title("Watch what happened when I take this super car off\u2026")[0]
    assert cut < clean


def test_empty_title_scores_zero():
    assert score_title("")[0] == 0


def test_score_is_always_in_range():
    for text in ["", "a", "THE BEST!!!", "A perfectly reasonable title here",
                 "word " * 40]:
        assert 0 <= score_title(text)[0] <= 100


# ---------------------------- generation ----------------------------------- #

@pytest.mark.parametrize("text", [HELI, CARD, "That was absolutely insane.", ""])
def test_generated_titles_are_always_well_formed(text):
    for v in generate_titles(text, count=6):
        assert v.text.strip()
        assert len(v.text) <= MAX_TITLE + 1
        assert not has_adjacent_duplicate(v.text)
        assert not any(w.lower() in BANNED for w in v.text.split())
        assert v.reason


def test_variants_are_ranked_and_unique():
    variants = generate_titles(HELI, count=6)
    assert [v.score for v in variants] == sorted((v.score for v in variants), reverse=True)
    assert len({v.text.lower() for v in variants}) == len(variants)


def test_adjective_templates_skip_when_the_subject_is_the_adjective():
    """Regression: produced "The Most Insane Insane I've Seen"."""
    texts = [v.text for v in generate_titles("That was absolutely insane.", count=6)]
    assert not any("insane insane" in t.lower() for t in texts)
    assert not any(t.lower().endswith("the insane") for t in texts)


def test_a_clip_with_no_usable_speech_still_gets_a_title():
    variants = generate_titles("", count=3, gaming=True)
    assert variants and variants[0].text


def test_the_selected_title_is_kept_as_a_candidate():
    variants = generate_titles(HELI, existing="My own title", count=8)
    assert any(v.framework == "selected" for v in variants)


# --------------------------- thumbnail text -------------------------------- #

def test_thumbnail_text_is_short_and_upper_case():
    text = thumbnail_text(HELI)
    assert text == text.upper()
    assert 1 <= len(text.split()) <= 4
    assert len(text) <= 28


def test_thumbnail_text_never_opens_on_a_filler_word():
    """Regression: produced "THING NOBODY TELLS" -- the biggest word slot
    on the image spent on "THING"."""
    for text in (HELI, CARD, "Okay so here is the thing nobody tells you about collecting."):
        first = thumbnail_text(text).split()[0].lower()
        assert first not in {"the", "a", "is", "it", "thing", "things", "stuff"}


def test_thumbnail_text_falls_back_when_there_is_nothing_to_say():
    assert thumbnail_text("", gaming=True)
    assert thumbnail_text("", gaming=False)


def test_wrap_produces_at_most_two_balanced_lines():
    lines = wrap_thumbnail_text("ABSOLUTELY BRUTAL PULL RATE")
    assert 1 <= len(lines) <= 2
    assert " ".join(lines).split() == "ABSOLUTELY BRUTAL PULL RATE".split()


def test_short_text_stays_on_one_line():
    assert wrap_thumbnail_text("NO WAY") == ["NO WAY"]


# ---------------------------- packaging ------------------------------------ #

def test_every_platform_caption_is_within_its_limit():
    out = package("A reasonably long title about a helicopter", ["#a", "#b", "#c", "#d", "#e"])
    assert set(out) == set(PLATFORMS)
    for name, data in out.items():
        assert data["within_limit"], f"{name} overflowed"
        assert data["length"] <= data["limit"]


def test_a_very_long_title_is_trimmed_not_overflowed():
    for data in package("word " * 80, ["#tag"]).values():
        assert data["length"] <= data["limit"]


def test_youtube_gets_the_shorts_tag():
    assert "#Shorts" in package("Title", ["#a"])["youtube_shorts"]["hashtags"]


# ---------------------------- enrichment ----------------------------------- #

def test_enrichment_fills_every_field():
    pick = ClipPick(0, 20, title="He flew into the helicopter",
                    hashtags=["#gaming"], transcript=HELI)
    enrich_picks([pick], gaming=True, preset=get_preset("gaming"))
    assert pick.title_variants
    assert pick.thumbnail_text
    assert pick.platforms
    assert pick.title == pick.title_variants[0].text     # best was promoted


def test_keeping_the_original_title_still_lists_variants():
    pick = ClipPick(0, 20, title="My own title", transcript=HELI)
    enrich_picks([pick], gaming=False, promote_best=False)
    assert pick.title == "My own title"
    assert len(pick.title_variants) > 1
