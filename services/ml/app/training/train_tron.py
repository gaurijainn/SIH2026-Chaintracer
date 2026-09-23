"""B7.4: the TRON XGBoost model training entrypoint. Run from services/ml with:

    python -m app.training.train_tron

Trains a single binary risk model (POSITIVE == "high_risk", NEGATIVE == "licit") on the real,
live-collected `data/labels/tron-bootstrap/v1/tron_bootstrap_dataset.csv` (500 rows: 250
high_risk, 250 licit, already validated -- see that directory's `validation_report.json`),
calibrates it with isotonic regression, verifies SHAP explainability, benchmarks scoring latency,
and writes every artifact `app/models/paths.py` names under `TRON_ARTIFACTS_DIR`.

This is explicitly a 500-row *bootstrap* model -- a prototype proving the pipeline works
end-to-end, not a validated production fraud detector. Every log line and every artifact says so;
do not let a promising-looking metric here read as more than it is.
"""
from __future__ import annotations

import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import shap
import xgboost as xgb
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    brier_score_loss,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)

from ..datasets import Chain, require_chain, require_training
from ..datasets.loaders.tron_bootstrap import TronBootstrapLoader
from ..features import FEATURE_NAMES
from ..models import (
    tron_calibrator_path,
    tron_feature_metadata_path,
    tron_metrics_path,
    tron_model_card_md_path,
    tron_model_card_path,
    tron_model_path,
    tron_training_metadata_path,
)
from ..models.paths import TRON_ARTIFACTS_DIR
from ..models.metadata import trained_metadata
from .calibration import IsotonicCalibrator
from .feature_matrix import (
    ACTIVATOR_LABEL_BUCKETS,
    ACTIVATOR_LABEL_ENCODER_NAME,
    FeatureMatrixResult,
    _STRUCTURALLY_UNAVAILABLE_FEATURES,
    build_feature_matrix,
)
from .labels import BinaryLabel, collapse_label
from .split import build_temporal_split
from .timestamps import correct_row_timestamps
from .weights import compute_scale_pos_weight

REPO_ROOT = Path(__file__).resolve().parents[4]
DATASET_PATH = REPO_ROOT / "data" / "labels" / "tron-bootstrap" / "v1" / "tron_bootstrap_dataset.csv"

MODEL_VERSION = "v1"
RANDOM_SEED = 42
PREPROCESSING_VERSION = "tron-feature-matrix-v1"

#: Columns that must never reach the feature matrix -- an explicit, code-level leakage guard, not
#: just a convention. Checked directly against the built DataFrame's columns in _check_no_leakage.
_FORBIDDEN_LEAKAGE_COLUMNS = {"label", "source", "evidence", "confidence", "fetched_at", "address", "identifier", "chain"}

#: Fixed, literature-standard hyperparameters -- deliberately NOT hyperparameter-searched (explicit
#: instruction: no huge hyperparameter search over a 500-row dataset, which would just overfit the
#: search itself). Shallow trees + a modest number of rounds is the standard prescription for a
#: dataset this small; a deep/large model would almost certainly memorize the ~300 training rows.
XGB_PARAMS: dict[str, Any] = {
    "max_depth": 3,
    "n_estimators": 150,
    "learning_rate": 0.1,
    "eval_metric": "aucpr",  # imbalance-robust (this is a balanced 250/250 dataset, but splits aren't perfectly balanced); PR-AUC is the more honest metric for a fraud/risk task regardless
    "missing": np.nan,  # native XGBoost missing-value handling -- no imputation
    "random_state": RANDOM_SEED,
    "n_jobs": 1,
}

CLASSIFICATION_THRESHOLD = 0.5  # applied to the calibrated probability; see model card for rationale


def _log(msg: str) -> None:
    print(f"[train] {msg}")


def _check_no_leakage(df: pd.DataFrame) -> None:
    present = _FORBIDDEN_LEAKAGE_COLUMNS & set(df.columns)
    assert not present, f"label-leakage guard failed: forbidden column(s) present in feature matrix: {sorted(present)}"
    _log(f"leakage guard: none of {sorted(_FORBIDDEN_LEAKAGE_COLUMNS)} present in the {len(df.columns)}-column feature matrix -- OK")


def _git_commit_hash() -> str | None:
    """Local git metadata read only (git rev-parse HEAD against the local repo) -- not a network
    call. Returns None (never raises) if git isn't available, so a training run never fails over
    provenance metadata it can't get."""
    try:
        result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True, timeout=10, check=True)
        return result.stdout.strip()
    except Exception:  # noqa: BLE001 - genuinely best-effort
        return None


def _binary_labels_as_int(labels: list[BinaryLabel]) -> np.ndarray:
    return np.array([1 if l == BinaryLabel.POSITIVE else 0 for l in labels], dtype=int)


