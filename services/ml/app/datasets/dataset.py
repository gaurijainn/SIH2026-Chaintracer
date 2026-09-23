"""Dataset containers, and the runtime guard that keeps TRAINING and BENCHMARK data apart.

Two things enforce the separation, not just document it:
  1. Every concrete loader is pinned to return either a `TrainingDataset` or a `BenchmarkDataset`
     (distinct classes, not a flag on one class), so a loader's return type alone tells you which
     one it is.
  2. `require_training`/`require_benchmark` re-check `manifest.purpose` at runtime and raise if it
     doesn't match, so even a caller that ignores the type hints (or a manifest that was
     hand-constructed wrong) cannot silently mix benchmark rows into a training set.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence, cast

from .manifest import DatasetManifest, DatasetPurpose
from .schema import Chain, DatasetRow
from .validation import ValidationReport


@dataclass(frozen=True)
class Dataset:
    manifest: DatasetManifest
    rows: list[DatasetRow]
    validation: ValidationReport

    def __post_init__(self) -> None:
        if self.manifest.purpose != self._expected_purpose():
            raise ValueError(f"{type(self).__name__} requires purpose={self._expected_purpose().value}, got manifest.purpose={self.manifest.purpose.value} ({self.manifest.name})")

    def _expected_purpose(self) -> DatasetPurpose:
        raise NotImplementedError


@dataclass(frozen=True)
class TrainingDataset(Dataset):
    def _expected_purpose(self) -> DatasetPurpose:
        return DatasetPurpose.TRAINING


@dataclass(frozen=True)
class BenchmarkDataset(Dataset):
    def _expected_purpose(self) -> DatasetPurpose:
        return DatasetPurpose.BENCHMARK


def require_training(datasets: Sequence[Dataset]) -> list[TrainingDataset]:
    """Fails loudly if anything in `datasets` is not a training-purpose dataset. B7.3+'s training
    pipeline calls this before building a feature matrix, so a benchmark dataset passed in by
    mistake is a hard error, not a silently-contaminated model."""
    bad = [d.manifest.name for d in datasets if not isinstance(d, TrainingDataset) or d.manifest.purpose != DatasetPurpose.TRAINING]
    if bad:
        raise ValueError(f"not training datasets, refusing to use for training: {bad}")
    return cast("list[TrainingDataset]", list(datasets))


def require_benchmark(datasets: Sequence[Dataset]) -> list[BenchmarkDataset]:
    """The mirror of require_training, for B7.3+'s benchmark harness."""
    bad = [d.manifest.name for d in datasets if not isinstance(d, BenchmarkDataset) or d.manifest.purpose != DatasetPurpose.BENCHMARK]
    if bad:
        raise ValueError(f"not benchmark datasets, refusing to use for benchmarking: {bad}")
    return cast("list[BenchmarkDataset]", list(datasets))


def require_chain(datasets: Sequence[Dataset], chain: Chain) -> list[Dataset]:
    """Plan B7.4 architecture: the TRON production model and the Ethereum baseline must never share
    a feature matrix -- their feature vocabularies are entirely different (B6's 15 Appendix-B names
    vs. Kaggle's own raw columns) and concatenating them would silently produce nonsense rows. Fails
    loudly if any dataset contains even one row from a chain other than `chain`, naming the dataset
    and the offending chain(s) so the mistake is obvious rather than a training run that "works" on
    a meaningless matrix."""
    bad: list[tuple[str, list[str]]] = []
    for d in datasets:
        wrong_chains = sorted({r.chain.value for r in d.rows if r.chain != chain})
        if wrong_chains:
            bad.append((d.manifest.name, wrong_chains))
    if bad:
        raise ValueError(f"dataset(s) contain rows outside chain={chain.value}, refusing to combine: {bad}")
    return list(datasets)
