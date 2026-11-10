"""Configuration, caption styling, and brand presets."""

from __future__ import annotations

import os
from dataclasses import dataclass, field, replace

TARGET_W = 1080
TARGET_H = 1920

MIN_CLIP = 15.0
MAX_CLIP = 60.0


def _cache_root() -> str:
    env = os.environ.get("CFP_CACHE_DIR")
    if env:
        return env
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(
        os.path.expanduser("~"), ".cache"
    )
    return os.path.join(base, "clipforge-pro")


# --------------------------------------------------------------------------- #
# Caption styling
# --------------------------------------------------------------------------- #
#
# ASS colours are &HAABBGGRR -- alpha, then **blue, green, red**. Writing them
# in RGB order is the single most common way to get these wrong, so every
# constant below documents its RGB intent.

ASS_WHITE = "&H00FFFFFF"            # rgb(255,255,255)
ASS_YELLOW = "&H0000D6FF"           # rgb(255,214,0)  brand highlight
ASS_NAVY = "&H0040160A"             # rgb(10,22,64)   brand outline
ASS_BLACK = "&H00000000"
ASS_SHADOW = "&H64000000"           # 39% alpha black


@dataclass(frozen=True)
class CaptionStyle:
    """Look of the burned-in captions."""

    font: str = "DejaVu Sans"
    size: int = 108
    base_color: str = ASS_WHITE
    highlight_color: str = ASS_YELLOW
    outline_color: str = ASS_NAVY
    shadow_color: str = ASS_SHADOW
    outline: float = 6.0
    shadow: float = 3.0
    bold: bool = True
    uppercase: bool = True
    # Vertical placement: ASS alignment 2 = bottom-centre; margin from bottom.
    alignment: int = 2
    margin_v: int = 420
    margin_h: int = 70
    # Words shown together in one caption frame.
    words_per_frame: int = 3
    # "Pop" on the active word: scale % it starts at, and settle time (ms).
    pop_scale: int = 118
    pop_ms: int = 110

    hook_size: int = 92
    hook_color: str = ASS_WHITE
    hook_outline_color: str = ASS_NAVY
    hook_alignment: int = 8          # 8 = top-centre
    hook_margin_v: int = 260         # distance from the top, with alignment 8
    hook_seconds: float = 3.0


@dataclass(frozen=True)
class ThumbStyle:
    """Look of a generated thumbnail.

    A thumbnail is judged at roughly 180px wide in a feed, so the text is
    sized as a fraction of image height rather than in points, and the
    outline is heavy enough to survive that downscale.
    """

    font: str = "DejaVu Sans"
    size_ratio: float = 0.105        # cap height as a fraction of image height
    color: str = ASS_WHITE
    accent: str = ASS_YELLOW         # high-arousal words get this
    outline_color: str = ASS_NAVY
    outline: float = 7.0
    shadow: float = 4.0
    bold: bool = True
    uppercase: bool = True
    margin_v: int = 120              # from the bottom edge
    max_chars_per_line: int = 13

    # Image treatment. Modest on purpose: oversaturated thumbnails read as
    # spam and the platforms re-compress them anyway.
    scrim: float = 0.62              # peak opacity of the bottom gradient
    scrim_height: float = 0.46       # fraction of image height it covers
    saturation: float = 1.16
    contrast: float = 1.10
    vignette: float = 0.16


@dataclass(frozen=True)
class Preset:
    """A brand preset: forced hashtags plus caption look."""

    name: str
    forced_hashtags: tuple[str, ...] = ()
    style: CaptionStyle = field(default_factory=CaptionStyle)
    thumb: ThumbStyle = field(default_factory=ThumbStyle)
    description: str = ""


BRAND_STYLE = CaptionStyle()

PRESETS: dict[str, Preset] = {
    "brand": Preset(
        name="brand",
        style=BRAND_STYLE,
        description="Default ClipForge look: yellow highlight, navy outline.",
    ),
    "pepercollectibles": Preset(
        name="pepercollectibles",
        forced_hashtags=("#pepercollectibles",),
        style=BRAND_STYLE,
        description="Peper Collectibles: forces #pepercollectibles on every clip.",
    ),
    "gaming": Preset(
        name="gaming",
        forced_hashtags=("#gaming", "#gamingclips"),
        thumb=replace(ThumbStyle(), size_ratio=0.118, saturation=1.22),
        style=replace(BRAND_STYLE, size=116, margin_v=330, words_per_frame=2),
        description="Punchier, lower captions sized for gameplay footage.",
    ),
    "plain": Preset(
        name="plain",
        thumb=replace(
            ThumbStyle(), accent=ASS_WHITE, outline_color=ASS_BLACK,
            saturation=1.0, contrast=1.0, vignette=0.0,
        ),
        style=replace(
            BRAND_STYLE,
            highlight_color=ASS_WHITE,
            outline_color=ASS_BLACK,
            uppercase=False,
        ),
        description="Neutral white-on-black captions, no brand colours.",
    ),
}


def get_preset(name: str | None) -> Preset:
    if not name:
        return PRESETS["brand"]
    key = name.strip().lower()
    if key not in PRESETS:
        known = ", ".join(sorted(PRESETS))
        raise KeyError(f"unknown preset {name!r}; available: {known}")
    return PRESETS[key]


# --------------------------------------------------------------------------- #
# Run settings
# --------------------------------------------------------------------------- #


@dataclass
class Settings:
    source: str
    out_dir: str = "out"
    clips: int = 8
    prompt: str | None = None

    # transcription
    model: str = "base.en"
    language: str | None = None
    device: str = "auto"            # auto | cuda | cpu
    compute_type: str | None = None

    # selection
    min_dur: float = MIN_CLIP
    max_dur: float = MAX_CLIP
    gaming: bool | None = None      # None = auto-detect
    use_api: bool = True
    api_key: str | None = None
    api_model: str = "claude-sonnet-4-6"

    # rendering
    preset: str = "brand"
    captions: bool = True
    hook: bool = True
    encoder: str = "auto"
    jobs: int = 0                   # 0 = auto
    crf: int = 20
    audio_bitrate: str = "160k"
    loudnorm: bool = True
    sharpen: bool = True

    # thumbnails
    thumbs: int = 3                 # text variants per clip, 0 disables
    thumb_wide: bool = True         # also emit a 16:9 version of the best
    thumb_clean: bool = True        # also emit the best frame with no text
    thumb_text: bool = True

    # titles
    title_variants: int = 5
    promote_best_title: bool = True

    # plumbing
    cache_dir: str = field(default_factory=_cache_root)
    min_free_gib: float = 2.0
    dry_run: bool = False
    keep_temp: bool = False
    seed: int = 0

    def resolved_jobs(self) -> int:
        if self.jobs and self.jobs > 0:
            return self.jobs
        cpu = os.cpu_count() or 4
        # Each clip render is itself multi-threaded, so stay well under the
        # core count: oversubscribing makes a whole pack slower, not faster.
        return max(1, min(4, cpu // 2 or 1))

    def resolved_preset(self) -> Preset:
        return get_preset(self.preset)
