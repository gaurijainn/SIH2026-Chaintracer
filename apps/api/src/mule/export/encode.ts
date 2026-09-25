import type { MuleFeatures } from '../types';
import type { EncodedCategoricals } from './types';

const ACTIVATOR_LABEL_BUCKETS = 32;

/**
 * Deterministic, seedless string hash (FNV-1a). Same input always produces the same output on any
 * run/platform — no fitted vocabulary, no train/inference skew, nothing to persist as a model
 * artifact. Only needs to be stable across runs of this exporter, not matched by any Python code.
 */
export function stableHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic ML-ready representations of B6's two non-numeric features. `activator_label` (a
 * free-text label, possibly absent) becomes a stable hash bucket, or null when B6 reported none —
 * null is preserved, never coerced into bucket 0, so "no activator label" is never confused with
 * "activator label hashed to 0". `external_flags` (a variable-length string list) becomes a count
 * (numeric, always present) and a sorted '|'-joined hash (for exact-match grouping/dedup).
 */
export function encodeCategoricals(features: Pick<MuleFeatures, 'activator_label' | 'external_flags'>): EncodedCategoricals {
  return {
    activator_label_hash: features.activator_label == null ? null : stableHash(features.activator_label) % ACTIVATOR_LABEL_BUCKETS,
    external_flags_count: features.external_flags.length,
    external_flags_hash: [...features.external_flags].sort().join('|'),
  };
}
