"""B7.1: FEATURE_NAMES / feature_row ordering — the contract training (B7.2+) and inference (B7.2+)
both rely on so a training row and a live scoring request always line up feature-for-feature.
"""
from app.features import FEATURE_NAMES, FeatureVector, feature_row

CANONICAL_ORDER = (
    "dwell_median_min",
    "fan_out_1h",
    "fan_in_unique",
    "passthrough_ratio",
    "age_at_taint_days",
    "activator_label",
    "trx_dust_usdt",
    "round_amount_ratio",
    "burst_tx_per_hour",
    "hops_from_victim",
    "hops_to_vasp",
    "sanction_exposure",
    "external_flags",
    "shared_mule_cps",
    "cross_case_count",
)


def test_feature_names_matches_plan_appendix_b_order_exactly():
    assert FEATURE_NAMES == CANONICAL_ORDER


def test_feature_row_values_line_up_positionally_with_feature_names():
    v = FeatureVector(
        dwell_median_min=1.0,
        fan_out_1h=2,
        fan_in_unique=3,
        passthrough_ratio=0.4,
        age_at_taint_days=5.0,
        activator_label="a",
        trx_dust_usdt=True,
        round_amount_ratio=0.6,
        burst_tx_per_hour=7,
        hops_from_victim=8,
        hops_to_vasp=9,
        sanction_exposure=10,
        external_flags=["x"],
        shared_mule_cps=11,
        cross_case_count=12,
    )
    row = feature_row(v)
    assert len(row) == len(FEATURE_NAMES) == 15
    positional = dict(zip(FEATURE_NAMES, row))
    assert positional == v.model_dump()


def test_feature_row_ordering_is_stable_across_two_different_vectors():
    """Two independently-built vectors must produce rows in the same column order (no dict-ordering drift)."""
    kwargs = dict(fan_out_1h=0, fan_in_unique=0, trx_dust_usdt=False, round_amount_ratio=0.0, burst_tx_per_hour=0, shared_mule_cps=0, cross_case_count=1)
    a = feature_row(FeatureVector(**kwargs))
    b = feature_row(FeatureVector(**kwargs, activator_label="whatever"))
    assert len(a) == len(b)
    # every index except activator_label's must be identical between the two rows
    idx = FEATURE_NAMES.index("activator_label")
    assert [x for i, x in enumerate(a) if i != idx] == [x for i, x in enumerate(b) if i != idx]
