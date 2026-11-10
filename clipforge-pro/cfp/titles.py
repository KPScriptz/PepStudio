"""Title, thumbnail-text and caption generation tuned for click-through.

Three jobs:

* **Generate** several candidate titles per clip, each built from a named
  high-CTR framework and filled with words the speaker actually said, so the
  title describes the clip instead of being generic bait.
* **Score** them with a transparent proxy for click-through. It is a
  heuristic, not a prediction: every component is listed in the output so you
  can disagree with it. The point is to rank candidates against each other,
  not to claim a real CTR number.
* **Package** the winner per platform, respecting each one's limits and
  conventions.

The scorer deliberately penalises the things that make a title *look*
clickbaity without being specific -- ALL CAPS, exclamation pile-ups, vague
nouns like "thing" and "stuff" -- because those correlate with the
impressions-without-watch-time pattern that short-form algorithms punish.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from .models import TitleVariant

log = logging.getLogger("cfp.titles")

MAX_TITLE = 70
IDEAL_MIN, IDEAL_MAX = 25, 55

# Words that carry no information and should never anchor a title.
STOPWORDS = {
    "a", "an", "the", "and", "or", "but", "if", "then", "than", "so", "because",
    "as", "at", "by", "for", "from", "in", "into", "of", "on", "onto", "to",
    "with", "up", "down", "out", "over", "under", "is", "are", "was", "were",
    "be", "been", "being", "am", "do", "does", "did", "have", "has", "had",
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us",
    "them", "my", "your", "his", "its", "our", "their", "this", "that",
    "these", "those", "there", "here", "what", "which", "who", "whom", "when",
    "where", "why", "how", "all", "any", "both", "each", "few", "more", "most",
    "some", "such", "no", "nor", "not", "only", "own", "same", "too", "very",
    "can", "will", "just", "should", "now", "okay", "ok", "like", "really",
    "gonna", "got", "get", "going", "yeah", "well", "right", "know", "think",
    "see", "look", "guys", "guy", "actually", "literally", "basically",
}

# Emotional / high-arousal vocabulary. Arousal is what drives a tap.
POWER_WORDS = {
    "insane", "crazy", "unreal", "brutal", "savage", "chaos", "disaster",
    "destroyed", "obliterated", "demolished", "terrifying", "terrified",
    "shocking", "shocked", "unbelievable", "ridiculous", "hilarious",
    "impossible", "perfect", "flawless", "legendary", "rare", "jackpot",
    "worst", "best", "greatest", "biggest", "massive", "huge", "tiny",
    "secret", "hidden", "banned", "illegal", "forbidden", "exposed",
    "mistake", "fail", "failed", "broke", "broken", "lost", "won", "rage",
    "panic", "scream", "screaming", "explosion", "exploded", "clutch",
    "comeback", "expensive", "worth", "fortune", "nightmare", "obsessed",
}

# POWER_WORDS that are adjectives, so they read correctly after "the most"
# or before a noun. "exploded" and "worth" are power words but produce
# "The Most Exploded Helicopter" and "The Most Worth Card" -- so templates
# that need an adjective draw from this subset only.
ADJECTIVE_POWER = {
    "insane", "crazy", "unreal", "brutal", "savage", "chaotic", "shocking",
    "unbelievable", "ridiculous", "hilarious", "impossible", "perfect",
    "flawless", "legendary", "rare", "expensive", "terrifying", "massive",
    "huge", "tiny", "painful", "awkward", "dangerous", "embarrassing",
    "worst", "best", "greatest", "biggest", "secret", "hidden", "illegal",
}

# Markers that open an information gap the viewer wants closed.
CURIOSITY = {
    "nobody", "never", "everyone", "actually", "really", "why", "how",
    "what", "secret", "hidden", "truth", "reason", "happens", "happened",
    "until", "before", "after", "almost", "finally", "turns",
}

# Nouns that say nothing. A title leaning on these is not specific.
VAGUE = {"thing", "things", "stuff", "something", "anything", "everything",
         "moment", "part", "bit", "way", "one"}

# Generic category words that describe the format, not the content.
BANNED = {
    "gaming", "gameplay", "lets", "play", "episode", "part", "stream",
    "video", "vlog", "clip", "footage", "montage", "compilation", "content",
}

# Words that end a noun phrase. Deliberately smaller than STOPWORDS:
# intensifiers and adjectives ("most", "single", "very") must stay INSIDE a
# phrase, or "the single most valuable card" collapses to "card".
DETERMINERS = {
    "the", "a", "an", "my", "your", "his", "her", "its", "our", "their",
    "this", "that", "these", "those", "another", "every", "each",
}
PREPOSITIONS = {
    "into", "onto", "with", "on", "in", "at", "to", "from", "of", "for",
    "about", "over", "under", "through", "across", "behind", "against",
    "inside", "near", "toward", "towards", "off", "out",
}
PHRASE_STOP = DETERMINERS | PREPOSITIONS | {
    "and", "or", "but", "so", "because", "if", "then", "than", "as", "while",
    "when", "where", "who", "which", "what", "i", "you", "he", "she", "it",
    "we", "they", "me", "him", "us", "them", "is", "are", "was", "were", "be",
    "been", "being", "am", "do", "does", "did", "have", "has", "had", "will",
    "would", "can", "could", "should", "just", "not", "there", "here",
}

# A noun phrase should not END on one of these.
VERBISH = {
    "flew", "went", "got", "made", "said", "came", "took", "gave", "saw",
    "ran", "hit", "threw", "put", "look", "looked", "watch", "watched",
    "think", "thought", "know", "knew", "believe", "believed", "happen",
    "happened", "work", "worked", "try", "tried", "tell", "told", "straight",
    "back", "down", "away", "again", "now", "really", "actually",
}

SMALL_WORDS = {
    "a", "an", "the", "and", "or", "but", "for", "nor", "on", "at", "to",
    "from", "by", "of", "in", "with", "as", "is", "it",
}

PLATFORMS = {
    "youtube_shorts": {"limit": 100, "tags": 3, "suffix": "#Shorts"},
    "tiktok": {"limit": 150, "tags": 5, "suffix": ""},
    "instagram_reels": {"limit": 125, "tags": 5, "suffix": ""},
    "x": {"limit": 240, "tags": 2, "suffix": ""},
}


# --------------------------------------------------------------------------- #
# Text mining
# --------------------------------------------------------------------------- #


def tokens(text: str) -> list[str]:
    return re.findall(r"[A-Za-z']+", text or "")


def sentences(text: str) -> list[str]:
    clean = re.sub(r"\s+", " ", text or "").strip()
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", clean) if s.strip()]


def title_case(text: str) -> str:
    """Capitalise like a headline: small words stay lowercase inside."""
    words = text.split()
    out: list[str] = []
    for i, word in enumerate(words):
        low = word.lower()
        if i != 0 and i != len(words) - 1 and low in SMALL_WORDS:
            out.append(low)
        elif word.isupper() and len(word) > 1:
            out.append(word)                        # keep deliberate acronyms
        else:
            out.append(low[:1].upper() + low[1:])
    return " ".join(out)


def content_words(text: str) -> list[str]:
    return [t for t in tokens(text) if t.lower() not in STOPWORDS and len(t) > 2]


def plausible_noun(phrase: str) -> bool:
    """Does this phrase contain something that can act as a noun?

    "insane" is a power word, not a subject. Without this check the
    adjective templates produce "The Most Insane Insane I've Seen" and the
    preposition templates produce "Nobody Expected This From The Insane".
    """
    for word in tokens(phrase):
        low = word.lower()
        if low in POWER_WORDS or low in CURIOSITY or low in VAGUE:
            continue
        if low in STOPWORDS or low in BANNED or _verbish(low):
            continue
        if low.endswith("ly") or len(low) < 3:
            continue
        return True
    return False


def has_adjacent_duplicate(text: str) -> bool:
    words = [w.lower() for w in tokens(text)]
    return any(a == b for a, b in zip(words, words[1:]))


def _verbish(word: str) -> bool:
    low = word.lower()
    return low in VERBISH or (low.endswith("ly") and len(low) > 4)


def noun_phrases(text: str, *, max_words: int = 4) -> list[tuple[str, str]]:
    """Approximate noun phrases as (bare, with_determiner).

    No POS tagger (and no heavyweight dependency to get one). Instead we use
    the strongest positional cue English offers: a determiner or preposition
    is almost always followed by a noun phrase. "flew straight into the
    helicopter" yields "the helicopter", not "flew straight" -- which is the
    bug this replaced, and which produced titles like "Never Do This With
    Flew Straight".
    """
    words = tokens(text)
    found: list[tuple[str, str]] = []

    for i, word in enumerate(words):
        low = word.lower()
        if low not in DETERMINERS and low not in PREPOSITIONS:
            continue
        j = i + 1
        determiner = ""
        if j < len(words) and words[j].lower() in DETERMINERS:
            determiner = words[j]
            j += 1
        elif low in DETERMINERS:
            determiner = word

        phrase: list[str] = []
        while j < len(words) and len(phrase) < max_words:
            candidate = words[j]
            if candidate.lower() in PHRASE_STOP or candidate.lower() in BANNED:
                break
            phrase.append(candidate)
            j += 1

        while phrase and _verbish(phrase[-1]):
            phrase.pop()
        if not phrase:
            continue

        bare = " ".join(phrase)
        with_det = f"{determiner} {bare}".strip() if determiner else f"the {bare}"
        found.append((bare, with_det))
    return found


def key_phrase(text: str, *, max_words: int = 4) -> str:
    """The clip's subject, without a leading determiner."""
    bare, _ = key_phrase_pair(text, max_words=max_words)
    return bare


