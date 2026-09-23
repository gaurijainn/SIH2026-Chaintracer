"""TRAINING: the B6 -> B7 feature-export bridge (plan B7.3).

B6 (apps/api/src/mule) is the sole source of truth for computing the 15 Appendix-B features; this
loader never recomputes them. It reads the JSON file produced by
apps/api/src/mule/export (via scripts/export-mule-features-fixture.mts or, in a later phase, a real
per-case export), validates every row's feature vector against the same canonical `FeatureVector`
schema B7.1 defined (`app.features.schema`), and repackages it as a `DatasetRow` the rest of the B7.2
dataset layer already knows how to handle.

Cross-language contract: the export file states its own `featureOrder`; this loader asserts it
equals `FEATURE_NAMES` exactly and refuses to load otherwise, so a Node-side feature added, removed,
or reordered without updating the Python schema fails loudly here rather than silently misaligning a
future training matrix.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from ..dataset import Dataset, TrainingDataset
from ..manifest import DatasetManifest, DatasetPurpose
from ..schema import Chain, DatasetLabel, DatasetRow, IdentifierType
from ..validation import ValidationReport
from ...features import FEATURE_NAMES, FeatureVector, feature_dict
from .base import DatasetLoader

#: B6's MuleFeatures fields that are genuinely numeric once encoded; everything else (the raw
#: categorical string/list and their deterministic encodings) is carried in `extra`, matching every
#: other B7.2 loader's numeric-vs-non-numeric split.
_NON_NUMERIC_FEATURES = {"activator_label", "external_flags"}


class B6ExportLoader(DatasetLoader):
    manifest = DatasetManifest(
        name="b6-mule-features",
        source="apps/api/src/mule (B6 production feature computation), exported via apps/api/src/mule/export",
        purpose=DatasetPurpose.TRAINING,
        version="set from the export file's own datasetVersion at load time",
        license="internal (derived from the platform's own traced case data)",
        notes="Never recomputes a feature; validates every row against B7.1's FeatureVector schema before repackaging as a DatasetRow.",
    )

    def load(self, path: str | Path) -> Dataset:
        path = Path(path)
        data = json.loads(path.read_text(encoding="utf-8"))

        file_order = tuple(data.get("featureOrder", ()))
        if file_order != FEATURE_NAMES:
            raise ValueError(
                f"{self.manifest.name}: {path} declares featureOrder={file_order}, "
                f"expected the canonical B7.1 order {FEATURE_NAMES} (Node/Python schema drift)"
            )

        raw_rows: list[dict[str, Any]] = data.get("rows", [])
        errors: list[str] = []
        missing_by_column: dict[str, int] = {name: 0 for name in FEATURE_NAMES}
        seen_ids: set[str] = set()
        duplicate_count = 0
        label_counts: dict[str, int] = {}

        rows: list[DatasetRow] = []
        for i, raw in enumerate(raw_rows):
            try:
                row = self._to_dataset_row(raw)
            except Exception as e:  # noqa: BLE001 - surfaced as one validation error per row
                errors.append(f"row {i} ({raw.get('identifier', '?')}): {e}")
                continue
            rows.append(row)

            if row.identifier in seen_ids:
                duplicate_count += 1
            seen_ids.add(row.identifier)

            label_counts[row.label.value] = label_counts.get(row.label.value, 0) + 1
            present = set(row.features.keys())
            for name in FEATURE_NAMES:
                if name not in _NON_NUMERIC_FEATURES and name not in present:
                    missing_by_column[name] += 1

        report = ValidationReport(
            row_count=len(raw_rows),
            duplicate_count=duplicate_count,
            missing_by_column={k: v for k, v in missing_by_column.items() if v > 0},
            invalid_labels=[],
            label_counts=label_counts,
            timestamp_parse_failures=0,
            errors=errors,
            warnings=[f"{duplicate_count} duplicate identifier(s)"] if duplicate_count else [],
        )
        if not report.is_valid:
            raise ValueError(f"{self.manifest.name}: invalid export file {path}: {report.errors}")

        manifest = self.manifest.model_copy(update={"local_path": str(path), "version": data.get("datasetVersion", self.manifest.version)})
        return TrainingDataset(manifest=manifest, rows=rows, validation=report)

    def _to_dataset_row(self, raw: dict[str, Any]) -> DatasetRow:
        # Validates against the exact canonical schema B7.1 defined -- extra="forbid" rejects any
        # feature B6 stopped exporting, and the range/type constraints on FeatureVector's fields
        # apply here too, not just at inference time.
        fv = FeatureVector(**raw["features"])
        numeric = {k: v for k, v in feature_dict(fv).items() if k not in _NON_NUMERIC_FEATURES and v is not None}
        numeric["trx_dust_usdt"] = float(fv.trx_dust_usdt)  # a bool is a legitimate 0.0/1.0 numeric feature

        encoded = raw.get("encoded", {})
        if encoded.get("activator_label_hash") is not None:
            numeric["activator_label_hash"] = float(encoded["activator_label_hash"])
        numeric["external_flags_count"] = float(encoded.get("external_flags_count", len(fv.external_flags)))

        missing_features = sorted(name for name in FEATURE_NAMES if name not in _NON_NUMERIC_FEATURES and feature_dict(fv)[name] is None)

        extra: dict[str, Any] = {
            "activator_label": fv.activator_label,
            "external_flags": fv.external_flags,
            "external_flags_hash": encoded.get("external_flags_hash"),
            "missing_features": missing_features,  # explicit record of what was unknown, never guessed
            "export_source": raw.get("source"),
        }

        ts_raw = raw.get("timestamp")
        timestamp: datetime | None = datetime.fromisoformat(ts_raw.replace("Z", "+00:00")) if ts_raw else None

        raw_label = raw.get("label")
        label = DatasetLabel(raw_label) if raw_label else DatasetLabel.UNKNOWN  # "not yet known", never guessed

        return DatasetRow(
            identifier=raw["identifier"],
            identifier_type=IdentifierType.ADDRESS,
            chain=Chain(raw["chain"]),
            label=label,
            timestamp=timestamp,
            source=raw.get("source", {}).get("name", self.manifest.name),
            features=numeric,
            extra=extra,
        )
