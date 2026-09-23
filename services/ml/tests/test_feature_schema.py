"""B7.1: the FeatureVector schema itself — required vs nullable fields, defaults, types."""
import pytest
from pydantic import ValidationError

from app.features import FEATURE_NAMES, FeatureVector, feature_dict


def minimal_kwargs() -> dict:
    """Every field pydantic requires (no default): the ones plan Appendix B always has a value for."""
    return dict(
        fan_out_1h=0,
        fan_in_unique=0,
        trx_dust_usdt=False,
        round_amount_ratio=0.0,
        burst_tx_per_hour=0,
        shared_mule_cps=0,
        cross_case_count=1,
    )


def test_all_fifteen_appendix_b_features_are_present():
    assert len(FEATURE_NAMES) == 15
    assert set(FEATURE_NAMES) == {
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
    }


def test_nullable_fields_default_to_none_when_metadata_is_unavailable():
    v = FeatureVector(**minimal_kwargs())
    assert v.dwell_median_min is None
    assert v.passthrough_ratio is None
    assert v.age_at_taint_days is None
    assert v.activator_label is None
    assert v.hops_from_victim is None
    assert v.hops_to_vasp is None
    assert v.sanction_exposure is None


def test_always_present_fields_have_sensible_defaults_not_none():
    v = FeatureVector(**minimal_kwargs())
    assert v.external_flags == []
    assert v.trx_dust_usdt is False
    assert v.cross_case_count == 1  # a wallet always appears in at least its own case


def test_full_vector_round_trips_through_feature_dict():
    v = FeatureVector(
        dwell_median_min=32.0,
        fan_out_1h=7,
        fan_in_unique=3,
        passthrough_ratio=0.95,
        age_at_taint_days=2.0,
        activator_label="exchange",
        trx_dust_usdt=True,
        round_amount_ratio=0.4,
        burst_tx_per_hour=5,
        hops_from_victim=2,
        hops_to_vasp=1,
        sanction_exposure=None,
        external_flags=["fraudTransaction"],
        shared_mule_cps=3,
        cross_case_count=2,
    )
    d = feature_dict(v)
    assert d["dwell_median_min"] == 32.0
    assert d["activator_label"] == "exchange"
    assert d["external_flags"] == ["fraudTransaction"]


def test_feature_vector_is_immutable():
    v = FeatureVector(**minimal_kwargs())
    try:
        v.fan_out_1h = 5  # type: ignore[misc]
        assert False, "FeatureVector should be frozen"
    except Exception:
        pass


# --- cross_case_count lower bound (B7.5 cleanup regression) -----------------------------------
# The real tron-bootstrap-v1 dataset has cross_case_count=0 for every one of its 500 rows (B5's
# cross-case linkage was never wired into the bootstrap collector -- see the model card's known
# limitations), so ge=1 was wrong: it made POST /score 422 on the single most common real-world
# value. cross_case_count means "how many complaints/cases this wallet appears in so far", and 0
# ("appears in zero cases so far") is a legitimate answer, not a missing/invalid one. The field is
# a plain non-nullable `int` (never `int | None`), so there is no separate "missing vs zero"
# distinction to preserve here, unlike the genuinely-nullable graph features (hops_from_victim,
# hops_to_vasp, sanction_exposure) covered above.


def test_cross_case_count_accepts_zero():
    v = FeatureVector(**{**minimal_kwargs(), "cross_case_count": 0})
    assert v.cross_case_count == 0


def test_cross_case_count_accepts_one():
    v = FeatureVector(**{**minimal_kwargs(), "cross_case_count": 1})
    assert v.cross_case_count == 1


def test_cross_case_count_accepts_values_greater_than_one():
    v = FeatureVector(**{**minimal_kwargs(), "cross_case_count": 7})
    assert v.cross_case_count == 7


def test_cross_case_count_rejects_negative_values():
    with pytest.raises(ValidationError):
        FeatureVector(**{**minimal_kwargs(), "cross_case_count": -1})
