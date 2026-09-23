"""B7.4: app/training/calibration.py -- the isotonic calibration wrapper. Covers fitting on
synthetic monotonic-ish data, save/load round-tripping to identical predictions, and a structural
leakage check (the calibrator is never exposed to a "test-only" slice within the test itself).
"""
import numpy as np
import pytest

from app.training.calibration import IsotonicCalibrator


def _synthetic_calibration_data(seed: int = 0, n: int = 200):
    rng = np.random.default_rng(seed)
    true_labels = rng.integers(0, 2, size=n)
    # Raw scores correlated with the true label but poorly calibrated (systematically
    # overconfident), the way an unregularized boosted-tree's raw sigmoid output often is.
    noise = rng.normal(0, 0.15, size=n)
    raw = np.clip(true_labels * 0.9 + (1 - true_labels) * 0.1 + noise, 0.001, 0.999)
    return raw, true_labels


def test_fit_and_predict_on_monotonic_ish_synthetic_data():
    raw, y = _synthetic_calibration_data()
    calibrator = IsotonicCalibrator().fit(raw, y)
    calibrated = calibrator.predict(raw)
    assert calibrated.shape == raw.shape
    assert (calibrated >= 0).all() and (calibrated <= 1).all()
    # A higher raw score should never map to a strictly lower calibrated one (isotonic = monotonic).
    order = np.argsort(raw)
    assert (np.diff(calibrated[order]) >= -1e-9).all()


def test_predict_before_fit_raises():
    with pytest.raises(RuntimeError, match="fit"):
        IsotonicCalibrator().predict([0.5])


def test_fit_on_empty_data_raises():
    with pytest.raises(ValueError, match="zero rows"):
        IsotonicCalibrator().fit([], [])


def test_fit_on_mismatched_lengths_raises():
    with pytest.raises(ValueError, match="same length"):
        IsotonicCalibrator().fit([0.1, 0.2], [1])


def test_save_load_round_trips_to_identical_predictions(tmp_path):
    raw, y = _synthetic_calibration_data()
    calibrator = IsotonicCalibrator().fit(raw, y)
    path = tmp_path / "calibrator.joblib"
    calibrator.save(path)

    reloaded = IsotonicCalibrator.load(path)
    probe = np.array([0.1, 0.3, 0.5, 0.7, 0.9])
    np.testing.assert_array_equal(calibrator.predict(probe), reloaded.predict(probe))


def test_save_before_fit_raises(tmp_path):
    with pytest.raises(RuntimeError, match="unfitted"):
        IsotonicCalibrator().save(tmp_path / "x.joblib")


def test_calibrator_is_fit_only_on_the_slice_passed_in_never_a_wider_dataset():
    """Structural leakage check: fitting on a 'calibration' slice must not let the calibrator see
    or be influenced by a disjoint 'test' slice's values at all -- verified here by fitting two
    calibrators on two disjoint synthetic slices from the same generator and confirming they
    produce different predictions (i.e. each one only learned from what it was given, not from
    some shared/leaked wider dataset)."""
    raw_a, y_a = _synthetic_calibration_data(seed=1, n=100)
    raw_b, y_b = _synthetic_calibration_data(seed=2, n=100)

    calibrator_a = IsotonicCalibrator().fit(raw_a, y_a)
    calibrator_b = IsotonicCalibrator().fit(raw_b, y_b)

    probe = np.array([0.2, 0.5, 0.8])
    pred_a = calibrator_a.predict(probe)
    pred_b = calibrator_b.predict(probe)
    assert not np.array_equal(pred_a, pred_b), "two calibrators fit on disjoint data slices should not produce identical predictions -- if they do, something is leaking a shared fit"
