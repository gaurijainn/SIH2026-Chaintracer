"""B7.5: inference-time feature assembly parity with training's own encoders. Verifies column
order/count, NaN-for-missing behavior, and that the exact same encoder functions
(encode_activator_label / encode_external_flags_count) training used produce identical results
here -- never a re-implementation that could silently drift."""
from __future__ import annotations

import math

import numpy as np

from app.features.schema import FEATURE_NAMES, FeatureVector
from app.inference.features import build_inference_row
from app.training.feature_matrix import encode_activator_label, encode_external_flags_count


def _full_fv(**overrides) -> FeatureVector:
    base = dict(
        dwell_median_min=15.0,
        fan_out_1h=3,
        fan_in_unique=4,
        passthrough_ratio=0.9,
        age_at_taint_days=10.0,
        activator_label="TSomeAddr",
        trx_dust_usdt=True,
        round_amount_ratio=0.5,
        burst_tx_per_hour=6,
        hops_from_victim=2,
        hops_to_vasp=1,
        sanction_exposure=0,
        external_flags=["a", "b"],
        shared_mule_cps=2,
        cross_case_count=1,
    )
    base.update(overrides)
    return FeatureVector(**base)


def test_row_has_exactly_15_columns_in_canonical_order():
    row = build_inference_row(_full_fv())
    assert row.values.shape == (15,)
    assert row.feature_names == FEATURE_NAMES


def test_missing_nullable_fields_become_nan():
    fv = _full_fv(dwell_median_min=None, passthrough_ratio=None, age_at_taint_days=None, activator_label=None, hops_from_victim=None, hops_to_vasp=None, sanction_exposure=None)
    row = build_inference_row(fv)
    for name in ("dwell_median_min", "passthrough_ratio", "age_at_taint_days", "hops_from_victim", "hops_to_vasp", "sanction_exposure"):
        idx = FEATURE_NAMES.index(name)
        assert math.isnan(row.values[idx])
        assert row.present[name] is False
    idx = FEATURE_NAMES.index("activator_label")
    assert math.isnan(row.values[idx])


def test_activator_label_uses_the_exact_training_encoder():
    fv = _full_fv(activator_label="TAbc123")
    row = build_inference_row(fv)
    idx = FEATURE_NAMES.index("activator_label")
    assert row.values[idx] == encode_activator_label("TAbc123")


def test_external_flags_uses_the_exact_training_encoder():
    fv = _full_fv(external_flags=["high_risk", "reported", "x"])
    row = build_inference_row(fv)
    idx = FEATURE_NAMES.index("external_flags")
    assert row.values[idx] == encode_external_flags_count(["high_risk", "reported", "x"])


def test_trx_dust_usdt_encoded_as_1_or_0():
    row_true = build_inference_row(_full_fv(trx_dust_usdt=True))
    row_false = build_inference_row(_full_fv(trx_dust_usdt=False))
    idx = FEATURE_NAMES.index("trx_dust_usdt")
    assert row_true.values[idx] == 1.0
    assert row_false.values[idx] == 0.0


def test_present_dict_covers_all_15_fields():
    row = build_inference_row(_full_fv())
    assert set(row.present.keys()) == set(FEATURE_NAMES)


def test_deterministic_same_input_same_output():
    fv = _full_fv()
    r1 = build_inference_row(fv)
    r2 = build_inference_row(fv)
    assert np.array_equal(r1.values, r2.values, equal_nan=True)
