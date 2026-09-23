from app.datasets import DatasetLabel
from app.training import BinaryLabel, collapse_label


def test_high_risk_collapses_to_positive():
    assert collapse_label(DatasetLabel.HIGH_RISK) == BinaryLabel.POSITIVE


def test_illicit_collapses_to_positive():
    assert collapse_label(DatasetLabel.ILLICIT) == BinaryLabel.POSITIVE


def test_licit_collapses_to_negative():
    assert collapse_label(DatasetLabel.LICIT) == BinaryLabel.NEGATIVE


def test_unknown_is_excluded_never_guessed():
    assert collapse_label(DatasetLabel.UNKNOWN) is None
