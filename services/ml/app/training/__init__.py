"""B7.4 training preparation: label collapsing, the deterministic time-based train/calibration/test
split, and class-weight computation from the train split only. Actual XGBoost fitting and isotonic
calibration are not implemented here (they arrive in B7.5+, once real data exists) -- these are the
reusable pieces that step will use.
"""
from .calibration import IsotonicCalibrator
from .feature_matrix import (
    ACTIVATOR_LABEL_BUCKETS,
    ACTIVATOR_LABEL_ENCODER_NAME,
    FeatureMatrixResult,
    build_feature_matrix,
    encode_activator_label,
    encode_external_flags_count,
)
from .labels import BinaryLabel, collapse_label
from .split import TemporalSplit, build_temporal_split
from .timestamps import correct_row_timestamps, derive_event_timestamp
from .weights import compute_scale_pos_weight

__all__ = [
    "BinaryLabel",
    "collapse_label",
    "TemporalSplit",
    "build_temporal_split",
    "compute_scale_pos_weight",
    "correct_row_timestamps",
    "derive_event_timestamp",
    "build_feature_matrix",
    "FeatureMatrixResult",
    "encode_activator_label",
    "encode_external_flags_count",
    "ACTIVATOR_LABEL_BUCKETS",
    "ACTIVATOR_LABEL_ENCODER_NAME",
    "IsotonicCalibrator",
]
