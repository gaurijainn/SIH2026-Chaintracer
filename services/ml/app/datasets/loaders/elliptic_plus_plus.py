"""BENCHMARK ONLY: Elliptic++ (plan Section 4: Bitcoin transactions plus a wallet-address (actor)
graph with labels; GitHub git-disl/EllipticPlusPlus). Address-level illicit classification
benchmark, kept out of training for the same reason as Elliptic/Elliptic2.

Expected local file: a CSV with `address` and `label` (`illicit` | `licit` | `unknown`) — B7.2's own
normalised column contract for this loader, not a guarantee of the upstream repo's exact raw header
names (the actual GitHub CSVs are not inspected here, per the "no dataset downloads yet" scope of
this phase; adjust the required-column list if the real file's headers differ once it is fetched).
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from ..dataset import BenchmarkDataset, Dataset
from ..manifest import DatasetManifest, DatasetPurpose
from ..schema import Chain, DatasetLabel, DatasetRow, IdentifierType
from ..validation import validate_dataframe
from .base import DatasetLoader

ID_COLUMN = "address"
LABEL_COLUMN = "label"
VALID_LABELS = {"illicit", "licit", "unknown"}


class EllipticPlusPlusLoader(DatasetLoader):
    manifest = DatasetManifest(
        name="elliptic-plus-plus",
        source="GitHub: git-disl/EllipticPlusPlus",
        purpose=DatasetPurpose.BENCHMARK,
        version="unversioned (record the git commit/download date when fetched)",
        license="see the GitHub repository",
        notes="Address-level illicit classification benchmark; not used for training.",
    )

    def load(self, path: str | Path) -> Dataset:
        path = Path(path)
        df = pd.read_csv(path)
        df.columns = [str(c).strip().lower() for c in df.columns]

        report = validate_dataframe(
            df,
            required_columns=[ID_COLUMN, LABEL_COLUMN],
            id_column=ID_COLUMN,
            label_column=LABEL_COLUMN,
            valid_labels=VALID_LABELS,
        )
        if not report.is_valid:
            raise ValueError(f"{self.manifest.name}: invalid dataset file {path}: {report.errors}")

        extra_columns = [c for c in df.columns if c not in (ID_COLUMN, LABEL_COLUMN)]
        rows: list[DatasetRow] = []
        for _, r in df.iterrows():
            features = {}
            for c in extra_columns:
                v = r[c]
                if pd.isna(v):
                    continue
                try:
                    features[c] = float(v)
                except (TypeError, ValueError):
                    pass
            rows.append(
                DatasetRow(
                    identifier=str(r[ID_COLUMN]),
                    identifier_type=IdentifierType.ADDRESS,
                    chain=Chain.BTC,
                    label=DatasetLabel(r[LABEL_COLUMN]),
                    timestamp=None,
                    source=self.manifest.name,
                    features=features,
                )
            )

        manifest = self.manifest.model_copy(update={"local_path": str(path)})
        return BenchmarkDataset(manifest=manifest, rows=rows, validation=report)
