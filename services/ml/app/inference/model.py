"""B7.5: loads the real, already-trained (B7.4) TRON XGBoost model + isotonic calibrator once per
process and exposes raw/calibrated scoring functions. Never retrains, never refits, never touches
the dataset -- purely reads the artifacts B7.4 already wrote and committed.

Loading is a lazy module-level singleton (see `get_model_bundle`): the first call loads from disk
and validates; every later call in the same process reuses the same objects. Any structural
mismatch between the artifacts on disk and what this service expects raises a specific,
loud exception immediately -- this service must never silently paper over a drifted artifact by
falling back to some default or partial behavior.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
import xgboost as xgb

from ..features.schema import FEATURE_NAMES
from ..models.paths import (
    tron_calibrator_path,
    tron_feature_metadata_path,
    tron_model_path,
    tron_training_metadata_path,
)
from ..training.calibration import IsotonicCalibrator

MODEL_VERSION = "v1"
MODEL_VERSION_FULL = "tron-xgb-v1"


class ModelArtifactError(Exception):
    """Raised when a loaded TRON model artifact does not match what this service expects (missing
    file, feature-order mismatch, feature-count mismatch, ...). Deliberately a distinct exception
    type -- callers must never catch this alongside generic Exception and silently continue; a
    drifted or missing artifact is a deploy-time bug, not a request-time condition to route around."""


@dataclass(frozen=True)
class ModelBundle:
    booster: xgb.Booster
    calibrator: IsotonicCalibrator
    feature_order: tuple[str, ...]
    dataset_version: str
    preprocessing_version: str
    model_version: str = MODEL_VERSION_FULL


def _load_bundle() -> ModelBundle:
    model_path = tron_model_path(MODEL_VERSION)
    calibrator_path = tron_calibrator_path(MODEL_VERSION)
    feature_metadata_path = tron_feature_metadata_path(MODEL_VERSION)
    training_metadata_path = tron_training_metadata_path(MODEL_VERSION)

    for path, label in (
        (model_path, "model"),
        (calibrator_path, "calibrator"),
        (feature_metadata_path, "feature metadata"),
        (training_metadata_path, "training metadata"),
    ):
        if not path.exists():
            raise ModelArtifactError(f"required TRON {label} artifact is missing: {path}")

    feature_metadata = json.loads(feature_metadata_path.read_text(encoding="utf-8"))
    feature_order = tuple(feature_metadata["feature_order"])
    if feature_order != FEATURE_NAMES:
        raise ModelArtifactError(
            "tron-xgb-v1-features.json feature_order does not match the canonical FEATURE_NAMES "
            f"schema: artifact={feature_order!r} vs schema={FEATURE_NAMES!r}"
        )

    booster = xgb.Booster()
    booster.load_model(str(model_path))

    model_feature_names = booster.feature_names
    if model_feature_names is None or tuple(model_feature_names) != FEATURE_NAMES:
        raise ModelArtifactError(
            "loaded XGBoost booster's feature_names do not match the canonical 15-feature schema "
            f"this service builds inference rows in: model={model_feature_names!r} vs "
            f"schema={FEATURE_NAMES!r}"
        )
    if booster.num_features() != len(FEATURE_NAMES):
        raise ModelArtifactError(
            f"loaded XGBoost booster expects {booster.num_features()} features but the canonical "
            f"schema has {len(FEATURE_NAMES)}"
        )

    calibrator = IsotonicCalibrator.load(calibrator_path)

    training_metadata = json.loads(training_metadata_path.read_text(encoding="utf-8"))
    dataset_version = training_metadata.get("dataset_version", "unknown")
    preprocessing_version = training_metadata.get("preprocessing_version", "unknown")

    return ModelBundle(
        booster=booster,
        calibrator=calibrator,
        feature_order=feature_order,
        dataset_version=dataset_version,
        preprocessing_version=preprocessing_version,
    )


@lru_cache(maxsize=1)
def get_model_bundle() -> ModelBundle:
    """Loads (once per process) and returns the singleton TRON v1 model bundle. Subsequent calls
    reuse the cached bundle rather than re-reading from disk."""
    return _load_bundle()


def score_raw(feature_row: np.ndarray, bundle: ModelBundle | None = None) -> float:
    """Raw (uncalibrated) XGBoost probability of the positive (high_risk) class for one 15-element
    feature row, in canonical FEATURE_NAMES order."""
    bundle = bundle or get_model_bundle()
    row = np.asarray(feature_row, dtype=np.float64).reshape(1, -1)
    if row.shape[1] != len(bundle.feature_order):
        raise ModelArtifactError(
            f"feature row has {row.shape[1]} columns but the model expects {len(bundle.feature_order)}"
        )
    dmatrix = xgb.DMatrix(row, feature_names=list(bundle.feature_order), missing=np.nan)
    pred = bundle.booster.predict(dmatrix)
    return float(pred[0])


def calibrate(raw_prob: float, bundle: ModelBundle | None = None) -> float:
    """Isotonic-calibrated probability, clipped to [0, 1] (IsotonicCalibrator.predict already
    clips)."""
    bundle = bundle or get_model_bundle()
    calibrated = bundle.calibrator.predict(np.array([raw_prob], dtype=np.float64))
    return float(calibrated[0])
