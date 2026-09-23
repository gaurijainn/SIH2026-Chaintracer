"""B7.5: unit tests for the deterministic rule-score module (app.inference.rule_score). Covers
each rule independently, the combined weighted-sum-then-clamp formula, bounds, the documented
"no applicable signal -> 0" behavior, and determinism (same input -> same output, every time)."""
from __future__ import annotations

from app.features.schema import FeatureVector
from app.inference.rule_score import (
    FAN_OUT_MIN_DISTINCT,
    FRESH_WALLET_MAX_AGE_DAYS,
    PASSTHROUGH_MAX_DWELL_MINUTES,
    compute_rule_score,
)


def _fv(**overrides) -> FeatureVector:
    base = dict(
        dwell_median_min=None,
        fan_out_1h=0,
        fan_in_unique=0,
        passthrough_ratio=None,
        age_at_taint_days=None,
        activator_label=None,
        trx_dust_usdt=False,
        round_amount_ratio=0.0,
        burst_tx_per_hour=0,
        hops_from_victim=None,
        hops_to_vasp=None,
        sanction_exposure=None,
        external_flags=[],
        shared_mule_cps=0,
        cross_case_count=1,
    )
    base.update(overrides)
    return FeatureVector(**base)


# --- bounds & determinism, on a maximally-saturated request -----------------------------------


def test_rule_score_is_bounded_0_100():
    fv = _fv(
        dwell_median_min=1.0,
        passthrough_ratio=1.0,
        fan_out_1h=50,
        age_at_taint_days=0.0,
        external_flags=["a", "b", "c", "d"],
        hops_to_vasp=0,
        shared_mule_cps=50,
        cross_case_count=50,
    )
    result = compute_rule_score(fv, sanctioned=True, stablecoin_blacklisted=True)
    assert 0.0 <= result.rule_score <= 100.0
    assert result.rule_score == 100.0  # every rule saturated + weights sum to 100


def test_rule_score_is_deterministic():
    fv = _fv(fan_out_1h=7, age_at_taint_days=3.0, external_flags=["x"])
    r1 = compute_rule_score(fv, sanctioned=None, stablecoin_blacklisted=None)
    r2 = compute_rule_score(fv, sanctioned=None, stablecoin_blacklisted=None)
    assert r1.rule_score == r2.rule_score
    assert r1.sub_scores == r2.sub_scores


def test_no_applicable_signal_scores_legitimately_zero():
    fv = _fv()  # everything nullable is None, everything required is at its 0/1-baseline
    result = compute_rule_score(fv, sanctioned=None, stablecoin_blacklisted=None)
    assert result.rule_score == 0.0
    # fan_out and mule_evidence are always-applicable (required fields, 0/1-baseline is a real
    # "nothing observed" value, not missing data) -- they still participate, just contributing 0.
    # Every nullable-signal rule (passthrough, fresh_wallet, external_flags, sanction_blacklist,
    # vasp_exposure) is genuinely not applicable here.
    assert set(result.applicable_rules) == {"fan_out", "mule_evidence"}
    for name in ("passthrough", "fresh_wallet", "external_flags", "sanction_blacklist", "vasp_exposure"):
        assert result.sub_scores[name] is None


# --- per-rule behavior --------------------------------------------------------------------------


def test_passthrough_rule_not_applicable_when_both_inputs_missing():
    fv = _fv(passthrough_ratio=None, dwell_median_min=None)
    result = compute_rule_score(fv)
    assert result.sub_scores["passthrough"] is None


def test_passthrough_rule_high_when_ratio_near_one_and_dwell_fast():
    fv = _fv(passthrough_ratio=1.0, dwell_median_min=10.0)
    result = compute_rule_score(fv)
    assert result.sub_scores["passthrough"] == 100.0


def test_passthrough_rule_decays_with_deviation_and_slow_dwell():
    fv = _fv(passthrough_ratio=1.5, dwell_median_min=PASSTHROUGH_MAX_DWELL_MINUTES * 10)
    result = compute_rule_score(fv)
    assert result.sub_scores["passthrough"] < 50.0


def test_fan_out_rule_always_applicable_zero_at_zero():
    fv = _fv(fan_out_1h=0)
    result = compute_rule_score(fv)
    assert result.sub_scores["fan_out"] == 0.0
    assert "fan_out" in result.applicable_rules


def test_fan_out_rule_saturates_at_threshold_multiple():
    fv = _fv(fan_out_1h=FAN_OUT_MIN_DISTINCT * 2)
    result = compute_rule_score(fv)
    assert result.sub_scores["fan_out"] == 100.0


def test_fresh_wallet_rule_none_when_age_missing():
    fv = _fv(age_at_taint_days=None)
    result = compute_rule_score(fv)
    assert result.sub_scores["fresh_wallet"] is None


def test_fresh_wallet_rule_max_within_threshold():
    fv = _fv(age_at_taint_days=FRESH_WALLET_MAX_AGE_DAYS - 1)
    result = compute_rule_score(fv)
    assert result.sub_scores["fresh_wallet"] == 100.0


def test_fresh_wallet_rule_decays_with_age():
    fv = _fv(age_at_taint_days=FRESH_WALLET_MAX_AGE_DAYS * 2)
    result = compute_rule_score(fv)
    assert 0.0 < result.sub_scores["fresh_wallet"] < 100.0


def test_external_flags_rule_none_when_empty():
    fv = _fv(external_flags=[])
    result = compute_rule_score(fv)
    assert result.sub_scores["external_flags"] is None


def test_external_flags_rule_scales_with_count():
    fv = _fv(external_flags=["a"])
    result = compute_rule_score(fv)
    assert 0.0 < result.sub_scores["external_flags"] < 100.0


def test_sanction_blacklist_rule_unknown_when_both_none():
    fv = _fv()
    result = compute_rule_score(fv, sanctioned=None, stablecoin_blacklisted=None)
    assert result.sub_scores["sanction_blacklist"] is None


def test_sanction_blacklist_rule_negative_evidence_is_zero_not_none():
    fv = _fv()
    result = compute_rule_score(fv, sanctioned=False, stablecoin_blacklisted=False)
    assert result.sub_scores["sanction_blacklist"] == 0.0
    assert "sanction_blacklist" in result.applicable_rules


def test_sanction_blacklist_rule_true_saturates():
    fv = _fv()
    result = compute_rule_score(fv, sanctioned=True, stablecoin_blacklisted=None)
    assert result.sub_scores["sanction_blacklist"] == 100.0


def test_vasp_exposure_rule_none_when_missing():
    fv = _fv(hops_to_vasp=None)
    result = compute_rule_score(fv)
    assert result.sub_scores["vasp_exposure"] is None


def test_vasp_exposure_rule_high_when_close():
    fv = _fv(hops_to_vasp=0)
    result = compute_rule_score(fv)
    assert result.sub_scores["vasp_exposure"] == 100.0


def test_mule_evidence_rule_always_applicable_baseline_zero():
    fv = _fv(shared_mule_cps=0, cross_case_count=1)
    result = compute_rule_score(fv)
    assert result.sub_scores["mule_evidence"] == 0.0


def test_mule_evidence_rule_rises_with_shared_cps_and_cross_case_count():
    fv = _fv(shared_mule_cps=5, cross_case_count=4)
    result = compute_rule_score(fv)
    assert result.sub_scores["mule_evidence"] == 100.0