def _evaluate(
    name: str,
    raw_probs: np.ndarray,
    calibrated_probs: np.ndarray,
    y_true: np.ndarray,
    *,
    threshold: float = CLASSIFICATION_THRESHOLD,
) -> dict[str, Any]:
    y_pred = (calibrated_probs >= threshold).astype(int)
    cm = confusion_matrix(y_true, y_pred, labels=[0, 1])
    metrics: dict[str, Any] = {
        "n": int(len(y_true)),
        "n_positive": int(y_true.sum()),
        "n_negative": int(len(y_true) - y_true.sum()),
        "roc_auc": float(roc_auc_score(y_true, calibrated_probs)) if len(set(y_true.tolist())) > 1 else None,
        "pr_auc": float(average_precision_score(y_true, calibrated_probs)) if len(set(y_true.tolist())) > 1 else None,
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "precision": float(precision_score(y_true, y_pred, zero_division=0)),
        "recall": float(recall_score(y_true, y_pred, zero_division=0)),
        "f1": float(f1_score(y_true, y_pred, zero_division=0)),
        "brier_score": float(brier_score_loss(y_true, calibrated_probs)),
        "confusion_matrix": {"tn": int(cm[0, 0]), "fp": int(cm[0, 1]), "fn": int(cm[1, 0]), "tp": int(cm[1, 1])},
        "threshold": threshold,
    }

    # recall at ~90% precision: only remotely stable with a decent-sized positive class in this
    # split. State the judgment call plainly rather than silently computing a noisy number.
    if len(y_true) >= 50 and y_true.sum() >= 10:
        order = np.argsort(-calibrated_probs)
        sorted_probs = calibrated_probs[order]
        sorted_true = y_true[order]
        best_recall_at_90p = None
        for k in range(1, len(sorted_true) + 1):
            preds_at_k = sorted_true[:k]
            precision_at_k = preds_at_k.sum() / k
            if precision_at_k >= 0.9:
                best_recall_at_90p = preds_at_k.sum() / y_true.sum()
        metrics["recall_at_90pct_precision"] = float(best_recall_at_90p) if best_recall_at_90p is not None else None
        metrics["recall_at_90pct_precision_note"] = f"computed over n={len(y_true)} rows ({int(y_true.sum())} positive) -- noisy at this size, directional only"
    else:
        metrics["recall_at_90pct_precision"] = None
        metrics["recall_at_90pct_precision_note"] = f"skipped: split too small (n={len(y_true)}, positives={int(y_true.sum())}) for this metric to be remotely stable"

    _log(f"{name} metrics: n={metrics['n']} roc_auc={metrics['roc_auc']} pr_auc={metrics['pr_auc']} acc={metrics['accuracy']:.3f} prec={metrics['precision']:.3f} recall={metrics['recall']:.3f} f1={metrics['f1']:.3f} brier={metrics['brier_score']:.4f}")
    return metrics


def _feature_metadata() -> dict[str, Any]:
    per_feature: dict[str, Any] = {}
    for name in FEATURE_NAMES:
        if name in _STRUCTURALLY_UNAVAILABLE_FEATURES:
            per_feature[name] = {
                "type": "float (native NaN for missing)",
                "status": "present in schema, unavailable in this bootstrap training run (100% missing -- no case-graph context)",
                "missing_value_policy": "native XGBoost NaN handling; never fabricated as 0",
            }
        elif name == "activator_label":
            per_feature[name] = {
                "type": "categorical (free-text TRON address), hash-bucket encoded to float",
                "status": "used",
                "encoding": {"name": ACTIVATOR_LABEL_ENCODER_NAME, "buckets": ACTIVATOR_LABEL_BUCKETS, "description": "32-bit FNV-1a over the raw label string, mod bucket count; fit-free/stateless, no train/inference skew"},
                "missing_value_policy": "np.nan when activator_label is absent from the row (never bucket 0 -- missing is never confused with 'hashed to bucket 0')",
            }
        elif name == "external_flags":
            per_feature[name] = {
                "type": "list[str] in schema; encoded as float count of flags for the model matrix",
                "status": "used (as count)",
                "encoding": {"description": "len(json.loads(external_flags)); the raw list/hash is audit metadata only, never a model input on its own"},
                "missing_value_policy": "defaults to 0 (empty list) when the column is entirely absent; every real row in tron-bootstrap-v1 has at least '[]'",
            }
        elif name == "trx_dust_usdt":
            per_feature[name] = {
                "type": "bool in schema; encoded as float 1.0/0.0 for the model matrix",
                "status": "used, but zero-variance in this bootstrap dataset (every one of the 500 rows is false)",
                "source_note": "pandas infers this all-lowercase true/false CSV column as boolean dtype, so it is already a 0.0/1.0 float in DatasetRow.features (not a string in extra, as an all-string-dtype read would produce)",
                "missing_value_policy": "np.nan if genuinely absent",
            }
        else:
            per_feature[name] = {
                "type": "float",
                "status": "used",
                "missing_value_policy": "native XGBoost NaN handling (np.nan when absent from the source row); never imputed",
            }
    return {
        "model_version": MODEL_VERSION,
        "feature_order": list(FEATURE_NAMES),
        "features": per_feature,
        "preprocessing_version": PREPROCESSING_VERSION,
    }


