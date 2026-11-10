"""Shared data types. Kept dependency-free so every module can import it."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict


@dataclass(frozen=True)
class Word:
    start: float
    end: float
    text: str

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    text: str


@dataclass
class Transcript:
    words: list[Word] = field(default_factory=list)
    segments: list[Segment] = field(default_factory=list)
    language: str = ""
    duration: float = 0.0
    model: str = ""

    def __bool__(self) -> bool:
        return bool(self.words or self.segments)

    @property
    def word_count(self) -> int:
        return len(self.words)

    def words_between(self, start: float, end: float) -> list[Word]:
        """Words whose midpoint falls inside ``[start, end)``."""
        return [w for w in self.words if start <= (w.start + w.end) / 2.0 < end]

    def text_between(self, start: float, end: float) -> str:
        return " ".join(w.text for w in self.words_between(start, end)).strip()

    def to_json(self) -> dict:
        return {
            "version": 1,
            "language": self.language,
            "duration": self.duration,
            "model": self.model,
            "words": [{"s": w.start, "e": w.end, "t": w.text} for w in self.words],
            "segments": [
                {"s": s.start, "e": s.end, "t": s.text} for s in self.segments
            ],
        }

    @classmethod
    def from_json(cls, data: dict) -> "Transcript":
        return cls(
            words=[
                Word(float(w["s"]), float(w["e"]), str(w["t"]))
                for w in data.get("words") or []
            ],
            segments=[
                Segment(float(s["s"]), float(s["e"]), str(s["t"]))
                for s in data.get("segments") or []
            ],
            language=str(data.get("language") or ""),
            duration=float(data.get("duration") or 0.0),
            model=str(data.get("model") or ""),
        )


@dataclass
class Peak:
    """A moment the signal pass thinks is interesting."""

    time: float
    score: float          # z-score / normalised strength
    kind: str             # loudness | scene | speechrate

    def to_json(self) -> dict:
        return {"time": round(self.time, 3), "score": round(self.score, 3), "kind": self.kind}


@dataclass
class ClipPick:
    """One selected clip, before rendering."""

    start: float
    end: float
    title: str = ""
    hook: str = ""
    score: int = 0                       # virality 0-100
    reason: str = ""
    hashtags: list[str] = field(default_factory=list)
    picked_by: str = "heuristic"         # claude | heuristic
    transcript: str = ""
    index: int = 0

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    def overlaps(self, other: "ClipPick", tolerance: float = 0.0) -> bool:
        return (self.start < other.end - tolerance) and (other.start < self.end - tolerance)

    def to_json(self) -> dict:
        d = asdict(self)
        d["start"] = round(self.start, 3)
        d["end"] = round(self.end, 3)
        d["duration"] = round(self.duration, 3)
        return d


@dataclass
class RenderedClip:
    """A clip that made it through ffmpeg."""

    pick: ClipPick
    path: str
    thumbnail: str = ""
    width: int = 0
    height: int = 0
    bytes: int = 0
    render_seconds: float = 0.0

    def to_json(self) -> dict:
        import os

        d = self.pick.to_json()
        d.update(
            file=os.path.basename(self.path),
            thumbnail=os.path.basename(self.thumbnail) if self.thumbnail else "",
            width=self.width,
            height=self.height,
            bytes=self.bytes,
            render_seconds=round(self.render_seconds, 2),
        )
        return d
