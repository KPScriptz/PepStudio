"""Command line interface: ``cfp input.mp4 --clips 8 --prompt "..."``."""

from __future__ import annotations

import argparse
import logging
import os
import sys

from . import __version__
from .config import MAX_CLIP, MIN_CLIP, PRESETS, Settings
from .pipeline import run


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="cfp",
        description=(
            "ClipForge Pro - turn long videos into vertical short-form clips, "
            "entirely on your own machine."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            "  cfp stream.mp4 --clips 8 --prompt \"funniest moments\"\n"
            "  cfp https://youtu.be/xxxx --clips 5 --preset pepercollectibles\n"
            "  cfp gameplay.mkv --gaming --no-api --clips 10\n"
        ),
    )
    ap.add_argument("source", help="local video file or a URL (fetched with yt-dlp)")
    ap.add_argument("-n", "--clips", type=int, default=8, help="how many clips (default 8)")
    ap.add_argument("-p", "--prompt", default=None,
                    help="what to look for, e.g. \"funniest moments\"")
    ap.add_argument("-o", "--out", dest="out_dir", default="out",
                    help="output directory (default ./out)")

    g = ap.add_argument_group("transcription")
    g.add_argument("--model", default="base.en",
                   help="faster-whisper model (default base.en)")
    g.add_argument("--language", default=None, help="force a language code")
    g.add_argument("--device", default="auto", choices=("auto", "cuda", "cpu"),
                   help="auto uses the GPU when one is actually present")
    g.add_argument("--no-cache", action="store_true", help="ignore the transcript cache")

    g = ap.add_argument_group("selection")
    g.add_argument("--min-dur", type=float, default=MIN_CLIP,
                   help=f"shortest clip in seconds (default {MIN_CLIP:.0f})")
    g.add_argument("--max-dur", type=float, default=MAX_CLIP,
                   help=f"longest clip in seconds (default {MAX_CLIP:.0f})")
    mode = g.add_mutually_exclusive_group()
    mode.add_argument("--gaming", dest="gaming", action="store_true", default=None,
                      help="force audio-spike ranking (works with no speech)")
    mode.add_argument("--no-gaming", dest="gaming", action="store_false",
                      help="force speech-led ranking")
    g.add_argument("--no-api", dest="use_api", action="store_false", default=True,
                   help="skip the Claude API and use the built-in heuristic")
    g.add_argument("--api-key", default=None,
                   help="Anthropic API key (default: $ANTHROPIC_API_KEY)")
    g.add_argument("--api-model", default="claude-opus-5-5", help="Claude model id")

    g = ap.add_argument_group("render")
    g.add_argument("--preset", default="brand", choices=sorted(PRESETS),
                   help="brand preset (default brand)")
    g.add_argument("--no-captions", dest="captions", action="store_false", default=True,
                   help="do not burn in subtitles")
    g.add_argument("--no-hook", dest="hook", action="store_false", default=True,
                   help="do not overlay hook text over the first seconds")
    g.add_argument("--encoder", default="auto",
                   help="auto | libx264 | nvenc | qsv | amf | videotoolbox")
    g.add_argument("-j", "--jobs", type=int, default=0,
                   help="parallel clip renders (default: auto)")
    g.add_argument("--crf", type=int, default=20, help="quality, lower is better")
    g.add_argument("--no-loudnorm", dest="loudnorm", action="store_false", default=True,
                   help="skip loudness normalisation")
    g.add_argument("--no-sharpen", dest="sharpen", action="store_false", default=True,
                   help="skip the pre-caption sharpening pass")

    g = ap.add_argument_group("thumbnails & titles")
    g.add_argument("--thumbs", type=int, default=3, metavar="N",
                   help="thumbnail variants per clip, 0 disables (default 3)")
    g.add_argument("--no-thumb-text", dest="thumb_text", action="store_false",
                   default=True, help="don't burn text onto thumbnails")
    g.add_argument("--no-thumb-wide", dest="thumb_wide", action="store_false",
                   default=True, help="skip the extra 16:9 thumbnail")
    g.add_argument("--no-thumb-clean", dest="thumb_clean", action="store_false",
                   default=True, help="skip the extra text-free thumbnail")
    g.add_argument("--title-variants", type=int, default=5, metavar="N",
                   help="how many title options to generate (default 5)")
    g.add_argument("--keep-title", dest="promote_best_title", action="store_false",
                   default=True,
                   help="keep the originally selected title instead of promoting "
                        "the highest-scoring variant")

    g = ap.add_argument_group("other")
    g.add_argument("--dry-run", action="store_true",
                   help="pick clips and print them without rendering")
    g.add_argument("--keep-temp", action="store_true", help="keep intermediate files")
    g.add_argument("--min-free-gib", type=float, default=2.0,
                   help="refuse to render below this much free disk (default 2)")
    g.add_argument("-v", "--verbose", action="count", default=0,
                   help="-v for debug logging of our own modules, -vv for everything")
    g.add_argument("-q", "--quiet", action="store_true", help="warnings and errors only")
    g.add_argument("--version", action="version", version=f"ClipForge Pro {__version__}")
    return ap


