"""Transcript caching, device selection, and CLI argument handling."""

from __future__ import annotations

import os

import pytest

from cfp.cli import build_parser, settings_from_args
from cfp.config import get_preset
from cfp.models import Transcript, Word
from cfp.transcribe import cache_key, load_cached, resolve_device, save_cached


# ----------------------------- caching ------------------------------------ #

def test_cache_key_is_stable_and_setting_sensitive(tmp_path):
    f = tmp_path / "v.mp4"
    f.write_bytes(b"x" * 100)
    base = cache_key(str(f), "base.en", None)
    assert base == cache_key(str(f), "base.en", None)
    assert base != cache_key(str(f), "tiny.en", None)
    assert base != cache_key(str(f), "base.en", "fr")
    assert base != cache_key(str(f), "base.en", None, vad=False)


def test_cache_key_changes_when_the_source_changes(tmp_path):
    f = tmp_path / "v.mp4"
    f.write_bytes(b"x" * 100)
    before = cache_key(str(f), "base.en", None)
    os.utime(str(f), (0, 0))
    assert cache_key(str(f), "base.en", None) != before


def test_cache_round_trip(tmp_path):
    t = Transcript(
        words=[Word(0.0, 0.5, "hi"), Word(0.5, 1.0, "there")],
        language="en", duration=1.0, model="base.en",
    )
    save_cached(str(tmp_path), "k", t)
    back = load_cached(str(tmp_path), "k")
    assert back is not None
    assert back.word_count == 2
    assert back.words[1].text == "there"
    assert back.language == "en"


def test_a_missing_or_corrupt_cache_entry_returns_none(tmp_path):
    assert load_cached(str(tmp_path), "absent") is None
    d = tmp_path / "transcripts"
    d.mkdir()
    (d / "bad.json").write_text("not json at all")
    assert load_cached(str(tmp_path), "bad") is None


def test_cache_writes_never_raise(tmp_path):
    save_cached("/this/path/cannot/exist", "k", Transcript())


# ----------------------------- devices ------------------------------------ #

def test_cpu_is_forced_when_asked():
    assert resolve_device("cpu") == ("cpu", "int8")


def test_auto_uses_cuda_when_a_device_exists(monkeypatch):
    import sys, types

    fake = types.SimpleNamespace(get_cuda_device_count=lambda: 2)
    monkeypatch.setitem(sys.modules, "ctranslate2", fake)
    assert resolve_device("auto") == ("cuda", "float16")


def test_cuda_request_degrades_to_cpu_when_absent(monkeypatch):
    import sys, types

    fake = types.SimpleNamespace(get_cuda_device_count=lambda: 0)
    monkeypatch.setitem(sys.modules, "ctranslate2", fake)
    assert resolve_device("cuda") == ("cpu", "int8")


def test_a_broken_cuda_probe_does_not_raise(monkeypatch):
    import sys, types

    def boom():
        raise RuntimeError("driver missing")

    monkeypatch.setitem(sys.modules, "ctranslate2",
                        types.SimpleNamespace(get_cuda_device_count=boom))
    assert resolve_device("auto") == ("cpu", "int8")


# -------------------------------- CLI -------------------------------------- #

def test_defaults():
    s = settings_from_args(build_parser().parse_args(["in.mp4"]))
    assert s.clips == 8 and s.use_api and s.captions and s.preset == "brand"
    assert s.min_dur == 15.0 and s.max_dur == 60.0


def test_flags_are_wired_through():
    args = build_parser().parse_args([
        "in.mp4", "--clips", "5", "--prompt", "funniest moments",
        "--preset", "pepercollectibles", "--no-api", "--no-captions",
        "--gaming", "--encoder", "nvenc", "-j", "3", "--dry-run",
    ])
    s = settings_from_args(args)
    assert s.clips == 5 and s.prompt == "funniest moments"
    assert s.preset == "pepercollectibles" and not s.use_api
    assert not s.captions and s.gaming is True
    assert s.encoder == "nvenc" and s.jobs == 3 and s.dry_run


def test_gaming_is_tri_state():
    p = build_parser()
    assert settings_from_args(p.parse_args(["i.mp4"])).gaming is None
    assert settings_from_args(p.parse_args(["i.mp4", "--gaming"])).gaming is True
    assert settings_from_args(p.parse_args(["i.mp4", "--no-gaming"])).gaming is False


def test_durations_cannot_invert():
    s = settings_from_args(build_parser().parse_args(
        ["i.mp4", "--min-dur", "40", "--max-dur", "10"]))
    assert s.max_dur > s.min_dur


def test_an_unknown_preset_is_rejected():
    with pytest.raises(SystemExit):
        build_parser().parse_args(["i.mp4", "--preset", "nope"])


def test_jobs_resolve_to_a_bounded_worker_count():
    s = settings_from_args(build_parser().parse_args(["i.mp4"]))
    assert 1 <= s.resolved_jobs() <= 4


def test_preset_lookup_is_case_insensitive():
    assert get_preset("BRAND").name == "brand"
    with pytest.raises(KeyError):
        get_preset("does-not-exist")
