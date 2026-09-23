"""Where future real trained artifacts will be written (plan B7.4 Task 7: directory/metadata
structure only -- no artifact is created by this module, and none exists on disk yet beyond the
empty `artifacts/tron/` and `artifacts/ethereum/` directories themselves).

Two separate subtrees, matching the plan's architecture: the TRON production model (B6 features +
bootstrap labels) and the Ethereum baseline (Kaggle's native features) are different models with
different artifacts, never sharing a directory or a version namespace.
"""
from __future__ import annotations

from pathlib import Path

ARTIFACTS_DIR = Path(__file__).parent / "artifacts"
TRON_ARTIFACTS_DIR = ARTIFACTS_DIR / "tron"
ETHEREUM_ARTIFACTS_DIR = ARTIFACTS_DIR / "ethereum"


def tron_model_path(version: str) -> Path:
    return TRON_ARTIFACTS_DIR / f"tron-xgb-{version}.json"


def tron_calibrator_path(version: str) -> Path:
    return TRON_ARTIFACTS_DIR / f"tron-xgb-{version}-calibrator.joblib"


def tron_feature_metadata_path(version: str) -> Path:
    return TRON_ARTIFACTS_DIR / f"tron-xgb-{version}-features.json"


def tron_metrics_path(version: str) -> Path:
    return TRON_ARTIFACTS_DIR / f"tron-xgb-{version}-metrics.json"


def tron_model_card_path(version: str) -> Path:
    return TRON_ARTIFACTS_DIR / f"tron-xgb-{version}-model-card.json"


def tron_training_metadata_path(version: str) -> Path:
    return TRON_ARTIFACTS_DIR / f"tron-xgb-{version}-training-metadata.json"


def tron_model_card_md_path(version: str) -> Path:
    return TRON_ARTIFACTS_DIR / f"tron-xgb-{version}-model-card.md"


def ethereum_model_path(version: str) -> Path:
    return ETHEREUM_ARTIFACTS_DIR / f"eth-baseline-{version}.json"


def ethereum_metrics_path(version: str) -> Path:
    return ETHEREUM_ARTIFACTS_DIR / f"eth-baseline-{version}-metrics.json"


def ethereum_model_card_path(version: str) -> Path:
    return ETHEREUM_ARTIFACTS_DIR / f"eth-baseline-{version}-model-card.json"
