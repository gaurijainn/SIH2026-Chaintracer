"""Canonical dataset row schema shared by every B7 loader (plan Section 4 + Appendix B). One row is
one labeled entity (an address or a transaction) from one dataset, normalised to a common shape so
training (B7.3+) never has to special-case a dataset's own column names or label vocabulary.

Neutral vocabulary only (same rule as B5/B6): a row is "illicit"/"high_risk"/"licit"/"unknown",
never "criminal" — Tether also freezes wallets holding stolen funds, and Elliptic's own "illicit"
label covers many different underlying reasons.
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class Chain(str, Enum):
    """Matches packages/shared/src/chainTypes.ts's Chain union on the Node side, plus UNKNOWN for
    benchmark datasets that don't state a chain explicitly (kept distinct from BTC/ETH so a loader
    is never tempted to guess)."""

    TRON = "TRON"
    ETH = "ETH"
    BSC = "BSC"
    POLYGON = "POLYGON"
    BTC = "BTC"
    UNKNOWN = "UNKNOWN"


class IdentifierType(str, Enum):
    ADDRESS = "address"
    TRANSACTION = "transaction"
    SUBGRAPH = "subgraph"  # Elliptic2: a labeled subgraph, not a single address or transaction


class DatasetLabel(str, Enum):
    """Every dataset's own label vocabulary maps onto this set; a loader that cannot map a raw
    label value onto one of these must fail validation rather than guess (see validation.py)."""

    ILLICIT = "illicit"
    LICIT = "licit"
    HIGH_RISK = "high_risk"  # plan B7's TRON bootstrap vocabulary ("high-risk", not "criminal")
    UNKNOWN = "unknown"  # Elliptic's ~77% unlabeled majority class


class DatasetRow(BaseModel):
    """One normalised, labeled entity from one dataset."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    identifier: str = Field(min_length=1, description="Address, transaction hash, or subgraph id, dataset-defined by identifier_type")
    identifier_type: IdentifierType
    chain: Chain
    label: DatasetLabel
    timestamp: datetime | None = Field(default=None, description="None when the dataset provides no real-world timestamp (e.g. Elliptic's anonymised time steps)")
    source: str = Field(min_length=1, description="Dataset id this row came from, e.g. 'kaggle-eth-fraud', 'elliptic', 'tron-bootstrap'")
    features: dict[str, float] = Field(default_factory=dict, description="Raw dataset feature columns where the dataset provides them; empty for datasets whose features are computed later (e.g. TRON bootstrap uses B6's Appendix-B pipeline, not raw columns)")
    extra: dict[str, Any] = Field(default_factory=dict, description="Non-numeric dataset-specific metadata that doesn't fit `features` (e.g. a public tag)")
