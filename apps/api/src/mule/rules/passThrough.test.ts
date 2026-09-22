import { describe, expect, it } from 'vitest';
import type { HopLike } from '../types';
import { detectPassThrough } from './passThrough';

const T0 = Date.UTC(2026, 8, 1);
const hop = (over: Partial<HopLike>): HopLike => ({ txHash: 'tx', idx: 0, fromAddr: 'F', toAddr: 'T', token: 'USDT', amount: '0', usd: 0, ts: T0, ...over });

describe('detectPassThrough', () => {
  it('fires when value out is close to value in and the median dwell is under the threshold', () => {
    const inbound = [hop({ usd: 1000, ts: T0 })];
    const outbound = [hop({ usd: 985, ts: T0 + 20 * 60_000 })]; // 1.5% off, 20 min dwell
    const [m] = detectPassThrough(inbound, outbound);
    expect(m).toMatchObject({ confidence: 0.8 });
    expect(m.evidence).toMatchObject({ ratio: 0.985, dwellMedianMin: 20 });
  });

  it('does not fire when the value drops well below the tolerance (funds were split off, not passed through)', () => {
    const inbound = [hop({ usd: 1000, ts: T0 })];
    const outbound = [hop({ usd: 500, ts: T0 + 10 * 60_000 })];
    expect(detectPassThrough(inbound, outbound)).toEqual([]);
  });

  it('does not fire when the dwell exceeds the max-dwell threshold', () => {
    const inbound = [hop({ usd: 1000, ts: T0 })];
    const outbound = [hop({ usd: 990, ts: T0 + 90 * 60_000 })]; // 90 min > 60 min default
    expect(detectPassThrough(inbound, outbound)).toEqual([]);
  });

  it('does not fire with no inbound or no outbound activity', () => {
    expect(detectPassThrough([], [hop({ usd: 100 })])).toEqual([]);
    expect(detectPassThrough([hop({ usd: 100 })], [])).toEqual([]);
  });

  it('respects a configured tolerance and max-dwell override', () => {
    const inbound = [hop({ usd: 1000, ts: T0 })];
    const outbound = [hop({ usd: 800, ts: T0 + 100 * 60_000 })]; // 20% off, 100 min
    expect(detectPassThrough(inbound, outbound, { valueTolerance: 0.25, maxDwellMinutes: 120 })).toHaveLength(1);
  });
});
