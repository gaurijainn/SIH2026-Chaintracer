"""Loader interface every B7 dataset reader implements.

LOCAL FILES ONLY. `load()` takes a path already sitting on disk; no loader in this package makes a
network call or downloads anything. Getting the actual dataset onto disk (a Kaggle login + manual
download, a `git clone`, or — for the TRON bootstrap dataset specifically — a live collector that
does not exist yet) is a separate, later step, deliberately kept out of this module.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from ..dataset import Dataset
from ..manifest import DatasetManifest


class DatasetLoader(ABC):
    """One loader per dataset. `manifest` is fixed metadata about the dataset itself (name, source,
    purpose, license); `load(path)` reads one local file/directory and returns a validated Dataset
    whose own `.manifest` also carries `local_path` set to the path actually read.
    """

    #: Overridden by each concrete loader; describes the dataset, not any particular file on disk.
    manifest: DatasetManifest

    @abstractmethod
    def load(self, path: str | Path) -> Dataset:
        """Reads `path` (a local file) and returns a validated Dataset. Raises ValueError on a
        malformed file (missing required columns, invalid labels) — never silently drops rows into
        a shape the schema doesn't allow."""
        raise NotImplementedError
