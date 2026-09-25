import type { Chain } from '@ps26183/shared';
import type { MuleFeatures } from '../types';

/**
 * B7.3 bridge: the canonical Appendix-B feature order, hand-declared to match
 * services/ml/app/features/schema.py's FEATURE_NAMES exactly. `satisfies` catches a typo'd or
 * removed key at compile time; exportFeatures.test.ts checks the array is exhaustive (every
 * MuleFeatures key present, in this exact order) since TypeScript alone cannot express that.
 */
export const MULE_FEATURE_NAMES = [
  'dwell_median_min',
  'fan_out_1h',
  'fan_in_unique',
  'passthrough_ratio',
  'age_at_taint_days',
  'activator_label',
  'trx_dust_usdt',
  'round_amount_ratio',
  'burst_tx_per_hour',
  'hops_from_victim',
  'hops_to_vasp',
  'sanction_exposure',
  'external_flags',
  'shared_mule_cps',
  'cross_case_count',
] as const satisfies readonly (keyof MuleFeatures)[];

export type MuleFeatureName = (typeof MULE_FEATURE_NAMES)[number];

/** Deterministic, seedless representations of B6's two categorical/array-valued features, computed
 * once at export time (see encode.ts) so the Python side never has to re-derive an encoding. */
export interface EncodedCategoricals {
  /** stable hash bucket of activator_label, or null when B6 reported no activator label (never invented). */
  activator_label_hash: number | null;
  external_flags_count: number;
  /** sorted, '|'-joined external_flags, for exact-match grouping; '' when the list is empty. */
  external_flags_hash: string;
}

export interface ExportSource {
  name: string;
  version: string;
  caseId?: string;
  traceId?: string;
}

export interface ExportRow {
  identifier: string;
  chain: Chain;
  /** ISO-8601 UTC, or null when the caller has no meaningful timestamp for this snapshot (never invented). */
  timestamp: string | null;
  /** training label when known (e.g. from a confirmed WatchlistItem/RiskScore), else null. */
  label: string | null;
  source: ExportSource;
  /** exactly what B6's computeMuleFeatures produced; keys inserted in MULE_FEATURE_NAMES order. */
  features: MuleFeatures;
  encoded: EncodedCategoricals;
}

export interface ExportFile {
  datasetVersion: string;
  generatedAt: string;
  featureOrder: readonly MuleFeatureName[];
  rows: ExportRow[];
}
