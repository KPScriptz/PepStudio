"""Shared fixtures. Video-dependent tests skip cleanly when the generated
footage is absent -- it is not committed. Run::

    python scripts/make_fixtures.py tests/data
"""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
GAMEPLAY = os.path.join(DATA, "gameplay.mp4")
TALKING = os.path.join(DATA, "talking.mp4")
QUALITY = os.path.join(DATA, "quality.mp4")
TRUTH = os.path.join(DATA, "ground_truth.json")

needs_fixtures = pytest.mark.skipif(
    not (os.path.exists(GAMEPLAY) and os.path.exists(TRUTH)),
    reason="test footage missing; run `python scripts/make_fixtures.py tests/data`",
)
needs_talking = pytest.mark.skipif(
    not os.path.exists(TALKING),
    reason="talking.mp4 missing; run `python scripts/make_fixtures.py tests/data`",
)


@pytest.fixture(scope="session")
def ground_truth() -> dict:
    with open(TRUTH, "r", encoding="utf-8") as fh:
        return json.load(fh)["gameplay"]


needs_quality = pytest.mark.skipif(
    not (os.path.exists(QUALITY) and os.path.exists(TRUTH)),
    reason="quality.mp4 missing; run `python scripts/make_fixtures.py tests/data`",
)


@pytest.fixture(scope="session")
def quality_truth() -> dict:
    with open(TRUTH, "r", encoding="utf-8") as fh:
        return json.load(fh)["quality"]


@pytest.fixture(scope="session")
def quality_path() -> str:
    return QUALITY


@pytest.fixture(scope="session")
def gameplay_path() -> str:
    return GAMEPLAY


@pytest.fixture(scope="session")
def talking_path() -> str:
    return TALKING


@pytest.fixture
def words():
    from cfp.models import Word

    spoken = (
        "This is absolutely insane. He just flew straight into the helicopter! "
        "Okay guys so basically welcome back to the channel."
    ).split()
    out, t = [], 0.0
    for token in spoken:
        out.append(Word(t, t + 0.3, token))
        t += 0.35
    return out


@pytest.fixture
def transcript(words):
    from cfp.models import Transcript

    return Transcript(words=words, duration=words[-1].end, language="en")


@pytest.fixture
def empty_signals():
    from cfp.signals import Signals

    return Signals(duration=120.0, has_audio=True)
