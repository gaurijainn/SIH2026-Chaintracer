"""B7.5: deterministic typology rule engine (plan PDF Section B7's typology table, quoted below).
Pure rule logic over case-level signals a `/typology` request supplies explicitly -- never over the
15 canonical B7 Appendix-B address features (those describe one address's behavior; typology is a
case-level judgment about the whole fraud pattern) and never tuned against any test set (there is
no typology test set -- this is rule logic, not a learned model).

Typology              On-chain signals                                                Complaint prior
Investment/            Escalating deposits from the same victim over days or weeks;    Investment or trading fraud
pig-butchering         a consolidation wallet; exit via OTC, instant-swap or exchange
Sextortion             Many small, similar-value inbound payments from unrelated       Sextortion or extortion
                        senders to a short-lived address
Ransomware              Bitcoin-heavy; one large inbound per victim; fast peel chains;  Ransomware
                        mixer or privacy-coin swap exposure
Phishing/wallet drainer Victim approval or permission change right before the outflow;  Phishing, fake app
                        known drainer contract
Address poisoning       Zero-value or dust transfers from look-alike addresses          Wrong-address transfer
                        (same-tail spoofing)

Confidence is explicitly "rule-derived confidence, not a model-calibrated probability" -- a simple,
bounded [0, 1], deterministic function of (a) how much of a typology's on-chain-signal weight
matched (each typology's signal weights sum to 1.0) and (b) whether the complaint's own stated
category agrees with that typology's prior (a fixed +0.2 bonus, capped at 1.0 overall).

If no typology has any matched on-chain signal at all, the result is `"Unknown"` -- a documented
fallback, not an error, and never a forced guess from the complaint category alone (a complaint
prior on its own, with zero on-chain corroboration, is not enough to name a typology).
"""
from __future__ import annotations

from dataclasses import dataclass

#: Per-typology on-chain signal weights (each typology's weights sum to 1.0, so a fully-matched
#: typology's on-chain-only base score is exactly 1.0 before any complaint-prior bonus).
_TYPOLOGY_SIGNAL_WEIGHTS: dict[str, dict[str, float]] = {
    "pig_butchering": {
        "escalating_deposits": 0.4,
        "consolidation_wallet": 0.3,
        "exit_via_otc_swap_exchange": 0.3,
    },
    "sextortion": {
        "many_small_similar_inbound": 0.6,
        "short_lived_address": 0.4,
    },
    "ransomware": {
        "bitcoin_heavy": 0.25,
        "one_large_inbound_per_victim": 0.25,
        "fast_peel_chain": 0.25,
        "mixer_or_privacy_coin_exposure": 0.25,
    },
    "phishing_drainer": {
        "approval_change_before_outflow": 0.5,
        "known_drainer_contract": 0.5,
    },
    "address_poisoning": {
        "zero_value_or_dust_transfers": 0.5,
        "look_alike_address": 0.5,
    },
}

#: Human-readable descriptions per signal key, matching the plan PDF's own wording (the /typology
#: contract example response uses exactly "many small similar inbound" for that signal).
_SIGNAL_DESCRIPTIONS: dict[str, str] = {
    "escalating_deposits": "escalating deposits from the same victim over days or weeks",
    "consolidation_wallet": "consolidation wallet",
    "exit_via_otc_swap_exchange": "exit via OTC, instant-swap or exchange",
    "many_small_similar_inbound": "many small similar inbound",
    "short_lived_address": "short-lived address",
    "bitcoin_heavy": "bitcoin-heavy",
    "one_large_inbound_per_victim": "one large inbound per victim",
    "fast_peel_chain": "fast peel chains",
    "mixer_or_privacy_coin_exposure": "mixer or privacy-coin swap exposure",
    "approval_change_before_outflow": "approval or permission change before the outflow",
    "known_drainer_contract": "known drainer contract",
    "zero_value_or_dust_transfers": "zero-value or dust transfers",
    "look_alike_address": "look-alike address",
}

#: Complaint-category prior strings (lower-cased, matched by substring) that boost each typology.
_TYPOLOGY_PRIORS: dict[str, tuple[str, ...]] = {
    "pig_butchering": ("investment or trading fraud", "investment fraud", "trading fraud"),
    "sextortion": ("sextortion or extortion", "sextortion", "extortion"),
    "ransomware": ("ransomware",),
    "phishing_drainer": ("phishing, fake app", "phishing", "fake app", "drainer"),
    "address_poisoning": ("wrong-address transfer", "wrong address transfer", "address poisoning"),
}

#: Display label per internal typology key (PDF's own casing/spelling for the label field).
_DISPLAY_LABEL: dict[str, str] = {
    "pig_butchering": "pig_butchering",
    "sextortion": "sextortion",
    "ransomware": "ransomware",
    "phishing_drainer": "phishing_drainer",
    "address_poisoning": "address_poisoning",
}

UNKNOWN_LABEL = "Unknown"
PRIOR_BONUS = 0.2
ON_CHAIN_WEIGHT = 1.0 - PRIOR_BONUS


@dataclass(frozen=True)
class TypologyResult:
    label: str  #: one of the 5 typology keys, or "Unknown".
    confidence: float  #: [0, 1], rule-derived, NOT a model-calibrated probability.
    signals: list[str]  #: human-readable descriptions of the on-chain signals that matched.


def _prior_matches(typology: str, complaint_category: str | None) -> bool:
    if not complaint_category:
        return False
    category_lower = complaint_category.strip().lower()
    return any(prior in category_lower for prior in _TYPOLOGY_PRIORS[typology])


def classify_typology(case_features: dict[str, bool | None], complaint_category: str | None = None) -> TypologyResult:
    """`case_features`: a dict of the optional boolean case-level signal fields (unset/None keys
    are treated as "unknown", never as False -- a signal that was never reported is not evidence
    against a typology). `complaint_category`: the free-text NCRP complaint category, used only as
    a bounded confidence bonus per the plan's prior table, never as the sole basis for a label."""
    best_label: str | None = None
    best_confidence = 0.0
    best_signals: list[str] = []

    for typology, weights in _TYPOLOGY_SIGNAL_WEIGHTS.items():
        matched_weight = 0.0
        matched_signals: list[str] = []
        for signal_key, weight in weights.items():
            if case_features.get(signal_key) is True:
                matched_weight += weight
                matched_signals.append(_SIGNAL_DESCRIPTIONS[signal_key])

        if matched_weight <= 0.0:
            continue  # no on-chain corroboration at all -> this typology is not a candidate

        prior_match = _prior_matches(typology, complaint_category)
        confidence = min(1.0, matched_weight * ON_CHAIN_WEIGHT + (PRIOR_BONUS if prior_match else 0.0))

        if confidence > best_confidence:
            best_label = typology
            best_confidence = confidence
            best_signals = matched_signals

    if best_label is None:
        return TypologyResult(label=UNKNOWN_LABEL, confidence=0.0, signals=[])

    return TypologyResult(label=_DISPLAY_LABEL[best_label], confidence=best_confidence, signals=best_signals)
