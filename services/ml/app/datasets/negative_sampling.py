"""TRON negative-sampling candidate interface (plan B7 bootstrap box: "sample active USDT holders
with none of these flags, excluding tagged services"). This is a *review* structure, not a
DatasetLoader: it records the evidence for or against treating an address as a training negative,
so the future real collector (not built here) can be audited later. It deliberately does not
produce DatasetRow objects directly -- see confirmed_negatives() below for how a candidate becomes
usable training input, via the same TronBootstrapLoader path as any other label.

Plan-mandated rule: "do not label an address negative merely because no evidence was found." A
candidate's status can only be INCLUDED (a confirmed negative) when both activity_evidence and
usdt_holder_evidence are actually present and non-empty; otherwise it must be UNDETERMINED. This is
enforced by validation, not left to the caller's discipline.
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

import pandas as pd
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .schema import Chain


class NegativeCandidateStatus(str, Enum):
    #: confirmed negative -- active USDT holder, no risk flags, not a tagged service.
    INCLUDED = "included"
    #: excluded from the negative pool (e.g. is itself a tagged exchange/service/contract).
    EXCLUDED = "excluded"
    #: insufficient evidence either way -- must NOT be treated as a negative.
    UNDETERMINED = "undetermined"


class NegativeCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    address: str = Field(min_length=1)
    chain: Chain
    #: e.g. {"txCount": 42, "lastActiveAt": "..."}; empty when no activity evidence was collected.
    activity_evidence: dict[str, Any] = Field(default_factory=dict)
    #: e.g. {"balance": 120.5, "observedAt": "..."}; empty when no USDT-holding evidence was collected.
    usdt_holder_evidence: dict[str, Any] = Field(default_factory=dict)
    status: NegativeCandidateStatus
    #: required when status == EXCLUDED (e.g. "tagged as an exchange hot wallet"); null otherwise.
    exclusion_reason: str | None = None
    source: str = Field(min_length=1)
    timestamp: datetime

    @model_validator(mode="after")
    def _status_matches_evidence(self) -> "NegativeCandidate":
        has_evidence = bool(self.activity_evidence) and bool(self.usdt_holder_evidence)
        if self.status == NegativeCandidateStatus.INCLUDED and not has_evidence:
            raise ValueError("a candidate cannot be INCLUDED without both activity_evidence and usdt_holder_evidence -- absence of evidence is not evidence of a negative")
        if self.status == NegativeCandidateStatus.EXCLUDED and not self.exclusion_reason:
            raise ValueError("an EXCLUDED candidate must state exclusion_reason")
        if self.status != NegativeCandidateStatus.EXCLUDED and self.exclusion_reason is not None:
            raise ValueError("exclusion_reason is only meaningful when status is EXCLUDED")
        return self


REQUIRED_COLUMNS = ["address", "chain", "status", "source", "timestamp"]


def load_negative_candidates(path: str | Path) -> list[NegativeCandidate]:
    """Reads a local CSV of negative-sampling candidates. Local-file only, like every B7.2 loader --
    no live TronGrid/Tronscan call happens here; that's the future collector's job."""
    path = Path(path)
    df = pd.read_csv(path)
    df.columns = [str(c).strip().lower() for c in df.columns]
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"tron-negative-sampling: {path}: missing required columns: {missing}")

    candidates: list[NegativeCandidate] = []
    for i, r in df.iterrows():
        try:
            candidates.append(
                NegativeCandidate(
                    address=str(r["address"]),
                    chain=Chain(r["chain"]),
                    activity_evidence=_parse_evidence_cell(r.get("activity_evidence")),
                    usdt_holder_evidence=_parse_evidence_cell(r.get("usdt_holder_evidence")),
                    status=NegativeCandidateStatus(r["status"]),
                    exclusion_reason=r.get("exclusion_reason") if pd.notna(r.get("exclusion_reason")) else None,
                    source=str(r["source"]),
                    timestamp=pd.to_datetime(r["timestamp"], utc=True).to_pydatetime(),
                )
            )
        except Exception as e:  # noqa: BLE001 - surfaced as one error per row
            raise ValueError(f"tron-negative-sampling: {path}: row {i} ({r.get('address', '?')}): {e}") from e
    return candidates


def _parse_evidence_cell(raw: Any) -> dict[str, Any]:
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return {}
    if isinstance(raw, dict):
        return raw
    import json

    try:
        parsed = json.loads(str(raw))
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def confirmed_negatives(candidates: list[NegativeCandidate]) -> list[NegativeCandidate]:
    """Only status == INCLUDED candidates are usable as actual training negatives; EXCLUDED and
    UNDETERMINED candidates are kept for audit but never silently promoted to "negative"."""
    return [c for c in candidates if c.status == NegativeCandidateStatus.INCLUDED]
