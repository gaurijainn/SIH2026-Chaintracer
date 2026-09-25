import { describe, expect, it } from 'vitest';
import { computeMuleFeatures } from '../features';
import type { HopLike } from '../types';
import { buildExportFile, toExportRow } from './exportFeatures';
import { MULE_FEATURE_NAMES } from './types';

const T0 = Date.UTC(2026, 8, 1);
const hop = (over: Partial<HopLike>): HopLike => ({ txHash: 'tx', idx: 0, fromAddr: 'F', toAddr: 'T', token: 'USDT', amount: '0', usd: 0, ts: T0, ...over });

describe('toExportRow', () => {
  it('preserves every B6-computed feature value exactly, with no recomputation', () => {
    const features = computeMuleFeatures({
      chain: 'TRON',
      addr: 'W1',
      inbound: [hop({ fromAddr: 'S1', usd: 1000, ts: T0 })],
      outbound: [hop({ toAddr: 'D1', usd: 950, ts: T0 + 20 * 60_000 })],
      accountCreatedAtMs: T0 - 3 * 86_400_000,
      firstTaintedAtMs: T0,
      activatorLabel: 'exchange',
      sanctionExposure: null,
      externalFlags: ['fraudTransaction'],
      trxDustUsdt: true,
      hopsFromVictim: 2,
      hopsToVasp: 1,
      sharedMuleCps: 3,
      crossCaseCount: 2,
    });

    const row = toExportRow({
      identifier: 'W1',
      chain: 'TRON',
      timestamp: new Date(T0).toISOString(),
      label: 'high_risk',
      source: { name: 'b6-mule-features', version: 'v1', caseId: 'case-1' },
      features,
    });

    expect(row.features).toEqual(features); // byte-for-byte: exporter never mutates a value
    expect(row.identifier).toBe('W1');
    expect(row.label).toBe('high_risk');
  });

  it('exports feature keys in the exact canonical MULE_FEATURE_NAMES order', () => {
    const features = computeMuleFeatures({
      chain: 'ETH',
      addr: 'W2',
      inbound: [],
      outbound: [],
      accountCreatedAtMs: null,
      firstTaintedAtMs: null,
      activatorLabel: null,
      sanctionExposure: null,
      externalFlags: [],
      trxDustUsdt: false,
      hopsFromVictim: null,
      hopsToVasp: null,
      sharedMuleCps: 0,
      crossCaseCount: 1,
    });
    const row = toExportRow({ identifier: 'W2', chain: 'ETH', timestamp: null, source: { name: 's', version: 'v1' }, features });
    expect(Object.keys(row.features)).toEqual([...MULE_FEATURE_NAMES]);
  });

  it('defaults an omitted label to null rather than inventing one', () => {
    const features = computeMuleFeatures({
      chain: 'ETH', addr: 'W3', inbound: [], outbound: [], accountCreatedAtMs: null, firstTaintedAtMs: null,
      activatorLabel: null, sanctionExposure: null, externalFlags: [], trxDustUsdt: false,
      hopsFromVictim: null, hopsToVasp: null, sharedMuleCps: 0, crossCaseCount: 1,
    });
    const row = toExportRow({ identifier: 'W3', chain: 'ETH', timestamp: null, source: { name: 's', version: 'v1' }, features });
    expect(row.label).toBeNull();
  });

  it('preserves null values on nullable numeric features rather than substituting 0', () => {
    const features = computeMuleFeatures({
      chain: 'ETH', addr: 'W4', inbound: [], outbound: [], accountCreatedAtMs: null, firstTaintedAtMs: null,
      activatorLabel: null, sanctionExposure: null, externalFlags: [], trxDustUsdt: false,
      hopsFromVictim: null, hopsToVasp: null, sharedMuleCps: 0, crossCaseCount: 1,
    });
    const row = toExportRow({ identifier: 'W4', chain: 'ETH', timestamp: null, source: { name: 's', version: 'v1' }, features });
    expect(row.features.dwell_median_min).toBeNull();
    expect(row.features.passthrough_ratio).toBeNull();
    expect(row.features.age_at_taint_days).toBeNull();
    expect(row.features.hops_from_victim).toBeNull();
  });

  it('computes a deterministic encoded-categoricals block alongside the raw features', () => {
    const features = computeMuleFeatures({
      chain: 'TRON', addr: 'W5', inbound: [], outbound: [], accountCreatedAtMs: null, firstTaintedAtMs: null,
      activatorLabel: 'exchange', sanctionExposure: null, externalFlags: ['a', 'b'], trxDustUsdt: false,
      hopsFromVictim: null, hopsToVasp: null, sharedMuleCps: 0, crossCaseCount: 1,
    });
    const row = toExportRow({ identifier: 'W5', chain: 'TRON', timestamp: null, source: { name: 's', version: 'v1' }, features });
    expect(row.encoded.activator_label_hash).not.toBeNull();
    expect(row.encoded.external_flags_count).toBe(2);
  });
});

describe('buildExportFile', () => {
  it('carries the canonical feature order at the file level', () => {
    const file = buildExportFile([], { datasetVersion: 'v1', generatedAt: '2026-09-01T00:00:00.000Z' });
    expect(file.featureOrder).toEqual([...MULE_FEATURE_NAMES]);
    expect(file.rows).toEqual([]);
  });
});
