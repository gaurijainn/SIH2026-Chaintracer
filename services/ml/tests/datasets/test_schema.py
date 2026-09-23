"""B7.2: DatasetRow schema — required vs nullable fields, label/chain enum validation."""
import pytest
from pydantic import ValidationError

from app.datasets import Chain, DatasetLabel, DatasetRow, IdentifierType


def test_minimal_valid_row():
    row = DatasetRow(
        identifier="0xabc",
        identifier_type=IdentifierType.ADDRESS,
        chain=Chain.ETH,
        label=DatasetLabel.LICIT,
        source="kaggle-eth-fraud",
    )
    assert row.timestamp is None
    assert row.features == {}
    assert row.extra == {}


def test_rejects_an_empty_identifier():
    with pytest.raises(ValidationError):
        DatasetRow(identifier="", identifier_type=IdentifierType.ADDRESS, chain=Chain.ETH, label=DatasetLabel.LICIT, source="x")


def test_rejects_an_unknown_label_value():
    with pytest.raises(ValidationError):
        DatasetRow(identifier="a", identifier_type=IdentifierType.ADDRESS, chain=Chain.ETH, label="criminal", source="x")  # type: ignore[arg-type]


def test_rejects_an_unknown_chain_value():
    with pytest.raises(ValidationError):
        DatasetRow(identifier="a", identifier_type=IdentifierType.ADDRESS, chain="DOGE", label=DatasetLabel.LICIT, source="x")  # type: ignore[arg-type]


def test_rejects_an_unknown_extra_field():
    with pytest.raises(ValidationError):
        DatasetRow(identifier="a", identifier_type=IdentifierType.ADDRESS, chain=Chain.ETH, label=DatasetLabel.LICIT, source="x", not_a_field=1)  # type: ignore[call-arg]


def test_row_is_immutable():
    row = DatasetRow(identifier="a", identifier_type=IdentifierType.ADDRESS, chain=Chain.ETH, label=DatasetLabel.LICIT, source="x")
    with pytest.raises(Exception):
        row.label = DatasetLabel.ILLICIT  # type: ignore[misc]


def test_high_risk_label_is_distinct_from_illicit():
    """Plan B6/B7 neutrality rule: TRON bootstrap labels are 'high_risk', never 'criminal'/'illicit'."""
    assert DatasetLabel.HIGH_RISK != DatasetLabel.ILLICIT
    assert DatasetLabel.HIGH_RISK.value == "high_risk"


def test_subgraph_identifier_type_exists_for_elliptic2():
    assert IdentifierType.SUBGRAPH.value == "subgraph"