def main(*, artifacts_dir: Path = TRON_ARTIFACTS_DIR) -> dict[str, Any]:
    """Runs the full B7.4 training pipeline once and returns a dict of everything worth reporting
    (metrics, split boundaries, latency, artifact paths) -- used both for the real training run and
    by the reproducibility test, which calls this twice and diffs the results.

    `artifacts_dir` defaults to the real committed `TRON_ARTIFACTS_DIR` for a real/manual training
    run (`python -m app.training.train_tron`). Tests that exercise this real pipeline end-to-end
    (test_train_tron_integration.py, test_reproducibility.py) pass a pytest `tmp_path` instead, so
    running the full test suite never rewrites the committed artifact files' timestamps/git_commit
    metadata and never dirties the working tree."""
    t_start = time.time()
    _log(f"loading dataset from {DATASET_PATH}")
    dataset = TronBootstrapLoader().load(DATASET_PATH)

    # Step 2: fail loudly, don't catch-and-continue.
    if not dataset.validation.is_valid:
        raise ValueError(f"tron-bootstrap dataset failed validation: {dataset.validation.errors}")
    report = dataset.validation
    _log(f"dataset valid: {report.row_count} rows, {report.duplicate_count} duplicate identifier(s), label_counts={report.label_counts}")
    assert report.duplicate_count == 0, f"expected 0 duplicate rows in tron-bootstrap-v1, found {report.duplicate_count}"
    observed_labels = set(report.label_counts.keys())
    assert observed_labels <= {"high_risk", "licit"}, f"unexpected label values: {observed_labels}"

    missing_by_column = {c: int(sum(1 for r in dataset.rows if c not in r.features and c not in r.extra)) for c in FEATURE_NAMES}
    _log(f"per-feature missingness (raw rows, pre-matrix): {missing_by_column}")
    _log(f"dataset manifest: name={dataset.manifest.name} version={dataset.manifest.version} local_path={dataset.manifest.local_path}")

    # Step 3: derive real per-row event timestamps (see timestamps.py's rationale).
    _log("deriving real per-row event timestamps from embedded evidence (replacing the degenerate shared fetched_at)")
    corrected_rows = correct_row_timestamps(dataset.rows)
    ts_values = sorted(r.timestamp for r in corrected_rows)
    _log(f"derived timestamp range: earliest={ts_values[0].isoformat()} latest={ts_values[-1].isoformat()} distinct_values={len(set(ts_values))}")

    # Step 4: defense-in-depth dataset-purpose/chain guards.
    dataset_corrected = dataset.__class__(manifest=dataset.manifest, rows=corrected_rows, validation=dataset.validation)
    require_training([dataset_corrected])
    require_chain([dataset_corrected], Chain.TRON)
    _log("require_training/require_chain(TRON) passed")

    # Step 5: exclude any row whose label can't be collapsed to POSITIVE/NEGATIVE.
    excluded = [r.identifier for r in corrected_rows if collapse_label(r.label) is None]
    if excluded:
        _log(f"excluding {len(excluded)} row(s) with an unresolvable label: {excluded}")
    usable_rows = [r for r in corrected_rows if collapse_label(r.label) is not None]
    _log(f"{len(usable_rows)} usable rows after label collapsing ({len(excluded)} excluded)")

    # Step 7: temporal split. 60/20/20 checked against the real derived timestamps below; only
    # adjusted if it produces a degenerate partition (it does not, for this dataset -- see log).
    train_frac, calibration_frac = 0.6, 0.2
    split = build_temporal_split(usable_rows, train_frac=train_frac, calibration_frac=calibration_frac)
    _log(
        f"temporal split (train_frac={train_frac}, calibration_frac={calibration_frac}): "
        f"train={len(split.train)} [{min(r.timestamp for r in split.train).isoformat()} .. {max(r.timestamp for r in split.train).isoformat()}], "
        f"calibration={len(split.calibration)} [{min(r.timestamp for r in split.calibration).isoformat()} .. {max(r.timestamp for r in split.calibration).isoformat()}], "
        f"test={len(split.test)} [{min(r.timestamp for r in split.test).isoformat()} .. {max(r.timestamp for r in split.test).isoformat()}]"
    )
    for part_name, part_rows in (("train", split.train), ("calibration", split.calibration), ("test", split.test)):
        counts: dict[str, int] = {}
        for r in part_rows:
            counts[r.label.value] = counts.get(r.label.value, 0) + 1
        _log(f"{part_name} class counts: {counts}")
        if not counts.get("high_risk") or not counts.get("licit"):
            raise ValueError(f"{part_name} split has only one class present ({counts}) -- 60/20/20 is not viable for this dataset, would need adjustment (not observed in the real run)")

    # Step 8: build feature matrices per split. The activator_label hash-bucket encoder and the
    # external_flags count are both fit-free/stateless (pure functions of the row), so there is no
    # "fit on train, transform on calibration/test" step needed here -- confirmed by construction.
    train_fm = build_feature_matrix(split.train)
    cal_fm = build_feature_matrix(split.calibration)
    test_fm = build_feature_matrix(split.test)
    _check_no_leakage(train_fm.dataframe)
    _log(f"train feature matrix: {train_fm.dataframe.shape}, missingness={train_fm.missingness}")

    # Step 9: class weight from the train split only.
    scale_pos_weight = compute_scale_pos_weight(train_fm.labels)
    _log(f"scale_pos_weight (train split, negatives/positives) = {scale_pos_weight}")

    # Step 10: train.
    y_train = _binary_labels_as_int(train_fm.labels)
    model = xgb.XGBClassifier(**XGB_PARAMS, scale_pos_weight=scale_pos_weight)
    _log(f"training XGBClassifier with params={ {**XGB_PARAMS, 'scale_pos_weight': scale_pos_weight} }")
    model.fit(train_fm.dataframe[list(FEATURE_NAMES)], y_train)
    _log("training complete")

    # Step 11: fit the isotonic calibrator on the CALIBRATION split's raw predicted probabilities.
    y_cal = _binary_labels_as_int(cal_fm.labels)
    raw_cal_probs = model.predict_proba(cal_fm.dataframe[list(FEATURE_NAMES)])[:, 1]
    calibrator = IsotonicCalibrator().fit(raw_cal_probs, y_cal)
    _log(f"isotonic calibrator fit on calibration split only (n={len(y_cal)})")

    # Step 12: evaluate on all three splits.
    def raw_and_calibrated(fm: FeatureMatrixResult) -> tuple[np.ndarray, np.ndarray]:
        raw = model.predict_proba(fm.dataframe[list(FEATURE_NAMES)])[:, 1]
        return raw, calibrator.predict(raw)

    raw_train, cal_train = raw_and_calibrated(train_fm)
    raw_cal, cal_cal = raw_and_calibrated(cal_fm)
    raw_test, cal_test = raw_and_calibrated(test_fm)

    metrics = {
        "train": _evaluate("train", raw_train, cal_train, y_train),
        "calibration": _evaluate("calibration", raw_cal, cal_cal, y_cal),
        "test": _evaluate("test", raw_test, cal_test, _binary_labels_as_int(test_fm.labels)),
    }

    # Step 13: SHAP verification on the (uncalibrated) trained booster.
    _log("computing SHAP values for the test split")
    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(test_fm.dataframe[list(FEATURE_NAMES)])
    base_value = explainer.expected_value
    raw_model_output = model.predict(test_fm.dataframe[list(FEATURE_NAMES)], output_margin=True)

    shap_examples: list[dict[str, Any]] = []
    n_shap_examples = min(3, len(test_fm.identifiers))
    for i in range(n_shap_examples):
        row_shap = shap_values[i]
        reconstructed = base_value + row_shap.sum()
        tolerance = 1e-4
        assert abs(reconstructed - raw_model_output[i]) < tolerance, f"SHAP sanity check failed for row {i}: base+sum(shap)={reconstructed} vs raw_model_output={raw_model_output[i]}"
        contributions = sorted(
            [
                {"feature": name, "feature_value": (None if pd.isna(test_fm.dataframe.iloc[i][name]) else float(test_fm.dataframe.iloc[i][name])), "shap_contribution": float(row_shap[j])}
                for j, name in enumerate(FEATURE_NAMES)
            ],
            key=lambda d: abs(d["shap_contribution"]),
            reverse=True,
        )
        example = {"identifier": test_fm.identifiers[i], "base_value": float(base_value), "raw_model_output": float(raw_model_output[i]), "reconstruction_error": float(abs(reconstructed - raw_model_output[i])), "top_contributions": contributions[:5]}
        shap_examples.append(example)
        _log(f"SHAP example {i} ({test_fm.identifiers[i]}): base={base_value:.4f} raw_output={raw_model_output[i]:.4f} reconstruction_error={example['reconstruction_error']:.2e} top_feature={contributions[0]['feature']}({contributions[0]['shap_contribution']:.4f})")

    # Step 14: save artifacts.
    tron_model_path(MODEL_VERSION, artifacts_dir).parent.mkdir(parents=True, exist_ok=True)
    model.save_model(str(tron_model_path(MODEL_VERSION, artifacts_dir)))
    calibrator.save(tron_calibrator_path(MODEL_VERSION, artifacts_dir))
    _log(f"saved model to {tron_model_path(MODEL_VERSION, artifacts_dir)}")
    _log(f"saved calibrator to {tron_calibrator_path(MODEL_VERSION, artifacts_dir)}")

    feature_metadata = _feature_metadata()
    feature_metadata["dataset_version"] = dataset.manifest.version
    feature_metadata["dataset_local_path"] = dataset.manifest.local_path
    tron_feature_metadata_path(MODEL_VERSION, artifacts_dir).write_text(json.dumps(feature_metadata, indent=2), encoding="utf-8")
    _log(f"saved feature metadata to {tron_feature_metadata_path(MODEL_VERSION, artifacts_dir)}")

    trained_at = datetime.now(timezone.utc)
    git_commit = _git_commit_hash()

    training_metadata = {
        "model_version": MODEL_VERSION,
        "trained_at": trained_at.isoformat(),
        "dataset_version": dataset.manifest.version,
        "dataset_local_path": dataset.manifest.local_path,
        "row_counts": {"total": len(usable_rows), "excluded_unresolvable_label": len(excluded), "train": len(split.train), "calibration": len(split.calibration), "test": len(split.test)},
        "class_counts": {
            "train": {"high_risk": int(y_train.sum()), "licit": int(len(y_train) - y_train.sum())},
            "calibration": {"high_risk": int(y_cal.sum()), "licit": int(len(y_cal) - y_cal.sum())},
            "test": {"high_risk": int(_binary_labels_as_int(test_fm.labels).sum()), "licit": int(len(test_fm.labels) - _binary_labels_as_int(test_fm.labels).sum())},
        },
        "temporal_boundaries": {
            "train": {"earliest": min(r.timestamp for r in split.train).isoformat(), "latest": max(r.timestamp for r in split.train).isoformat()},
            "calibration": {"earliest": min(r.timestamp for r in split.calibration).isoformat(), "latest": max(r.timestamp for r in split.calibration).isoformat()},
            "test": {"earliest": min(r.timestamp for r in split.test).isoformat(), "latest": max(r.timestamp for r in split.test).isoformat()},
        },
        "temporal_split_fractions": {"train_frac": train_frac, "calibration_frac": calibration_frac, "adjusted_from_default": False, "note": "60/20/20 produced non-degenerate, both-class-present partitions on the real derived timestamps -- no adjustment needed"},
        "random_seed": RANDOM_SEED,
        "xgboost_params": {**XGB_PARAMS, "missing": "np.nan", "scale_pos_weight": scale_pos_weight},
        "scale_pos_weight": scale_pos_weight,
        "preprocessing_version": PREPROCESSING_VERSION,
        "calibration_method": "isotonic",
        "calibration_fit_split": "calibration",
        "activator_label_encoder": {"name": ACTIVATOR_LABEL_ENCODER_NAME, "buckets": ACTIVATOR_LABEL_BUCKETS},
        "git_commit": git_commit,
        "classification_threshold": CLASSIFICATION_THRESHOLD,
    }
    tron_training_metadata_path(MODEL_VERSION, artifacts_dir).write_text(json.dumps(training_metadata, indent=2), encoding="utf-8")
    _log(f"saved training metadata to {tron_training_metadata_path(MODEL_VERSION, artifacts_dir)}")

    metrics_payload = {
        "model_version": MODEL_VERSION,
        "trained_at": trained_at.isoformat(),
        "classification_threshold": CLASSIFICATION_THRESHOLD,
        "splits": metrics,
        "feature_missingness": {"train": train_fm.missingness, "calibration": cal_fm.missingness, "test": test_fm.missingness},
        "shap_verification": {"n_examples": n_shap_examples, "examples": shap_examples},
    }
    tron_metrics_path(MODEL_VERSION, artifacts_dir).write_text(json.dumps(metrics_payload, indent=2), encoding="utf-8")
    _log(f"saved metrics to {tron_metrics_path(MODEL_VERSION, artifacts_dir)}")

    compact_card = trained_metadata(
        "tron",
        model_version=MODEL_VERSION,
        trained_at=trained_at,
        data_sources=[dataset.manifest.source],
        metrics={
            "test_roc_auc": metrics["test"]["roc_auc"] or 0.0,
            "test_pr_auc": metrics["test"]["pr_auc"] or 0.0,
            "test_accuracy": metrics["test"]["accuracy"],
            "test_precision": metrics["test"]["precision"],
            "test_recall": metrics["test"]["recall"],
            "test_f1": metrics["test"]["f1"],
            "test_brier_score": metrics["test"]["brier_score"],
        },
        limitations=[
            "trained on a 500-row bootstrap dataset (250 high_risk / 250 licit) -- a prototype, not a validated production fraud detector",
            "per-row event timestamps for the temporal split were derived from embedded evidence (blockTimestampMs / observedAt), not the dataset's own fetched_at column, which is identical across all 500 rows -- see app/training/timestamps.py",
            "hops_from_victim, hops_to_vasp and sanction_exposure are 100% missing (no case-graph context in this bootstrap collector) and contributed nothing to this model",
            "one row (OFAC-only source) has no genuine event timestamp and falls back to fetched_at",
            "no oversampling; class imbalance handled only via scale_pos_weight",
            "high_risk is a heuristic/blacklist/sanctions-overlap label, not a criminal or investigative determination",
            "trx_dust_usdt, shared_mule_cps and cross_case_count are zero-variance in this dataset (every one of the 500 rows is false/0) because apps/api/src/mule/bootstrap/tracedAddressProvider.ts's ChainLayerTracedAddressProvider hardcodes these three fields (trxDustUsdt: false, sharedMuleCps: 0, crossCaseCount: 0) rather than deriving them -- B5's full attribution heuristics and cross-case linkage were never wired into this bootstrap collector; this is a collector-completeness gap for a future phase, not evidence that real TRX balances/mule rings/case links were checked and happened to be negative",
            "activator_label is encoded as a 32-bucket FNV-1a hash cast to a plain float; XGBoost can still split on it (each split carves out a subset of buckets), but adjacent bucket numbers carry no real semantic similarity, so this is a weaker encoding than target/one-hot/leave-one-out encoding would be for this nominal categorical -- a concrete future improvement, not implemented here to avoid a test-set-influenced or newly-introduced encoding change mid-audit",
            f"overfitting gap: PR-AUC drops {metrics['train']['pr_auc'] - metrics['test']['pr_auc']:.4f} ({metrics['train']['pr_auc']:.4f} train -> {metrics['test']['pr_auc']:.4f} test), ROC-AUC drops {metrics['train']['roc_auc'] - metrics['test']['roc_auc']:.4f}, precision drops {metrics['train']['precision'] - metrics['test']['precision']:.2f} -- consistent with a shallow-tree/no-hyperparameter-search setup on a ~300-row training split, but a real generalization gap to watch, not a fixed issue",
        ],
        feature_names=FEATURE_NAMES,
    )
    tron_model_card_path(MODEL_VERSION, artifacts_dir).write_text(compact_card.model_dump_json(indent=2), encoding="utf-8")
    _log(f"saved compact model card to {tron_model_card_path(MODEL_VERSION, artifacts_dir)}")

    model_card_md = _render_model_card_md(dataset, metrics, training_metadata, trained_at)
    tron_model_card_md_path(MODEL_VERSION, artifacts_dir).write_text(model_card_md, encoding="utf-8")
    _log(f"saved narrative model card to {tron_model_card_md_path(MODEL_VERSION, artifacts_dir)}")

    # Step 15: latency benchmark, from artifacts reloaded fresh off disk.
    _log("reloading model+calibrator from disk for the latency benchmark (proving round-trip works)")
    reloaded_model = xgb.XGBClassifier()
    reloaded_model.load_model(str(tron_model_path(MODEL_VERSION, artifacts_dir)))
    reloaded_calibrator = IsotonicCalibrator.load(tron_calibrator_path(MODEL_VERSION, artifacts_dir))
    reloaded_explainer = shap.TreeExplainer(reloaded_model)

    latency = _benchmark_latency(reloaded_model, reloaded_calibrator, reloaded_explainer, split.test, n_iterations=200)
    _log(f"latency (ms): preprocessing p50={latency['preprocessing_ms']['p50']:.3f} p95={latency['preprocessing_ms']['p95']:.3f}")
    _log(f"latency (ms): xgboost p50={latency['xgboost_ms']['p50']:.3f} p95={latency['xgboost_ms']['p95']:.3f}")
    _log(f"latency (ms): calibration p50={latency['calibration_ms']['p50']:.3f} p95={latency['calibration_ms']['p95']:.3f}")
    _log(f"latency (ms): core_scoring (preproc+xgb+cal) p50={latency['core_scoring_ms']['p50']:.3f} p95={latency['core_scoring_ms']['p95']:.3f} -- under 200ms p95? {latency['core_scoring_ms']['p95'] < 200}")
    _log(f"latency (ms): shap_explanation p50={latency['shap_ms']['p50']:.3f} p95={latency['shap_ms']['p95']:.3f} (reported separately, excluded from core scoring latency)")

    elapsed = time.time() - t_start
    _log(f"training pipeline complete in {elapsed:.1f}s")

    return {
        "metrics": metrics,
        "training_metadata": training_metadata,
        "feature_metadata": feature_metadata,
        "latency": latency,
        "shap_examples": shap_examples,
        "split_sizes": {"train": len(split.train), "calibration": len(split.calibration), "test": len(split.test)},
        "row_identifiers": {"train": train_fm.identifiers, "calibration": cal_fm.identifiers, "test": test_fm.identifiers},
        "feature_matrices": {"train": train_fm.dataframe, "calibration": cal_fm.dataframe, "test": test_fm.dataframe},
        "elapsed_seconds": elapsed,
    }


