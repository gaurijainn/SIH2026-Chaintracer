"""B7.4: isotonic probability calibration for the TRON XGBoost model (plan: calibrate raw model
scores into honest probabilities). Method is fixed to isotonic regression (`sklearn.isotonic
.IsotonicRegression`), not Platt/sigmoid scaling -- isotonic makes no parametric assumption about
the shape of the miscalibration, which matters more than its extra variance at this dataset size
being a concern (500 rows total, ~100 in the calibration split) is outweighed by not forcing a
sigmoid shape onto data that may not follow one.

Structural leakage rule (enforced by convention here, verified by a real test in
tests/training/test_calibration.py): this must be fit ONLY on the calibration split's raw XGBoost
`predict_proba` outputs vs. true labels -- never on train (the model already saw those rows) and
never on test (the calibrator would then contaminate the very split used to report honest metrics).
"""
from __future__ import annotations

from pathlib import Path
from typing import Sequence

import joblib
import numpy as np
from sklearn.isotonic import IsotonicRegression


class IsotonicCalibrator:
    """Thin, save/load-able wrapper around `sklearn.isotonic.IsotonicRegression`, clipped to
    [0, 1] (a calibrated probability must never leave that range, even for raw scores outside the
    range seen during fitting)."""

    def __init__(self) -> None:
        self._model = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        self._fitted = False

    def fit(self, raw_probs: Sequence[float], true_binary_labels: Sequence[int]) -> "IsotonicCalibrator":
        """`raw_probs`: the trained model's uncalibrated `predict_proba(...)[:, 1]` on the
        CALIBRATION split only. `true_binary_labels`: 0/1 ground truth for the same rows, same
        order."""
        raw = np.asarray(raw_probs, dtype=float)
        y = np.asarray(true_binary_labels, dtype=float)
        if raw.shape != y.shape:
            raise ValueError(f"raw_probs and true_binary_labels must be the same length (got {raw.shape} vs {y.shape})")
        if raw.size == 0:
            raise ValueError("cannot fit an isotonic calibrator on zero rows")
        self._model.fit(raw, y)
        self._fitted = True
        return self

    def predict(self, raw_probs: Sequence[float]) -> np.ndarray:
        if not self._fitted:
            raise RuntimeError("IsotonicCalibrator.predict called before fit()/load()")
        return self._model.predict(np.asarray(raw_probs, dtype=float))

    def save(self, path: str | Path) -> None:
        if not self._fitted:
            raise RuntimeError("refusing to save an unfitted IsotonicCalibrator")
        joblib.dump(self._model, path)

    @classmethod
    def load(cls, path: str | Path) -> "IsotonicCalibrator":
        instance = cls()
        instance._model = joblib.load(path)
        instance._fitted = True
        return instance
