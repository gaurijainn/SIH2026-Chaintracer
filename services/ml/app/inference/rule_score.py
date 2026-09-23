"""B7.5, user decision #1: a deterministic, independently unit-testable rule-score module -- NOT a
stub returning 0. Combines a handful of named, bounded (0-100) sub-scores into one 0-100
`rule_score`, using only signals the request itself supplies: the address's `FeatureVector` plus
two explicit evidence fields (`sanctioned`, `stablecoin_blacklisted`) that a caller may attach to a
`/score` request. Never uses the fitted XGBoost/calibrator output, never uses label/source/evidence
fields that would reveal the ground truth, never fabricates a value for a signal the request didn't
provide.

Design rules (verbatim from the user's brief):
  - deterministic, bounded 0-100, independently unit-testable
  - weights are named constants
  - each rule function contributes a sub-score only when its own signal is genuinely present (not
    None) -- "missing" is never silently treated as "0" or "no risk"; it means the rule simply does
    not participate in that request's combination
  - if literally no applicable signal is present anywhere in the request, `rule_score` legitimately
    == 0.0 -- documented here as expected behavior, never raised as an error

Threshold provenance: several thresholds mirror the *philosophy* (not the code, not a shared
constant -- this is a separate Python service, no cross-language import) of B6's own rule
thresholds in apps/api/src/mule/config.ts (`DEFAULT_MULE_RULE_CONFIG`), read there as a reference
only:
  - passThrough.valueTolerance = 0.05, passThrough.maxDwellMinutes = 60
  - fanOut.minDistinctOutputs = 5
  - freshWallet.maxAgeDays = 7
These are cited per-constant below. None of these constants, nor any other threshold in this
module, was tuned against the B7.4 training/calibration/test data -- they are hand-picked, modest,
documented judgment calls, exactly as the user required.
"""
from __future__ import annotations

from dataclasses import dataclass

from ..features.schema import FeatureVector

# --- Named weight constants (sum to 100; each rule's max 0-100 sub-score is scaled by weight/100) -
WEIGHT_PASSTHROUGH = 20.0
WEIGHT_FAN_OUT = 15.0
WEIGHT_FRESH_WALLET = 15.0
WEIGHT_EXTERNAL_FLAGS = 15.0
WEIGHT_SANCTION_BLACKLIST = 20.0
WEIGHT_VASP_EXPOSURE = 5.0
WEIGHT_MULE_EVIDENCE = 10.0

assert (
    WEIGHT_PASSTHROUGH
    + WEIGHT_FAN_OUT
    + WEIGHT_FRESH_WALLET
    + WEIGHT_EXTERNAL_FLAGS
    + WEIGHT_SANCTION_BLACKLIST
    + WEIGHT_VASP_EXPOSURE
    + WEIGHT_MULE_EVIDENCE
    == 100.0
), "rule weights must sum to 100 so a fully-saturated, fully-present request scores exactly 100"

# --- Named threshold constants -------------------------------------------------------------------
#: apps/api/src/mule/config.ts DEFAULT_MULE_RULE_CONFIG.passThrough.valueTolerance (read-only
#: reference; "approximately equal" value-out/value-in).
PASSTHROUGH_RATIO_TOLERANCE = 0.05
#: Beyond this deviation from 1.0, pass-through value-matching is no longer considered any signal.
PASSTHROUGH_RATIO_DECAY_LIMIT = 0.5
#: apps/api/src/mule/config.ts DEFAULT_MULE_RULE_CONFIG.passThrough.maxDwellMinutes.
PASSTHROUGH_MAX_DWELL_MINUTES = 60.0
#: Beyond this dwell time, pass-through timing is no longer considered any signal.
PASSTHROUGH_DWELL_DECAY_LIMIT_MINUTES = 240.0

#: apps/api/src/mule/config.ts DEFAULT_MULE_RULE_CONFIG.fanOut.minDistinctOutputs.
FAN_OUT_MIN_DISTINCT = 5
#: fan_out_1h at or above this is treated as maximally suspicious (saturation point).
FAN_OUT_SATURATION = 2 * FAN_OUT_MIN_DISTINCT

#: apps/api/src/mule/config.ts DEFAULT_MULE_RULE_CONFIG.freshWallet.maxAgeDays.
FRESH_WALLET_MAX_AGE_DAYS = 7.0
#: Beyond this age, "freshness" is no longer considered any signal.
FRESH_WALLET_DECAY_LIMIT_DAYS = FRESH_WALLET_MAX_AGE_DAYS * 4

