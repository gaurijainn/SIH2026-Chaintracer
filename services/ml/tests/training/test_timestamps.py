"""B7.4: app/training/timestamps.py -- real per-row event-timestamp derivation for the TRON
bootstrap dataset. Covers the exact 4 evidence shapes documented in that module (verified against
the real tron_bootstrap_dataset.csv), including the single-row ofac-only fallback case.
"""
from datetime import datetime, timezone

import pytest

from app.datasets import Chain, DatasetLabel, DatasetRow, IdentifierType
from app.training.timestamps import correct_row_timestamps, derive_event_timestamp

FETCHED_AT = datetime(2026, 9, 23, 5, 7, 32, tzinfo=timezone.utc)


def row(identifier: str, source_detail: str, evidence, *, timestamp=FETCHED_AT) -> DatasetRow:
    return DatasetRow(
        identifier=identifier,
        identifier_type=IdentifierType.ADDRESS,
        chain=Chain.TRON,
        label=DatasetLabel.HIGH_RISK,
        timestamp=timestamp,
        source="tron-bootstrap",
        features={},
        extra={"source_detail": source_detail, "evidence": evidence},
    )


def test_usdt_blacklist_uses_earliest_block_timestamp_ms():
    r = row(
        "addr1",
        "usdt_blacklist",
        {"eventCount": 2, "events": [{"txHash": "a", "blockNumber": 1, "blockTimestampMs": 1758539670000}, {"txHash": "b", "blockNumber": 2, "blockTimestampMs": 1752306693000}]},
    )
    ts = derive_event_timestamp(r)
    assert ts == datetime.fromtimestamp(1752306693000 / 1000, tz=timezone.utc)


def test_ofac_plus_usdt_blacklist_extracts_nested_usdt_blacklist_entry():
    r = row(
        "addr2",
        "ofac+usdt_blacklist",
        [
            {"source": "usdt_blacklist", "evidence": {"eventCount": 1, "events": [{"txHash": "c", "blockNumber": 3, "blockTimestampMs": 1782892932000}]}, "confidence": 0.9},
            {"source": "ofac", "evidence": {"list": "OFAC SDN digital-currency addresses", "file": "sanctioned_addresses_TRX.txt"}, "confidence": 1},
        ],
    )
    ts = derive_event_timestamp(r)
    assert ts == datetime.fromtimestamp(1782892932000 / 1000, tz=timezone.utc)


def test_tron_negative_sampling_uses_usdt_holder_observed_at():
    r = row(
        "addr3",
        "tron_negative_sampling",
        {"activity_evidence": {"txCount": 400, "lastActiveAt": 1790136792000, "createdAt": 1763544903000}, "usdt_holder_evidence": {"usdtTxCount": 400, "observedAt": 1790136792000, "sampleAmount": "25159"}},
    )
    ts = derive_event_timestamp(r)
    assert ts == datetime.fromtimestamp(1790136792000 / 1000, tz=timezone.utc)


def test_ofac_only_falls_back_to_fetched_at_since_it_has_no_embedded_timestamp():
    r = row("addr4", "ofac", {"list": "OFAC SDN digital-currency addresses", "file": "sanctioned_addresses_TRX.txt", "repo": "github.com/0xB10C/ofac-sanctioned-digital-currency-addresses"})
    ts = derive_event_timestamp(r)
    assert ts == FETCHED_AT


def test_unrecognized_source_raises_rather_than_inventing_a_timestamp():
    r = row("addr5", "some_future_source", {"whatever": True})
    with pytest.raises(ValueError, match="unrecognized"):
        derive_event_timestamp(r)


def test_correct_row_timestamps_never_mutates_input_and_returns_new_rows():
    original = row("addr1", "usdt_blacklist", {"eventCount": 1, "events": [{"txHash": "a", "blockNumber": 1, "blockTimestampMs": 1758539670000}]})
    corrected = correct_row_timestamps([original])
    assert original.timestamp == FETCHED_AT  # untouched (frozen model, never mutated)
    assert corrected[0].timestamp == datetime.fromtimestamp(1758539670000 / 1000, tz=timezone.utc)
    assert corrected[0] is not original
    assert corrected[0].identifier == original.identifier  # everything else preserved


def test_correct_row_timestamps_surfaces_real_diversity_from_a_degenerate_fetched_at():
    # The real bug this module fixes: every row shares the same fetched_at, but each row's
    # evidence carries a genuinely different real event time.
    rows = [
        row("addr1", "usdt_blacklist", {"eventCount": 1, "events": [{"txHash": "a", "blockNumber": 1, "blockTimestampMs": 1758539670000}]}),
        row("addr2", "usdt_blacklist", {"eventCount": 1, "events": [{"txHash": "b", "blockNumber": 2, "blockTimestampMs": 1752306693000}]}),
    ]
    assert len({r.timestamp for r in rows}) == 1  # degenerate before correction
    corrected = correct_row_timestamps(rows)
    assert len({r.timestamp for r in corrected}) == 2  # real diversity after correction
