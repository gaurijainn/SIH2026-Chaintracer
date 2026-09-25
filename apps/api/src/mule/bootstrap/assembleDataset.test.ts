import { describe, expect, it } from 'vitest';
import { tronAddr } from '@ps26183/workers/adapters/testing';
import type { MuleFeatureInputs } from '../features';
import { joinBootstrapLabels } from '../training/join';
import type { BootstrapLabelRow, TracedAddressProvider } from '../training/types';
import { buildTronBootstrapCsv, buildValidationReport, TRON_BOOTSTRAP_CSV_COLUMNS } from './assembleDataset';

const T0 = '2026-09-23T00:00:00.000Z';
const ADDR_HR = tronAddr('assemble-hr');
const ADDR_LICIT = tronAddr('assemble-licit');

const inputsFor = (addr: string): MuleFeatureInputs => ({
  chain: 'TRON', addr, inbound: [], outbound: [], accountCreatedAtMs: null, firstTaintedAtMs: null,
  activatorLabel: null, sanctionExposure: null, externalFlags: [], trxDustUsdt: false,
  hopsFromVictim: null, hopsToVasp: null, sharedMuleCps: 0, crossCaseCount: 0,
});

function provider(addrs: string[]): TracedAddressProvider {
  const map = new Map(addrs.map((a) => [a, inputsFor(a)]));
  return { listTracedAddresses: () => addrs, getFeatureInputs: (_c, a) => map.get(a) ?? null };
}

const labels: BootstrapLabelRow[] = [
  { address: ADDR_HR, chain: 'TRON', label: 'high_risk', source: 'usdt_blacklist', fetchedAt: T0, confidence: 0.9 },
  { address: ADDR_LICIT, chain: 'TRON', label: 'licit', source: 'tron_negative_sampling', fetchedAt: T0, confidence: 1 },
];

describe('buildTronBootstrapCsv', () => {
  it('produces a header matching TronBootstrapLoader REQUIRED_COLUMNS plus the 15 canonical features', () => {
    const report = joinBootstrapLabels(labels, provider([ADDR_HR, ADDR_LICIT]));
    const csv = buildTronBootstrapCsv(report.rows);
    const header = csv.split('\n')[0].split(',');
    expect(TRON_BOOTSTRAP_CSV_COLUMNS.slice(0, 7)).toEqual(['address', 'chain', 'label', 'source', 'fetched_at', 'evidence', 'confidence']);
    expect(header).toEqual([...TRON_BOOTSTRAP_CSV_COLUMNS]);
    expect(csv).toContain(ADDR_HR);
    expect(csv).toContain('high_risk');
    expect(csv.trim().split('\n')).toHaveLength(3); // header + 2 rows
  });
});

describe('buildValidationReport', () => {
  it('reports every required metric and never claims balance when it is not balanced', () => {
    const hrAddrs = Array.from({ length: 3 }, (_, i) => tronAddr(`assemble-hr-${i}`));
    const skewedLabels: BootstrapLabelRow[] = [
      ...hrAddrs.map((address) => ({ address, chain: 'TRON' as const, label: 'high_risk' as const, source: 'usdt_blacklist', fetchedAt: T0, confidence: 0.9 })),
      { address: ADDR_LICIT, chain: 'TRON', label: 'licit', source: 'tron_negative_sampling', fetchedAt: T0, confidence: 1 },
    ];
    const traced = [ADDR_LICIT, ...hrAddrs];
    const report = joinBootstrapLabels(skewedLabels, provider(traced));
    const validation = buildValidationReport({
      joinReport: report,
      negativeCandidates: [{ address: ADDR_LICIT, chain: 'TRON', activity_evidence: { txCount: 1 }, usdt_holder_evidence: { usdtTxCount: 1 }, status: 'included', source: 'tron_negative_sampling', timestamp: T0 }],
      sourceCounts: { addedBlackListAddresses: 3, ofacAddresses: 0, chainabuseEnrichedAddresses: 0 },
      datasetVersion: 'v1',
      generatedAt: T0,
      totalHighRiskCandidatesConsidered: 3,
    });
    expect(validation.totals.finalRows).toBe(4);
    expect(validation.totals.highRiskRows).toBe(3);
    expect(validation.totals.licitRows).toBe(1);
    expect(validation.balanced).toBe(false); // 3 vs 1 is not balanced
    expect(Object.keys(validation.featureMissingness)).toHaveLength(15);
    expect(validation.sourceDistribution['usdt_blacklist']).toBe(3);
  });

  it('does claim balanced when high-risk and licit counts are actually close', () => {
    const balancedLabels: BootstrapLabelRow[] = [
      { address: ADDR_HR, chain: 'TRON', label: 'high_risk', source: 'usdt_blacklist', fetchedAt: T0, confidence: 0.9 },
      { address: ADDR_LICIT, chain: 'TRON', label: 'licit', source: 'tron_negative_sampling', fetchedAt: T0, confidence: 1 },
    ];
    const report = joinBootstrapLabels(balancedLabels, provider([ADDR_HR, ADDR_LICIT]));
    const validation = buildValidationReport({
      joinReport: report,
      negativeCandidates: [],
      sourceCounts: { addedBlackListAddresses: 1, ofacAddresses: 0, chainabuseEnrichedAddresses: 0 },
      datasetVersion: 'v1',
      generatedAt: T0,
      totalHighRiskCandidatesConsidered: 1,
    });
    expect(validation.balanced).toBe(true);
  });
});