def key_phrase_pair(text: str, *, max_words: int = 4) -> tuple[str, str]:
    """(bare, with_determiner) for the most informative noun phrase."""
    candidates = noun_phrases(text, max_words=max_words)
    if not candidates:
        # Nothing determiner-anchored: fall back to the longest informative run.
        run: list[str] = []
        best: list[str] = []
        for word in tokens(text):
            if word.lower() in PHRASE_STOP or word.lower() in BANNED or _verbish(word):
                if len(run) > len(best):
                    best = run
                run = []
            else:
                run.append(word)
        if len(run) > len(best):
            best = run
        bare = " ".join(best[:max_words])
        return bare, (f"the {bare}" if bare else "")

    total = max(1, len(candidates))

    def rank(item: tuple[int, tuple[str, str]]) -> float:
        idx, (bare, _) = item
        words = bare.split()
        score = float(len(words))
        score += 0.4 * (idx / total)                 # objects beat subjects
        score += 1.0 if any(w.lower() in POWER_WORDS for w in words) else 0.0
        score -= 1.5 if any(w.lower() in VAGUE for w in words) else 0.0
        return score

    best_idx = max(enumerate(candidates), key=rank)[0]
    return candidates[best_idx]


def punchiest_sentence(text: str) -> str:
    """The sentence carrying the most emotional weight."""
    best, best_score = "", -1.0
    for sentence in sentences(text):
        words = [w.lower() for w in tokens(sentence)]
        if len(words) < 3:
            continue
        score = (
            sum(2.0 for w in words if w in POWER_WORDS)
            + sum(1.0 for w in words if w in CURIOSITY)
            - sum(1.5 for w in words if w in VAGUE)
        )
        if score > best_score:
            best, best_score = sentence, score
    return best or (sentences(text)[0] if sentences(text) else "")