def configure_logging(verbose: int, quiet: bool) -> None:
    level = logging.WARNING if quiet else (logging.DEBUG if verbose else logging.INFO)
    logging.basicConfig(
        level=logging.DEBUG if verbose >= 2 else level,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    if verbose < 2:
        for noisy in ("faster_whisper", "urllib3", "httpx", "httpcore", "anthropic"):
            logging.getLogger(noisy).setLevel(logging.WARNING)
    if verbose == 1:
        logging.getLogger("cfp").setLevel(logging.DEBUG)


def settings_from_args(args: argparse.Namespace) -> Settings:
    s = Settings(
        source=args.source,
        out_dir=args.out_dir,
        clips=max(1, args.clips),
        prompt=args.prompt,
        model=args.model,
        language=args.language,
        device=args.device,
        min_dur=max(1.0, args.min_dur),
        max_dur=max(args.min_dur + 1.0, args.max_dur),
        gaming=args.gaming,
        use_api=args.use_api,
        api_key=args.api_key,
        api_model=args.api_model,
        preset=args.preset,
        captions=args.captions,
        hook=args.hook,
        encoder=args.encoder,
        jobs=max(0, args.jobs),
        crf=max(0, min(51, args.crf)),
        loudnorm=args.loudnorm,
        sharpen=args.sharpen,
        thumbs=max(0, args.thumbs),
        thumb_text=args.thumb_text,
        thumb_wide=args.thumb_wide,
        thumb_clean=args.thumb_clean,
        title_variants=max(1, args.title_variants),
        promote_best_title=args.promote_best_title,
        dry_run=args.dry_run,
        keep_temp=args.keep_temp,
        min_free_gib=max(0.0, args.min_free_gib),
    )
    if args.no_cache:
        s.cache_dir = os.path.join(s.cache_dir, "nocache")
    return s


def _print_summary(result) -> None:
    print()
    if result.picks and not result.clips:
        print(f"Selected {len(result.picks)} clip(s):")
    for pick in result.picks:
        mark = "ok " if any(c.pick.index == pick.index for c in result.clips) else "-- "
        print(
            f"  {mark}[{pick.score:3d}] {pick.start:7.2f}s -> {pick.end:7.2f}s "
            f"({pick.duration:5.1f}s)  {pick.title}"
        )
        if pick.reason:
            print(f"        why: {pick.reason}")
        if pick.hashtags:
            print(f"        tags: {' '.join(pick.hashtags)}")
        if pick.thumbnail_text:
            print(f"        thumb: \"{pick.thumbnail_text}\"")
        for alt in pick.title_variants[1:4]:
            print(f"        alt [{alt.score:3d}]: {alt.text}")

    if result.failed:
        print(f"\n{len(result.failed)} clip(s) failed:")
        for f in result.failed:
            print(f"  clip {f['clip']}: {f['error']}")

    if result.clips:
        print(
            f"\nRendered {len(result.clips)} clip(s) in {result.elapsed:.1f}s "
            f"using {result.encoder}"
        )
        print(f"  output:  {result.out_dir}")
        print(f"  review:  {result.index_html}")
        print(f"  data:    {result.clips_json}")
    elif not result.picks:
        print("No clips were selected. Try --no-gaming, a lower --min-dur, "
              "or a longer source.")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    configure_logging(args.verbose, args.quiet)
    log = logging.getLogger("cfp")

    try:
        result = run(settings_from_args(args))
    except KeyboardInterrupt:
        log.error("interrupted")
        return 130
    except Exception as exc:  # noqa: BLE001 - CLI boundary: report, don't traceback
        log.error("%s", exc)
        if args.verbose:
            raise
        return 1

    _print_summary(result)
    if result.picks and not result.clips and not args.dry_run:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
