"""B7.1/B7.4 Task 7: model-artifact structure, and (B7.4) the real trained TRON artifacts.

Split into two parts, deliberately:
  1. Path-helper tests: pure `paths.py` behavior, no filesystem dependency beyond the artifact
     directories themselves existing -- these always run and never depend on training having run.
  2. Real-artifact-shape tests: assert the actual trained files (written by
     `app/training/train_tron.main()`, exercised for real in
     `tests/training/test_train_tron_integration.py`) have sane structure -- skipped, not failed,
     if that hasn't run yet in this test session (pytest collection order runs this file before
     `tests/training/`, so these files may not exist purely because nothing has written them yet
     in this process; the integration test is the one place that actually trains and asserts they
     get created. This file only checks *shape*, once they exist, never re-runs training itself).

Note: `test_no_real_artifact_files_exist_yet` (B7.1-era) has been deliberately removed. Its premise
-- that TRON_ARTIFACTS_DIR must stay empty -- is now obsolete: B7.4 trains a real model and writes
real artifacts there on purpose. Removing/replacing it here, rather than leaving it to fail, is an
intentional, understood change (see the B7.4 handoff report), not accidental test breakage.
"""
import json

import pytest

from app.models import (
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
    untrained_metadata,
)


def test_tron_and_ethereum_artifact_directories_exist_and_are_separate():
    assert TRON_ARTIFACTS_DIR.is_dir()
    assert ETHEREUM_ARTIFACTS_DIR.is_dir()
    assert TRON_ARTIFACTS_DIR != ETHEREUM_ARTIFACTS_DIR


def test_tron_artifact_paths_are_versioned_and_under_the_tron_directory():
    v = "v1"
    for p in [
        tron_model_path(v),
        tron_calibrator_path(v),
        tron_feature_metadata_path(v),
        tron_metrics_path(v),
        tron_model_card_path(v),
        tron_model_card_md_path(v),
        tron_training_metadata_path(v),
    ]:
        assert p.parent == TRON_ARTIFACTS_DIR
        assert v in p.name


def test_tron_calibrator_path_uses_joblib_extension():
    # B7.4: renamed from -calibrator.pkl to -calibrator.joblib to match the joblib.dump/load
    # serialization actually used (app/training/calibration.py).
    assert tron_calibrator_path("v1").suffix == ".joblib"


def test_ethereum_artifact_paths_are_versioned_and_under_the_ethereum_directory():
    v = "v1"
    for p in [ethereum_model_path(v), ethereum_metrics_path(v), ethereum_model_card_path(v)]:
        assert p.parent == ETHEREUM_ARTIFACTS_DIR
        assert v in p.name


def test_untrained_metadata_requires_a_model_family():
    tron_card = untrained_metadata("tron", feature_names=("dwell_median_min",))
    eth_card = untrained_metadata("ethereum")
    assert tron_card.model_family == "tron"
    assert eth_card.model_family == "ethereum"
    assert tron_card.status == "untrained"


# --- Real trained TRON artifact shape (only checked once they exist; see module docstring) -----

_ARTIFACTS_TRAINED = tron_model_path("v1").exists() and tron_metrics_path("v1").exists()
_SKIP_REASON = "real v1 TRON artifacts not written yet in this test session (see tests/training/test_train_tron_integration.py, which trains and writes them)"


@pytest.mark.skipif(not _ARTIFACTS_TRAINED, reason=_SKIP_REASON)
def test_real_model_json_is_a_valid_xgboost_model_file():
    content = json.loads(tron_model_path("v1").read_text(encoding="utf-8"))
    assert "learner" in content  # XGBoost's native JSON model format


@pytest.mark.skipif(not _ARTIFACTS_TRAINED, reason=_SKIP_REASON)
def test_real_calibrator_file_is_nonempty():
    assert tron_calibrator_path("v1").stat().st_size > 0


@pytest.mark.skipif(not _ARTIFACTS_TRAINED, reason=_SKIP_REASON)
def test_real_feature_metadata_covers_all_15_canonical_features():
    from app.features import FEATURE_NAMES

    content = json.loads(tron_feature_metadata_path("v1").read_text(encoding="utf-8"))
    assert content["feature_order"] == list(FEATURE_NAMES)
    assert set(content["features"].keys()) == set(FEATURE_NAMES)


@pytest.mark.skipif(not _ARTIFACTS_TRAINED, reason=_SKIP_REASON)
def test_real_metrics_json_has_all_three_splits():
    content = json.loads(tron_metrics_path("v1").read_text(encoding="utf-8"))
    assert set(content["splits"].keys()) == {"train", "calibration", "test"}
    for split_metrics in content["splits"].values():
        assert 0.0 <= split_metrics["accuracy"] <= 1.0


@pytest.mark.skipif(not _ARTIFACTS_TRAINED, reason=_SKIP_REASON)
def test_real_compact_model_card_reports_status_trained():
    content = json.loads(tron_model_card_path("v1").read_text(encoding="utf-8"))
    assert content["status"] == "trained"
    assert content["model_family"] == "tron"
    assert len(content["feature_names"]) == 15


@pytest.mark.skipif(not _ARTIFACTS_TRAINED, reason=_SKIP_REASON)
def test_real_narrative_model_card_states_the_prototype_framing_and_label_caveat():
    text = tron_model_card_md_path("v1").read_text(encoding="utf-8")
    assert "not a validated production fraud detector" in text
    assert "does NOT mean criminal" in text
