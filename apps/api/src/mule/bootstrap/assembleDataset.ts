import { MULE_FEATURE_NAMES } from '../export/types';
import type { JoinReport, TronTrainingRow } from '../training/types';
import { toCsv } from './csv';
import type { NegativeCandidateRow } from './negativeCandidates';

/**
 * B7.4 tasks 8-9: turns a `JoinReport` (already-joined, B6-feature-bearing training rows) plus the
 * pipeline's bookkeeping counts into (a) the final versioned training CSV matching
 * services/ml/app/datasets/loaders/tron_bootstrap.py's `TronBootstrapLoader` schema exactly, and
 * (b) a validation report covering every metric task 9 asks for. Deterministic: rows are taken
 * as-is from JoinReport (already sorted by (chain, address) by joinBootstrapLabels itself).
 */

export const TRON_BOOTSTRAP_CSV_COLUMNS = ['address', 'chain', 'label', 'source', 'fetched_at', 'evidence', 'confidence', ...MULE_FEATURE_NAMES] as const;

export function trainingRowToCsvRow(row: TronTrainingRow): Record<string, unknown> {
  const featureCols: Record<string, unknown> = {};
  for (const name of MULE_FEATURE_NAMES) {
    const v = row.features[name];
    featureCols[name] = Array.isArray(v) ? JSON.stringify(v) : v === null ? '' : v;
  }
  return {
    address: row.identifier,
    chain: row.chain,
    label: row.label,
    source: row.source,
    fetched_at: row.timestamp,
    evidence: JSON.stringify(row.evidence ?? null),
    confidence: row.confidence,
    ...featureCols,
  };
}

export function buildTronBootstrapCsv(rows: TronTrainingRow[]): string {
  return toCsv(rows.map(trainingRowToCsvRow), TRON_BOOTSTRAP_CSV_COLUMNS);
}

export interface HighRiskSourceCounts {
  addedBlackListAddresses: number;
  ofacAddresses: number;
  chainabuseEnrichedAddresses: number;
}

export interface ValidationReport {
  datasetVersion: string;
  generatedAt: string;
  totals: {
    totalCandidates: number;
    finalRows: number;
    highRiskRows: number;
    licitRows: number;
    unusableRows: number;
    duplicateAddressesMerged: number;
    conflicts: number;
    invalidAddresses: number;
  };
  sourceDistribution: Record<string, number>;
  timestampRange: { earliest: string | null; latest: string | null };
  featureMissingness: Record<string, { missing: number; missingPct: number }>;
  usableTrainingRows: number;
  sourceCounts: HighRiskSourceCounts;
  excluded: {
    vaspOrService: number;
    ambiguousOrConflicting: number;
    insufficientActivity: number;
  };
  balanced: boolean;
}

export function buildValidationReport(opts: {
  joinReport: JoinReport;
  negativeCandidates: NegativeCandidateRow[];
  sourceCounts: HighRiskSourceCounts;
  datasetVersion: string;
  generatedAt: string;
  totalHighRiskCandidatesConsidered: number;
}): ValidationReport {
  const { joinReport, negativeCandidates, sourceCounts, datasetVersion, generatedAt } = opts;
  const rows = joinReport.rows;

  const highRiskRows = rows.filter((r) => r.label === 'high_risk').length;
  const licitRows = rows.filter((r) => r.label === 'licit').length;
  const unusableRows = joinReport.unmatchedLabels.length + joinReport.invalidAddresses.length + joinReport.untracedAddresses.length;

  const sourceDistribution: Record<string, number> = {};
  for (const r of rows) sourceDistribution[r.source] = (sourceDistribution[r.source] ?? 0) + 1;

  const timestamps = rows.map((r) => r.timestamp).sort();
  const featureMissingness: Record<string, { missing: number; missingPct: number }> = {};
  for (const name of MULE_FEATURE_NAMES) {
    const missing = rows.filter((r) => {
      const v = r.features[name];
      return v === null || (Array.isArray(v) && v.length === 0 && typeof v !== 'boolean');
    }).length;
    featureMissingness[name] = { missing, missingPct: rows.length ? Math.round((missing / rows.length) * 1000) / 10 : 0 };
  }

  const vaspOrService = negativeCandidates.filter((c) => c.status === 'excluded').length;
  const insufficientActivity = negativeCandidates.filter((c) => c.status === 'undetermined').length;

  const totalCandidates = opts.totalHighRiskCandidatesConsidered + negativeCandidates.length;

  return {
    datasetVersion,
    generatedAt,
    totals: {
      totalCandidates,
      finalRows: rows.length,
      highRiskRows,
      licitRows,
      unusableRows,
      duplicateAddressesMerged: 0, // dedup happens before the join (highRisk.ts/mergeHighRiskLabelRows); nothing duplicate reaches JoinReport
      conflicts: joinReport.conflicts.length,
      invalidAddresses: joinReport.invalidAddresses.length,
    },
    sourceDistribution,
    timestampRange: { earliest: timestamps[0] ?? null, latest: timestamps[timestamps.length - 1] ?? null },
    featureMissingness,
    usableTrainingRows: rows.length,
    sourceCounts,
    excluded: {
      vaspOrService,
      ambiguousOrConflicting: joinReport.conflicts.length,
      insufficientActivity,
    },
    balanced: highRiskRows > 0 && licitRows > 0 && Math.abs(highRiskRows - licitRows) / Math.max(highRiskRows, licitRows) < 0.15,
  };
}
