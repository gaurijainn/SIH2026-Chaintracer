"""B7.2: loader behavior against small synthetic fixtures — local files only, no downloads."""
from pathlib import Path

import pytest

from app.datasets import BenchmarkDataset, Chain, DatasetLabel, IdentifierType, TrainingDataset
from app.datasets.loaders import (
    Elliptic2Loader,
    EllipticLoader,
    EllipticPlusPlusLoader,
    KaggleEthFraudLoader,
    TronBootstrapLoader,
)

FIXTURES = Path(__file__).parent.parent / "fixtures" / "datasets"


class TestKaggleEthFraudLoader:
    def test_loads_a_valid_file_into_a_training_dataset(self):
        ds = KaggleEthFraudLoader().load(FIXTURES / "kaggle_eth_fraud_valid.csv")
        assert isinstance(ds, TrainingDataset)
        assert len(ds.rows) == 4
        assert ds.manifest.local_path == str(FIXTURES / "kaggle_eth_fraud_valid.csv")

    def test_maps_flag_to_illicit_licit_and_carries_numeric_features(self):
        ds = KaggleEthFraudLoader().load(FIXTURES / "kaggle_eth_fraud_valid.csv")
        by_id = {r.identifier: r for r in ds.rows}
        assert by_id["0xaaa1"].label == DatasetLabel.LICIT
        assert by_id["0xaaa2"].label == DatasetLabel.ILLICIT
        assert by_id["0xaaa1"].chain == Chain.ETH
        assert by_id["0xaaa1"].identifier_type == IdentifierType.ADDRESS
        assert by_id["0xaaa1"].features["avg min between sent tnx"] == 12.5

    def test_non_numeric_column_goes_to_extra_not_features(self):
        ds = KaggleEthFraudLoader().load(FIXTURES / "kaggle_eth_fraud_valid.csv")
        row = next(r for r in ds.rows if r.identifier == "0xaaa1")
        assert "erc20 most sent token" not in row.features
        assert row.extra["erc20 most sent token"] == "USDT"

    def test_raises_on_a_missing_required_column(self):
        with pytest.raises(ValueError, match="missing required columns"):
            KaggleEthFraudLoader().load(FIXTURES / "kaggle_eth_fraud_missing_column.csv")


class TestTronBootstrapLoader:
    def test_loads_a_valid_file_into_a_training_dataset(self):
        ds = TronBootstrapLoader().load(FIXTURES / "tron_bootstrap_valid.csv")
        assert isinstance(ds, TrainingDataset)
        assert len(ds.rows) == 4
        labels = {r.identifier: r.label for r in ds.rows}
        assert labels["TAAA1"] == DatasetLabel.HIGH_RISK
        assert labels["TAAA3"] == DatasetLabel.LICIT

    def test_rows_are_chain_tron_and_carry_source_detail(self):
        ds = TronBootstrapLoader().load(FIXTURES / "tron_bootstrap_valid.csv")
        row = next(r for r in ds.rows if r.identifier == "TAAA1")
        assert row.chain == Chain.TRON
        assert row.extra["source_detail"] == "usdt_blacklist"
        assert row.timestamp is not None

    def test_evidence_and_confidence_are_preserved_from_the_source_row(self):
        ds = TronBootstrapLoader().load(FIXTURES / "tron_bootstrap_valid.csv")
        row = next(r for r in ds.rows if r.identifier == "TAAA1")
        assert row.extra["evidence"] == {"event": "AddedBlackList", "tx": "0xabc"}
        assert row.extra["confidence"] == 0.95

    def test_non_json_evidence_is_kept_as_a_raw_string_not_dropped(self):
        ds = TronBootstrapLoader().load(FIXTURES / "tron_bootstrap_valid.csv")
        row = next(r for r in ds.rows if r.identifier == "TAAA3")
        assert row.extra["evidence"] == "active USDT holder, no flags"

    def test_account_age_days_is_carried_as_a_feature(self):
        ds = TronBootstrapLoader().load(FIXTURES / "tron_bootstrap_valid.csv")
        row = next(r for r in ds.rows if r.identifier == "TAAA1")
        assert row.features["account_age_days"] == 5.0

    def test_duplicate_addresses_are_reported_but_do_not_block_loading(self):
        ds = TronBootstrapLoader().load(FIXTURES / "tron_bootstrap_duplicate_ids.csv")
        assert ds.validation.duplicate_count == 1
        assert len(ds.rows) == 3  # every row is still loaded; dedup is a training-time decision

    def test_raises_on_an_invalid_label_value(self):
        with pytest.raises(ValueError, match="invalid label"):
            TronBootstrapLoader().load(FIXTURES / "tron_bootstrap_bad_label.csv")

    def test_raises_on_an_invalid_chain_value(self):
        with pytest.raises(ValueError, match="invalid chain"):
            TronBootstrapLoader().load(FIXTURES / "tron_bootstrap_bad_chain.csv")

    def test_raises_on_a_confidence_value_outside_zero_to_one(self):
        with pytest.raises(ValueError, match="confidence"):
            TronBootstrapLoader().load(FIXTURES / "tron_bootstrap_bad_confidence.csv")

    def test_raises_on_an_unparseable_timestamp_rather_than_silently_dropping_it(self):
        """B7.4: every training row must carry a real timestamp (never invented) -- unlike B7.2's
        original behaviour, an unparseable fetched_at is now a hard failure, not a null timestamp."""
        with pytest.raises(ValueError, match="timestamp"):
            TronBootstrapLoader().load(FIXTURES / "tron_bootstrap_bad_timestamp.csv")


