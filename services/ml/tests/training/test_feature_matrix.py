"""B7.4: app/training/feature_matrix.py -- the 15-column, FEATURE_NAMES-ordered matrix builder,
against small synthetic DatasetRow fixtures (not the real CSV -- that's covered by the slower
integration test in tests/training/test_train_tron_integration.py).
"""
import math
from datetime import datetime, timezone

import pytest

from app.datasets import Chain, DatasetLabel, DatasetRow, IdentifierType
from app.features import FEATURE_NAMES
from app.training.feature_matrix import (
    ACTIVATOR_LABEL_BUCKETS,
    build_feature_matrix,
    encode_activator_label,
    encode_external_flags_count,
)
from app.training.labels import BinaryLabel

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def full_row(identifier="addr-full", label=DatasetLabel.HIGH_RISK) -> DatasetRow:
    return DatasetRow(
        identifier=identifier,
        identifier_type=IdentifierType.ADDRESS,
        chain=Chain.TRON,
        label=label,
        timestamp=T0,
        source="tron-bootstrap",
        features={
            "dwell_median_min": 32.75,
            "fan_out_1h": 1.0,
            "fan_in_unique": 1.0,
            "passthrough_ratio": 1.0,
            "age_at_taint_days": 5.0,
            "round_amount_ratio": 0.5,
            "burst_tx_per_hour": 3.0,
            "shared_mule_cps": 2.0,
            "cross_case_count": 1.0,
            "trx_dust_usdt": 0.0,
        },
        extra={"activator_label": "TFS9frnykucuhk4f3M94o5hTm9igDM5iPN", "external_flags": '["high_risk"]'},
    )


def test_full_row_has_all_15_canonical_columns_in_canonical_order():
    result = build_feature_matrix([full_row()])
    assert list(result.dataframe.columns) == list(FEATURE_NAMES)


def test_full_row_pure_numeric_fields_pass_through_unchanged():
    result = build_feature_matrix([full_row()])
    r = result.dataframe.iloc[0]
    assert r["dwell_median_min"] == 32.75
    assert r["fan_out_1h"] == 1.0
    assert r["age_at_taint_days"] == 5.0
    assert r["shared_mule_cps"] == 2.0
    assert r["cross_case_count"] == 1.0


def test_missing_activator_label_is_nan_never_bucket_zero():
    row = full_row()
    row = row.model_copy(update={"extra": {k: v for k, v in row.extra.items() if k != "activator_label"}})
    result = build_feature_matrix([row])
    val = result.dataframe.iloc[0]["activator_label"]
    assert math.isnan(val)


def test_present_activator_label_is_a_valid_bucket_in_range():
    result = build_feature_matrix([full_row()])
    val = result.dataframe.iloc[0]["activator_label"]
    assert 0 <= val < ACTIVATOR_LABEL_BUCKETS


def test_activator_label_encoding_is_deterministic():
    a = encode_activator_label("TFS9frnykucuhk4f3M94o5hTm9igDM5iPN")
    b = encode_activator_label("TFS9frnykucuhk4f3M94o5hTm9igDM5iPN")
    assert a == b
    assert math.isnan(encode_activator_label(None))


def test_external_flags_absent_defaults_to_zero_count():
    row = full_row()
    row = row.model_copy(update={"extra": {k: v for k, v in row.extra.items() if k != "external_flags"}})
    result = build_feature_matrix([row])
    assert result.dataframe.iloc[0]["external_flags"] == 0.0


def test_external_flags_json_string_is_parsed_to_a_count():
    assert encode_external_flags_count('["high_risk"]') == 1.0
    assert encode_external_flags_count("[]") == 0.0
    assert encode_external_flags_count('["reported","high_risk"]') == 2.0
    assert encode_external_flags_count(None) == 0.0
    assert encode_external_flags_count(["already", "parsed"]) == 2.0


def test_structurally_unavailable_columns_are_present_but_always_nan_when_absent():
    result = build_feature_matrix([full_row()])
    r = result.dataframe.iloc[0]
    assert math.isnan(r["hops_from_victim"])
    assert math.isnan(r["hops_to_vasp"])
    assert math.isnan(r["sanction_exposure"])


def test_trx_dust_usdt_boolean_parsing_from_features_dict():
    row_true = full_row().model_copy(update={"features": {**full_row().features, "trx_dust_usdt": 1.0}})
    result = build_feature_matrix([row_true])
    assert result.dataframe.iloc[0]["trx_dust_usdt"] == 1.0


def test_trx_dust_usdt_boolean_parsing_from_extra_string_fallback():
    row = full_row()
    features_without_dust = {k: v for k, v in row.features.items() if k != "trx_dust_usdt"}
    row = row.model_copy(update={"features": features_without_dust, "extra": {**row.extra, "trx_dust_usdt": "true"}})
    result = build_feature_matrix([row])
    assert result.dataframe.iloc[0]["trx_dust_usdt"] == 1.0


def test_trx_dust_usdt_missing_entirely_is_nan():
    row = full_row()
    features_without_dust = {k: v for k, v in row.features.items() if k != "trx_dust_usdt"}
    row = row.model_copy(update={"features": features_without_dust})
    result = build_feature_matrix([row])
    assert math.isnan(result.dataframe.iloc[0]["trx_dust_usdt"])


def test_labels_identifiers_and_missingness_are_aligned_with_the_dataframe():
    rows = [full_row("addr1", DatasetLabel.HIGH_RISK), full_row("addr2", DatasetLabel.LICIT)]
    result = build_feature_matrix(rows)
    assert result.labels == [BinaryLabel.POSITIVE, BinaryLabel.NEGATIVE]
    assert result.identifiers == ["addr1", "addr2"]
    assert result.missingness["hops_from_victim"] == 2
    assert result.missingness["dwell_median_min"] == 0


def test_unresolvable_label_raises_rather_than_silently_dropping():
    row = full_row(label=DatasetLabel.UNKNOWN)
    with pytest.raises(ValueError, match="unresolvable label"):
        build_feature_matrix([row])