def find_number(text: str) -> str:
    match = re.search(r"\b(\d[\d,]*(?:\.\d+)?)\b", text or "")
    return match.group(1) if match else ""


def trim(text: str, limit: int = MAX_TITLE) -> str:
    text = re.sub(r"\s+", " ", text).strip(" .,-")
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0]
    return (cut or text[: limit - 1]).rstrip(" ,.-") + "…"


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #


def score_title(text: str) -> tuple[int, dict]:
    """A 0-100 click-through proxy. Every component is reported."""
    raw = (text or "").strip()
    if not raw:
        return 0, {"empty": True}

    words = tokens(raw)
    lower = [w.lower() for w in words]
    length = len(raw)
    parts: dict[str, float] = {}

    # Length: short enough to read in a thumbnail glance, long enough to say
    # something. Falls off either side of the band rather than cliff-edging.
    if IDEAL_MIN <= length <= IDEAL_MAX:
        parts["length"] = 22.0
    elif length < IDEAL_MIN:
        parts["length"] = 22.0 * max(0.0, length / IDEAL_MIN) * 0.75
    else:
        over = (length - IDEAL_MAX) / max(1, MAX_TITLE - IDEAL_MAX)
        parts["length"] = 22.0 * max(0.15, 1.0 - over)

    power = sum(1 for w in lower if w in POWER_WORDS)
    parts["emotion"] = min(22.0, 11.0 * power)

    curious = sum(1 for w in lower if w in CURIOSITY)
    parts["curiosity"] = min(18.0, 9.0 * curious)

    # Specificity. NOT measured from capitalisation: titles are Title Cased,
    # so every word looks like a proper noun and the signal is meaningless.
    # Informative word count is casing-independent.
    specific = 0.0
    if find_number(raw):
        specific += 9.0
    informative = {w.lower() for w in words if w.lower() not in STOPWORDS and len(w) > 3}
    specific += min(8.0, 2.7 * len(informative))
    parts["specificity"] = min(17.0, specific)

    # Front-loading: the strongest word should arrive early.
    head = lower[:3]
    parts["front_loaded"] = 8.0 if any(
        w in POWER_WORDS or w in CURIOSITY for w in head
    ) else 0.0

    parts["concrete"] = 8.0 if len(content_words(raw)) >= 3 else 0.0

    # --- penalties ---------------------------------------------------------
    parts["vague_penalty"] = -7.0 * sum(1 for w in lower if w in VAGUE)
    parts["generic_penalty"] = -12.0 * sum(1 for w in lower if w in BANNED)

    shouty = sum(1 for w in words if len(w) > 2 and w.isupper())
    parts["caps_penalty"] = -6.0 * max(0, shouty - 1)

    bangs = raw.count("!") + raw.count("?")
    parts["punctuation_penalty"] = -5.0 * max(0, bangs - 1)

    content = [w for w in lower if w not in STOPWORDS and len(w) > 2]
    repeats = len(content) - len(set(content))
    parts["repetition_penalty"] = -9.0 * repeats
    if has_adjacent_duplicate(raw):
        parts["repetition_penalty"] -= 12.0

    if length > MAX_TITLE:
        parts["overflow_penalty"] = -15.0

    # A title cut off mid-phrase reads as sloppy in a feed. This mostly
    # matters as a tie-break: the clean rewrite of a quote and its truncated
    # original otherwise score identically, and the truncated one won.
    if raw.endswith("\u2026"):
        parts["truncated_penalty"] = -5.0

    total = int(round(max(0.0, min(100.0, sum(parts.values())))))
    return total, {k: round(v, 2) for k, v in parts.items()}