class TestEllipticLoader:
    def test_loads_classes_only_as_a_benchmark_dataset(self):
        ds = EllipticLoader().load(FIXTURES / "elliptic_classes_valid.csv")
        assert isinstance(ds, BenchmarkDataset)
        assert len(ds.rows) == 4
        labels = {r.identifier: r.label for r in ds.rows}
        assert labels["230425980"] == DatasetLabel.ILLICIT
        assert labels["230425981"] == DatasetLabel.LICIT
        assert labels["230425982"] == DatasetLabel.UNKNOWN

    def test_rows_have_no_features_when_features_file_is_not_given(self):
        ds = EllipticLoader().load(FIXTURES / "elliptic_classes_valid.csv")
        assert all(r.features == {} for r in ds.rows)

    def test_merges_in_features_by_txid_when_features_path_is_given(self):
        loader = EllipticLoader(features_path=FIXTURES / "elliptic_features_valid.csv")
        ds = loader.load(FIXTURES / "elliptic_classes_valid.csv")
        row = next(r for r in ds.rows if r.identifier == "230425980")
        assert row.features == {"f1": 0.1, "f2": 0.2, "f3": 0.3}

    def test_transaction_identifier_type_and_btc_chain(self):
        ds = EllipticLoader().load(FIXTURES / "elliptic_classes_valid.csv")
        assert all(r.identifier_type == IdentifierType.TRANSACTION and r.chain == Chain.BTC for r in ds.rows)

    def test_raises_on_an_invalid_class_value(self):
        with pytest.raises(ValueError, match="invalid label"):
            EllipticLoader().load(FIXTURES / "elliptic_bad_class.csv")


class TestElliptic2Loader:
    def test_loads_a_subgraph_summary_as_a_benchmark_dataset(self):
        ds = Elliptic2Loader().load(FIXTURES / "elliptic2_valid.csv")
        assert isinstance(ds, BenchmarkDataset)
        assert len(ds.rows) == 3
        row = next(r for r in ds.rows if r.identifier == "sg-1")
        assert row.identifier_type == IdentifierType.SUBGRAPH
        assert row.label == DatasetLabel.ILLICIT
        assert row.features == {"num_nodes": 42.0, "num_edges": 80.0}


class TestEllipticPlusPlusLoader:
    def test_loads_an_address_level_file_as_a_benchmark_dataset(self):
        ds = EllipticPlusPlusLoader().load(FIXTURES / "elliptic_plus_plus_valid.csv")
        assert isinstance(ds, BenchmarkDataset)
        assert len(ds.rows) == 3
        row = next(r for r in ds.rows if r.identifier == "bc1aaa1")
        assert row.identifier_type == IdentifierType.ADDRESS
        assert row.label == DatasetLabel.ILLICIT
        assert row.features["total_txs"] == 120.0
