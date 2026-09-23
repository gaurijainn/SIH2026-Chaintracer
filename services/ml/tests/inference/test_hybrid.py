"""B7.5: hybrid-score formula exactness, band boundaries (boundary-inclusive, tested at every
specified value including 0.999 either side of each edge), and hard-override precedence/score-band
consistency."""
from __future__ import annotations

import pytest

from app.inference.hybrid import CRITICAL_BAND_FLOOR, apply_overrides, band_for_score, compute_hybrid_score


def test_hybrid_formula_exact():
    # 0.6 * (0.5 * 100) + 0.4 * 50 = 30 + 20 = 50
    assert compute_hybrid_score(0.5, 50.0) == pytest.approx(50.0)
    # 0.6 * (1.0 * 100) + 0.4 * 0 = 60
    assert compute_hybrid_score(1.0, 0.0) == pytest.approx(60.0)
    # 0.6 * 0 + 0.4 * 100 = 40
    assert compute_hybrid_score(0.0, 100.0) == pytest.approx(40.0)


def test_hybrid_score_clamped_to_0_100():
    assert compute_hybrid_score(1.0, 100.0) == 100.0
    assert compute_hybrid_score(0.0, 0.0) == 0.0


@pytest.mark.parametrize(
    "score,expected_band",
    [
        (0.0, "Low"),
        (29.0, "Low"),
        (29.999, "Low"),
        (30.0, "Medium"),
        (59.0, "Medium"),
        (59.999, "Medium"),
        (60.0, "High"),
        (79.0, "High"),
        (79.999, "High"),
        (80.0, "Critical"),
        (100.0, "Critical"),
    ],
)
def test_band_boundaries_exact(score, expected_band):
    assert band_for_score(score) == expected_band


def test_no_override_when_both_flags_none():
    result = apply_overrides(0.1, 10.0, sanctioned=None, stablecoin_blacklisted=None)
    assert result.overrides_fired == ()
    assert result.band == result.computed_band
    assert result.score == result.computed_score


def test_no_override_when_both_flags_explicitly_false():
    result = apply_overrides(0.1, 10.0, sanctioned=False, stablecoin_blacklisted=False)
    assert result.overrides_fired == ()
    assert result.band != "Critical" or result.computed_band == "Critical"


def test_override_sanctioned_true_forces_critical_band():
    result = apply_overrides(0.1, 10.0, sanctioned=True, stablecoin_blacklisted=None)
    assert result.band == "Critical"
    assert result.overrides_fired == ("sanctioned",)


def test_override_stablecoin_blacklisted_true_forces_critical_band():
    result = apply_overrides(0.1, 10.0, sanctioned=None, stablecoin_blacklisted=True)
    assert result.band == "Critical"
    assert result.overrides_fired == ("stablecoin_blacklisted",)


def test_override_both_true_reports_both():
    result = apply_overrides(0.1, 10.0, sanctioned=True, stablecoin_blacklisted=True)
    assert set(result.overrides_fired) == {"sanctioned", "stablecoin_blacklisted"}


def test_override_floors_low_computed_score_to_critical_floor():
    # computed hybrid score is deliberately low (below 80)
    result = apply_overrides(0.05, 5.0, sanctioned=True, stablecoin_blacklisted=None)
    assert result.computed_score < CRITICAL_BAND_FLOOR
    assert result.score == CRITICAL_BAND_FLOOR
    assert result.band == "Critical"


def test_override_never_lowers_an_already_high_computed_score():
    result = apply_overrides(0.95, 95.0, sanctioned=True, stablecoin_blacklisted=None)
    assert result.computed_score >= CRITICAL_BAND_FLOOR
    assert result.score == result.computed_score  # unchanged, not floored down
    assert result.band == "Critical"


def test_override_score_and_band_always_mutually_consistent():
    for calibrated_prob, rule_score in [(0.0, 0.0), (0.01, 1.0), (0.5, 50.0)]:
        result = apply_overrides(calibrated_prob, rule_score, sanctioned=True, stablecoin_blacklisted=None)
        assert result.band == "Critical"
        assert result.score >= CRITICAL_BAND_FLOOR