def explain_score(components: dict) -> str:
    """Plain-language account of why a title scored what it did."""
    good = [
        ("emotion", "high-arousal wording"),
        ("curiosity", "opens a curiosity gap"),
        ("specificity", "concrete and specific"),
        ("front_loaded", "strong opening words"),
    ]
    bad = [
        ("vague_penalty", "vague nouns"),
        ("generic_penalty", "generic category words"),
        ("caps_penalty", "shouty capitals"),
        ("punctuation_penalty", "punctuation pile-up"),
        ("overflow_penalty", "too long"),
    ]
    wins = [label for key, label in good if components.get(key, 0) > 0]
    losses = [label for key, label in bad if components.get(key, 0) < 0]
    bits = []
    if wins:
        bits.append(", ".join(wins))
    if losses:
        bits.append("held back by " + ", ".join(losses))
    return ("; ".join(bits) or "neutral wording").capitalize() + "."


# --------------------------------------------------------------------------- #
# Frameworks
# --------------------------------------------------------------------------- #
#
# Each returns a title or "" when the clip gives it nothing to work with.
# They embed the speaker's own words so the title stays truthful to the clip.


def _fw_direct_quote(ctx: dict) -> str:
    line = ctx["punch"]
    if len(tokens(line)) < 3:
        return ""
    return trim(f"“{line.rstrip('.!?')}”")


