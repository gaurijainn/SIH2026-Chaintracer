"""Class weighting for the future TRON XGBoost model, computed from the TRAIN split only -- never
from the full/unsplit dataset, which would leak the test set's class balance into training.
"""
from __future__ import annotations

from typing import Sequence

from .labels import BinaryLabel


def compute_scale_pos_weight(train_labels: Sequence[BinaryLabel]) -> float:
    """XGBoost's `scale_pos_weight`: negatives / positives, from the training split only."""
    positives = sum(1 for l in train_labels if l == BinaryLabel.POSITIVE)
    negatives = sum(1 for l in train_labels if l == BinaryLabel.NEGATIVE)
    if positives == 0:
        raise ValueError("cannot compute a class weight with zero positive examples in the training split")
    if negatives == 0:
        raise ValueError("cannot compute a class weight with zero negative examples in the training split")
    return negatives / positives
