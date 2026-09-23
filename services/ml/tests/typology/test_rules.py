"""B7.5: typology rule engine. Covers all 5 typologies matching, no-match -> Unknown fallback,
incomplete evidence (unset fields never treated as False), and deterministic confidence."""
from __future__ import annotations

from app.typology.rules import UNKNOWN_LABEL, classify_typology


def test_pig_butchering_matches():
    result = classify_typology(
        {"escalating_deposits": True, "consolidation_wallet": True, "exit_via_otc_swap_exchange": True},
        complaint_category="Investment or trading fraud",
    )
    assert result.label == "pig_butchering"
    assert result.confidence == 1.0
    assert len(result.signals) == 3


def test_sextortion_matches():
    result = classify_typology(
        {"many_small_similar_inbound": True, "short_lived_address": True},
        complaint_category="Sextortion or extortion",
    )
    assert result.label == "sextortion"
    assert "many small similar inbound" in result.signals


def test_ransomware_matches():
    result = classify_typology(
        {"bitcoin_heavy": True, "fast_peel_chain": True},
        complaint_category="Ransomware",
    )
    assert result.label == "ransomware"
    assert result.confidence > 0.0


def test_phishing_drainer_matches():
    result = classify_typology(
        {"approval_change_before_outflow": True},
        complaint_category="Phishing, fake app",
    )
    assert result.label == "phishing_drainer"


def test_address_poisoning_matches():
    result = classify_typology(
        {"zero_value_or_dust_transfers": True, "look_alike_address": True},
        complaint_category="Wrong-address transfer",
    )
    assert result.label == "address_poisoning"
    assert result.confidence == 1.0


def test_no_match_falls_back_to_unknown():
    result = classify_typology({}, complaint_category="Investment or trading fraud")
    assert result.label == UNKNOWN_LABEL
    assert result.confidence == 0.0
    assert result.signals == []


def test_incomplete_evidence_unset_fields_never_treated_as_false():
    # Only one of pig-butchering's 3 signals set; the other two are simply absent (None), not False.
    result = classify_typology({"escalating_deposits": True}, complaint_category=None)
    assert result.label == "pig_butchering"
    assert result.confidence == 0.4 * 0.8  # only the escalating_deposits weight (0.4) applied, no prior bonus


def test_complaint_category_prior_boosts_confidence_without_being_required():
    without_prior = classify_typology({"bitcoin_heavy": True}, complaint_category=None)
    with_prior = classify_typology({"bitcoin_heavy": True}, complaint_category="Ransomware")
    assert with_prior.confidence > without_prior.confidence
    assert without_prior.label == "ransomware"  # on-chain signal alone is still enough to name it


def test_confidence_is_deterministic():
    features = {"mixer_or_privacy_coin_exposure": True, "one_large_inbound_per_victim": True}
    r1 = classify_typology(features, complaint_category="Ransomware")
    r2 = classify_typology(features, complaint_category="Ransomware")
    assert r1.confidence == r2.confidence
    assert r1.label == r2.label


def test_confidence_always_bounded_0_1():
    result = classify_typology(
        {"escalating_deposits": True, "consolidation_wallet": True, "exit_via_otc_swap_exchange": True},
        complaint_category="Investment or trading fraud",
    )
    assert 0.0 <= result.confidence <= 1.0