def _fw_quote_fragment(ctx: dict) -> str:
    """The speaker's own clause -- usually the most truthful title there is."""
    words = tokens(ctx["punch"])
    if len(words) < 4:
        return ""
    keep = words[:9]
    while keep and keep[-1].lower() in PHRASE_STOP:
        keep.pop()
    if len(keep) < 4:
        return ""
    return trim(title_case(" ".join(keep)))


def _fw_curiosity_gap(ctx: dict) -> str:
    if not ctx["subject_det"]:
        return ""
    return trim(title_case(f"What Happened With {ctx['subject_det']}"))


def _fw_contradiction(ctx: dict) -> str:
    if not ctx["subject_det"]:
        return ""
    return trim(title_case(f"Nobody Expected This From {ctx['subject_det']}"))


def _fw_stakes(ctx: dict) -> str:
    if ctx["number"]:
        return trim(title_case(f"This Cost Me {ctx['number']}"))
    adjective, subject = ctx["adjective"], ctx["subject"]
    if adjective and subject:
        if adjective.lower() in {w.lower() for w in tokens(subject)}:
            return ""
        return trim(title_case(f"The {adjective.title()} {subject} Moment"))
    return ""


def _fw_negative_warning(ctx: dict) -> str:
    if not ctx["subject_det"]:
        return ""
    return trim(title_case(f"Never Do This With {ctx['subject_det']}"))


def _fw_superlative(ctx: dict) -> str:
    adjective, subject = ctx["adjective"], ctx["subject"]
    if not (adjective and subject):
        return ""
    if adjective.lower() in {w.lower() for w in tokens(subject)}:
        return ""
    return trim(title_case(f"The Most {adjective.title()} {subject} I've Seen"))


def _fw_second_person(ctx: dict) -> str:
    """Only fits an activity, so it is gated on a gerund subject."""
    subject = ctx["subject"]
    if not subject or not subject.split()[-1].lower().endswith("ing"):
        return ""
    return trim(title_case(f"You're Doing {subject} Wrong"))


def _fw_number_specific(ctx: dict) -> str:
    if not ctx["number"] or not ctx["subject_det"]:
        return ""
    return trim(title_case(f"{ctx['number']} Seconds Of {ctx['subject_det']}"))


FRAMEWORKS: tuple[tuple[str, object], ...] = (
    ("direct_quote", _fw_direct_quote),
    ("quote_fragment", _fw_quote_fragment),
    ("curiosity_gap", _fw_curiosity_gap),
    ("contradiction", _fw_contradiction),
    ("stakes", _fw_stakes),
    ("superlative", _fw_superlative),
    ("negative_warning", _fw_negative_warning),
    ("second_person", _fw_second_person),
    ("number_specific", _fw_number_specific),
)


def _context(transcript: str) -> dict:
    punch = punchiest_sentence(transcript)
    lower = [w.lower() for w in tokens(transcript)]
    power = next((w for w in lower if w in POWER_WORDS), "")
    adjective = next((w for w in lower if w in ADJECTIVE_POWER), "")
    bare, with_det = key_phrase_pair(punch or transcript)
    if not plausible_noun(bare):
        bare, with_det = "", ""
    return {
        "punch": punch,
        "subject": bare,
        "subject_det": with_det,
        "number": find_number(transcript),
        "power": power,
        "adjective": adjective,
    }


def generate_titles(
    transcript: str,
    *,
    existing: str = "",
    count: int = 5,
    gaming: bool = False,
) -> list[TitleVariant]:
    """Build and rank candidate titles for one clip."""
    ctx = _context(transcript)
    seen: set[str] = set()
    variants: list[TitleVariant] = []

    def add(text: str, framework: str) -> None:
        text = (text or "").strip()
        if not text:
            return
        if has_adjacent_duplicate(text):
            return                              # "The Most Insane Insane ..."
        key = re.sub(r"[^a-z0-9]", "", text.lower())
        if not key or key in seen:
            return
        seen.add(key)
        score, components = score_title(text)
        variants.append(
            TitleVariant(
                text=text, framework=framework, score=score,
                reason=explain_score(components),
            )
        )

    if existing:
        add(trim(existing), "selected")
    for name, build in FRAMEWORKS:
        add(build(ctx), name)
    if not variants:
        add("Chaotic Moment" if gaming else "Highlight", "fallback")

    variants.sort(key=lambda v: -v.score)
    return variants[:max(1, count)]


