"""B7.4: real per-row event-timestamp derivation for the TRON bootstrap dataset.

Why this module exists (do not delete this rationale -- it documents a real, verified finding,
not a hypothetical): `TronBootstrapLoader` sets `DatasetRow.timestamp` from the CSV's `fetched_at`
column, which is the *collection run's* wall-clock time (`generatedAt` in
`data/labels/tron-bootstrap/v1/validation_report.json`), not a per-row event time. In the real,
live-collected `tron_bootstrap_dataset.csv`, every single one of the 500 rows carries the exact
same `fetched_at` value. Feeding that straight into `app/training/split.py`'s
`build_temporal_split()` produces zero temporal diversity: every row ties on the same timestamp,
the split's tie-extension logic pushes the whole dataset into one partition, and the function
correctly raises rather than silently producing a degenerate split.

Per the project's own instruction ("if the dataset lacks enough temporal diversity, STOP and
report; do not invent dates"), the right move is *not* to invent per-row dates. But there is real,
already-collected, non-fabricated temporal signal sitting unused in the CSV's `evidence` column
(carried through, unparsed, into `DatasetRow.extra["evidence"]` and
`DatasetRow.extra["source_detail"]` by the loader) -- this module extracts it instead of inventing
anything:

  - source == "usdt_blacklist" (235 rows): evidence is
    `{"eventCount": N, "events": [{"txHash":..., "blockNumber":..., "blockTimestampMs": ms}, ...]}`.
    We take the *earliest* `blockTimestampMs` across the row's events -- the real on-chain moment
    the AddedBlackList event(s) backing this label occurred.
  - source == "ofac+usdt_blacklist" (14 rows): evidence is a JSON array of
    `{"source": ..., "evidence": {...}, "confidence": ...}` entries (one per contributing source
    for that address). We find the entry whose `source` is `"usdt_blacklist"` and extract its
    nested `evidence.events[*].blockTimestampMs` the same way as above.
  - source == "tron_negative_sampling" (250 rows, all licit): evidence is
    `{"activity_evidence": {...}, "usdt_holder_evidence": {"usdtTxCount": N, "observedAt": ms,
    "sampleAmount": ...}}`. We use `usdt_holder_evidence.observedAt` -- the real, recorded moment
    this address's USDT activity was observed during negative sampling.
  - source == "ofac" (exactly 1 row): evidence is `{"list": ..., "file": ..., "repo": ...}` --
    a static reference to a sanctions list file, with genuinely no event timestamp of any kind
    embedded anywhere. For this single row only, we fall back to the row's existing
    `timestamp` (== `fetched_at`, i.e. "when we recorded this label"). That IS a real fact, just a
    coarse one -- it is not fabricated, it is simply the best real signal available for this one
    row. This is documented here explicitly so nobody mistakes it for the same degenerate-fetched_at
    problem this module otherwise fixes: it affects exactly one row, not the whole dataset.

`DatasetRow` is a frozen pydantic model (`extra="forbid", frozen=True`), so rows are never mutated
in place -- `correct_row_timestamps()` returns *new* rows built via `.model_copy(update=...)`,
leaving the original loader output untouched. `build_temporal_split()` and `tron_bootstrap.py`
itself are deliberately not modified: both work exactly as designed for datasets that do carry
per-row `fetched_at` diversity (a reasonable general assumption for most future loaders); this is
an additive, TRON-bootstrap-specific correction layered on top, not a fix to either module.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Sequence

from ..datasets import DatasetRow

#: Sources for which the earliest embedded on-chain event timestamp is the row's real event time.
_BLACKLIST_EVENT_SOURCES = {"usdt_blacklist"}


def _earliest_event_ms(evidence: dict[str, Any]) -> int:
    events = evidence.get("events") or []
    if not events:
        raise ValueError("usdt_blacklist-shaped evidence has no events to derive a timestamp from")
    return min(int(e["blockTimestampMs"]) for e in events)


def derive_event_timestamp(row: DatasetRow) -> datetime:
    """The real event timestamp for one TRON-bootstrap `DatasetRow`, derived from its `extra`
    payload (`source_detail` + parsed `evidence`) per the four cases documented at module level.
    Raises ValueError for any source/evidence shape it doesn't recognize, rather than silently
    falling back to the degenerate `fetched_at` value for a row that could have a real one.
    """
    source = row.extra.get("source_detail")
    evidence = row.extra.get("evidence")

    if source in _BLACKLIST_EVENT_SOURCES:
        if not isinstance(evidence, dict):
            raise ValueError(f"{row.identifier}: source={source!r} expects a dict evidence payload, got {type(evidence)}")
        ms = _earliest_event_ms(evidence)
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)

    if source == "ofac+usdt_blacklist":
        if not isinstance(evidence, list):
            raise ValueError(f"{row.identifier}: source={source!r} expects a list evidence payload, got {type(evidence)}")
        matches = [e for e in evidence if isinstance(e, dict) and e.get("source") == "usdt_blacklist"]
        if not matches:
            raise ValueError(f"{row.identifier}: source={source!r} evidence has no nested usdt_blacklist entry")
        ms = _earliest_event_ms(matches[0]["evidence"])
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)

    if source == "tron_negative_sampling":
        if not isinstance(evidence, dict):
            raise ValueError(f"{row.identifier}: source={source!r} expects a dict evidence payload, got {type(evidence)}")
        holder_evidence = evidence.get("usdt_holder_evidence")
        if not holder_evidence or "observedAt" not in holder_evidence:
            raise ValueError(f"{row.identifier}: source={source!r} evidence has no usdt_holder_evidence.observedAt")
        ms = int(holder_evidence["observedAt"])
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)

    if source == "ofac":
        # No timestamp of any kind is embedded in a bare OFAC-list evidence payload (see module
        # docstring). Fall back to the row's existing timestamp (fetched_at) -- a real, if coarse,
        # fact, not an invented one. Documented explicitly so this single-row fallback is never
        # confused with the dataset-wide degenerate-fetched_at problem this module otherwise fixes.
        if row.timestamp is None:
            raise ValueError(f"{row.identifier}: source={source!r} has no evidence timestamp and no fetched_at fallback either")
        return row.timestamp

    raise ValueError(f"{row.identifier}: unrecognized source_detail={source!r}; cannot derive a real event timestamp without inventing one")


def correct_row_timestamps(rows: Sequence[DatasetRow]) -> list[DatasetRow]:
    """Returns new `DatasetRow`s with `.timestamp` replaced by `derive_event_timestamp(row)`.
    `DatasetRow` is frozen, so each row is rebuilt via `.model_copy(update=...)` rather than
    mutated -- the input sequence is left untouched."""
    return [row.model_copy(update={"timestamp": derive_event_timestamp(row)}) for row in rows]
