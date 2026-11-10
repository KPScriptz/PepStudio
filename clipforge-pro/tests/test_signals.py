"""Signal analysis, checked against footage whose ground truth we chose."""

from __future__ import annotations

import numpy as np
import pytest

from cfp.models import Transcript, Word
from cfp.signals import (
    GLOBAL_Z, LOUD_Z, Signals, _rolling_baseline, analyse, detect_scene_cuts,
    find_peaks, global_z, local_z, looks_like_gameplay, loudness_curve,
    merge_peaks, read_audio, speech_density,
)
from conftest import needs_fixtures


# ------------------------------- maths ------------------------------------ #

def test_loudness_curve_shape_and_times():
    sr, hop = 16000, 0.25
    samples = np.zeros(sr * 4, dtype=np.float32)
    dbfs, times = loudness_curve(samples, sample_rate=sr, hop=hop)
    assert dbfs.size == times.size == 16
    assert times[0] == pytest.approx(hop / 2)


def test_silence_is_floored_not_negative_infinity():
    dbfs, _ = loudness_curve(np.zeros(16000, dtype=np.float32))
    assert np.all(np.isfinite(dbfs))


def test_empty_audio_is_handled():
    dbfs, times = loudness_curve(np.zeros(0, dtype=np.float32))
    assert dbfs.size == 0 and times.size == 0


def test_rolling_baseline_keeps_length():
    values = np.linspace(0, 10, 57)
    mean, std = _rolling_baseline(values, 11)
    assert mean.shape == std.shape == values.shape


def test_peaks_are_found_where_bursts_were_planted():
    sr = 16000
    rng = np.random.default_rng(0)
    x = rng.normal(0, 0.02, sr * 50).astype(np.float32)
    for t in (10.0, 25.0, 40.0):
        x[int(t * sr):int((t + 0.4) * sr)] *= 25
    dbfs, times = loudness_curve(x)
    peaks = find_peaks(local_z(dbfs), times)
    found = sorted(p.time for p in peaks)
    assert len(found) == 3
    for want, got in zip((10.0, 25.0, 40.0), found):
        assert abs(got - want) < 0.5


def test_peaks_are_thinned_by_the_minimum_gap():
    z = np.full(100, 5.0)
    times = np.arange(100) * 0.25
    peaks = find_peaks(z, times, min_gap=2.0)
    for a, b in zip(peaks, peaks[1:]):
        assert b.time - a.time >= 2.0


def test_a_flat_signal_produces_no_peaks():
    z = np.zeros(100)
    assert find_peaks(z, np.arange(100) * 0.25) == []


def test_local_baseline_beats_a_global_one_on_drifting_audio():
    """A quiet burst in a quiet passage must still register once the track
    gets louder later -- that is the point of a rolling baseline."""
    sr = 16000
    x = np.full(sr * 60, 0.01, dtype=np.float32)
    x[sr * 40:] = 0.3                          # whole second half is loud
    x[int(9.5 * sr):int(10.0 * sr)] = 0.12     # a spike inside the quiet half
    dbfs, times = loudness_curve(x)
    peaks = find_peaks(local_z(dbfs), times)
    assert any(abs(p.time - 9.7) < 1.0 for p in peaks)


# ------------------------------- modes ------------------------------------ #

def test_gameplay_detection_uses_speech_density():
    sig = Signals(duration=100.0)
    sparse = Transcript(words=[Word(i, i + 0.2, "x") for i in range(10)])
    dense = Transcript(words=[Word(i * 0.2, i * 0.2 + 0.15, "x") for i in range(400)])
    assert looks_like_gameplay(sig, sparse)
    assert not looks_like_gameplay(sig, dense)
    assert looks_like_gameplay(sig, None)


def test_speech_density_handles_a_zero_duration():
    assert speech_density(Transcript(), 0.0) == 0.0


# ---------------------------- window queries ------------------------------- #

def test_window_queries_are_bounded():
    sig = Signals(duration=60.0)
    sig.times = np.arange(240) * 0.25
    sig.loud_z = np.zeros(240)
    sig.loud_z[80] = 5.0                       # t = 20.0
    assert sig.loudness_stats(19.0, 21.0)[0] == pytest.approx(5.0)
    assert sig.loudness_stats(0.0, 10.0)[0] == pytest.approx(0.0)
    assert sig.loudness_stats(500.0, 600.0) == (0.0, 0.0)


# ------------------------- against real footage ---------------------------- #

@needs_fixtures
def test_detected_spikes_match_the_planted_explosions(gameplay_path, ground_truth):
    """Both loudness passes together must find every planted explosion.

    The relative pass alone misses the one at 54.2s: it lands inside loud
    speech, which lifts its own rolling baseline to 1.83z -- below windows
    that hold nothing of interest. The absolute pass rates it 3.04z.
    """
    samples = read_audio(gameplay_path)
    assert samples.size > 0
    dbfs, times = loudness_curve(samples)
    peaks = merge_peaks(
        find_peaks(local_z(dbfs), times, threshold=LOUD_Z)
        + find_peaks(global_z(dbfs), times, threshold=GLOBAL_Z)
    )
    found = [p.time for p in peaks]
    for planted in ground_truth["explosions"]:
        assert any(abs(f - planted) < 1.0 for f in found), (
            f"no spike detected near {planted}s; found {found}"
        )
    # Recall must not come from flagging everything.
    assert len(found) <= ground_truth["duration"] / 8.0


@needs_fixtures
def test_the_relative_pass_alone_has_a_known_blind_spot(gameplay_path):
    """Documents WHY the second pass exists; if this ever starts passing,
    the merge may no longer be carrying its weight."""
    dbfs, times = loudness_curve(read_audio(gameplay_path))
    local_only = [p.time for p in find_peaks(local_z(dbfs), times, threshold=LOUD_Z)]
    assert not any(abs(t - 54.2) < 1.0 for t in local_only)


def test_merge_keeps_the_strongest_peak_in_a_cluster():
    from cfp.models import Peak

    merged = merge_peaks(
        [Peak(10.0, 3.0, "loudness"), Peak(10.4, 5.0, "loudness_global"),
         Peak(30.0, 2.0, "loudness")],
        min_gap=1.2,
    )
    assert [round(p.time, 1) for p in merged] == [10.4, 30.0]
    assert merged[0].score == 5.0


def test_global_z_centres_on_the_track_mean():
    values = np.array([0.0, 10.0, 20.0, 30.0])
    z = global_z(values)
    assert float(z.mean()) == pytest.approx(0.0, abs=1e-9)
    assert z[-1] > z[0]


@needs_fixtures
def test_detected_scene_cuts_match_the_concatenated_segments(gameplay_path, ground_truth):
    cuts = detect_scene_cuts(gameplay_path)
    for planted in ground_truth["scene_cuts"]:
        assert any(abs(c - planted) < 1.0 for c in cuts), (
            f"no scene cut detected near {planted}s; found {cuts}"
        )


@needs_fixtures
def test_analyse_produces_a_complete_signal_set(gameplay_path, ground_truth):
    sig = analyse(gameplay_path, duration=ground_truth["duration"])
    assert sig.peaks and sig.scene_cuts
    assert sig.dbfs.size == sig.times.size == sig.loud_z.size
    payload = sig.to_json()
    assert payload["duration"] == pytest.approx(ground_truth["duration"], abs=0.5)
