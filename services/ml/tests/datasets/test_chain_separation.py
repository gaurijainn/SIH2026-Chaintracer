"""B7.4 Task 5: TRON and Ethereum training data must never be concatenated into one feature matrix."""
from pathlib import Path

import pytest

from app.datasets import Chain, require_chain
from app.datasets.loaders import KaggleEthFraudLoader, TronBootstrapLoader

FIXTURES = Path(__file__).parent.parent / "fixtures" / "datasets"


def test_a_tron_only_dataset_passes_require_chain_tron():
    ds = TronBootstrapLoader().load(FIXTURES / "tron_bootstrap_valid.csv")
    assert require_chain([ds], Chain.TRON) == [ds]


def test_a_tron_dataset_fails_require_chain_eth():
    ds = TronBootstrapLoader().load(FIXTURES / "tron_bootstrap_valid.csv")
    with pytest.raises(ValueError, match="tron-bootstrap"):
        require_chain([ds], Chain.ETH)


def test_an_eth_only_dataset_passes_require_chain_eth():
    ds = KaggleEthFraudLoader().load(FIXTURES / "kaggle_eth_fraud_valid.csv")
    assert require_chain([ds], Chain.ETH) == [ds]


def test_an_eth_dataset_fails_require_chain_tron():
    ds = KaggleEthFraudLoader().load(FIXTURES / "kaggle_eth_fraud_valid.csv")
    with pytest.raises(ValueError, match="kaggle-eth-fraud"):
        require_chain([ds], Chain.TRON)


def test_mixing_tron_and_eth_datasets_is_rejected_by_a_single_require_chain_call():
    tron_ds = TronBootstrapLoader().load(FIXTURES / "tron_bootstrap_valid.csv")
    eth_ds = KaggleEthFraudLoader().load(FIXTURES / "kaggle_eth_fraud_valid.csv")
    with pytest.raises(ValueError):
        require_chain([tron_ds, eth_ds], Chain.TRON)
    with pytest.raises(ValueError):
        require_chain([tron_ds, eth_ds], Chain.ETH)
