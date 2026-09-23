from datetime import datetime, timedelta, timezone

import pytest

from app.datasets import Chain, DatasetLabel, DatasetRow, IdentifierType
from app.training import build_temporal_split

T0 = datetime(2026, 9, 1, tzinfo=timezone.utc)


def row(i: int, ts: datetime | None) -> DatasetRow:
    return DatasetRow(identifier=f"addr{i}", identifier_type=IdentifierType.ADDRESS, chain=Chain.TRON, label=DatasetLabel.HIGH_RISK, source="s", timestamp=ts)


def test_splits_chronologically_with_test_strictly_after_calibration_strictly_after_train():
    rows = [row(i, T0 + timedelta(days=i)) for i in range(10)]
    split = build_temporal_split(rows, train_frac=0.6, calibration_frac=0.2)
    assert len(split.train) + len(split.calibration) + len(split.test) == 10
    assert max(r.timestamp for r in split.train) < min(r.timestamp for r in split.calibration)
    assert max(r.timestamp for r in split.calibration) < min(r.timestamp for r in split.test)


def test_raises_when_any_row_has_no_timestamp():
    rows = [row(0, T0), row(1, None), row(2, T0 + timedelta(days=1))]
    with pytest.raises(ValueError, match="timestamp"):
        build_temporal_split(rows)


def test_never_splits_rows_sharing_the_exact_same_timestamp_across_a_boundary():
    # 4 distinct timestamps (3+3+3+1 rows) so the naive 50%/80% index cuts land mid-tie group,
    # forcing the boundary to extend -- but a lone final timestamp keeps `test` non-empty.
    rows = (
        [row(i, T0) for i in range(3)]
        + [row(i, T0 + timedelta(days=1)) for i in range(3, 6)]
        + [row(i, T0 + timedelta(days=2)) for i in range(6, 9)]
        + [row(9, T0 + timedelta(days=3))]
    )
    split = build_temporal_split(rows, train_frac=0.5, calibration_frac=0.3)
    train_ts = {r.timestamp for r in split.train}
    cal_ts = {r.timestamp for r in split.calibration}
    test_ts = {r.timestamp for r in split.test}
    assert train_ts.isdisjoint(cal_ts)
    assert cal_ts.isdisjoint(test_ts)
    assert len(split.test) > 0


def test_raises_on_zero_rows():
    with pytest.raises(ValueError, match="zero rows"):
        build_temporal_split([])


def test_raises_when_fractions_leave_no_room_for_test():
    rows = [row(i, T0 + timedelta(days=i)) for i in range(5)]
    with pytest.raises(ValueError):
        build_temporal_split(rows, train_frac=0.7, calibration_frac=0.4)


def test_is_deterministic_regardless_of_input_order():
    ordered = [row(i, T0 + timedelta(days=i)) for i in range(10)]
    shuffled = list(reversed(ordered))
    a = build_temporal_split(ordered)
    b = build_temporal_split(shuffled)
    assert [r.identifier for r in a.train] == [r.identifier for r in b.train]
    assert [r.identifier for r in a.calibration] == [r.identifier for r in b.calibration]
    assert [r.identifier for r in a.test] == [r.identifier for r in b.test]