#: external_flags count at or above this is treated as maximally suspicious.
EXTERNAL_FLAGS_SATURATION_COUNT = 3

#: hops_to_vasp at or below this is treated as maximally suspicious (near-term cash-out risk).
VASP_CLOSE_HOPS = 2
#: Beyond this hop distance, VASP proximity is no longer considered any signal.
VASP_DECAY_LIMIT_HOPS = VASP_CLOSE_HOPS * 4

#: shared_mule_cps at or above this is treated as maximally suspicious.
SHARED_MULE_CPS_SATURATION = 5
#: cross_case_count *beyond the baseline 1* at or above this is treated as maximally suspicious.
CROSS_CASE_COUNT_EXTRA_SATURATION = 3


def _clamp01_100(x: float) -> float:
    return max(0.0, min(100.0, x))


def _linear_decay(value: float, saturated_at: float, zero_at: float) -> float:
    """100.0 at `value <= saturated_at`, linearly down to 0.0 at `value >= zero_at`, else the
    linear interpolation between them. `zero_at` must be > `saturated_at`."""
    if value <= saturated_at:
        return 100.0
    if value >= zero_at:
        return 0.0
    return 100.0 * (zero_at - value) / (zero_at - saturated_at)


# --- Independent, named rule functions ------------------------------------------------------------
# Each returns a float in [0, 100] when its signal genuinely applies, or None when the request gave
# no usable input for that rule (never conflated with "0 = no risk").


def _rule_passthrough(fv: FeatureVector) -> float | None:
    """Pass-through mule behavior: value out ~= value in, forwarded quickly."""
    if fv.passthrough_ratio is None and fv.dwell_median_min is None:
        return None
    parts: list[float] = []
    if fv.passthrough_ratio is not None:
        deviation = abs(fv.passthrough_ratio - 1.0)
        if deviation <= PASSTHROUGH_RATIO_TOLERANCE:
            parts.append(100.0)
        elif deviation >= PASSTHROUGH_RATIO_DECAY_LIMIT:
            parts.append(0.0)
        else:
            span = PASSTHROUGH_RATIO_DECAY_LIMIT - PASSTHROUGH_RATIO_TOLERANCE
            parts.append(100.0 * (PASSTHROUGH_RATIO_DECAY_LIMIT - deviation) / span)
    if fv.dwell_median_min is not None:
        parts.append(
            _linear_decay(
                fv.dwell_median_min,
                saturated_at=PASSTHROUGH_MAX_DWELL_MINUTES,
                zero_at=PASSTHROUGH_DWELL_DECAY_LIMIT_MINUTES,
            )
        )
    return sum(parts) / len(parts)


def _rule_fan_out(fv: FeatureVector) -> float:
    """Distinct-recipient fan-out within 1 hour. `fan_out_1h` is a required, always-present int (0
    is a real "no fan-out observed" value, not a missing signal), so this rule always applies."""
    x = fv.fan_out_1h
    if x <= 0:
        return 0.0
    if x >= FAN_OUT_SATURATION:
        return 100.0
    if x < FAN_OUT_MIN_DISTINCT:
        return (x / FAN_OUT_MIN_DISTINCT) * 70.0
    return 70.0 + (x - FAN_OUT_MIN_DISTINCT) / (FAN_OUT_SATURATION - FAN_OUT_MIN_DISTINCT) * 30.0


def _rule_fresh_wallet(fv: FeatureVector) -> float | None:
    """Account age at first tainted-fund receipt; freshly-created accounts receiving tainted funds
    are a classic mule-onboarding pattern."""
    if fv.age_at_taint_days is None:
        return None
    return _linear_decay(
        fv.age_at_taint_days,
        saturated_at=FRESH_WALLET_MAX_AGE_DAYS,
        zero_at=FRESH_WALLET_DECAY_LIMIT_DAYS,
    )


def _rule_external_flags(fv: FeatureVector) -> float | None:
    """Third-party fraud/blacklist/report flags (Tronscan/USDT-blacklist/Chainabuse categories).
    An empty list means "no flags reported", which is genuinely "no applicable signal" here (not a
    0-risk assertion), so this rule does not participate for an empty list."""
    n = len(fv.external_flags)
    if n == 0:
        return None
    return _clamp01_100((n / EXTERNAL_FLAGS_SATURATION_COUNT) * 100.0)


