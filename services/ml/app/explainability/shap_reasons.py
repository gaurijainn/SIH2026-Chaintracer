"""B7.5: SHAP-based, plain-language reasons for one scored address. Reuses the already-loaded
XGBoost booster singleton from `app.inference.model` (never reloads/refits), computes
`shap.TreeExplainer` contributions for a single live feature row, keeps only positive
contributions (the ones that pushed the score *up*), ranks them by magnitude, and maps the top
ones to the exact reason-text style plan Appendix B specifies.

REASONS dict: PDF's own code block (Section B7) gives four entries verbatim --
`dwell_median_min`, `fan_out_1h`, `age_at_taint_days`, `shared_mule_cps` -- quoted here exactly,
unchanged. The remaining eleven canonical features are not in that code block, only in Appendix
B's prose table ("Feature | Definition | Reason shown to the officer"); those are adapted here into
the same f-string-lambda style, in the same concise, factual, non-causal tone, staying close to the
table's own wording. `activator_label` is a deliberate exception: Appendix B's table wording
("Activated by a wallet linked to a known mule cluster") asserts a specific fact (cluster
membership) this service cannot actually verify from a bare FNV-1a hash bucket number, so its
lambda here describes the feature honestly (a hash-bucket-encoded activator pattern) rather than
repeating an unverifiable claim -- consistent with the "never fabricate a reason" rule.

Never fabricates: a reason is only emitted for a feature that (a) had a positive SHAP contribution
for this specific request, AND (b) has an actually-present, actually-meaningful value (not NaN/
missing, and not a "0/false = nothing happened" baseline for count-like or boolean features). A
negative SHAP contribution is never reworded into a positive-sounding reason -- it is simply
excluded from `factors`, full stop.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd
import shap

from ..features.schema import FEATURE_NAMES
from ..inference.model import ModelBundle, get_model_bundle

#: Plan B7 Appendix B / Section B7 code block: exact reason-text templates, one lambda per
#: canonical feature name, in the plan's own concise non-causal style. The four marked VERBATIM
#: are copied byte-for-byte from the plan PDF's own `REASONS` code sample; the rest are this
#: service's own adaptation of the Appendix B "Reason shown to the officer" column.
REASONS: dict[str, Callable[[float], str]] = {
    # --- VERBATIM from the plan PDF's REASONS code block (Section B7) ---------------------------
    "dwell_median_min": lambda v: f"Forwards funds a median {v:.0f} min after receiving them",
    "fan_out_1h": lambda v: f"Split incoming funds across {int(v)} wallets within an hour",
    "age_at_taint_days": lambda v: f"Wallet was {v:.0f} days old when it received victim funds",
    "shared_mule_cps": lambda v: f"Shares {int(v)} counterparties with a known mule ring",
    # --- Adapted from Appendix B's prose table (same factual, non-causal tone) ------------------
    "fan_in_unique": lambda v: f"Received from {int(v)} unrelated senders in the last 30 days",
    "passthrough_ratio": lambda v: f"Passed on {v * 100:.0f}% of everything it received",
    "activator_label": lambda v: f"Activated by a wallet in activator-risk bucket {int(v)} (a pattern this model treats as elevated risk)",
    "trx_dust_usdt": lambda v: "Operates as a USDT relay with no TRX of its own",
    "round_amount_ratio": lambda v: f"{v * 100:.0f}% of transfers are round amounts",
    "burst_tx_per_hour": lambda v: f"Burst of {int(v)} transactions in one hour",
    "hops_from_victim": lambda v: f"{int(v)} hop(s) from the victim on the case trace",
    "hops_to_vasp": lambda v: f"{int(v)} hop(s) from the nearest attributed exchange on the case trace",
    "sanction_exposure": lambda v: f"Within {int(v)} hop(s) of a sanctioned (OFAC-listed) address on the case trace",
    "external_flags": lambda v: f"Flagged {int(v)} time(s) by third-party sources (Tronscan / stablecoin blacklist / Chainabuse)",
    "cross_case_count": lambda v: f"Appears in {int(v)} separate complaints",
}

assert set(REASONS.keys()) == set(FEATURE_NAMES), "REASONS must have an entry for every canonical feature (future-proofing, even if not all are currently reachable)"

#: Count/hop-like features where a value of exactly 0 means "nothing observed" -- never meaningful
#: enough to show an officer, even if SHAP assigns it a (typically tiny) positive contribution.
_ZERO_IS_NOT_MEANINGFUL = {
    "fan_out_1h",
    "fan_in_unique",
    "burst_tx_per_hour",
    "external_flags",
    "shared_mule_cps",
    "hops_from_victim",
    "hops_to_vasp",
    "sanction_exposure",
    "cross_case_count",
    "round_amount_ratio",
    "passthrough_ratio",
    "dwell_median_min",
}
#: Boolean-shaped feature: only 1.0 (true) is a meaningful signal, never 0.0 (false).
_BOOLEAN_TRUE_ONLY = {"trx_dust_usdt"}

MAX_REASONS = 5
MIN_REASONS_FOR_NO_STATUS = 3
STATUS_OK = "ok"
STATUS_INSUFFICIENT = "insufficient_positive_contributions"


def _is_meaningful(feature_name: str, value: float) -> bool:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return False
    if feature_name in _BOOLEAN_TRUE_ONLY:
        return value >= 0.5
    if feature_name in _ZERO_IS_NOT_MEANINGFUL and value <= 0:
        return False
    return True


@dataclass(frozen=True)
class ExplanationResult:
    factors: list[dict]  #: [{"feature", "impact", "reason"}, ...], positive-only, ranked, <=5.
    explanation_status: str  #: STATUS_OK or STATUS_INSUFFICIENT.
    base_value: float
    raw_margin_output: float
    reconstruction_error: float  #: |base_value + sum(all 15 shap values) - raw_margin_output|.


_explainer_cache: dict[int, shap.TreeExplainer] = {}


def _get_explainer(bundle: ModelBundle) -> shap.TreeExplainer:
    """Reuses one `shap.TreeExplainer` per loaded booster (keyed by the booster object's identity)
    rather than reloading/rebuilding it per request."""
    key = id(bundle.booster)
    explainer = _explainer_cache.get(key)
    if explainer is None:
        explainer = shap.TreeExplainer(bundle.booster)
        _explainer_cache[key] = explainer
    return explainer


def explain(feature_row: np.ndarray, *, bundle: ModelBundle | None = None) -> ExplanationResult:
    """Computes SHAP contributions for one 15-element feature row (canonical FEATURE_NAMES order)
    and returns the top <=5 positive-only, present-and-meaningful contributors as officer-readable
    reasons, ranked by |contribution| descending."""
    bundle = bundle or get_model_bundle()
    explainer = _get_explainer(bundle)

    row_df = pd.DataFrame([feature_row], columns=list(FEATURE_NAMES))
    shap_values = explainer.shap_values(row_df)
    row_shap = np.asarray(shap_values[0], dtype=np.float64)

    base_value = float(explainer.expected_value)
    import xgboost as xgb  # local import: keep shap_reasons usable without xgboost at import time

    dmatrix = xgb.DMatrix(row_df.values, feature_names=list(FEATURE_NAMES), missing=np.nan)
    raw_margin_output = float(bundle.booster.predict(dmatrix, output_margin=True)[0])
    reconstruction_error = abs(base_value + float(row_shap.sum()) - raw_margin_output)

    candidates = []
    for j, name in enumerate(FEATURE_NAMES):
        contribution = float(row_shap[j])
        value = float(feature_row[j])
        if contribution <= 0:
            continue  # never turn a negative/zero contribution into a reason
        if not _is_meaningful(name, value):
            continue  # never fabricate a reason for a missing/zero-baseline value
        candidates.append((name, contribution, value))

    candidates.sort(key=lambda t: abs(t[1]), reverse=True)
    top = candidates[:MAX_REASONS]

    factors = [
        {"feature": name, "impact": round(contribution, 3), "reason": REASONS[name](value)}
        for name, contribution, value in top
    ]

    status = STATUS_OK if len(factors) >= MIN_REASONS_FOR_NO_STATUS else STATUS_INSUFFICIENT

    return ExplanationResult(
        factors=factors,
        explanation_status=status,
        base_value=base_value,
        raw_margin_output=raw_margin_output,
        reconstruction_error=reconstruction_error,
    )
