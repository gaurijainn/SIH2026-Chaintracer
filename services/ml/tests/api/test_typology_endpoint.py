"""B7.5: FastAPI /typology endpoint integration tests."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_typology_matches_and_returns_expected_shape():
    resp = client.post("/typology", json={"caseFeatures": {"many_small_similar_inbound": True, "short_lived_address": True}, "complaintCategory": "sextortion"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["label"] == "sextortion"
    assert 0.0 <= body["confidence"] <= 1.0
    assert isinstance(body["signals"], list)


def test_typology_no_case_features_defaults_to_unknown():
    resp = client.post("/typology", json={"complaintCategory": "some unrelated category"})
    assert resp.status_code == 200
    assert resp.json()["label"] == "Unknown"


def test_typology_unknown_case_feature_key_returns_422():
    resp = client.post("/typology", json={"caseFeatures": {"not_a_real_signal": True}})
    assert resp.status_code == 422
