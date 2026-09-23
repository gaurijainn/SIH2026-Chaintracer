"""B7.5: pydantic request/response shapes for the `/score` and `/typology` FastAPI endpoints (plan
PDF Section B7's "ML service (internal)" contract), plus the case-level typology signal fields the
plan's typology table implies but never names as a JSON schema (those are added here as explicit,
optional, `None`-defaulted fields -- unset must never be read as `False`).
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ..features.schema import FeatureVector

# --- /score -----------------------------------------------------------------------------------


class AddressScoreRequest(BaseModel):
    """One address to score. `sanctioned`/`stablecoin_blacklisted` are explicit, separate evidence
    fields (see `app.inference.hybrid`) -- `None`/absent means "unknown", never "not sanctioned"."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    chain: Literal["TRON"] = Field(description="Only TRON is supported by the v1 model")
    addr: str
    features: FeatureVector
    sanctioned: bool | None = None
    stablecoin_blacklisted: bool | None = Field(default=None, alias="stablecoinBlacklisted")


class ScoreRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    addresses: list[AddressScoreRequest] = Field(min_length=1)


class ScoreFactor(BaseModel):
    feature: str
    impact: float
    reason: str


class AddressScoreResponse(BaseModel):
    """Response item. Field names are camelCase directly (this is an outgoing-only response shape,
    matching the plan PDF's own /score response example casing)."""

    addr: str
    score: int  #: 0-100, rounded only here at serialization time.
    band: Literal["Low", "Medium", "High", "Critical"]
    factors: list[ScoreFactor]
    overrides: list[str]
    modelVersion: str
    mlProbability: float  #: calibrated ML probability (0-1, unrounded).
    ruleScore: float  #: 0-100 rule score (unrounded).
    explanationStatus: str
    datasetVersion: str


# --- /typology --------------------------------------------------------------------------------


class CaseFeatures(BaseModel):
    """Case-level typology signals (plan PDF Section B7's typology table). Every field defaults to
    `None` ("unknown"/not reported) -- never assumed False. These are NOT part of the 15 canonical
    B7 Appendix-B address features; they describe the whole fraud pattern, not one address."""

    model_config = ConfigDict(extra="forbid")

    escalating_deposits: bool | None = None
    consolidation_wallet: bool | None = None
    exit_via_otc_swap_exchange: bool | None = None
    many_small_similar_inbound: bool | None = None
    short_lived_address: bool | None = None
    bitcoin_heavy: bool | None = None
    one_large_inbound_per_victim: bool | None = None
    fast_peel_chain: bool | None = None
    mixer_or_privacy_coin_exposure: bool | None = None
    approval_change_before_outflow: bool | None = None
    known_drainer_contract: bool | None = None
    zero_value_or_dust_transfers: bool | None = None
    look_alike_address: bool | None = None


class TypologyRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    case_features: CaseFeatures = Field(default_factory=CaseFeatures, alias="caseFeatures")
    complaint_category: str | None = Field(default=None, alias="complaintCategory")


class TypologyResponse(BaseModel):
    label: str
    confidence: float
    signals: list[str]
