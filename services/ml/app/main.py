"""Risk + XAI service. B0 shipped only the health surface; B7.1 added the ML foundation (deps,
module layout, the canonical Appendix-B feature schema) with no scoring behavior yet. B7.5 adds the
real /score, /typology and /model-card endpoints, wired to the real B7.4-trained TRON v1 artifacts
(no retraining, no calibration refit -- this module only loads and serves what B7.4 already
produced)."""
from __future__ import annotations

import json

from fastapi import FastAPI, HTTPException

from app.explainability.shap_reasons import explain
from app.inference.features import build_inference_row
from app.inference.hybrid import apply_overrides
from app.inference.model import MODEL_VERSION, MODEL_VERSION_FULL, ModelArtifactError, calibrate, get_model_bundle, score_raw
from app.inference.rule_score import compute_rule_score
from app.inference.schemas import AddressScoreRequest, AddressScoreResponse, ScoreFactor, ScoreRequest, TypologyRequest, TypologyResponse
from app.models.metadata import UNTRAINED_MODEL_VERSION
from app.models.paths import tron_feature_metadata_path, tron_metrics_path, tron_model_card_path, tron_training_metadata_path
from app.typology.rules import classify_typology

app = FastAPI(title="PS26183 risk + XAI service")

#: Maps hybrid.py's internal override-reason keys to the response's `overrides` entries (PDF-style
#: uppercase constants, e.g. "STABLECOIN_BLACKLIST" from the plan's own /score example).
_OVERRIDE_LABELS = {"sanctioned": "SANCTIONED", "stablecoin_blacklisted": "STABLECOIN_BLACKLIST"}


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "ml", "modelVersion": UNTRAINED_MODEL_VERSION}


def _score_one(item: AddressScoreRequest) -> AddressScoreResponse:
    inference_row = build_inference_row(item.features)

    try:
        bundle = get_model_bundle()
    except ModelArtifactError as exc:
        raise HTTPException(status_code=500, detail=f"model artifact error: {exc}") from exc

    raw_prob = score_raw(inference_row.values, bundle=bundle)
    calibrated_prob = calibrate(raw_prob, bundle=bundle)

    rule_result = compute_rule_score(item.features, sanctioned=item.sanctioned, stablecoin_blacklisted=item.stablecoin_blacklisted)

    hybrid = apply_overrides(
        calibrated_prob,
        rule_result.rule_score,
        sanctioned=item.sanctioned,
        stablecoin_blacklisted=item.stablecoin_blacklisted,
    )

    explanation = explain(inference_row.values, bundle=bundle)

    return AddressScoreResponse(
        addr=item.addr,
        score=round(hybrid.score),
        band=hybrid.band,
        factors=[ScoreFactor(**f) for f in explanation.factors],
        overrides=[_OVERRIDE_LABELS[name] for name in hybrid.overrides_fired],
        modelVersion=MODEL_VERSION_FULL,
        mlProbability=calibrated_prob,
        ruleScore=rule_result.rule_score,
        explanationStatus=explanation.explanation_status,
        datasetVersion=bundle.dataset_version,
    )


@app.post("/score", response_model=list[AddressScoreResponse])
def score(request: ScoreRequest) -> list[AddressScoreResponse]:
    return [_score_one(item) for item in request.addresses]


@app.post("/typology", response_model=TypologyResponse)
def typology(request: TypologyRequest) -> TypologyResponse:
    result = classify_typology(request.case_features.model_dump(), request.complaint_category)
    return TypologyResponse(label=result.label, confidence=result.confidence, signals=result.signals)


@app.get("/model-card")
def model_card() -> dict:
    card_path = tron_model_card_path(MODEL_VERSION)
    metrics_path = tron_metrics_path(MODEL_VERSION)
    training_metadata_path = tron_training_metadata_path(MODEL_VERSION)
    feature_metadata_path = tron_feature_metadata_path(MODEL_VERSION)

    for path in (card_path, metrics_path, training_metadata_path, feature_metadata_path):
        if not path.exists():
            raise HTTPException(status_code=500, detail=f"model card artifact missing: {path}")

    card = json.loads(card_path.read_text(encoding="utf-8"))
    metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
    training_metadata = json.loads(training_metadata_path.read_text(encoding="utf-8"))
    feature_metadata = json.loads(feature_metadata_path.read_text(encoding="utf-8"))

    return {
        "modelVersion": MODEL_VERSION_FULL,
        "status": card["status"],
        "trainedAt": card["trained_at"],
        "dataSources": card["data_sources"],
        "datasetVersion": training_metadata["dataset_version"],
        "rowCounts": training_metadata["row_counts"],
        "calibrationMethod": training_metadata["calibration_method"],
        "calibrationFitSplit": training_metadata["calibration_fit_split"],
        "classificationThreshold": training_metadata["classification_threshold"],
        "metrics": metrics["splits"],
        "featureOrder": feature_metadata["feature_order"],
        "featureInfo": feature_metadata["features"],
        "limitations": card["limitations"],
    }
