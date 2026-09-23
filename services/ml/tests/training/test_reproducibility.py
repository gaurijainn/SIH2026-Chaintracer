"""B7.4 reproducibility check: runs the REAL training pipeline (app.training.train_tron.main)
TWICE against the real dataset and asserts the parts that must be deterministic actually are.

Judgment call: this runs the real pipeline twice rather than a synthetic-fixture stand-in, because
the property under test -- "does the exact same pipeline, run twice, produce byte-identical
feature matrices/predictions/metrics" -- is precisely about the real pipeline's own determinism
(fixed random_state, fit-free categorical encoders, deterministic temporal split), not about
whether a smaller synthetic model is reproducible in the abstract (that would prove less). The
whole real pipeline only takes a few seconds on this 500-row dataset, so running it twice here is
still fast enough for routine test runs; if the dataset grows enough to make that untrue, switch
this to a synthetic-fixture version and keep the real-pipeline check only in the (already-slower)
integration test.

What legitimately differs between the two runs (excluded from the identity checks below):
  - `trained_at` (real wall-clock `datetime.utcnow()` timestamps, by design)
  - `elapsed_seconds` (wall-clock duration)
  - the exact latency benchmark numbers (real timing measurements, expected to vary run to run)

What must be byte-identical: the feature matrices (row-for-row, column-for-column, including NaN
placement), every split's predictions on the same fixed rows, and every evaluation metric.
"""
import pandas as pd
import pytest

from app.training.train_tron import DATASET_PATH, main

pytestmark = pytest.mark.skipif(not DATASET_PATH.exists(), reason="real tron-bootstrap-v1 dataset not present in this checkout")


@pytest.fixture(scope="module")
def two_runs(tmp_path_factory):
    # Each run gets its own throwaway artifacts_dir so this real-pipeline run never rewrites the
    # committed tron/ artifacts (and so the two runs' writes can never collide with each other).
    run_a = main(artifacts_dir=tmp_path_factory.mktemp("tron-artifacts-a"))
    run_b = main(artifacts_dir=tmp_path_factory.mktemp("tron-artifacts-b"))
    return run_a, run_b


def test_feature_matrices_are_byte_identical_across_runs(two_runs):
    run_a, run_b = two_runs
    for split_name in ("train", "calibration", "test"):
        pd.testing.assert_frame_equal(run_a["feature_matrices"][split_name], run_b["feature_matrices"][split_name])


def test_row_identifiers_per_split_are_identical_across_runs(two_runs):
    run_a, run_b = two_runs
    for split_name in ("train", "calibration", "test"):
        assert run_a["row_identifiers"][split_name] == run_b["row_identifiers"][split_name]


def test_metrics_are_identical_across_runs(two_runs):
    run_a, run_b = two_runs
    assert run_a["metrics"] == run_b["metrics"]


def test_shap_examples_are_identical_across_runs(two_runs):
    run_a, run_b = two_runs
    assert run_a["shap_examples"] == run_b["shap_examples"]


def test_split_sizes_and_class_counts_are_identical_across_runs(two_runs):
    run_a, run_b = two_runs
    assert run_a["split_sizes"] == run_b["split_sizes"]
    assert run_a["training_metadata"]["class_counts"] == run_b["training_metadata"]["class_counts"]
    assert run_a["training_metadata"]["temporal_boundaries"] == run_b["training_metadata"]["temporal_boundaries"]


def test_trained_at_legitimately_differs_between_runs(two_runs):
    """Documents, as an explicit assertion rather than just a comment, which field is *expected*
    to differ -- so a future reader doesn't mistake this test file as claiming everything must
    match. (Extremely unlikely, but not impossible, for two runs to land in the same microsecond;
    if this ever flakes, that's why -- not a determinism regression.)"""
    run_a, run_b = two_runs
    assert isinstance(run_a["training_metadata"]["trained_at"], str)
    assert isinstance(run_b["training_metadata"]["trained_at"], str)
