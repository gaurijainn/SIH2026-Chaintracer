"""B7.4 Task 4: the TRON negative-sampling candidate interface."""
from pathlib import Path

import pytest

from app.datasets import Chain
from app.datasets.negative_sampling import NegativeCandidate, NegativeCandidateStatus, confirmed_negatives, load_negative_candidates

FIXTURES = Path(__file__).parent.parent / "fixtures" / "datasets"


def test_loads_included_excluded_and_undetermined_candidates():
    candidates = load_negative_candidates(FIXTURES / "negative_candidates_valid.csv")
    by_addr = {c.address: c for c in candidates}
    assert by_addr["TNEG1"].status == NegativeCandidateStatus.INCLUDED
    assert by_addr["TEXCH1"].status == NegativeCandidateStatus.EXCLUDED
    assert by_addr["TUNK1"].status == NegativeCandidateStatus.UNDETERMINED


def test_confirmed_negatives_returns_only_included():
    candidates = load_negative_candidates(FIXTURES / "negative_candidates_valid.csv")
    confirmed = confirmed_negatives(candidates)
    assert [c.address for c in confirmed] == ["TNEG1"]


def test_excluded_candidate_carries_its_reason():
    candidates = load_negative_candidates(FIXTURES / "negative_candidates_valid.csv")
    excluded = next(c for c in candidates if c.address == "TEXCH1")
    assert excluded.exclusion_reason == "tagged as an exchange hot wallet"


def test_undetermined_candidate_is_never_treated_as_a_negative():
    candidates = load_negative_candidates(FIXTURES / "negative_candidates_valid.csv")
    undetermined = next(c for c in candidates if c.address == "TUNK1")
    assert undetermined not in confirmed_negatives(candidates)
    assert undetermined.activity_evidence == {}
    assert undetermined.usdt_holder_evidence == {}


def test_rejects_an_included_candidate_missing_usdt_holder_evidence():
    with pytest.raises(ValueError, match="INCLUDED"):
        load_negative_candidates(FIXTURES / "negative_candidates_invalid_included.csv")


def test_direct_construction_rejects_included_without_evidence():
    with pytest.raises(ValueError, match="INCLUDED"):
        NegativeCandidate(
            address="X",
            chain=Chain.TRON,
            activity_evidence={},
            usdt_holder_evidence={},
            status=NegativeCandidateStatus.INCLUDED,
            source="s",
            timestamp="2026-08-05T00:00:00Z",
        )


def test_direct_construction_rejects_excluded_without_a_reason():
    with pytest.raises(ValueError, match="EXCLUDED"):
        NegativeCandidate(
            address="X",
            chain=Chain.TRON,
            status=NegativeCandidateStatus.EXCLUDED,
            source="s",
            timestamp="2026-08-05T00:00:00Z",
        )


def test_direct_construction_rejects_a_reason_on_a_non_excluded_candidate():
    with pytest.raises(ValueError, match="only meaningful"):
        NegativeCandidate(
            address="X",
            chain=Chain.TRON,
            status=NegativeCandidateStatus.UNDETERMINED,
            exclusion_reason="should not be here",
            source="s",
            timestamp="2026-08-05T00:00:00Z",
        )
