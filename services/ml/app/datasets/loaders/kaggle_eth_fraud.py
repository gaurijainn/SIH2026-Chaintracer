"""TRAINING: Kaggle Ethereum Fraud Detection (plan Section 4 / B7: "EVM risk model; its feature
ideas port directly to TRON"). Account-level tabular features with a binary fraud flag.

Expected local file: a CSV with at least an address column and a fraud-flag column (the published
dataset uses `Address` and `FLAG`); every other numeric column is carried through as a raw feature.
Column names are matched case-insensitively and with surrounding whitespace stripped, since the
published CSV's headers are inconsistently spaced (e.g. " ERC20 avg time between sent tnx").
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from ..dataset import Dataset, TrainingDataset
from ..manifest import DatasetManifest, DatasetPurpose
from ..schema import Chain, DatasetLabel, DatasetRow, IdentifierType
from ..validation import validate_dataframe
from .base import DatasetLoader

ADDRESS_COLUMN = "address"
FLAG_COLUMN = "flag"
VALID_FLAGS = {"0", "1"}


class KaggleEthFraudLoader(DatasetLoader):
    manifest = DatasetManifest(
        name="kaggle-eth-fraud",
        source="Kaggle: vagifa/ethereum-frauddetection-dataset",
        purpose=DatasetPurpose.TRAINING,
        version="unversioned (Kaggle dataset has no release tags; record the download date when fetched)",
        license="see the Kaggle dataset page (not redistributed in this repo)",
        notes="No timestamp column; used for EVM-side training features only.",
    )

    def load(self, path: str | Path) -> Dataset:
        path = Path(path)
        df = pd.read_csv(path)
        df.columns = [str(c).strip().lower() for c in df.columns]

        report = validate_dataframe(
            df,
            required_columns=[ADDRESS_COLUMN, FLAG_COLUMN],
            id_column=ADDRESS_COLUMN,
            label_column=FLAG_COLUMN,
            valid_labels=VALID_FLAGS,
        )
        if not report.is_valid:
            raise ValueError(f"{self.manifest.name}: invalid dataset file {path}: {report.errors}")

        feature_columns = [c for c in df.columns if c not in (ADDRESS_COLUMN, FLAG_COLUMN)]
        rows: list[DatasetRow] = []
        for _, r in df.iterrows():
            features: dict[str, float] = {}
            extra: dict[str, object] = {}
            for c in feature_columns:
                v = r[c]
                if pd.isna(v):
                    continue
                try:
                    features[c] = float(v)
                except (TypeError, ValueError):
                    extra[c] = v
            rows.append(
                DatasetRow(
                    identifier=str(r[ADDRESS_COLUMN]),
                    identifier_type=IdentifierType.ADDRESS,
                    chain=Chain.ETH,
                    label=DatasetLabel.ILLICIT if str(int(r[FLAG_COLUMN])) == "1" else DatasetLabel.LICIT,
                    timestamp=None,
                    source=self.manifest.name,
                    features=features,
                    extra=extra,
                )
            )

        manifest = self.manifest.model_copy(update={"local_path": str(path)})
        return TrainingDataset(manifest=manifest, rows=rows, validation=report)
