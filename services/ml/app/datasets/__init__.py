"""B7.2: dataset ingestion. Local-file loaders for every dataset in plan Section 4, normalised to a
common DatasetRow schema, with TRAINING and BENCHMARK datasets kept structurally separate (see
dataset.py). No loader here downloads anything or makes a network call — see loaders/base.py.
"""
from .dataset import BenchmarkDataset, Dataset, TrainingDataset, require_benchmark, require_chain, require_training
from .manifest import DatasetManifest, DatasetPurpose
from .negative_sampling import NegativeCandidate, NegativeCandidateStatus, confirmed_negatives, load_negative_candidates
from .schema import Chain, DatasetLabel, DatasetRow, IdentifierType
from .validation import ValidationReport, validate_dataframe

__all__ = [
    "Chain",
    "DatasetLabel",
    "IdentifierType",
    "DatasetRow",
    "DatasetManifest",
    "DatasetPurpose",
    "ValidationReport",
    "validate_dataframe",
    "Dataset",
    "TrainingDataset",
    "BenchmarkDataset",
    "require_training",
    "require_benchmark",
    "require_chain",
    "NegativeCandidate",
    "NegativeCandidateStatus",
    "load_negative_candidates",
    "confirmed_negatives",
]
