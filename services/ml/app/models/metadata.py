"""Model-artifact/version metadata shapes (plan B7: GET /model-card). B7.1 defines the structure
only — no model has been trained yet, so the module-level singleton below always reports the
"untrained" placeholder. B7.2+ replaces it once training produces a real artifact.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

ModelStatus = Literal["untrained", "trained"]

#: plan B7.4 architecture: the TRON production model (B6 Appendix-B features + TRON bootstrap
#: labels) and the Ethereum baseline (Kaggle's native features) are separate models with separate
#: model cards -- never one card covering a matrix that mixed the two.
ModelFamily = Literal["tron", "ethereum"]

#: Version string used until a real model is trained (plan B7 example: "tron-xgb-v1").
UNTRAINED_MODEL_VERSION = "unloaded"


class ModelMetadata(BaseModel):
    """The B7 model card: data sources, metrics, known limitations, date trained (plan B7)."""

    model_family: ModelFamily
    model_version: str = UNTRAINED_MODEL_VERSION
    status: ModelStatus = "untrained"
    trained_at: datetime | None = None
    data_sources: list[str] = Field(default_factory=list)
    metrics: dict[str, float] = Field(default_factory=dict)
    limitations: list[str] = Field(
        default_factory=lambda: ["no model has been trained yet (B7.1: ML foundation only)"]
    )
    feature_names: list[str] = Field(default_factory=list)


def untrained_metadata(model_family: ModelFamily, feature_names: tuple[str, ...] = ()) -> ModelMetadata:
    """The placeholder model card B7.1/B7.4 ship until a later phase trains a real model."""
    return ModelMetadata(model_family=model_family, feature_names=list(feature_names))


def trained_metadata(
    model_family: ModelFamily,
    *,
    model_version: str,
    trained_at: datetime,
    data_sources: list[str],
    metrics: dict[str, float],
    limitations: list[str],
    feature_names: tuple[str, ...],
) -> ModelMetadata:
    """The compact, structured "status=trained" model card counterpart to `untrained_metadata`,
    written by `app/training/train_tron.py` to `tron_model_card_path(version)` once a real model
    exists. `metrics` is a flat summary (e.g. `{"test_roc_auc": 0.9, "test_pr_auc": 0.85, ...}`) --
    this is the compact JSON card; the full narrative writeup lives in the sibling
    `tron_model_card_md_path(version)` markdown file, produced separately by the training script."""
    return ModelMetadata(
        model_family=model_family,
        model_version=model_version,
        status="trained",
        trained_at=trained_at,
        data_sources=data_sources,
        metrics=metrics,
        limitations=limitations,
        feature_names=list(feature_names),
    )
