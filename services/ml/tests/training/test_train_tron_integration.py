"""B7.4 integration test: runs the REAL end-to-end training pipeline (app.training.train_tron.main)
against the real, live-collected 500-row tron_bootstrap_dataset.csv and checks the results are
structurally sane. This is the one deliberately slower test in the B7.4 suite (a few seconds, not
milliseconds, because it actually loads the real CSV, derives real timestamps, trains a real
XGBoost model, fits a real isotonic calibrator, computes real SHAP values, and writes real
artifacts to disk) -- every other B7.4 test uses small synthetic fixtures instead. Do not add a
second test like this; extend this one if more end-to-end assertions are needed.
"""
import math

import pytest

from app.features import FEATURE_NAMES
from app.models import (
    tron_calibrator_path,
    tron_feature_metadata_path,
    tron_metrics_path,
    tron_model_card_md_path,
    tron_model_card_path,
    tron_model_path,
    tron_training_metadata_path,
)
from app.training.train_tron import DATASET_PATH, main

pytestmark = pytest.mark.skipif(not DATASET_PATH.exists(), reason="real tron-bootstrap-v1 dataset not present in this checkout")


@pytest.fixture(scope="module")
def result():
    return main()


def test_dataset_row_counts_match_the_real_live_collection(result):
    sizes = result["split_sizes"]
    assert sizes["train"] + sizes["calibration"] + sizes["test"] == 500


def test_temporal_split_has_no_leakage_across_boundaries(result):
    boundaries = result["training_metadata"]["temporal_boundaries"]
    assert boundaries["train"]["latest"] < boundaries["calibration"]["earliest"]
    assert boundaries["calibration"]["latest"] < boundaries["test"]["earliest"]


def test_both_classes_present_in_every_split(result):
    class_counts = result["training_metadata"]["class_counts"]
    for split_name in ("train", "calibration", "test"):
        assert class_counts[split_name]["high_risk"] > 0
        assert class_counts[split_name]["licit"] > 0


def test_feature_matrices_have_the_canonical_15_column_order(result):
    for split_name in ("train", "calibration", "test"):
        df = result["feature_matrices"][split_name]
        assert list(df.columns) == list(FEATURE_NAMES)


def test_metrics_are_present_and_in_valid_ranges_for_all_three_splits(result):
    for split_name in ("train", "calibration", "test"):
        m = result["metrics"][split_name]
        assert 0.0 <= m["accuracy"] <= 1.0
        assert 0.0 <= m["precision"] <= 1.0
        assert 0.0 <= m["recall"] <= 1.0
        assert 0.0 <= m["f1"] <= 1.0
        assert 0.0 <= m["brier_score"] <= 1.0
        if m["roc_auc"] is not None:
            assert 0.0 <= m["roc_auc"] <= 1.0


def test_shap_examples_were_generated_and_pass_the_reconstruction_sanity_check(result):
    examples = result["shap_examples"]
    assert len(examples) >= 3
    for ex in examples:
        assert ex["reconstruction_error"] < 1e-3
        assert len(ex["top_contributions"]) > 0
        # sorted by |contribution| descending
        contribs = [abs(c["shap_contribution"]) for c in ex["top_contributions"]]
        assert contribs == sorted(contribs, reverse=True)


def test_core_scoring_latency_p95_is_reported_and_excludes_shap(result):
    latency = result["latency"]
    assert "core_scoring_ms" in latency
    assert "shap_ms" in latency
    assert latency["core_scoring_ms"]["p95"] > 0
    # core scoring = preprocessing + xgboost + calibration only, never includes SHAP time
    approx_core = latency["preprocessing_ms"]["p50"] + latency["xgboost_ms"]["p50"] + latency["calibration_ms"]["p50"]
    assert math.isclose(approx_core, latency["core_scoring_ms"]["p50"], rel_tol=0.5, abs_tol=5.0)


def test_all_named_artifact_files_are_written_to_disk(result):
    for path in [
        tron_model_path("v1"),
        tron_calibrator_path("v1"),
        tron_feature_metadata_path("v1"),
        tron_metrics_path("v1"),
        tron_model_card_path("v1"),
        tron_model_card_md_path("v1"),
        tron_training_metadata_path("v1"),
    ]:
        assert path.exists(), f"expected artifact missing: {path}"
        assert path.stat().st_size > 0


def test_no_leakage_columns_reached_the_feature_matrix(result):
    forbidden = {"label", "source", "evidence", "confidence", "fetched_at", "address", "identifier", "chain"}
    for split_name in ("train", "calibration", "test"):
        cols = set(result["feature_matrices"][split_name].columns)
        assert forbidden.isdisjoint(cols)
