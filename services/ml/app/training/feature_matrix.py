"""B7.4: builds the 15-column, XGBoost-ready feature matrix from `DatasetRow`s produced by
`TronBootstrapLoader` (after `timestamps.correct_row_timestamps`). Column order is always
`app.features.schema.FEATURE_NAMES` -- the single source of truth shared with the `FeatureVector`
pydantic schema, so training and (future, B7.5) inference can never silently drift apart.

Missing-value policy (deliberately *not* uniform across columns -- see plan preference for native
XGBoost NaN-handling over unnecessary imputation):
  - The 9 pure-numeric Appendix-B fields (`dwell_median_min`, `fan_out_1h`, `fan_in_unique`,
    `passthrough_ratio`, `age_at_taint_days`, `round_amount_ratio`, `burst_tx_per_hour`,
    `shared_mule_cps`, `cross_case_count`) come straight from `DatasetRow.features`; absent ->
    `np.nan`, never 0 (0 is a real, meaningful value for several of these).
  - `trx_dust_usdt`: verified against the real tron-bootstrap-v1 CSV, pandas infers this
    all-lowercase true/false column as boolean dtype, so `TronBootstrapLoader`'s own `float()`
    coercion already succeeds and the value lands in `DatasetRow.features["trx_dust_usdt"]` as
    0.0/1.0 directly -- used as-is when present. Handled defensively for the alternative shape too
    (a string in `DatasetRow.extra["trx_dust_usdt"]`, e.g. `"true"`/`"false"`), in case a future
    collector run or different pandas dtype inference produces that shape instead. Genuinely
    absent from both -> `np.nan`.
  - `activator_label`: a free-text TRON address string (near-unique per row in the real dataset --
    ~309 distinct values across 500 rows), so a *fitted* label vocabulary would have severe
    unseen-category problems on held-out data. Instead this is a stable, fit-free FNV-1a hash
    bucketed into `ACTIVATOR_LABEL_BUCKETS` buckets -- the same idea (not the same bit pattern; no
    cross-language parity is required, see `apps/api/src/mule/export/encode.ts`'s `stableHash()`,
    whose own doc comment says as much) used on the TypeScript side for the same field. Named and
    versioned as `ACTIVATOR_LABEL_ENCODER` so future inference code can reproduce it exactly.
    Genuinely absent (no `activator_label` in `extra` at all) -> `np.nan`, *never* bucket 0 --
    "missing" and "hashed to bucket 0" must never be confused.
  - `external_flags`: a JSON-array string (`"[]"`, `'["high_risk"]"`, `'["reported"]"`, ...) in
    `extra`. The numeric feature is its *count* (`len(parsed_list)`), matching the convention
    already established by `app/datasets/loaders/b6_export.py` (`external_flags_count`) -- the raw
    list/hash is audit metadata only, never a model input on its own.
  - `hops_from_victim`, `hops_to_vasp`, `sanction_exposure`: 100% missing in the real bootstrap
    dataset (no case-graph context available to this collector). The columns are always present in
    the output DataFrame (the canonical 15-feature schema is never narrowed), but every value will
    be `np.nan` for this training run -- never fabricated as 0 or any other placeholder.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np
import pandas as pd

from ..datasets import DatasetRow
from ..features import FEATURE_NAMES
from .labels import BinaryLabel, collapse_label

#: Fields read straight from DatasetRow.features (the loader already coerced these to float).
_PURE_NUMERIC_FEATURES = (
    "dwell_median_min",
    "fan_out_1h",
    "fan_in_unique",
    "passthrough_ratio",
    "age_at_taint_days",
    "round_amount_ratio",
    "burst_tx_per_hour",
    "shared_mule_cps",
    "cross_case_count",
)

#: Always 100%-missing in the tron-bootstrap-v1 dataset (no case-graph context); kept in the
#: schema, sourced the same way as the pure-numeric fields (row.features.get(name)) so they'd pick
#: up real values automatically if a future collector run ever supplies them.
_STRUCTURALLY_UNAVAILABLE_FEATURES = ("hops_from_victim", "hops_to_vasp", "sanction_exposure")

#: activator_label's stable, fit-free categorical encoder -- named/versioned so it can be recorded
#: in feature_metadata.json and reproduced exactly by future inference code (B7.5+).
ACTIVATOR_LABEL_ENCODER_NAME = "fnv1a_mod32_v1"
ACTIVATOR_LABEL_BUCKETS = 32


def _fnv1a_32(s: str) -> int:
    """32-bit FNV-1a over `s`'s Unicode code points. Deterministic and seedless -- same input
    always produces the same output on any run/platform/process; nothing to fit or persist beyond
    this function itself. Mirrors (not byte-for-bit, no parity required -- see module docstring)
    apps/api/src/mule/export/encode.ts's stableHash()."""
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def encode_activator_label(label: str | None) -> float:
    """`np.nan` when `label` is genuinely absent (never bucket 0 -- missing must never be confused
    with "hashed to bucket 0"); otherwise a bucket in [0, ACTIVATOR_LABEL_BUCKETS)."""
    if label is None:
        return float("nan")
    return float(_fnv1a_32(label) % ACTIVATOR_LABEL_BUCKETS)


