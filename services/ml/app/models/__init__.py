"""B7 model artifacts: the trained XGBoost model file, its calibrator and the model-card metadata
served from GET /model-card. metadata.py defines the model-card shape; paths.py names where a real
TRON model/calibrator/feature-metadata/metrics/model-card and a separate Ethereum baseline
model/metrics will be written under artifacts/tron/ and artifacts/ethereum/. No trained artifact
exists yet -- both directories are empty (kept in version control via .gitkeep) until a later phase
actually trains something.
"""
from .metadata import ModelFamily, ModelMetadata, ModelStatus, UNTRAINED_MODEL_VERSION, trained_metadata, untrained_metadata
from .paths import (
    ARTIFACTS_DIR,
    ETHEREUM_ARTIFACTS_DIR,
    TRON_ARTIFACTS_DIR,
    ethereum_metrics_path,
    ethereum_model_card_path,
    ethereum_model_path,
    tron_calibrator_path,
    tron_feature_metadata_path,
    tron_metrics_path,
    tron_model_card_md_path,
    tron_model_card_path,
    tron_model_path,
    tron_training_metadata_path,
)

__all__ = [
    "ModelFamily",
    "ModelMetadata",
    "ModelStatus",
    "UNTRAINED_MODEL_VERSION",
    "untrained_metadata",
    "trained_metadata",
    "ARTIFACTS_DIR",
    "TRON_ARTIFACTS_DIR",
    "ETHEREUM_ARTIFACTS_DIR",
    "tron_model_path",
    "tron_calibrator_path",
    "tron_feature_metadata_path",
    "tron_metrics_path",
    "tron_model_card_path",
    "tron_model_card_md_path",
    "tron_training_metadata_path",
    "ethereum_model_path",
    "ethereum_metrics_path",
    "ethereum_model_card_path",
]
