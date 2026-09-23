import pytest

from app.training import BinaryLabel, compute_scale_pos_weight


def test_computes_negatives_over_positives():
    labels = [BinaryLabel.POSITIVE, BinaryLabel.NEGATIVE, BinaryLabel.NEGATIVE, BinaryLabel.NEGATIVE]
    assert compute_scale_pos_weight(labels) == 3.0


def test_raises_with_zero_positives():
    with pytest.raises(ValueError, match="positive"):
        compute_scale_pos_weight([BinaryLabel.NEGATIVE, BinaryLabel.NEGATIVE])


def test_raises_with_zero_negatives():
    with pytest.raises(ValueError, match="negative"):
        compute_scale_pos_weight([BinaryLabel.POSITIVE, BinaryLabel.POSITIVE])


def test_balanced_classes_give_a_weight_of_one():
    assert compute_scale_pos_weight([BinaryLabel.POSITIVE, BinaryLabel.NEGATIVE]) == 1.0
