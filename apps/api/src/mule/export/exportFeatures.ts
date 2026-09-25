import type { Chain } from '@ps26183/shared';
import type { MuleFeatures } from '../types';
import { encodeCategoricals } from './encode';
import { MULE_FEATURE_NAMES, type ExportFile, type ExportRow, type ExportSource } from './types';

export interface ExportInput {
  identifier: string;
  chain: Chain;
  timestamp: string | null;
  /** omit or pass null when no training label is known yet for this address. */
  label?: string | null;
  source: ExportSource;
  /** the output of B6's computeMuleFeatures (apps/api/src/mule/features.ts) — never recomputed here. */
  features: MuleFeatures;
}

/**
 * Packages one already-computed B6 feature vector into the canonical B7 export row. This is a pure
 * repackaging step: every feature value is copied through unchanged from `input.features` (B6's
 * production computeMuleFeatures output); this module computes nothing about mule/layering
 * behaviour itself. B6 stays the sole source of truth for feature calculation (plan B7.3 boundary).
 */
export function toExportRow(input: ExportInput): ExportRow {
  const orderedFeatures = Object.fromEntries(MULE_FEATURE_NAMES.map((name) => [name, input.features[name]])) as unknown as MuleFeatures;
  return {
    identifier: input.identifier,
    chain: input.chain,
    timestamp: input.timestamp,
    label: input.label ?? null,
    source: input.source,
    features: orderedFeatures,
    encoded: encodeCategoricals(input.features),
  };
}

export function buildExportFile(rows: ExportRow[], opts: { datasetVersion: string; generatedAt: string }): ExportFile {
  return { datasetVersion: opts.datasetVersion, generatedAt: opts.generatedAt, featureOrder: MULE_FEATURE_NAMES, rows };
}
