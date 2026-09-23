"""BENCHMARK ONLY: Elliptic2 (plan Section 4: 122K labeled subgraphs inside a background graph of
49M node clusters and 196M edges — "the shapes of laundering"; work on a sample, the full set is
heavy). It follows Elliptic's lineage (MITIBMxGraph/Elliptic2, arxiv.org/abs/2404.19109) and is
Bitcoin-based, kept benchmark-only for the same reason as Elliptic itself.

The real dataset ships as a large background graph plus per-subgraph node/edge lists — out of scope
to fully ingest here. B7.2 defines a simplified *subgraph-summary* contract instead: a local CSV with
one row per labeled subgraph (`subgraph_id`, `label` in {"illicit","licit","unknown"}, and optional
`num_nodes`/`num_edges`), sufficient to prove the ingestion/validation/separation machinery and to
be exercised in tests. Loading the actual per-subgraph node/edge structure is left to whichever later
phase does the graph-pattern benchmarking itself.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from ..dataset import BenchmarkDataset, Dataset
from ..manifest import DatasetManifest, DatasetPurpose
from ..schema import Chain, DatasetLabel, DatasetRow, IdentifierType
from ..validation import validate_dataframe
from .base import DatasetLoader

ID_COLUMN = "subgraph_id"
LABEL_COLUMN = "label"
VALID_LABELS = {"illicit", "licit", "unknown"}
NUMERIC_EXTRA_COLUMNS = ("num_nodes", "num_edges")


class Elliptic2Loader(DatasetLoader):
    manifest = DatasetManifest(
        name="elliptic2",
        source="GitHub: MITIBMxGraph/Elliptic2 (arxiv.org/abs/2404.19109)",
        purpose=DatasetPurpose.BENCHMARK,
        version="unversioned (record the git commit/download date when fetched)",
        license="see the GitHub repository's official download guide",
        notes="B7.2 ingests a simplified subgraph-summary CSV, not the full background graph.",
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

        rows: list[DatasetRow] = []
        for _, r in df.iterrows():
            features = {c: float(r[c]) for c in NUMERIC_EXTRA_COLUMNS if c in df.columns and pd.notna(r[c])}
            rows.append(
                DatasetRow(
                    identifier=str(r[ID_COLUMN]),
                    identifier_type=IdentifierType.SUBGRAPH,
                    chain=Chain.BTC,
                    label=DatasetLabel(r[LABEL_COLUMN]),
                    timestamp=None,
                    source=self.manifest.name,
                    features=features,
                )
            )

        manifest = self.manifest.model_copy(update={"local_path": str(path)})
        return BenchmarkDataset(manifest=manifest, rows=rows, validation=report)