def _benchmark_latency(model: "xgb.XGBClassifier", calibrator: IsotonicCalibrator, explainer: "shap.TreeExplainer", rows, *, n_iterations: int) -> dict[str, dict[str, float]]:
    """Measures preprocessing, XGBoost predict_proba, calibration, and SHAP explanation latency
    SEPARATELY for single-row predictions, plus a 'core scoring' figure that deliberately excludes
    SHAP (per instruction: never conflate explanation latency with the inference-latency claim)."""
    preprocessing_times: list[float] = []
    xgboost_times: list[float] = []
    calibration_times: list[float] = []
    shap_times: list[float] = []

    sample_rows = [rows[i % len(rows)] for i in range(n_iterations)]
    for row in sample_rows:
        t0 = time.perf_counter()
        fm = build_feature_matrix([row])
        t1 = time.perf_counter()
        raw_prob = model.predict_proba(fm.dataframe[list(FEATURE_NAMES)])[:, 1]
        t2 = time.perf_counter()
        calibrator.predict(raw_prob)
        t3 = time.perf_counter()
        explainer.shap_values(fm.dataframe[list(FEATURE_NAMES)])
        t4 = time.perf_counter()

        preprocessing_times.append((t1 - t0) * 1000)
        xgboost_times.append((t2 - t1) * 1000)
        calibration_times.append((t3 - t2) * 1000)
        shap_times.append((t4 - t3) * 1000)

    core_scoring_times = [p + x + c for p, x, c in zip(preprocessing_times, xgboost_times, calibration_times)]

    def percentiles(values: list[float]) -> dict[str, float]:
        arr = np.asarray(values)
        return {"p50": float(np.percentile(arr, 50)), "p95": float(np.percentile(arr, 95)), "mean": float(arr.mean())}

    return {
        "preprocessing_ms": percentiles(preprocessing_times),
        "xgboost_ms": percentiles(xgboost_times),
        "calibration_ms": percentiles(calibration_times),
        "core_scoring_ms": percentiles(core_scoring_times),
        "shap_ms": percentiles(shap_times),
        "n_iterations": n_iterations,
    }


