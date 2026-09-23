"""B7.5: inference-time feature assembly. Builds one model-ready feature row from a single,
already-validated `FeatureVector` (the live-request counterpart to
`app.training.feature_matrix.build_feature_matrix`, which only works on `DatasetRow`/CSV-derived
training rows).

Reuses the exact same encoders training used (`encode_activator_label`,
`encode_external_flags_count`) -- imported, never reimplemented -- so a live request and a training
row that describe the same underlying facts always encode to the same numbers.

Column order is always `app.features.schema.FEATURE_NAMES` (all 15 canonical fields, including the
3 structurally-unavailable graph features `hops_from_victim`/`hops_to_vasp`/`sanction_exposure`).
The loaded v1 model was verified (by loading the real `tron-xgb-v1.json` and reading
`booster.feature_names`) to expect all 15 columns in this exact order -- it was trained on a
DataFrame that kept those 3 columns as always-NaN rather than dropping them, so inference must feed
NaN for them too rather than omitting them, to match XGBoost's own native missing-value handling.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..features.schema import FEATURE_NAMES, FeatureVector
from ..training.feature_matrix import encode_activator_label, encode_external_flags_count

#: The 9 fields carried straight through as float/NaN -- same set as feature_matrix.py's
#: _PURE_NUMERIC_FEATURES plus the 3 structurally-unavailable graph features, since both groups use
#: identical "value or NaN" logic at this stage (feature_matrix.py only splits them into two named
#: tuples for its own documentation purposes; the actual per-value logic is the same).
_PASSTHROUGH_FLOAT_FEATURES = (
    "dwell_median_min",
    "fan_out_1h",
    "fan_in_unique",
    "passthrough_ratio",
    "age_at_taint_days",
    "round_amount_ratio",
    "burst_tx_per_hour",
    "hops_from_victim",
    "hops_to_vasp",
    "sanction_exposure",
    "shared_mule_cps",
    "cross_case_count",
)


@dataclass(frozen=True)
class InferenceFeatureRow:
    """One encoded feature row plus which of the 15 canonical fields were genuinely present
    (non-None) on the incoming request -- callers (rule_score.py, shap_reasons.py) must never treat
    "missing" the same as "zero"; this is how they tell the two apart after encoding has happened."""

    values: np.ndarray  #: shape (15,), dtype float64, FEATURE_NAMES order, NaN for missing.
    present: dict[str, bool]  #: keyed by FEATURE_NAMES, True iff the request field was not None.
    feature_names: tuple[str, ...] = FEATURE_NAMES


def build_inference_row(vector: FeatureVector) -> InferenceFeatureRow:
    """Encodes `vector` (a single already-`FeatureVector`-validated address) into a model-ready
    15-element float row, in canonical `FEATURE_NAMES` order, using the exact per-field logic
    `app.training.feature_matrix` used for training rows."""
    dumped = vector.model_dump()

    values: dict[str, float] = {}
    present: dict[str, bool] = {}

    for name in _PASSTHROUGH_FLOAT_FEATURES:
        raw = dumped[name]
        present[name] = raw is not None
        values[name] = float("nan") if raw is None else float(raw)

    trx_dust_raw = dumped["trx_dust_usdt"]
    present["trx_dust_usdt"] = trx_dust_raw is not None
    values["trx_dust_usdt"] = float("nan") if trx_dust_raw is None else (1.0 if trx_dust_raw else 0.0)

    activator_raw = dumped["activator_label"]
    present["activator_label"] = activator_raw is not None
    values["activator_label"] = encode_activator_label(activator_raw)

    external_flags_raw = dumped["external_flags"]  # already a parsed list[str], never a JSON string
    # external_flags is a required, never-None field (default []); "present" here means "the field
    # was supplied at all" (always True), not "nonempty" -- callers that care whether the list is
    # actually nonempty (e.g. rule_score.py, shap_reasons.py) check len(...) themselves.
    present["external_flags"] = external_flags_raw is not None
    values["external_flags"] = encode_external_flags_count(external_flags_raw)

    # The remaining required (non-Optional) numeric fields are always non-None once FeatureVector
    # validation has passed; present[...] is already correctly True for them via the loop above.

    row = np.array([values[name] for name in FEATURE_NAMES], dtype=np.float64)
    assert row.shape == (len(FEATURE_NAMES),), "inference feature row must have exactly 15 columns, canonical order"

    return InferenceFeatureRow(values=row, present=present, feature_names=FEATURE_NAMES)