def _rule_sanction_blacklist(sanctioned: bool | None, stablecoin_blacklisted: bool | None) -> float | None:
    """Explicit sanction/stablecoin-blacklist evidence, supplied as its own request field --
    deliberately NOT derived from `sanction_exposure` (a graph-hop-distance int the model never saw
    any real training signal for, not a positive/negative evidence flag). None/absent means
    "unknown", never "not sanctioned"; only an explicit True/False value participates."""
    if sanctioned is None and stablecoin_blacklisted is None:
        return None
    if sanctioned is True or stablecoin_blacklisted is True:
        return 100.0
    return 0.0  # both explicitly known and both False: genuine negative evidence, not missing


def _rule_vasp_exposure(fv: FeatureVector) -> float | None:
    """Graph-hop closeness to a known exchange/VASP on the case trace; closer proximity can signal
    imminent cash-out risk. Uses `hops_to_vasp` purely as a rule input -- this field is one of the
    3 the trained model never learned from (100% missing in the training data), so this is a rule
    signal only, never presented as something the ML model itself used."""
    if fv.hops_to_vasp is None:
        return None
    return _linear_decay(float(fv.hops_to_vasp), saturated_at=VASP_CLOSE_HOPS, zero_at=VASP_DECAY_LIMIT_HOPS)


def _rule_mule_evidence(fv: FeatureVector) -> float:
    """Shared counterparties with known mule rings / how many cases this wallet appears in.
    `shared_mule_cps` and `cross_case_count` are required, always-present ints (0 / 1-baseline are
    real "no elevated signal" values, not missing data), so this rule always applies. Note: both
    fields were zero-variance in the B7.4 training data (a bootstrap-collector completeness gap,
    not evidence the true values are always 0) -- a nonzero value in a *live* request is still
    legitimate rule signal, since this rule is not learned from the training distribution."""
    contributions: list[float] = []
    if fv.shared_mule_cps > 0:
        contributions.append(_clamp01_100((fv.shared_mule_cps / SHARED_MULE_CPS_SATURATION) * 100.0))
    if fv.cross_case_count > 1:
        extra = fv.cross_case_count - 1
        contributions.append(_clamp01_100((extra / CROSS_CASE_COUNT_EXTRA_SATURATION) * 100.0))
    if not contributions:
        return 0.0
    return sum(contributions) / len(contributions)


@dataclass(frozen=True)
class RuleScoreResult:
    rule_score: float  #: final 0-100 combined score, clamped.
    sub_scores: dict[str, float | None]  #: per-rule raw sub-score (None if not applicable).
    applicable_rules: tuple[str, ...]  #: which rules actually contributed (sub-score was not None).


def compute_rule_score(
    fv: FeatureVector,
    *,
    sanctioned: bool | None = None,
    stablecoin_blacklisted: bool | None = None,
) -> RuleScoreResult:
    """Deterministic weighted-sum-then-clamp combination of the independent rule functions above.
    `rule_score = clamp(sum(weight_i * sub_score_i / 100 for i where sub_score_i is not None), 0, 100)`.
    If no rule is applicable at all (every nullable-signal rule returned None and both always-
    applicable rules legitimately evaluated to 0.0), `rule_score` is exactly 0.0 -- this is the
    documented, expected "no applicable signal" outcome, not an error condition."""
    sub_scores: dict[str, float | None] = {
        "passthrough": _rule_passthrough(fv),
        "fan_out": _rule_fan_out(fv),
        "fresh_wallet": _rule_fresh_wallet(fv),
        "external_flags": _rule_external_flags(fv),
        "sanction_blacklist": _rule_sanction_blacklist(sanctioned, stablecoin_blacklisted),
        "vasp_exposure": _rule_vasp_exposure(fv),
        "mule_evidence": _rule_mule_evidence(fv),
    }
    weights = {
        "passthrough": WEIGHT_PASSTHROUGH,
        "fan_out": WEIGHT_FAN_OUT,
        "fresh_wallet": WEIGHT_FRESH_WALLET,
        "external_flags": WEIGHT_EXTERNAL_FLAGS,
        "sanction_blacklist": WEIGHT_SANCTION_BLACKLIST,
        "vasp_exposure": WEIGHT_VASP_EXPOSURE,
        "mule_evidence": WEIGHT_MULE_EVIDENCE,
    }

    total = 0.0
    applicable: list[str] = []
    for name, sub in sub_scores.items():
        if sub is None:
            continue
        applicable.append(name)
        total += weights[name] * (sub / 100.0)

    return RuleScoreResult(
        rule_score=_clamp01_100(total),
        sub_scores=sub_scores,
        applicable_rules=tuple(applicable),
    )
