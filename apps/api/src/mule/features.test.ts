import { describe, expect, it } from 'vitest';
import { computeMuleFeatures } from './features';
import type { HopLike } from './types';

const T0 = Date.UTC(2026, 8, 1);
const hop = (over: Partial<HopLike>): HopLike => ({ txHash: 'tx', idx: 0, fromAddr: 'F', toAddr: 'T', token: 'USDT', amount: '0', usd: 0, ts: T0, ...over });

describe('computeMuleFeatures', () => {
  it('assembles the full Appendix B feature vector from already-fetched data', () => {
    const inbound = [hop({ fromAddr: 'S1', usd: 1000, ts: T0 })];
    const outbound = [hop({ toAddr: 'D1', usd: 950, ts: T0 + 20 * 60_000 })];

    const features = computeMuleFeatures({
      chain: 'TRON',
      addr: 'W1',
      inbound,
      outbound,
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

    expect(features).toEqual({
      dwell_median_min: 20,
      fan_out_1h: 1,
      fan_in_unique: 1,
      passthrough_ratio: 0.95,
      age_at_taint_days: 3,
      activator_label: 'exchange',
      trx_dust_usdt: true,
      round_amount_ratio: 0,
      burst_tx_per_hour: 2,
      hops_from_victim: 2,
      hops_to_vasp: 1,
      sanction_exposure: null,
      external_flags: ['fraudTransaction'],
      shared_mule_cps: 3,
      cross_case_count: 2,
    });
  });

  it('degrades gracefully when optional metadata is missing (no unsupported claims)', () => {
    const features = computeMuleFeatures({
      chain: 'TRON',
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
    expect(features.dwell_median_min).toBeNull();
    expect(features.passthrough_ratio).toBeNull();
    expect(features.age_at_taint_days).toBeNull();
  });
});
