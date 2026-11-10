"""Stage 4 - choose which moments become clips.

Two independent pickers, same output shape:

* :func:`pick_with_claude` sends a compact timestamped transcript plus the
  signal peaks to the Claude API and asks for structured JSON.
* :func:`pick_heuristic` needs no API key at all and is what runs when one is
  missing, when the call fails, or when ``--no-api`` is passed. On gameplay
  footage it ranks purely on audio/visual chaos, so a video with no speech
  still produces sensible clips.

Both results go through the same validation: clamped to the source, snapped
to sentence (or scene-cut) boundaries, held inside the duration window, and
de-overlapped.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass

from . import titles as titles_mod
from .config import Preset
from .models import ClipPick, Peak, Transcript, Word
from .signals import COMEDIC_TAIL_MS, Signals

log = logging.getLogger("cfp.select")

SENTENCE_GAP = 0.62          # a pause this long also ends a "sentence"
TERMINAL = re.compile(r"[.!?]+[\"')\]]*$")

# Words that correlate with retention in comedy/gaming/reaction content.
TRIGGERS = {
    "insane", "crazy", "unreal", "nuts", "wild", "chaos", "chaotic",
    "scream", "screaming", "screamed", "panic", "terrified", "scared",
    "died", "death", "killed", "destroyed", "obliterated", "demolished",
    "explosion", "exploded", "crash", "crashed", "flipped", "launched",
    "clutch", "comeback", "impossible", "perfect", "flawless",
    "fail", "failed", "disaster", "worst", "best", "greatest",
    "secret", "hidden", "nobody", "never", "always", "actually",
    "literally", "genuinely", "honestly", "swear",
    "wait", "watch", "look", "listen", "stop",
    "money", "expensive", "worth", "rare", "legendary", "jackpot",
    "unbelievable", "ridiculous", "hilarious", "funniest", "lost",
    "won", "win", "rage", "angry", "furious",
}

# Intro/outro filler. Clips that open on this underperform.
FILLER_PHRASES = (
    "okay guys", "ok guys", "hey guys", "what's up guys", "whats up guys",
    "so basically", "welcome back", "welcome to", "in this video",
    "don't forget to", "dont forget to", "like and subscribe",
    "smash that like", "hit the bell", "before we start", "before we begin",
    "today we're going to", "today we are going to", "quick reminder",
)

# Words a title must not lean on -- they say nothing about the clip.
BANNED_TITLE_WORDS = {
    "gaming", "gameplay", "lets", "play", "episode", "part", "stream",
    "video", "vlog", "clip", "footage", "montage",
}

DEFAULT_API_MODEL = "claude-opus-5-5"
FALLBACK_API_MODEL = "claude-sonnet-5-5"


# --------------------------------------------------------------------------- #
# Sentence segmentation
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Sentence:
    start: float
    end: float
    text: str

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


def build_sentences(transcript: Transcript) -> list[Sentence]:
    """Group words into sentences on punctuation or a long pause."""
    out: list[Sentence] = []
    bucket: list[Word] = []

    def flush() -> None:
        if not bucket:
            return
        text = " ".join(w.text for w in bucket).strip()
        if text:
            out.append(Sentence(bucket[0].start, bucket[-1].end, text))
        bucket.clear()

    for idx, word in enumerate(transcript.words):
        if bucket and (word.start - bucket[-1].end) >= SENTENCE_GAP:
            flush()
        bucket.append(word)
        if TERMINAL.search(word.text):
            flush()
            continue
        # Guard against a run-on with no punctuation at all.
        if len(bucket) >= 42:
            flush()
    flush()

    if not out and transcript.segments:
        out = [Sentence(s.start, s.end, s.text) for s in transcript.segments]
    return out


# --------------------------------------------------------------------------- #
# Boundary snapping
# --------------------------------------------------------------------------- #


def snap_to_sentences(
    start: float,
    end: float,
    sentences: list[Sentence],
    *,
    min_dur: float,
    max_dur: float,
    duration: float,
) -> tuple[float, float]:
    """Move ``start``/``end`` onto sentence boundaries, honouring the window.

    Returns the original (clamped) range unchanged when there is no speech to
    snap to -- gameplay footage must not be forced onto nonexistent sentences.
    """
    start = max(0.0, min(start, max(0.0, duration)))
    end = max(start, min(end, max(0.0, duration)))

    if not sentences:
        return _enforce_window(start, end, min_dur, max_dur, duration)

    # Begin at the sentence that best matches the requested start: the last
    # one starting at or before it, else the first one after.
    begin_idx = 0
    for i, s in enumerate(sentences):
        if s.start <= start + 0.35:
            begin_idx = i
        else:
            break
    if sentences[begin_idx].end <= start and begin_idx + 1 < len(sentences):
        begin_idx += 1

    new_start = sentences[begin_idx].start
    new_end = sentences[begin_idx].end
    last = begin_idx

    # Grow one whole sentence at a time while that keeps us under max_dur.
    for j in range(begin_idx + 1, len(sentences)):
        candidate = sentences[j].end
        if candidate - new_start > max_dur:
            break
        # Stop once we have covered the request and satisfied the minimum.
        if candidate - new_start > (end - new_start) and (new_end - new_start) >= min_dur:
            break
        new_end = candidate
        last = j

    # Still short? keep adding sentences purely to reach min_dur.
    j = last + 1
    while (new_end - new_start) < min_dur and j < len(sentences):
        if sentences[j].end - new_start > max_dur:
            break
        new_end = sentences[j].end
        j += 1

    return _enforce_window(new_start, new_end, min_dur, max_dur, duration)


def snap_to_cuts(
    start: float,
    end: float,
    cuts: list[float],
    *,
    min_dur: float,
    max_dur: float,
    duration: float,
    tolerance: float = 2.5,
) -> tuple[float, float]:
    """Align to nearby scene cuts -- the boundary snapping for gameplay."""
    start = max(0.0, min(start, duration))
    end = max(start, min(end, duration))

    before = [c for c in cuts if abs(c - start) <= tolerance]
    if before:
        start = min(before, key=lambda c: abs(c - start))
    after = [c for c in cuts if abs(c - end) <= tolerance and c > start + min_dur * 0.5]
    if after:
        end = min(after, key=lambda c: abs(c - end))
    return _enforce_window(start, end, min_dur, max_dur, duration)


def _enforce_window(
    start: float, end: float, min_dur: float, max_dur: float, duration: float
) -> tuple[float, float]:
    """Clamp into [min_dur, max_dur] without ever leaving the source."""
    duration = max(0.0, duration)
    start = max(0.0, min(start, duration))
    end = max(start, min(end, duration))

    if end - start > max_dur:
        end = start + max_dur
    if end - start < min_dur:
        end = min(duration, start + min_dur)
        if end - start < min_dur:                 # ran out of tape: back up
            start = max(0.0, end - min_dur)
    return round(start, 3), round(end, 3)


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def count_triggers(text: str) -> int:
    tokens = re.findall(r"[a-z']+", text.lower())
    return sum(1 for t in tokens if t in TRIGGERS)


def count_filler(text: str) -> int:
    low = " " + re.sub(r"\s+", " ", text.lower()) + " "
    return sum(1 for phrase in FILLER_PHRASES if phrase in low)


def score_window(
    start: float,
    end: float,
    sig: Signals,
    transcript: Transcript | None,
    *,
    gaming: bool,
) -> tuple[float, dict]:
    """Score a candidate window. Returns (0-100 score, component breakdown)."""
    span = max(1e-6, end - start)
    peak_z, mean_z = sig.loudness_stats(start, end)
    n_peaks = len(sig.peaks_between(start, end))
    n_cuts = len(sig.cuts_between(start, end))

    text = transcript.text_between(start, end) if transcript else ""
    words = len(text.split())
    wps = words / span
    triggers = min(3, count_triggers(text))
    filler = count_filler(text)

    if gaming:
        parts = {
            "audio_peak": 40.0 * _clamp01(peak_z / 4.0),
            "audio_density": 20.0 * _clamp01(n_peaks / 4.0),
            "visual_variety": 22.0 * _clamp01(n_cuts / 5.0),
            "audio_energy": 12.0 * _clamp01((mean_z + 1.0) / 3.0),
            "speech": 6.0 * _clamp01(wps / 2.0),
        }
    else:
        parts = {
            "audio_peak": 16.0 * _clamp01(peak_z / 4.0),
            "audio_density": 7.0 * _clamp01(n_peaks / 3.0),
            "visual_variety": 10.0 * _clamp01(n_cuts / 4.0),
            "speech": 30.0 * _clamp01(wps / 3.0),
            "triggers": 9.0 * triggers,
        }

    parts["filler_penalty"] = -9.0 * filler
    # Channel intros are reliably the weakest 10 seconds of any video.
    parts["intro_penalty"] = -8.0 if start < 10.0 else 0.0

    total = max(0.0, min(100.0, sum(parts.values())))
    parts["words"] = words
    parts["peak_z"] = round(peak_z, 2)
    parts["cuts"] = n_cuts
    return total, parts


# --------------------------------------------------------------------------- #
# Heuristic picker
# --------------------------------------------------------------------------- #


def _candidate_windows(
    sig: Signals, *, min_dur: float, max_dur: float, duration: float
) -> list[tuple[float, float]]:
    """Windows anchored on peaks, plus a coarse grid so nothing is missed."""
    lengths = sorted({min_dur, min_dur + (max_dur - min_dur) / 2.0, max_dur})
    out: list[tuple[float, float]] = []

    for peak in sig.peaks:
        for length in lengths:
            # Start before the peak and sustain past it, so the gag lands.
            s = peak.time - length * 0.35
            e = s + length
            tail = peak.time + COMEDIC_TAIL_MS / 1000.0
            if e < tail:
                e = min(duration, tail)
            out.append(_enforce_window(s, e, min_dur, max_dur, duration))

    step = max(1.0, duration / 400.0)
    t = 0.0
    while t < duration:
        for length in lengths:
            out.append(_enforce_window(t, t + length, min_dur, max_dur, duration))
        t += step

    return sorted(set(out))


def pick_heuristic(
    transcript: Transcript | None,
    sig: Signals,
    *,
    count: int,
    min_dur: float,
    max_dur: float,
    duration: float,
    gaming: bool,
    preset: Preset | None = None,
) -> list[ClipPick]:
    """Rank candidate windows with no language model involved."""
    sentences = build_sentences(transcript) if transcript else []
    scored: list[tuple[float, float, float, dict]] = []

    for start, end in _candidate_windows(
        sig, min_dur=min_dur, max_dur=max_dur, duration=duration
    ):
        total, parts = score_window(start, end, sig, transcript, gaming=gaming)
        scored.append((total, start, end, parts))

    scored.sort(key=lambda row: (-row[0], row[1]))

    picks: list[ClipPick] = []
    for total, start, end, parts in scored:
        if len(picks) >= count:
            break
        if gaming or not sentences:
            s, e = snap_to_cuts(
                start, end, sig.scene_cuts,
                min_dur=min_dur, max_dur=max_dur, duration=duration,
            )
        else:
            s, e = snap_to_sentences(
                start, end, sentences,
                min_dur=min_dur, max_dur=max_dur, duration=duration,
            )

        candidate = ClipPick(start=s, end=e)
        if any(candidate.overlaps(p, tolerance=0.75) for p in picks):
            continue

        text = transcript.text_between(s, e) if transcript else ""
        # Re-score the snapped range: the boundaries moved.
        final, final_parts = score_window(s, e, sig, transcript, gaming=gaming)
        candidate.score = int(round(final))
        candidate.transcript = text
        candidate.title = synthesize_title(text, final_parts, gaming=gaming)
        candidate.hook = synthesize_hook(text, gaming=gaming)
        candidate.reason = explain(final_parts, gaming=gaming)
        candidate.hashtags = synthesize_hashtags(text, preset, gaming=gaming)
        candidate.picked_by = "heuristic"
        picks.append(candidate)

    picks.sort(key=lambda p: -p.score)
    for i, pick in enumerate(picks, 1):
        pick.index = i
    return picks


def explain(parts: dict, *, gaming: bool) -> str:
    """Human-readable 'why this clip', which Opus Clip does not give you."""
    bits: list[str] = []
    if parts.get("peak_z", 0) >= 2.5:
        bits.append(f"loudness spike {parts['peak_z']:.1f}z above local baseline")
    if parts.get("cuts", 0) >= 2:
        bits.append(f"{int(parts['cuts'])} scene changes (high visual variety)")
    if parts.get("words", 0) and not gaming:
        bits.append(f"{int(parts['words'])} words of speech")
    if parts.get("triggers", 0):
        hits = int(parts["triggers"] / 9.0) or 1
        bits.append(f"{hits} retention trigger word(s)")
    if parts.get("filler_penalty", 0) < 0:
        bits.append("penalised for intro filler")
    if parts.get("intro_penalty", 0) < 0:
        bits.append("penalised for sitting in the channel intro")
    if not bits:
        bits.append("best available window on combined audio/visual signal")
    lead = "Gaming-mode ranking: " if gaming else "Ranked on: "
    return lead + "; ".join(bits) + "."


def synthesize_title(text: str, parts: dict, *, gaming: bool) -> str:
    """A short, concrete title -- no generic filler words."""
    cleaned = re.sub(r"\s+", " ", text).strip()
    if not cleaned:
        return "Chaotic moment" if gaming else "Highlight"

    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", cleaned) if s.strip()]
    best = ""
    best_hits = -1
    for s in sentences:
        hits = count_triggers(s) - count_filler(s) * 2
        if hits > best_hits and len(s.split()) >= 3:
            best, best_hits = s, hits
    best = best or sentences[0]

    words = [w for w in re.findall(r"[\w']+", best) if w.lower() not in BANNED_TITLE_WORDS]
    title = " ".join(words)
    if len(title) > 55:
        title = title[:54].rsplit(" ", 1)[0] + "…"
    return title[:1].upper() + title[1:] if title else "Highlight"


def synthesize_hook(text: str, *, gaming: bool) -> str:
    """Three-second opening overlay."""
    if gaming and not text.strip():
        return "WATCH THIS"
    first = re.split(r"(?<=[.!?])\s+", re.sub(r"\s+", " ", text).strip())
    opener = (first[0] if first else "").strip()
    words = opener.split()
    if not words:
        return "WATCH THIS"
    return " ".join(words[:6]).upper().rstrip(".,!?")


def synthesize_hashtags(
    text: str, preset: Preset | None, *, gaming: bool
) -> list[str]:
    tags: list[str] = []
    if preset is not None:
        tags.extend(preset.forced_hashtags)

    base = ["#shorts", "#viral", "#fyp"]
    if gaming:
        base = ["#gaming", "#gamingclips", "#shorts", "#fyp"]

    hits = [t for t in re.findall(r"[a-z']+", text.lower()) if t in TRIGGERS]
    for hit in hits[:2]:
        base.append("#" + re.sub(r"[^a-z]", "", hit))

    for tag in base:
        if tag not in tags:
            tags.append(tag)
    return tags[:8]


# --------------------------------------------------------------------------- #
# Claude picker
# --------------------------------------------------------------------------- #


def _timestamp(seconds: float) -> str:
    m, s = divmod(max(0.0, seconds), 60.0)
    return f"{int(m):02d}:{s:05.2f}"


def build_transcript_block(sentences: list[Sentence], budget: int = 45000) -> str:
    """Timestamped transcript, trimmed to a character budget."""
    lines = [f"[{_timestamp(s.start)} -> {_timestamp(s.end)}] {s.text}" for s in sentences]
    block = "\n".join(lines)
    if len(block) <= budget:
        return block
    # Keep whole lines from the front; the caller chunks long sources.
    kept: list[str] = []
    used = 0
    for line in lines:
        if used + len(line) + 1 > budget:
            break
        kept.append(line)
        used += len(line) + 1
    return "\n".join(kept)


def build_signal_block(sig: Signals, limit: int = 60) -> str:
    rows = [
        f"- {_timestamp(p.time)} loudness spike, {p.score:.1f}z above local baseline"
        for p in sig.peaks[:limit]
    ]
    cuts = sig.scene_cuts[:limit]
    if cuts:
        rows.append("- scene cuts at: " + ", ".join(_timestamp(c) for c in cuts))
    return "\n".join(rows) or "- no notable audio or visual peaks detected"


SYSTEM_PROMPT = """\
You are a short-form video editor who picks viral clips from long footage.

