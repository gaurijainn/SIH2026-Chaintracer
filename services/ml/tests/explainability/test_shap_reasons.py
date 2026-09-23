"""B7.5: SHAP-based reason generation. Positive-only, present-and-meaningful-only, ranked,
<=5, no fabrication, and the additivity sanity check (base_value + sum(shap) ~= raw margin output),
same tolerance convention as B7.4's own check (tests/training/test_train_tron_integration.py)."""
from __future__ import annotations

import pytest

from app.explainability.shap_reasons import MAX_REASONS, MIN_REASONS_FOR_NO_STATUS, STATUS_INSUFFICIENT, STATUS_OK, explain
from app.features.schema import FEATURE_NAMES, FeatureVector
from app.inference.features import build_inference_row
from app.models.paths import tron_model_path

_ARTIFACTS_TRAINED = tron_model_path("v1").exists()
pytestmark = pytest.mark.skipif(not _ARTIFACTS_TRAINED, reason="real v1 TRON artifacts not present in this test session")

_RECONSTRUCTION_TOLERANCE = 1e-4  # matches B7.4's own SHAP sanity-check tolerance


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


def test_reconstruction_sanity_check_holds_for_a_live_row():
    fv = _fv(dwell_median_min=5.0, fan_out_1h=10, passthrough_ratio=0.99, age_at_taint_days=1.0, shared_mule_cps=6)
    row = build_inference_row(fv)
    result = explain(row.values)
    assert result.reconstruction_error < _RECONSTRUCTION_TOLERANCE


def test_factors_are_positive_only():
    fv = _fv(dwell_median_min=5.0, fan_out_1h=10, passthrough_ratio=0.99, age_at_taint_days=1.0, shared_mule_cps=6, round_amount_ratio=0.9)
    row = build_inference_row(fv)
    result = explain(row.values)
    assert all(f["impact"] > 0 for f in result.factors)


def test_factors_never_exceed_max_reasons():
    fv = _fv(dwell_median_min=1.0, fan_out_1h=20, fan_in_unique=20, passthrough_ratio=1.0, age_at_taint_days=0.0, activator_label="X", trx_dust_usdt=True, round_amount_ratio=1.0, burst_tx_per_hour=20, external_flags=["a", "b", "c"], shared_mule_cps=10, cross_case_count=10)
    row = build_inference_row(fv)
    result = explain(row.values)
    assert len(result.factors) <= MAX_REASONS


def test_no_reason_for_missing_or_zero_baseline_features():
    fv = _fv()  # everything missing/baseline
    row = build_inference_row(fv)
    result = explain(row.values)
    reasoned_features = {f["feature"] for f in result.factors}
    # None of the always-missing/zero-baseline features may appear, even if SHAP assigned them a
    # nonzero (near-zero, from an always-NaN training column) contribution.
    assert "hops_from_victim" not in reasoned_features
    assert "fan_out_1h" not in reasoned_features


def test_explanation_status_reflects_reason_count():
    # A request with genuinely no strong positive signal -> likely < 3 reasons -> insufficient.
    fv = _fv()
    row = build_inference_row(fv)
    result = explain(row.values)
    if len(result.factors) < MIN_REASONS_FOR_NO_STATUS:
        assert result.explanation_status == STATUS_INSUFFICIENT
    else:
        assert result.explanation_status == STATUS_OK


def test_reason_text_uses_verbatim_plan_phrasing_for_the_four_pdf_examples():
    fv = _fv(dwell_median_min=12.0, shared_mule_cps=6, fan_out_1h=9, age_at_taint_days=2.0)
    row = build_inference_row(fv)
    result = explain(row.values)
    reasons_by_feature = {f["feature"]: f["reason"] for f in result.factors}
    if "dwell_median_min" in reasons_by_feature:
        assert reasons_by_feature["dwell_median_min"] == "Forwards funds a median 12 min after receiving them"
    if "fan_out_1h" in reasons_by_feature:
        assert reasons_by_feature["fan_out_1h"] == "Split incoming funds across 9 wallets within an hour"
    if "age_at_taint_days" in reasons_by_feature:
        assert reasons_by_feature["age_at_taint_days"] == "Wallet was 2 days old when it received victim funds"
    if "shared_mule_cps" in reasons_by_feature:
        assert reasons_by_feature["shared_mule_cps"] == "Shares 6 counterparties with a known mule ring"
