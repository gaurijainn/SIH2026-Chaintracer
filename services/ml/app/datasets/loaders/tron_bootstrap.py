"""TRAINING: the self-built TRON bootstrap label set (plan Section 4 box "Build the TRON label set
yourself"). TRON has no Elliptic-style public labeled dataset; the plan has the team build one from
USDT-TRC20 AddedBlackList events, OFAC TRX/USDT addresses, checked Chainabuse TRON reports, and
Tronscan security flags (positive signals), plus sampled negatives -- active USDT holders excluding
tagged services (see negative_sampling.py for that interface).

B7.2 defined the schema and a local-file loader; B7.4 fixes that schema to match what the future
real collector must actually produce: `chain`, `evidence` and `confidence` are now required columns
(previously only address/label/source were), and `fetched_at` is now required too (plan B7.4: every
training row must carry a real timestamp, never invented — see app/training/split.py's temporal
split, which refuses to run on a row with no timestamp).

The live collector that actually builds this file (a TronGrid events pull + per-address
Tronscan/Chainabuse enrichment) is explicitly out of scope here — see the B7 readiness audit for its
call-volume estimate — so until that collector exists and is run (with your go-ahead on the call
count), there is no real file to point this loader at; it is exercised in tests against a small
synthetic fixture only.

Expected local file, one row per labeled address:
  - address        required. Normalized on the Node side before export (see
                    apps/api/src/mule/training/normalize.ts); this loader does not re-normalize.
  - chain           required. One of the Chain enum's values (in practice always "TRON" here).
  - label           required. "high_risk" | "licit" — plan: "Label 'high-risk', not 'criminal'".
  - source          required. e.g. "usdt_blacklist" | "ofac" | "chainabuse" | "tronscan" |
                    "manual_negative" — kept as row-level provenance in `extra`, distinct from
                    DatasetRow.source (which names this *dataset*, matching every other B7.2 loader).
  - fetched_at      required. ISO-8601 UTC: when the source recorded this label.
  - evidence        required. A JSON object (parsed) or a plain string when it isn't valid JSON —
                    never dropped, always carried in `extra["evidence"]`.
  - confidence      required. 0..1, exactly as recorded by the source; never invented or defaulted.
  - (optional)      account_age_days, external_flags, contract/token columns, any other
                    source-specific metadata — numeric columns become features, everything else
                    (including external_flags, kept as a raw list/string) goes to `extra`.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandas as pd

from ..dataset import Dataset, TrainingDataset
from ..manifest import DatasetManifest, DatasetPurpose
from ..schema import Chain, DatasetLabel, DatasetRow, IdentifierType
from ..validation import validate_dataframe
from .base import DatasetLoader

ADDRESS_COLUMN = "address"
CHAIN_COLUMN = "chain"
LABEL_COLUMN = "label"
SOURCE_COLUMN = "source"
TIMESTAMP_COLUMN = "fetched_at"
EVIDENCE_COLUMN = "evidence"
CONFIDENCE_COLUMN = "confidence"
VALID_LABELS = {"high_risk", "licit"}
VALID_CHAINS = {c.value for c in Chain} - {Chain.UNKNOWN.value}
REQUIRED_COLUMNS = [ADDRESS_COLUMN, CHAIN_COLUMN, LABEL_COLUMN, SOURCE_COLUMN, TIMESTAMP_COLUMN, EVIDENCE_COLUMN, CONFIDENCE_COLUMN]
_NON_FEATURE_COLUMNS = {ADDRESS_COLUMN, CHAIN_COLUMN, LABEL_COLUMN, SOURCE_COLUMN, TIMESTAMP_COLUMN, EVIDENCE_COLUMN, CONFIDENCE_COLUMN}


def _parse_evidence(raw: Any) -> Any:
    """A JSON object when the column holds valid JSON; otherwise the raw string. Never dropped."""
    if pd.isna(raw):
        return None
    s = str(raw)
    try:
        return json.loads(s)
    except (json.JSONDecodeError, TypeError):
        return s


class TronBootstrapLoader(DatasetLoader):
    manifest = DatasetManifest(
        name="tron-bootstrap",
        source="self-built: TronGrid AddedBlackList events + OFAC TRX/USDT + Chainabuse TRON reports + Tronscan enrichment (plan Section 4)",
        purpose=DatasetPurpose.TRAINING,
        version="tron-bootstrap-v1-live",
        license="internal (derived from public on-chain events and OFAC/Chainabuse public data)",
        notes="Negatives are active USDT holders with none of the positive flags, excluding tagged services. Split train/calibration/test by time to avoid leakage.",
    )

    def load(self, path: str | Path) -> Dataset:
        path = Path(path)
        df = pd.read_csv(path, dtype={CONFIDENCE_COLUMN: "string"})
        df.columns = [str(c).strip().lower() for c in df.columns]

        report = validate_dataframe(
            df,
            required_columns=REQUIRED_COLUMNS,
            id_column=ADDRESS_COLUMN,
            label_column=LABEL_COLUMN,
            valid_labels=VALID_LABELS,
            timestamp_column=TIMESTAMP_COLUMN,
        )
        if not report.is_valid:
            raise ValueError(f"{self.manifest.name}: invalid dataset file {path}: {report.errors}")

        row_errors: list[str] = []
        if CHAIN_COLUMN in df.columns:
            bad_chains = sorted({str(c) for c in df[CHAIN_COLUMN].dropna().unique()} - VALID_CHAINS)
            if bad_chains:
                row_errors.append(f"invalid chain value(s): {bad_chains}")
        if CONFIDENCE_COLUMN in df.columns:
            confidences = pd.to_numeric(df[CONFIDENCE_COLUMN], errors="coerce")
            out_of_range = df[(confidences.isna() & df[CONFIDENCE_COLUMN].notna()) | (confidences < 0) | (confidences > 1)]
            if len(out_of_range) > 0:
                row_errors.append(f"{len(out_of_range)} row(s) have a confidence value outside [0, 1] or unparseable")
        if row_errors:
            raise ValueError(f"{self.manifest.name}: invalid dataset file {path}: {row_errors}")

        rows: list[DatasetRow] = []
        for _, r in df.iterrows():
            ts = pd.to_datetime(r[TIMESTAMP_COLUMN], errors="coerce", utc=True)
            if pd.isna(ts):
                raise ValueError(f"{self.manifest.name}: {path}: row for {r[ADDRESS_COLUMN]} has an unparseable {TIMESTAMP_COLUMN}; every training row requires a real timestamp")

            features: dict[str, float] = {}
            extra: dict[str, Any] = {"source_detail": r[SOURCE_COLUMN], "evidence": _parse_evidence(r[EVIDENCE_COLUMN]), "confidence": float(r[CONFIDENCE_COLUMN])}
            for c in df.columns:
                if c in _NON_FEATURE_COLUMNS:
                    continue
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
                    chain=Chain(r[CHAIN_COLUMN]),
                    label=DatasetLabel.HIGH_RISK if r[LABEL_COLUMN] == "high_risk" else DatasetLabel.LICIT,
                    timestamp=ts.to_pydatetime(),
                    source=self.manifest.name,
                    features=features,
                    extra=extra,
                )
            )

        manifest = self.manifest.model_copy(update={"local_path": str(path)})
        return TrainingDataset(manifest=manifest, rows=rows, validation=report)
