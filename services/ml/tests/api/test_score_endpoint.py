"""B7.5: FastAPI /score endpoint integration tests -- real HTTP-shaped requests through
TestClient(app), against the real loaded tron-xgb-v1 artifacts. Skips if those artifacts are not
present in this test session (same convention as tests/test_model_artifacts.py)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.paths import tron_model_path

_ARTIFACTS_TRAINED = tron_model_path("v1").exists()
pytestmark = pytest.mark.skipif(not _ARTIFACTS_TRAINED, reason="real v1 TRON artifacts not present in this test session")

client = TestClient(app)

_FULL_FEATURES = {
    "dwell_median_min": 12.0,
    "fan_out_1h": 8,
    "fan_in_unique": 15,
    "passthrough_ratio": 0.98,
    "age_at_taint_days": 2.0,
    "activator_label": "TSomeActivator123",
    "trx_dust_usdt": True,
    "round_amount_ratio": 0.7,
    "burst_tx_per_hour": 20,
    "hops_from_victim": None,
    "hops_to_vasp": None,
    "sanction_exposure": None,
    "external_flags": ["high_risk", "reported"],
    "shared_mule_cps": 4,
    "cross_case_count": 3,
}

_MINIMAL_FEATURES = {
    "dwell_median_min": None,
    "fan_out_1h": 0,
    "fan_in_unique": 1,
    "passthrough_ratio": None,
    "age_at_taint_days": None,
    "activator_label": None,
    "trx_dust_usdt": False,
    "round_amount_ratio": 0.0,
    "burst_tx_per_hour": 0,
    "hops_from_victim": None,
    "hops_to_vasp": None,
    "sanction_exposure": None,
    "external_flags": [],
    "shared_mule_cps": 0,
    "cross_case_count": 1,
}


def test_score_single_address_returns_200_with_expected_shape():
    resp = client.post("/score", json={"addresses": [{"chain": "TRON", "addr": "TAddr1", "features": _FULL_FEATURES}]})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    item = body[0]
    for key in ("addr", "score", "band", "factors", "overrides", "modelVersion", "mlProbability", "ruleScore", "explanationStatus", "datasetVersion"):
        assert key in item
    assert item["band"] in ("Low", "Medium", "High", "Critical")
    assert 0 <= item["score"] <= 100
    assert item["modelVersion"] == "tron-xgb-v1"


def test_score_batch_of_two_addresses():
    resp = client.post(
        "/score",
        json={
            "addresses": [
                {"chain": "TRON", "addr": "TAddr1", "features": _FULL_FEATURES},
                {"chain": "TRON", "addr": "TAddr2", "features": _MINIMAL_FEATURES},
            ]
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 2
    assert body[0]["addr"] == "TAddr1"
    assert body[1]["addr"] == "TAddr2"


def test_score_accepts_cross_case_count_zero():
    # Regression test (B7.5 cleanup): the real tron-bootstrap-v1 dataset has cross_case_count=0
    # for every row, so POST /score must accept it -- it must never 422 because of this field.
    zero_case_features = dict(_FULL_FEATURES)
    zero_case_features["cross_case_count"] = 0
    resp = client.post("/score", json={"addresses": [{"chain": "TRON", "addr": "TAddr1", "features": zero_case_features}]})
    assert resp.status_code == 200
    body = resp.json()[0]
    assert "score" in body
    assert 0 <= body["score"] <= 100


def test_score_sanctioned_override_forces_critical_band():
    resp = client.post(
        "/score",
        json={"addresses": [{"chain": "TRON", "addr": "TAddr1", "features": _MINIMAL_FEATURES, "sanctioned": True}]},
    )
    body = resp.json()[0]
    assert body["band"] == "Critical"
    assert "SANCTIONED" in body["overrides"]
    assert body["score"] >= 80


def test_score_malformed_feature_vector_returns_422_not_500():
    bad_features = dict(_MINIMAL_FEATURES)
    bad_features["fan_out_1h"] = -5  # violates ge=0
    resp = client.post("/score", json={"addresses": [{"chain": "TRON", "addr": "TAddr1", "features": bad_features}]})
    assert resp.status_code == 422


def test_score_unknown_extra_field_in_features_returns_422():
    bad_features = dict(_MINIMAL_FEATURES)
    bad_features["not_a_real_feature"] = 1
    resp = client.post("/score", json={"addresses": [{"chain": "TRON", "addr": "TAddr1", "features": bad_features}]})
    assert resp.status_code == 422


def test_score_missing_addresses_field_returns_422():
    resp = client.post("/score", json={})
    assert resp.status_code == 422


def test_score_empty_addresses_list_returns_422():
    resp = client.post("/score", json={"addresses": []})
    assert resp.status_code == 422


def test_score_unsupported_chain_returns_422():
    resp = client.post("/score", json={"addresses": [{"chain": "ETH", "addr": "0xabc", "features": _MINIMAL_FEATURES}]})
    assert resp.status_code == 422
