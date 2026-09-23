"""Deterministic time-based train/calibration/test split (plan B7: "time-based split"; bootstrap
box: "split train/test by time to avoid leakage"). Every row must carry a real timestamp -- a
training row with no timestamp cannot be placed in a temporal ordering at all, so this refuses to
run rather than silently dropping it or inventing one.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from ..datasets import DatasetRow


@dataclass(frozen=True)
class TemporalSplit:
    train: list[DatasetRow]
    calibration: list[DatasetRow]
    test: list[DatasetRow]


def _extend_past_ties(ordered: Sequence[DatasetRow], idx: int) -> int:
    """Never splits two rows that share the exact same timestamp across a boundary, so the test
    period is always strictly later than calibration, which is always strictly later than train."""
    while 0 < idx < len(ordered) and ordered[idx].timestamp == ordered[idx - 1].timestamp:
        idx += 1
    return idx


def build_temporal_split(rows: Sequence[DatasetRow], *, train_frac: float = 0.6, calibration_frac: float = 0.2) -> TemporalSplit:
    """Sorts `rows` chronologically and cuts them into TRAIN (earliest), CALIBRATION (next) and TEST
    (latest) by the given fractions. Raises if any row has no timestamp, or if the fractions leave
    an empty split (a split with no rows cannot train/calibrate/evaluate anything honestly).
    """
    if not 0 < train_frac < 1 or not 0 < calibration_frac < 1 or train_frac + calibration_frac >= 1:
        raise ValueError(f"train_frac ({train_frac}) and calibration_frac ({calibration_frac}) must each be in (0, 1) and leave a non-empty test fraction")

    missing = sorted(r.identifier for r in rows if r.timestamp is None)
    if missing:
        raise ValueError(f"rows without a timestamp cannot be placed in a temporal split (never invented): {missing}")

    ordered = sorted(rows, key=lambda r: r.timestamp)  # type: ignore[arg-type,return-value]
    n = len(ordered)
    if n == 0:
        raise ValueError("cannot build a temporal split from zero rows")

    train_end = _extend_past_ties(ordered, round(n * train_frac))
    cal_end = _extend_past_ties(ordered, max(train_end, round(n * (train_frac + calibration_frac))))

    train, calibration, test = ordered[:train_end], ordered[train_end:cal_end], ordered[cal_end:]
    if not train or not calibration or not test:
        raise ValueError(
            f"temporal split produced an empty partition (train={len(train)}, calibration={len(calibration)}, test={len(test)}) "
            "-- too few rows or too many rows sharing one timestamp for the requested fractions"
        )
    return TemporalSplit(train=train, calibration=calibration, test=test)