# --------------------------------------------------------------------------- #
# Thumbnail text
# --------------------------------------------------------------------------- #


def thumbnail_text(transcript: str, *, title: str = "", gaming: bool = False) -> str:
    """Two to four words, big enough to read at phone size.

    A thumbnail is seen for well under a second, so this is deliberately
    shorter than the title: it is a shout, not a sentence.
    """
    punch = punchiest_sentence(transcript)
    pool = [w for w in tokens(punch) if w.lower() not in BANNED]

    pool = [w for w in pool if w.lower() not in VAGUE]
    strong = [w for w in pool if w.lower() in POWER_WORDS or w.lower() in CURIOSITY]
    if strong:
        anchor = pool.index(strong[0])
        chosen = pool[max(0, anchor - 1): anchor + 2]
    else:
        chosen = [w for w in pool if w.lower() not in STOPWORDS][:3]

    if not chosen and title:
        chosen = [w for w in tokens(title) if w.lower() not in STOPWORDS][:3]

    # A thumbnail opening on "is", "the" or "thing" wastes its biggest slot.
    weak = PHRASE_STOP | VAGUE
    while chosen and chosen[0].lower() in weak:
        chosen.pop(0)
    while chosen and chosen[-1].lower() in weak:
        chosen.pop()
    if not chosen:
        return "NO WAY" if gaming else "WATCH THIS"

    text = " ".join(chosen[:4]).upper()
    return text[:28].rstrip()


def wrap_thumbnail_text(text: str, *, max_chars: int = 13) -> list[str]:
    """Split into at most two balanced lines."""
    words = text.split()
    if not words:
        return []
    if len(text) <= max_chars:
        return [text]

    best, best_cost = None, None
    for split in range(1, len(words)):
        a = " ".join(words[:split])
        b = " ".join(words[split:])
        cost = abs(len(a) - len(b)) + 2 * max(0, max(len(a), len(b)) - max_chars)
        if best_cost is None or cost < best_cost:
            best, best_cost = (a, b), cost
    return list(best) if best else [text]


# --------------------------------------------------------------------------- #
# Platform packaging
# --------------------------------------------------------------------------- #


def enrich_picks(picks, *, gaming: bool, preset=None, count: int = 5,
                 promote_best: bool = True) -> None:
    """Fill in title variants, thumbnail text and per-platform captions.

    With ``promote_best`` the highest-scoring variant becomes the clip's
    title. The ranked list is always kept, so nothing is lost -- the review
    page lets you take any of them.
    """
    for pick in picks:
        variants = generate_titles(
            pick.transcript, existing=pick.title, count=count, gaming=gaming
        )
        pick.title_variants = variants
        if promote_best and variants:
            pick.title = variants[0].text
        if not pick.thumbnail_text:
            pick.thumbnail_text = thumbnail_text(
                pick.transcript, title=pick.title, gaming=gaming
            )
        pick.platforms = package(pick.title, pick.hashtags)


def package(title: str, hashtags: list[str]) -> dict:
    """Per-platform caption text, trimmed to each platform's limit."""
    out: dict[str, dict] = {}
    for name, rules in PLATFORMS.items():
        limit = int(rules["limit"])
        tags = [t for t in hashtags if t.startswith("#")][: int(rules["tags"])]
        suffix = str(rules["suffix"])
        if suffix and suffix not in tags:
            tags = tags + [suffix]

        tail = (" " + " ".join(tags)).rstrip()
        headroom = max(10, limit - len(tail))
        body = title if len(title) <= headroom else trim(title, headroom)
        text = (body + tail).strip()
        out[name] = {
            "text": text,
            "hashtags": tags,
            "length": len(text),
            "limit": limit,
            "within_limit": len(text) <= limit,
        }
    return out