def encode_external_flags_count(raw: Any) -> float:
    """The count of a row's `external_flags` list, parsed from the raw JSON-array string
    TronBootstrapLoader carries in `extra["external_flags"]` (or an already-parsed list, for
    robustness against other loaders). Defaults to 0.0 (an empty list) when the field is
    completely absent -- every real row in tron-bootstrap-v1 has at least `"[]"`, but this is coded
    defensively in case a future row omits the column entirely."""
    if raw is None:
        return 0.0
    if isinstance(raw, list):
        return float(len(raw))
    parsed = json.loads(raw)
    return float(len(parsed))


def _parse_trx_dust_usdt(raw: Any) -> float:
    """Handles both observed shapes of this column: pandas can (and, verified against the real
    tron-bootstrap-v1 CSV, does) infer an all-lowercase true/false column as boolean dtype, in
    which case TronBootstrapLoader's own float() coercion already succeeds and the value lands in
    `DatasetRow.features` as 0.0/1.0 directly -- this function is then never called for that row
    (see `_feature_row`, which checks `features` first). Handled here too, defensively, for the
    string-in-`extra` shape ("true"/"false") in case a future collector run or a different pandas
    dtype-inference outcome produces that shape instead."""
    if raw is None:
        return float("nan")
    if isinstance(raw, bool):
        return 1.0 if raw else 0.0
    s = str(raw).strip().lower()
    if s == "true":
        return 1.0
    if s == "false":
        return 0.0
    raise ValueError(f"unrecognized trx_dust_usdt value: {raw!r}")


def _feature_row(row: DatasetRow) -> dict[str, float]:
    values: dict[str, float] = {}
    for name in _PURE_NUMERIC_FEATURES:
        values[name] = row.features.get(name, float("nan"))
    for name in _STRUCTURALLY_UNAVAILABLE_FEATURES:
        values[name] = row.features.get(name, float("nan"))
    if "trx_dust_usdt" in row.features:
        # Verified real-data shape: pandas infers the all-lowercase true/false column as boolean
        # dtype, so TronBootstrapLoader's own float() coercion already succeeded and the value is
        # sitting in `features` as 0.0/1.0 -- use it directly rather than re-deriving it.
        values["trx_dust_usdt"] = float(row.features["trx_dust_usdt"])
    else:
        values["trx_dust_usdt"] = _parse_trx_dust_usdt(row.extra.get("trx_dust_usdt"))
    values["activator_label"] = encode_activator_label(row.extra.get("activator_label"))
    values["external_flags"] = encode_external_flags_count(row.extra.get("external_flags"))
    return values


@dataclass(frozen=True)
class FeatureMatrixResult:
    """The training-ready matrix plus everything needed to evaluate/audit it: labels aligned
    row-for-row with `dataframe`, the original row identifiers for traceability, and per-column
    missingness counts (NaN counts, post-encoding)."""

    dataframe: pd.DataFrame
    labels: list[BinaryLabel]
    identifiers: list[str]
    missingness: dict[str, int]


def build_feature_matrix(rows: Sequence[DatasetRow]) -> FeatureMatrixResult:
    """Builds the canonical 15-column feature matrix (column order == FEATURE_NAMES exactly) from
    `rows`. Every row must have a label that `collapse_label` can resolve to POSITIVE/NEGATIVE --
    callers (train_tron.py) are expected to have already excluded UNKNOWN-label rows before this
    point (a deliberate, separately-reported step, not silently done here); this function raises if
    it is ever handed a row it can't label, rather than silently dropping training data.
    """
    records: list[dict[str, float]] = []
    labels: list[BinaryLabel] = []
    identifiers: list[str] = []

    for row in rows:
        label = collapse_label(row.label)
        if label is None:
            raise ValueError(f"{row.identifier}: has an unresolvable label ({row.label}); exclude UNKNOWN-label rows before building the feature matrix")
        records.append(_feature_row(row))
        labels.append(label)
        identifiers.append(row.identifier)

    df = pd.DataFrame.from_records(records, columns=list(FEATURE_NAMES))
    assert list(df.columns) == list(FEATURE_NAMES), "feature matrix column order drifted from the canonical schema"

    missingness = {name: int(df[name].isna().sum()) for name in FEATURE_NAMES}

    return FeatureMatrixResult(dataframe=df, labels=labels, identifiers=identifiers, missingness=missingness)
