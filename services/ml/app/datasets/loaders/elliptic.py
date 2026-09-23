"""BENCHMARK ONLY: the Elliptic Data Set (plan Section 4: ~204K Bitcoin transaction nodes, 166
anonymised features, 234K payment edges; ~2% illicit, ~21% licit, ~77% unknown). Its features are
anonymised and cannot be computed for a TRON address, so this dataset benchmarks the graph-feature
approach and gives a citable baseline — it must never be merged into TRAINING data (see
dataset.py's `require_training`/`require_benchmark`).

Expected local files: `elliptic_txs_classes.csv` (txId, class in {"1","2","unknown"} — 1=illicit,
2=licit) passed as `path`; optionally `elliptic_txs_features.csv` (txId + 166 unnamed numeric
feature columns, no header row) passed at construction as `features_path`, merged in by txId.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from ..dataset import BenchmarkDataset, Dataset
from ..manifest import DatasetManifest, DatasetPurpose
from ..schema import Chain, DatasetLabel, DatasetRow, IdentifierType
from ..validation import validate_dataframe
from .base import DatasetLoader

ID_COLUMN = "txid"
CLASS_COLUMN = "class"
VALID_CLASSES = {"1", "2", "unknown"}
CLASS_TO_LABEL = {"1": DatasetLabel.ILLICIT, "2": DatasetLabel.LICIT, "unknown": DatasetLabel.UNKNOWN}


class EllipticLoader(DatasetLoader):
    manifest = DatasetManifest(
        name="elliptic",
        source="Kaggle: ellipticco/elliptic-data-set",
        purpose=DatasetPurpose.BENCHMARK,
        version="unversioned (Kaggle dataset has no release tags; record the download date when fetched)",
        license="see the Kaggle dataset page (CC-based, not redistributed in this repo)",
        notes="Benchmark only — 166 anonymised features cannot be computed for a TRON address (plan Section 4).",
    )

    def __init__(self, features_path: str | Path | None = None):
        self.features_path = Path(features_path) if features_path else None

    def load(self, path: str | Path) -> Dataset:
        path = Path(path)
        df = pd.read_csv(path)
        df.columns = [str(c).strip().lower() for c in df.columns]

        report = validate_dataframe(
            df,
            required_columns=[ID_COLUMN, CLASS_COLUMN],
            id_column=ID_COLUMN,
            label_column=CLASS_COLUMN,
            valid_labels=VALID_CLASSES,
        )
        if not report.is_valid:
            raise ValueError(f"{self.manifest.name}: invalid dataset file {path}: {report.errors}")

        features_by_id = self._load_features()

        rows: list[DatasetRow] = []
        for _, r in df.iterrows():
            txid = str(r[ID_COLUMN])
            rows.append(
                DatasetRow(
                    identifier=txid,
                    identifier_type=IdentifierType.TRANSACTION,
                    chain=Chain.BTC,
                    label=CLASS_TO_LABEL[str(r[CLASS_COLUMN])],
                    timestamp=None,  # Elliptic's time steps are anonymised, not real-world timestamps
                    source=self.manifest.name,
                    features=features_by_id.get(txid, {}),
                )
            )

        manifest = self.manifest.model_copy(update={"local_path": str(path)})
        return BenchmarkDataset(manifest=manifest, rows=rows, validation=report)

    def _load_features(self) -> dict[str, dict[str, float]]:
        if self.features_path is None or not self.features_path.exists():
            return {}
        feat = pd.read_csv(self.features_path, header=None)
        feat = feat.rename(columns={0: ID_COLUMN})
        feat[ID_COLUMN] = feat[ID_COLUMN].astype(str)
        feature_cols = [c for c in feat.columns if c != ID_COLUMN]
        out: dict[str, dict[str, float]] = {}
        for _, r in feat.iterrows():
            out[r[ID_COLUMN]] = {f"f{c}": float(r[c]) for c in feature_cols if pd.notna(r[c])}
        return out
