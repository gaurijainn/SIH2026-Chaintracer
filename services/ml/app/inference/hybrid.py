"""B7.5: the hybrid score, band, and hard-override logic that combines the calibrated ML
probability with the deterministic rule score (`app.inference.rule_score`).

Formula (fixed, documented, never tuned against test data):
    hybrid_score = 0.6 * (calibrated_probability * 100) + 0.4 * rule_score
clamped to [0, 100]. Not rounded until final API-response serialization (main.py), so intermediate
callers/tests see the full-precision value.

Bands (boundary-inclusive, exactly as specified):
    [0, 29]   -> "Low"
    [30, 59]  -> "Medium"
    [60, 79]  -> "High"
    [80, 100] -> "Critical"

Hard overrides -- precedence over the computed band:
    `sanctioned is True` or `stablecoin_blacklisted is True` forces band="Critical", regardless of
    what the computed hybrid_score/band would otherwise have been. `None`/absent is "unknown", never
    treated as "not sanctioned" -- only an explicit True fires an override. An explicit False is
    negative evidence (feeds into rule_score.compute_rule_score, but never itself fires an
    override).

    Score/band consistency when an override fires (design decision, documented here since the plan
    PDF only says the literal words "sanctioned or stablecoin-blacklisted -> CRITICAL band" and does
    not specify what happens to the numeric `score`): the *computed* hybrid_score is reported as-is
    if it is already >= CRITICAL_BAND_FLOOR (80) -- i.e. the override and the computed score already
    agree, nothing to reconcile. If the computed hybrid_score is BELOW 80, it is floored up to 80.0
    (CRITICAL_BAND_FLOOR) before being returned, so a human reading the response never sees a
    "Critical"-banded address with e.g. score=12 -- that would be actively misleading. This means
    `score` and `band` are always mutually consistent for a human reader: band="Critical" always
    implies score >= 80. Overrides never *lower* a score that was already high; they only ever raise
    a low computed score up to the Critical floor. This flooring behavior, and which of the two
    override flags (if any) fired, is reported explicitly in the response's `overrides` list so nothing
    is hidden from the caller.
"""
from __future__ import annotations

from dataclasses import dataclass

Band = str  # "Low" | "Medium" | "High" | "Critical" -- exact PDF casing (not Prisma's UPPERCASE).

ML_WEIGHT = 0.6
RULE_WEIGHT = 0.4
assert ML_WEIGHT + RULE_WEIGHT == 1.0

#: Band lower bounds (the score at which each band starts). Bands are boundary-inclusive on their
#: own lower edge: [0, 30) Low, [30, 60) Medium, [60, 80) High, [80, 100] Critical -- so a
#: continuous score like 29.999 is still Low, and exactly 30.0 is already Medium.
BAND_MEDIUM_MIN = 30.0
BAND_HIGH_MIN = 60.0
BAND_CRITICAL_MIN = 80.0
#: Also the score floor applied when a hard override fires but the computed score was < 80.
CRITICAL_BAND_FLOOR = BAND_CRITICAL_MIN


def compute_hybrid_score(calibrated_probability: float, rule_score: float) -> float:
    """`0.6 * (calibrated_probability * 100) + 0.4 * rule_score`, clamped to [0, 100]. Not rounded."""
    raw = ML_WEIGHT * (calibrated_probability * 100.0) + RULE_WEIGHT * rule_score
    return max(0.0, min(100.0, raw))


def band_for_score(score: float) -> Band:
    """Boundary-inclusive banding: 0-29 Low, 30-59 Medium, 60-79 High, 80-100 Critical. For
    continuous (unrounded) scores, each band's own lower bound is inclusive: 29.999 is still Low,
    30.0 is already Medium, 59.999 is still Medium, 60.0 is already High, and so on."""
    if score >= BAND_CRITICAL_MIN:
        return "Critical"
    if score >= BAND_HIGH_MIN:
        return "High"
    if score >= BAND_MEDIUM_MIN:
        return "Medium"
    return "Low"


@dataclass(frozen=True)
class HybridResult:
    score: float  #: final, override-consistent 0-100 score (unrounded).
    band: Band
    computed_score: float  #: the hybrid_score before any override flooring (for audit/debugging).
    computed_band: Band  #: the band the computed_score alone would have produced.
    overrides_fired: tuple[str, ...]  #: e.g. ("sanctioned",), ("stablecoin_blacklisted",), or both.


def apply_overrides(
    calibrated_probability: float,
    rule_score: float,
    *,
    sanctioned: bool | None,
    stablecoin_blacklisted: bool | None,
) -> HybridResult:
    """Computes the hybrid score/band, then applies the hard-override precedence rule documented in
    this module's docstring. Override precedence: an explicit-True sanctioned/stablecoin_blacklisted
    flag always wins over the computed band, never the other way around."""
    computed_score = compute_hybrid_score(calibrated_probability, rule_score)
    computed_band = band_for_score(computed_score)

    fired: list[str] = []
    if sanctioned is True:
        fired.append("sanctioned")
    if stablecoin_blacklisted is True:
        fired.append("stablecoin_blacklisted")

    if not fired:
        return HybridResult(
            score=computed_score,
            band=computed_band,
            computed_score=computed_score,
            computed_band=computed_band,
            overrides_fired=(),
        )

    final_score = computed_score if computed_score >= CRITICAL_BAND_FLOOR else CRITICAL_BAND_FLOOR
    return HybridResult(
        score=final_score,
        band="Critical",
        computed_score=computed_score,
        computed_band=computed_band,
        overrides_fired=tuple(fired),
    )
