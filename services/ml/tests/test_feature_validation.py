"""B7.1: FeatureVector validation — bad input is rejected rather than silently accepted."""
import pytest
from pydantic import ValidationError

from app.features import FeatureVector

VALID = dict(fan_out_1h=0, fan_in_unique=0, trx_dust_usdt=False, round_amount_ratio=0.0, burst_tx_per_hour=0, shared_mule_cps=0, cross_case_count=1)


def test_rejects_an_unknown_feature_name():
    with pytest.raises(ValidationError):
        FeatureVector(**VALID, not_a_real_feature=1)


def test_rejects_a_missing_required_field():
    incomplete = dict(VALID)
    del incomplete["fan_out_1h"]
    with pytest.raises(ValidationError):
        FeatureVector(**incomplete)


@pytest.mark.parametrize("field", ["fan_out_1h", "fan_in_unique", "burst_tx_per_hour", "shared_mule_cps", "cross_case_count"])
def test_rejects_a_negative_count_field(field: str):
    with pytest.raises(ValidationError):
        FeatureVector(**{**VALID, field: -1})


def test_accepts_cross_case_count_of_zero():
    # B7.5 cleanup: the real tron-bootstrap-v1 dataset has cross_case_count=0 for every row (B5's
    # cross-case linkage isn't wired into the bootstrap collector yet), so 0 must be a valid value,
    # not rejected -- it means "appears in zero cases so far", not "missing".
    v = FeatureVector(**{**VALID, "cross_case_count": 0})
    assert v.cross_case_count == 0


def test_rejects_a_round_amount_ratio_outside_zero_to_one():
    with pytest.raises(ValidationError):
        FeatureVector(**{**VALID, "round_amount_ratio": 1.5})
    with pytest.raises(ValidationError):
        FeatureVector(**{**VALID, "round_amount_ratio": -0.1})


def test_rejects_wrong_type_for_trx_dust_usdt():
    # pydantic's lax bool parsing does accept a handful of truthy/falsy strings ("yes", "1", ...),
    # so use a value with no bool coercion at all to test type rejection itself.
    with pytest.raises(ValidationError):
        FeatureVector(**{**VALID, "trx_dust_usdt": ["not", "a", "bool"]})


def test_rejects_a_non_list_external_flags():
    with pytest.raises(ValidationError):
        FeatureVector(**{**VALID, "external_flags": "fraudTransaction"})


def test_accepts_a_fully_populated_valid_vector():
    v = FeatureVector(
        **VALID,
        dwell_median_min=12.5,
        passthrough_ratio=0.9,
        age_at_taint_days=3.0,
        activator_label="exchange",
        hops_from_victim=1,
        hops_to_vasp=2,
        sanction_exposure=0,
        external_flags=["fraudTransaction", "stablecoinBlacklist"],
    )
    assert v.external_flags == ["fraudTransaction", "stablecoinBlacklist"]
