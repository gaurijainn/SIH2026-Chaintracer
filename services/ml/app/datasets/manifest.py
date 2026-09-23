"""Dataset manifest/metadata (plan B7: every imported label needs a source and confidence column;
this is that record at the dataset level rather than the row level). Every loader's `.manifest`
states, up front, whether it is TRAINING or BENCHMARK data — see dataset.py for how that field is
enforced, not just documented, to keep the two apart.
"""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class DatasetPurpose(str, Enum):
    """plan B7 / Section 4: "Why Elliptic is a benchmark, not your training set" — its 166
    anonymised features can't be computed for a TRON address, so it (and Elliptic2/Elliptic++)
    only benchmark the graph-feature approach. Only TRAINING datasets may feed the model."""

    TRAINING = "training"
    BENCHMARK = "benchmark"


class DatasetManifest(BaseModel):
    """One dataset's identity, provenance and access terms."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = Field(min_length=1, description="Short id, e.g. 'kaggle-eth-fraud', 'elliptic', 'tron-bootstrap'")
    source: str = Field(min_length=1, description="Where it comes from, e.g. 'Kaggle: vagifa/ethereum-frauddetection-dataset'")
    purpose: DatasetPurpose
    version: str = Field(min_length=1, description="Dataset release tag, download date, or build date for a self-built dataset")
    local_path: str | None = Field(default=None, description="Path to the local file actually loaded; None until the file has been placed on disk")
    license: str | None = Field(default=None, description="License/access terms, when known")
    notes: str | None = Field(default=None, description="Anything else worth recording, e.g. known limitations")
