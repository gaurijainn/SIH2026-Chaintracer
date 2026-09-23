# TRON Risk Model -- Model Card (v1)

## Status: PROTOTYPE -- not a validated production fraud detector

This model was trained on a **500-row bootstrap dataset** (250 `high_risk`, 250 `licit`). It
demonstrates that the B7 training pipeline (data loading, feature encoding, temporal split, class
weighting, XGBoost training, isotonic calibration, SHAP explainability) works end-to-end on real
data. It has **not** been validated at production scale and should not be treated as one.

- Model version: `v1`
- Trained at (UTC): `2026-09-23T06:26:08.614421+00:00`
- Dataset: `tron-bootstrap` version `tron-bootstrap-v1-live`, path `C:\Users\Gauri Jain\SIH_project\data\labels\tron-bootstrap\v1\tron_bootstrap_dataset.csv`

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

XGBoost binary classifier (`max_depth=3`,
`n_estimators=150`,
`learning_rate=0.1`,
`eval_metric=aucpr`,
`scale_pos_weight=0.8987`, random_state=42),
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
  Train=300, calibration=100, test=100.
- Class imbalance handled via `scale_pos_weight` (negatives/positives in the train split only,
  = 0.8987); **no oversampling/SMOTE**.
- No hyperparameter search -- fixed, literature-standard shallow-tree defaults, chosen to avoid
  overfitting a ~300-row training split.

## Evaluation results (real run)

| split | n | roc_auc | pr_auc | accuracy | precision | recall | f1 | brier |
|---|---|---|---|---|---|---|---|---|
| train | 300 | 0.9995988589766447 | 0.9993178200560904 | 0.963 | 1.000 | 0.930 | 0.964 | 0.0238 |
| calibration | 100 | 0.9945652173913043 | 0.9933775082359988 | 0.970 | 0.981 | 0.963 | 0.972 | 0.0240 |
| test | 100 | 0.9630730050933787 | 0.896108731130151 | 0.880 | 0.760 | 1.000 | 0.864 | 0.0911 |

Classification threshold: 0.5 on the calibrated probability.

Recall-at-~90%-precision on the test split: 0.9473684210526315 -- computed over n=100 rows (38 positive) -- noisy at this size, directional only

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
   gap in the table above -- PR-AUC drops 0.1032 (0.9993 train -> 0.8961 test), ROC-AUC drops 0.0365.
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
- Trained: 2026-09-23T06:26:08.614421+00:00 (UTC)
- Model version: v1