You will receive a timestamped transcript and a list of detected audio/visual
peaks. Choose the strongest self-contained moments.

Rules:
- Every clip must be between {min_dur:.0f} and {max_dur:.0f} seconds long.
- Clips must not overlap each other.
- Start on a complete thought, not mid-sentence. End on a punchline or a
  resolution, never mid-word.
- Avoid channel intros, sponsor reads, and "don't forget to subscribe".
- A loud audio spike usually marks a reaction, a gag, or an impact. Those make
  strong clips even when the words around them are sparse.
- virality_score is 0-100. Be discriminating: reserve 85+ for genuinely
  exceptional moments and use the whole range.
- title: under 55 characters, concrete and specific. Never use the words
  gaming, gameplay, episode, part, stream, or video.
- hook: 3-6 words of on-screen text for the first 3 seconds.
- reason: one sentence on why THIS moment will retain a viewer.
- hashtags: 3-6 relevant tags, each starting with '#'.
- thumbnail_text: 2-4 words, upper case, for the thumbnail. A shout, not a
  sentence -- it is read in under a second at phone size.
- alt_titles: 2-3 genuinely different alternative titles for the same clip,
  each using a different angle (a quote, a stake, a curiosity gap). Do not
  restate the main title with synonyms.
"""


def _plan_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "clips": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "start_seconds": {"type": "number"},
                        "end_seconds": {"type": "number"},
                        "title": {"type": "string"},
                        "hook": {"type": "string"},
                        "virality_score": {"type": "integer"},
                        "reason": {"type": "string"},
                        "hashtags": {"type": "array", "items": {"type": "string"}},
                        "thumbnail_text": {"type": "string"},
                        "alt_titles": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": [
                        "start_seconds", "end_seconds", "title", "hook",
                        "virality_score", "reason", "hashtags",
                        "thumbnail_text", "alt_titles",
                    ],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["clips"],
        "additionalProperties": False,
    }


class ClipSelectionError(RuntimeError):
    pass


def pick_with_claude(
    transcript: Transcript,
    sig: Signals,
    *,
    count: int,
    min_dur: float,
    max_dur: float,
    duration: float,
    prompt: str | None = None,
    api_key: str | None = None,
    model: str = DEFAULT_API_MODEL,
    gaming: bool = False,
    preset: Preset | None = None,
    client=None,
) -> list[ClipPick]:
    """Ask Claude which moments to clip, as validated structured output."""
    try:
        import anthropic
    except ImportError as exc:  # pragma: no cover - declared dependency
        raise ClipSelectionError("the anthropic SDK is not installed") from exc

    if client is None:
        key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        # A missing key is not fatal: the SDK also resolves OAuth profiles.
        client = anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()

    sentences = build_sentences(transcript)
    user_block = "\n".join(
        [
            f"Source duration: {duration:.1f} seconds.",
            f"Clips requested: {count}.",
            "",
            "SELECTION BRIEF: " + (prompt or "the most engaging, highest-retention moments"),
            "",
            "DETECTED PEAKS:",
            build_signal_block(sig),
            "",
            "TRANSCRIPT:",
            build_transcript_block(sentences) or "(no speech detected in this source)",
        ]
    )
    system = SYSTEM_PROMPT.format(min_dur=min_dur, max_dur=max_dur)

    raw = _request_plan(client, model, system, user_block)
    suggestions = raw.get("clips") or []
    if not suggestions:
        raise ClipSelectionError("Claude returned no clips")

    picks = _validate_suggestions(
        suggestions,
        sentences=sentences,
        sig=sig,
        transcript=transcript,
        count=count,
        min_dur=min_dur,
        max_dur=max_dur,
        duration=duration,
        gaming=gaming,
        preset=preset,
    )
    if not picks:
        raise ClipSelectionError("no suggestion survived validation")
    log.info("Claude selected %d clips", len(picks))
    return picks


def _request_plan(client, model: str, system: str, user_block: str) -> dict:
    """One structured-output request, with a client-side model fallback.

    ``messages.parse`` is used for schema-validated JSON. Forced tool choice is
    deliberately NOT used: it returns HTTP 400 on current models. The SDK does
    not expose the server-side ``fallbacks`` parameter on this path, so a
    refusal or transient failure retries on a second model here instead.
    """
    import anthropic

    attempts = [model]
    if model != FALLBACK_API_MODEL:
        attempts.append(FALLBACK_API_MODEL)

    last: Exception | None = None
    for attempt_model in attempts:
        try:
            response = client.messages.parse(
                model=attempt_model,
                max_tokens=16000,
                system=system,
                messages=[{"role": "user", "content": user_block}],
                output_config={"format": {"type": "json_schema", "schema": _plan_schema()}},
            )
        except Exception as exc:  # noqa: BLE001 - mapped to a domain error below
            log.warning("clip selection call failed on %s: %s", attempt_model, exc)
            last = exc
            continue

        stop = getattr(response, "stop_reason", None)
        if stop == "refusal":
            details = getattr(response, "stop_details", None)
            log.warning(
                "model %s declined the request (%s)",
                attempt_model, getattr(details, "category", "unknown"),
            )
            last = ClipSelectionError(f"{attempt_model} declined the request")
            continue
        if stop == "max_tokens":
            last = ClipSelectionError("response hit max_tokens before completing")
            continue

        parsed = getattr(response, "parsed_output", None)
        if parsed is not None:
            return parsed if isinstance(parsed, dict) else _as_dict(parsed)

        text = "".join(
            block.text for block in getattr(response, "content", [])
            if getattr(block, "type", "") == "text"
        )
        try:
            return json.loads(text)
        except ValueError as exc:
            last = ClipSelectionError(f"could not parse the model response as JSON: {exc}")

    raise ClipSelectionError(str(last) if last else "clip selection failed")


def _as_dict(obj) -> dict:
    for attr in ("model_dump", "dict"):
        fn = getattr(obj, attr, None)
        if callable(fn):
            return fn()
    return dict(obj)


def _validate_suggestions(
    suggestions: list,
    *,
    sentences: list[Sentence],
    sig: Signals,
    transcript: Transcript | None,
    count: int,
    min_dur: float,
    max_dur: float,
    duration: float,
    gaming: bool,
    preset: Preset | None,
) -> list[ClipPick]:
    """Never trust model output: clamp, snap, de-overlap, re-score."""
    picks: list[ClipPick] = []

    for raw in suggestions:
        item = raw if isinstance(raw, dict) else _as_dict(raw)
        try:
            start = float(item.get("start_seconds"))
            end = float(item.get("end_seconds"))
        except (TypeError, ValueError):
            log.debug("dropping suggestion with unparseable times: %r", item)
            continue
        if not (start >= 0 and end > start):
            log.debug("dropping reversed/negative suggestion: %s-%s", start, end)
            continue
        if start >= duration:
            log.debug("dropping suggestion past the end of the source: %s", start)
            continue

        if sentences and not gaming:
            s, e = snap_to_sentences(
                start, end, sentences,
                min_dur=min_dur, max_dur=max_dur, duration=duration,
            )
        else:
            s, e = snap_to_cuts(
                start, end, sig.scene_cuts,
                min_dur=min_dur, max_dur=max_dur, duration=duration,
            )

        pick = ClipPick(start=s, end=e)
        if any(pick.overlaps(p, tolerance=0.75) for p in picks):
            log.debug("dropping suggestion overlapping an earlier pick: %s-%s", s, e)
            continue

        try:
            score = int(round(float(item.get("virality_score", 0))))
        except (TypeError, ValueError):
            score = 0
        pick.score = max(0, min(100, score))

        tags = item.get("hashtags") or []
        clean_tags: list[str] = []
        if preset is not None:
            clean_tags.extend(preset.forced_hashtags)
        for tag in tags:
            tag = str(tag).strip()
            if not tag:
                continue
            if not tag.startswith("#"):
                tag = "#" + tag
            tag = re.sub(r"[^#\w]", "", tag)
            if len(tag) > 1 and tag not in clean_tags:
                clean_tags.append(tag)

        text = transcript.text_between(s, e) if transcript else ""
        pick.title = str(item.get("title") or "").strip()[:80] or synthesize_title(
            text, {}, gaming=gaming
        )
        pick.hook = str(item.get("hook") or "").strip()[:60] or synthesize_hook(
            text, gaming=gaming
        )
        pick.reason = str(item.get("reason") or "").strip()[:400] or "Selected by Claude."
        pick.hashtags = clean_tags[:8]
        pick.transcript = text
        pick.thumbnail_text = str(item.get("thumbnail_text") or "").strip()[:28].upper()
        alts = item.get("alt_titles") or []
        pick.title_variants = [
            __import__("cfp.models", fromlist=["TitleVariant"]).TitleVariant(
                text=str(a).strip()[:80], framework="claude_alt",
                score=titles_mod.score_title(str(a))[0],
                reason="Suggested by the model as a different angle.",
            )
            for a in alts if str(a).strip()
        ][:4]
        pick.picked_by = "claude"
        picks.append(pick)

    picks.sort(key=lambda p: -p.score)
    picks = picks[:count]
    for i, pick in enumerate(picks, 1):
        pick.index = i
    return picks


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def select_clips(
    transcript: Transcript | None,
    sig: Signals,
    *,
    count: int,
    min_dur: float,
    max_dur: float,
    duration: float,
    gaming: bool,
    prompt: str | None = None,
    use_api: bool = True,
    api_key: str | None = None,
    api_model: str = DEFAULT_API_MODEL,
    preset: Preset | None = None,
    client=None,
) -> list[ClipPick]:
    """Pick clips with Claude when possible, heuristically otherwise."""
    has_key = bool(api_key or os.environ.get("ANTHROPIC_API_KEY"))
    if use_api and transcript is not None and (has_key or client is not None):
        try:
            return pick_with_claude(
                transcript, sig,
                count=count, min_dur=min_dur, max_dur=max_dur, duration=duration,
                prompt=prompt, api_key=api_key, model=api_model,
                gaming=gaming, preset=preset, client=client,
            )
        except Exception as exc:  # noqa: BLE001 - any failure must degrade, not crash
            log.warning("falling back to heuristic selection: %s", exc)
    elif use_api and not has_key and client is None:
        log.info("no ANTHROPIC_API_KEY found; using heuristic selection")

    return pick_heuristic(
        transcript, sig,
        count=count, min_dur=min_dur, max_dur=max_dur, duration=duration,
        gaming=gaming, preset=preset,
    )


def enrich(picks, *, gaming: bool, preset=None, promote_best: bool = True) -> list:
    """Attach title variants, thumbnail text and platform captions."""
    titles_mod.enrich_picks(
        picks, gaming=gaming, preset=preset, promote_best=promote_best
    )
    return picks
