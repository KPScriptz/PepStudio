"""Encoder detection. The point of this module is that a *listed* encoder is
not a *working* encoder, so the probe is what we assert on."""

from __future__ import annotations

import json
import os

import pytest

from cfp import encoder as enc
from cfp.encoder import SOFTWARE, Encoder, detect


def test_quality_flags_differ_per_family():
    assert "-crf" in SOFTWARE.video_args(20)
    assert "-cq" in enc.BY_KIND["nvenc"].video_args(20)
    assert "-global_quality" in enc.BY_KIND["qsv"].video_args(20)
    assert "-qp_i" in enc.BY_KIND["amf"].video_args(20)
    assert "-q:v" in enc.BY_KIND["videotoolbox"].video_args(20)


def test_videotoolbox_quality_scale_is_inverted():
    """VideoToolbox takes 1..100 where higher is better -- opposite to CRF."""
    vt = enc.BY_KIND["videotoolbox"]
    good = int(vt.video_args(10)[1])
    poor = int(vt.video_args(40)[1])
    assert good > poor
    assert 1 <= good <= 100 and 1 <= poor <= 100


def test_crf_is_clamped_into_range():
    assert "-crf" in SOFTWARE.video_args(-5)
    assert SOFTWARE.video_args(-5)[SOFTWARE.video_args(-5).index("-crf") + 1] == "0"
    assert SOFTWARE.video_args(99)[SOFTWARE.video_args(99).index("-crf") + 1] == "51"


def test_hardware_flag_is_accurate():
    assert not SOFTWARE.is_hardware
    assert all(e.is_hardware for e in enc.CANDIDATES if e is not SOFTWARE)


def test_an_explicit_choice_is_honoured_without_probing(monkeypatch, tmp_path):
    monkeypatch.setattr(enc, "probe_encoder", lambda *a, **k: pytest.fail("probed"))
    assert detect(str(tmp_path), requested="nvenc").name == "h264_nvenc"
    assert detect(str(tmp_path), requested="h264_qsv").name == "h264_qsv"


def test_an_unknown_encoder_is_rejected(tmp_path):
    with pytest.raises(KeyError):
        detect(str(tmp_path), requested="h264_magic")


def test_falls_back_to_software_when_every_probe_fails(monkeypatch, tmp_path):
    """The real condition on this machine: nvenc and qsv are compiled in but
    no hardware exists."""
    monkeypatch.setattr(enc, "list_compiled", lambda *a: {"h264_nvenc", "h264_qsv", "libx264"})
    monkeypatch.setattr(enc, "probe_encoder", lambda *a, **k: False)
    assert detect(str(tmp_path), use_cache=False).name == "libx264"


def test_the_first_working_hardware_encoder_wins(monkeypatch, tmp_path):
    monkeypatch.setattr(enc, "list_compiled", lambda *a: {"h264_nvenc", "h264_qsv", "libx264"})
    monkeypatch.setattr(enc, "probe_encoder", lambda e, *a, **k: e.name == "h264_qsv")
    assert detect(str(tmp_path), use_cache=False).name == "h264_qsv"


def test_an_encoder_that_is_not_compiled_in_is_never_probed(monkeypatch, tmp_path):
    seen = []
    monkeypatch.setattr(enc, "list_compiled", lambda *a: {"libx264"})
    monkeypatch.setattr(enc, "probe_encoder",
                        lambda e, *a, **k: (seen.append(e.name), False)[1])
    detect(str(tmp_path), use_cache=False)
    assert seen == []


def test_the_result_is_cached(monkeypatch, tmp_path):
    monkeypatch.setattr(enc, "list_compiled", lambda *a: {"libx264"})
    calls = []
    monkeypatch.setattr(enc, "probe_encoder",
                        lambda e, *a, **k: (calls.append(1), False)[1])
    detect(str(tmp_path))
    first = len(calls)
    detect(str(tmp_path))
    assert len(calls) == first          # second call served from cache


def test_a_corrupt_cache_file_is_ignored(monkeypatch, tmp_path):
    monkeypatch.setattr(enc, "list_compiled", lambda *a: {"libx264"})
    monkeypatch.setattr(enc, "probe_encoder", lambda *a, **k: False)
    detect(str(tmp_path))
    for name in os.listdir(tmp_path):
        if name.startswith("encoder-"):
            (tmp_path / name).write_text("{{{ not json")
    assert detect(str(tmp_path)).name == "libx264"


def test_the_env_override_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("CFP_ENCODER", "videotoolbox")
    assert detect(str(tmp_path), requested="auto").name == "h264_videotoolbox"
