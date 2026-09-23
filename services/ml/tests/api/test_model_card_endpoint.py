"""B7.5: FastAPI /model-card endpoint. Reads real B7.4 artifacts, never invents metrics."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.paths import tron_model_card_path

_ARTIFACTS_TRAINED = tron_model_card_path("v1").exists()
pytestmark = pytest.mark.skipif(not _ARTIFACTS_TRAINED, reason="real v1 TRON model card not present in this test session")

client = TestClient(app)


def test_model_card_returns_200_with_expected_fields():
    resp = client.get("/model-card")
    assert resp.status_code == 200
    body = resp.json()
    for key in ("modelVersion", "status", "trainedAt", "dataSources", "datasetVersion", "rowCounts", "calibrationMethod", "classificationThreshold", "metrics", "featureOrder", "featureInfo", "limitations"):
        assert key in body
    assert body["modelVersion"] == "tron-xgb-v1"
    assert body["status"] == "trained"
    assert set(body["metrics"].keys()) == {"train", "calibration", "test"}
    assert len(body["featureOrder"]) == 15


def test_model_card_limitations_include_key_caveats():
    resp = client.get("/model-card")
    limitations_text = " ".join(resp.json()["limitations"])
    assert "500-row" in limitations_text
    assert "not a criminal" in limitations_text or "not a validated production fraud detector" in limitations_text
