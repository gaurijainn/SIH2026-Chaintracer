"""B7.2: training/benchmark separation — a benchmark dataset must never be usable as training data,
and vice versa, enforced at runtime (not just by type hints)."""
import pytest

from app.datasets import (
    BenchmarkDataset,
    DatasetManifest,
    DatasetPurpose,
    TrainingDataset,
    require_benchmark,
    require_training,
)
from app.datasets.validation import ValidationReport

EMPTY_REPORT = ValidationReport(row_count=0, duplicate_count=0, missing_by_column={}, invalid_labels=[], label_counts={}, timestamp_parse_failures=0)


def make_training(name: str = "t1") -> TrainingDataset:
    m = DatasetManifest(name=name, source="s", purpose=DatasetPurpose.TRAINING, version="1")
    return TrainingDataset(manifest=m, rows=[], validation=EMPTY_REPORT)


def make_benchmark(name: str = "b1") -> BenchmarkDataset:
    m = DatasetManifest(name=name, source="s", purpose=DatasetPurpose.BENCHMARK, version="1")
    return BenchmarkDataset(manifest=m, rows=[], validation=EMPTY_REPORT)


def test_training_dataset_rejects_a_benchmark_manifest():
    m = DatasetManifest(name="wrong", source="s", purpose=DatasetPurpose.BENCHMARK, version="1")
    with pytest.raises(ValueError):
        TrainingDataset(manifest=m, rows=[], validation=EMPTY_REPORT)


def test_benchmark_dataset_rejects_a_training_manifest():
    m = DatasetManifest(name="wrong", source="s", purpose=DatasetPurpose.TRAINING, version="1")
    with pytest.raises(ValueError):
        BenchmarkDataset(manifest=m, rows=[], validation=EMPTY_REPORT)


def test_require_training_accepts_only_training_datasets():
    ok = require_training([make_training("t1"), make_training("t2")])
    assert len(ok) == 2


def test_require_training_rejects_a_benchmark_dataset_mixed_in():
    with pytest.raises(ValueError, match="b1"):
        require_training([make_training("t1"), make_benchmark("b1")])


def test_require_benchmark_accepts_only_benchmark_datasets():
    ok = require_benchmark([make_benchmark("b1"), make_benchmark("b2")])
    assert len(ok) == 2


def test_require_benchmark_rejects_a_training_dataset_mixed_in():
    with pytest.raises(ValueError, match="t1"):
        require_benchmark([make_benchmark("b1"), make_training("t1")])


def test_require_training_on_an_empty_list_is_fine():
    assert require_training([]) == []
