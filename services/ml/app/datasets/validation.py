"""Raw-file validation (plan B0/B7: "keep a source and confidence column on every label you
import"; plan B11-style done-when discipline applied to datasets). Runs over the *raw* DataFrame a
loader reads from disk, before any row is turned into a DatasetRow, so a malformed file is reported
with column-level detail rather than failing on the first bad row.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

import pandas as pd


@dataclass(frozen=True)
class ValidationReport:
    row_count: int
    duplicate_count: int
    missing_by_column: dict[str, int]
    invalid_labels: list[str]
    label_counts: dict[str, int]
    timestamp_parse_failures: int
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def is_valid(self) -> bool:
        """True when the file can be loaded at all; `warnings` (e.g. duplicates) don't block loading."""
        return len(self.errors) == 0


def validate_dataframe(
    df: pd.DataFrame,
    *,
    required_columns: Sequence[str],
    id_column: str,
    label_column: str | None = None,
    valid_labels: set[str] | None = None,
    timestamp_column: str | None = None,
) -> ValidationReport:
    """Validates a raw DataFrame against a dataset's expected shape.

    - required columns: every name in `required_columns` must be present, else an error.
    - valid labels: if `label_column`/`valid_labels` are given, every non-null value in that column
      must be one of `valid_labels`, else an error (this is what stops a loader from silently
      accepting a raw label it doesn't know how to map onto DatasetLabel).
    - timestamps: if `timestamp_column` is given, unparseable non-null values are counted and
      reported as a warning (loaders decide whether that's fatal for their dataset).
    - duplicates: rows sharing the same `id_column` value are counted and reported as a warning
      (some datasets, e.g. Elliptic edges, legitimately repeat an id; loaders decide whether to dedupe).
    - missing values: per-column null counts, reported for every required column present.
    """
    errors: list[str] = []
    warnings: list[str] = []

    missing_cols = [c for c in required_columns if c not in df.columns]
    if missing_cols:
        errors.append(f"missing required columns: {missing_cols}")

    missing_by_column = {c: int(df[c].isna().sum()) for c in required_columns if c in df.columns}
    for c, n in missing_by_column.items():
        if n > 0:
            warnings.append(f"column '{c}' has {n} missing value(s)")

    duplicate_count = 0
    if id_column in df.columns:
        duplicate_count = int(df.duplicated(subset=[id_column]).sum())
        if duplicate_count > 0:
            warnings.append(f"{duplicate_count} duplicate '{id_column}' value(s)")

    invalid_labels: list[str] = []
    label_counts: dict[str, int] = {}
    if label_column is not None and label_column in df.columns:
        counts = df[label_column].value_counts(dropna=False)
        label_counts = {str(k): int(v) for k, v in counts.items()}
        if valid_labels is not None:
            observed = {str(v) for v in df[label_column].dropna().unique()}
            bad = observed - valid_labels
            if bad:
                invalid_labels = sorted(bad)
                errors.append(f"invalid label value(s) in '{label_column}': {invalid_labels}")
    elif label_column is not None:
        errors.append(f"label column '{label_column}' not found")

    timestamp_parse_failures = 0
    if timestamp_column is not None and timestamp_column in df.columns:
        raw = df[timestamp_column]
        parsed = pd.to_datetime(raw, errors="coerce", utc=True)
        # only count values that were non-null in the source but failed to parse
        timestamp_parse_failures = int((parsed.isna() & raw.notna()).sum())
        if timestamp_parse_failures > 0:
            warnings.append(f"{timestamp_parse_failures} value(s) in '{timestamp_column}' failed to parse as a timestamp")

    return ValidationReport(
        row_count=len(df),
        duplicate_count=duplicate_count,
        missing_by_column=missing_by_column,
        invalid_labels=invalid_labels,
        label_counts=label_counts,
        timestamp_parse_failures=timestamp_parse_failures,
        errors=errors,
        warnings=warnings,
    )
