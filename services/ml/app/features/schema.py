"""The canonical B7 feature schema (plan Appendix B: "Features for the risk model and their reason
text"). This is the single source of truth for both the feature *names* and their *order* — training
(B7.2+) builds its feature matrix from `FEATURE_NAMES`/`feature_row`, and inference (B7.2+) validates
every incoming request through `FeatureVector`, so a training row and a live scoring request can never
silently drift apart (a differently-ordered or misspelled feature would fail validation instead of
being fed into the model wrong).

Field shapes mirror apps/api/src/mule/types.ts's MuleFeatures (B6) exactly, since B6 is what computes
this vector today: nullable fields are the ones B6 can legitimately not know (e.g. no AddressProfile
row yet); everything else always has a value, defaulting to 0/False/[] rather than null.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class FeatureVector(BaseModel):
    """One address's B7 Appendix-B feature vector. Field order is the canonical feature order."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    dwell_median_min: float | None = Field(default=None, description="Median minutes between receiving and forwarding funds")
    fan_out_1h: int = Field(ge=0, description="Distinct recipients within 1 hour of an inbound")
    fan_in_unique: int = Field(ge=0, description="Distinct senders in the last 30 days")
    passthrough_ratio: float | None = Field(default=None, ge=0, description="Value out / value in")
    age_at_taint_days: float | None = Field(default=None, ge=0, description="Account age when first tainted funds arrived")
    activator_label: str | None = Field(default=None, description="Label of the wallet that activated this TRON account")
    trx_dust_usdt: bool = Field(description="Holds USDT but almost no TRX; relies on rented energy")
    round_amount_ratio: float = Field(ge=0, le=1, description="Share of transfers in round amounts")
    burst_tx_per_hour: int = Field(ge=0, description="Peak transactions per hour")
    hops_from_victim: int | None = Field(default=None, ge=0, description="Graph distance from the victim on the case trace")
    hops_to_vasp: int | None = Field(default=None, ge=0, description="Graph distance to the nearest exchange on the case trace")
    sanction_exposure: int | None = Field(default=None, ge=0, description="Hop-distance exposure to an OFAC-listed address")
    external_flags: list[str] = Field(default_factory=list, description="Tronscan fraud flag / USDT blacklist / Chainabuse report categories")
    shared_mule_cps: int = Field(ge=0, description="Counterparties shared with known mule rings")
    cross_case_count: int = Field(ge=1, description="Complaints/cases this wallet appears in")


#: Canonical feature order, derived from FeatureVector itself so it can never drift from the schema.
FEATURE_NAMES: tuple[str, ...] = tuple(FeatureVector.model_fields.keys())

assert FEATURE_NAMES == (
    "dwell_median_min",
    "fan_out_1h",
    "fan_in_unique",
    "passthrough_ratio",
    "age_at_taint_days",
    "activator_label",
    "trx_dust_usdt",
    "round_amount_ratio",
    "burst_tx_per_hour",
    "hops_from_victim",
    "hops_to_vasp",
    "sanction_exposure",
    "external_flags",
    "shared_mule_cps",
    "cross_case_count",
), "FEATURE_NAMES must match plan Appendix B's 15 features, in the plan's own order"


def feature_dict(vector: FeatureVector) -> dict[str, Any]:
    """`vector`'s fields as a plain dict, in canonical `FEATURE_NAMES` order."""
    dumped = vector.model_dump()
    return {name: dumped[name] for name in FEATURE_NAMES}


def feature_row(vector: FeatureVector) -> list[Any]:
    """`vector`'s values only, in canonical `FEATURE_NAMES` order (training/inference alignment)."""
    return list(feature_dict(vector).values())
