"""B7.5: model-loading singleton and raw/calibrated scoring. Uses the real, already-trained (B7.4)
tron-xgb-v1 artifacts on disk -- never retrains, never refits. Skips (not fails) if those artifacts
are not present in this test session, matching the convention in tests/test_model_artifacts.py."""
from __future__ import annotations

import numpy as np
import pytest

from app.features.schema import FEATURE_NAMES
from app.inference.model import get_model_bundle, calibrate, score_raw
from app.models.paths import tron_model_path

_ARTIFACTS_TRAINED = tron_model_path("v1").exists()
_SKIP_REASON = "real v1 TRON artifacts not present in this test session"

pytestmark = pytest.mark.skipif(not _ARTIFACTS_TRAINED, reason=_SKIP_REASON)


def _nan_row() -> np.ndarray:
    return np.full(len(FEATURE_NAMES), np.nan, dtype=np.float64)


def test_bundle_loads_and_feature_order_matches_canonical_schema():
    bundle = get_model_bundle()
    assert bundle.feature_order == FEATURE_NAMES


def test_bundle_is_a_singleton_across_calls():
    b1 = get_model_bundle()
    b2 = get_model_bundle()
    assert b1 is b2


def test_score_raw_on_all_nan_row_is_a_valid_probability():
    bundle = get_model_bundle()
    p = score_raw(_nan_row(), bundle=bundle)
    assert 0.0 <= p <= 1.0


def test_score_raw_is_deterministic():
    bundle = get_model_bundle()
    row = _nan_row()
    row[FEATURE_NAMES.index("fan_out_1h")] = 8.0
    p1 = score_raw(row, bundle=bundle)
    p2 = score_raw(row, bundle=bundle)
    assert p1 == p2


def test_calibrate_output_is_clipped_to_0_1():
    bundle = get_model_bundle()
    for raw in (-5.0, 0.0, 0.5, 1.0, 5.0):
        calibrated = calibrate(raw, bundle=bundle)
        assert 0.0 <= calibrated <= 1.0
