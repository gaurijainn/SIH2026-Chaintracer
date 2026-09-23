"""Label collapsing for the future binary TRON risk model (plan B7's hybrid score is fundamentally
binary: risk vs. not). B7.2's DatasetLabel has four values because different datasets report
different things; this module is the one place that decides how each collapses onto a training
target, so the rule is never duplicated or re-decided ad hoc elsewhere.
"""
from __future__ import annotations

from enum import Enum

from ..datasets import DatasetLabel


class BinaryLabel(str, Enum):
    POSITIVE = "positive"
    NEGATIVE = "negative"


#: high_risk (TRON bootstrap's own vocabulary) and illicit (Elliptic/Kaggle-style vocabulary, kept
#: here in case a future training source uses it) both collapse to POSITIVE; licit to NEGATIVE.
_POSITIVE = {DatasetLabel.HIGH_RISK, DatasetLabel.ILLICIT}
_NEGATIVE = {DatasetLabel.LICIT}


def collapse_label(label: DatasetLabel) -> BinaryLabel | None:
    """Returns the binary training target for `label`, or None for DatasetLabel.UNKNOWN -- an
    unknown-label row must be excluded from training, never guessed as positive or negative."""
    if label in _POSITIVE:
        return BinaryLabel.POSITIVE
    if label in _NEGATIVE:
        return BinaryLabel.NEGATIVE
    return None