def _render_model_card_md(dataset, metrics: dict[str, Any], training_metadata: dict[str, Any], trained_at: datetime) -> str:
    test = metrics["test"]
    cal = metrics["calibration"]
    train = metrics["train"]
    train_pr_auc_delta = train["pr_auc"] - test["pr_auc"]
    train_roc_auc_delta = train["roc_auc"] - test["roc_auc"]
    return f"""# TRON Risk Model -- Model Card ({MODEL_VERSION})

## Status: PROTOTYPE -- not a validated production fraud detector

This model was trained on a **500-row bootstrap dataset** (250 `high_risk`, 250 `licit`). It
demonstrates that the B7 training pipeline (data loading, feature encoding, temporal split, class
weighting, XGBoost training, isotonic calibration, SHAP explainability) works end-to-end on real
data. It has **not** been validated at production scale and should not be treated as one.

- Model version: `{MODEL_VERSION}`
- Trained at (UTC): `{trained_at.isoformat()}`
- Dataset: `{dataset.manifest.name}` version `{dataset.manifest.version}`, path `{dataset.manifest.local_path}`

## Intended use

Risk-scores a TRON address from its B6-computed Appendix-B feature vector (15 features, see
below), as one input into the platform's hybrid mule/risk scoring (plan B7). It is meant to
prioritize investigator attention, not to make an automated accusation.

## Label definitions

`high_risk` and `licit` are the only two training labels. **`high_risk` does NOT mean criminal --
it reflects overlap with blacklist/sanctions/heuristic signals, not a legal or investigative
determination.** Positive examples come from USDT-TRC20 `AddedBlackList` events and OFAC
SDN digital-currency addresses; negative examples are sampled active USDT holders excluding
tagged services. Neither label is a court finding or a law-enforcement determination.

## Model type

XGBoost binary classifier (`max_depth={training_metadata['xgboost_params']['max_depth']}`,
`n_estimators={training_metadata['xgboost_params']['n_estimators']}`,
`learning_rate={training_metadata['xgboost_params']['learning_rate']}`,
`eval_metric={training_metadata['xgboost_params']['eval_metric']}`,
`scale_pos_weight={training_metadata['scale_pos_weight']:.4f}`, random_state={training_metadata['random_seed']}),
with isotonic-regression probability calibration fit on a held-out calibration split (never on
train or test).

## Feature schema (15 canonical features)

All 15 of the plan's Appendix-B features are present in the schema; 12 were usable in this
training run, 3 were structurally unavailable:

- **Usable**: dwell_median_min, fan_out_1h, fan_in_unique, passthrough_ratio, age_at_taint_days,
  activator_label (FNV-1a hash-bucketed, 32 buckets), trx_dust_usdt (zero-variance in this
  dataset -- every row is "false"), round_amount_ratio, burst_tx_per_hour, external_flags
  (encoded as count), shared_mule_cps, cross_case_count.
- **Structurally unavailable in this bootstrap run (100% missing, kept in schema, never
  fabricated)**: hops_from_victim, hops_to_vasp, sanction_exposure -- this collector has no
  case-graph context.

## Training methodology

- Deterministic **time-based split**: train (earliest) / calibration / test (latest), by real
  per-row event timestamps *derived from embedded evidence* (on-chain `blockTimestampMs` for
  blacklist events, `observedAt` for negative-sample USDT activity) -- not the dataset's raw
  `fetched_at` column, which is identical across all 500 rows (a collection-run timestamp, not a
  per-event one). See `app/training/timestamps.py` for the full rationale. One row (the single
  OFAC-only-source row) has no embedded event timestamp at all and falls back to `fetched_at`.
- Split fractions: 60% train / 20% calibration / 20% test, unmodified from the default -- this
  produced non-degenerate partitions with both classes present in every split on the real data.
  Train={training_metadata['row_counts']['train']}, calibration={training_metadata['row_counts']['calibration']}, test={training_metadata['row_counts']['test']}.
- Class imbalance handled via `scale_pos_weight` (negatives/positives in the train split only,
  = {training_metadata['scale_pos_weight']:.4f}); **no oversampling/SMOTE**.
- No hyperparameter search -- fixed, literature-standard shallow-tree defaults, chosen to avoid
  overfitting a ~300-row training split.

## Evaluation results (real run)

| split | n | roc_auc | pr_auc | accuracy | precision | recall | f1 | brier |
|---|---|---|---|---|---|---|---|---|
| train | {train['n']} | {train['roc_auc']} | {train['pr_auc']} | {train['accuracy']:.3f} | {train['precision']:.3f} | {train['recall']:.3f} | {train['f1']:.3f} | {train['brier_score']:.4f} |
| calibration | {cal['n']} | {cal['roc_auc']} | {cal['pr_auc']} | {cal['accuracy']:.3f} | {cal['precision']:.3f} | {cal['recall']:.3f} | {cal['f1']:.3f} | {cal['brier_score']:.4f} |
| test | {test['n']} | {test['roc_auc']} | {test['pr_auc']} | {test['accuracy']:.3f} | {test['precision']:.3f} | {test['recall']:.3f} | {test['f1']:.3f} | {test['brier_score']:.4f} |

Classification threshold: {training_metadata['classification_threshold']} on the calibrated probability.

Recall-at-~90%-precision on the test split: {test.get('recall_at_90pct_precision')} -- {test.get('recall_at_90pct_precision_note')}

Do not overstate these numbers: a near-perfect train-split metric with a weaker test-split metric
is consistent with the model's shallow-tree/low-complexity setup but should still be read as "this
pipeline works," not "this model is production-ready."

## Known limitations

1. **500-row bootstrap size.** Small enough that all metrics, especially test-split ones, are
   noisy point estimates, not stable population statistics.
2. **Derived-timestamp temporal split.** The split relies on timestamps this module derived from
   embedded evidence, not native per-row timestamps the collector originally recorded (which are
   degenerate -- see above). This is real, non-fabricated signal, but it is a workaround, not the
   ideal collector behavior; a future collector should record real per-row timestamps directly.
3. **3 always-missing features** (hops_from_victim, hops_to_vasp, sanction_exposure) contributed
   nothing to this model; a future version with real case-graph context could meaningfully improve.
4. **Single-row OFAC-source timestamp fallback.** One row of 500 has no genuine event timestamp
   and uses the (coarse, but real) collection-run `fetched_at` instead.
5. **No case-graph context** at all in this collector (hop distances, VASP proximity).
6. **Overfitting risk.** ~300 training rows against a boosted-tree model's capacity is a real
   concern even with shallow trees and no hyperparameter search; watch the train-vs-test metric
   gap in the table above -- PR-AUC drops {train_pr_auc_delta:.4f} ({train['pr_auc']:.4f} train -> {test['pr_auc']:.4f} test), ROC-AUC drops {train_roc_auc_delta:.4f}.
7. **Prototype, not a validated production fraud detector.** This model card exists to make that
   framing explicit and repeated, not to imply otherwise.
8. **`trx_dust_usdt`, `shared_mule_cps` and `cross_case_count` are zero-variance** (every one of
   the 500 rows is false/0). Root cause verified in the TypeScript collector, not guessed: `apps/api/src/mule/bootstrap/tracedAddressProvider.ts`'s `ChainLayerTracedAddressProvider.build()`
   hardcodes `trxDustUsdt: false`, `sharedMuleCps: 0` and `crossCaseCount: 0` for every address (B5's
   full attribution heuristics and cross-case linkage were never wired into this bootstrap
   collector) -- this is a collector-completeness gap for a future phase, not evidence that real
   TRX balances, mule-ring overlap, or case links were checked and happened to be negative.
9. **`activator_label` hash-ordinality.** Encoded as a 32-bucket FNV-1a hash cast to a plain float.
   Tree splits can still partially work around this (a tree can carve out an arbitrary subset of
   buckets across multiple splits, so it is not purely ordinal-blind), but adjacent bucket numbers
   have no real semantic proximity, so this is a weaker encoding than target/one-hot/leave-one-out
   encoding would be for this nominal categorical field. A concrete future improvement: fit a
   target encoding (or leave-one-out encoding) on the train split only, or one-hot encode if
   cardinality were lower.

## Dataset size, training date, model version

- Dataset size: 500 rows (250 high_risk / 250 licit)
- Trained: {trained_at.isoformat()} (UTC)
- Model version: {MODEL_VERSION}
"""


if __name__ == "__main__":
    main()
