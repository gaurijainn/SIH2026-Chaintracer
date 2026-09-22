import { describe, expect, it } from 'vitest';
import { ageAtTaintDays, burstTxPerHour, dwellMedianMin, fanInUnique, fanOut1h, isRoundAmount, passthroughRatio, roundAmountRatio } from './hopMath';
import type { HopLike } from './types';

const T0 = Date.UTC(2026, 8, 1);
const hop = (over: Partial<HopLike>): HopLike => ({ txHash: 'tx', idx: 0, fromAddr: 'F', toAddr: 'T', token: 'USDT', amount: '0', usd: 0, ts: T0, ...over });

describe('dwellMedianMin', () => {
  it('pairs earliest inbound/outbound and takes the median gap', () => {
    const inbound = [hop({ ts: T0 }), hop({ ts: T0 + 60_000 })];
    const outbound = [hop({ ts: T0 + 10 * 60_000 }), hop({ ts: T0 + 90 * 60_000 })];
    // gaps: (T0+10m - T0)=10m, (T0+90m - T0+1m)=89m -> median of [10,89] = 49.5
    expect(dwellMedianMin(inbound, outbound)).toBe(49.5);
  });

  it('is null with no inbound or outbound', () => {
    expect(dwellMedianMin([], [hop({})])).toBeNull();
    expect(dwellMedianMin([hop({})], [])).toBeNull();
  });
});

describe('fanOut1h', () => {
  it('returns the worst-case distinct-recipient count within the window', () => {
    const inbound = [hop({ ts: T0 })];
    const outbound = [hop({ toAddr: 'A', ts: T0 + 60_000 }), hop({ toAddr: 'B', ts: T0 + 90_000 }), hop({ toAddr: 'A', ts: T0 + 120_000 })];
    expect(fanOut1h(inbound, outbound)).toBe(2); // A, B distinct
  });
});

describe('fanInUnique', () => {
  it('counts distinct senders within the trailing window', () => {
    const inbound = [hop({ fromAddr: 'S1', ts: T0 }), hop({ fromAddr: 'S2', ts: T0 }), hop({ fromAddr: 'S1', ts: T0 - 40 * 86_400_000 })];
    expect(fanInUnique(inbound, T0)).toBe(2);
  });
});

describe('passthroughRatio', () => {
  it('divides total outbound value by total inbound value', () => {
    expect(passthroughRatio([hop({ usd: 100 })], [hop({ usd: 95 })])).toBe(0.95);
  });
  it('is null when nothing was received', () => {
    expect(passthroughRatio([], [hop({ usd: 10 })])).toBeNull();
  });
});

describe('isRoundAmount / roundAmountRatio', () => {
  it('treats multiples of 10 (>=10) as round', () => {
    expect(isRoundAmount(100)).toBe(true);
    expect(isRoundAmount(1000)).toBe(true);
    expect(isRoundAmount(103)).toBe(false);
    expect(isRoundAmount(5)).toBe(false);
  });
  it('computes the share of round-amount hops', () => {
    const hops = [hop({ amount: '100' }), hop({ amount: '103' }), hop({ amount: '500' }), hop({ amount: '7' })];
    expect(roundAmountRatio(hops)).toBe(0.5);
  });
});

describe('burstTxPerHour', () => {
  it('finds the peak rolling 1-hour transaction count', () => {
    const hops = [hop({ ts: T0 }), hop({ ts: T0 + 10 * 60_000 }), hop({ ts: T0 + 50 * 60_000 }), hop({ ts: T0 + 3 * 3_600_000 })];
    expect(burstTxPerHour(hops)).toBe(3); // first three all within 1 hour of each other
  });
});

describe('ageAtTaintDays', () => {
  it('computes age in days between account creation and first taint', () => {
    expect(ageAtTaintDays(T0 - 2 * 86_400_000, T0)).toBe(2);
  });
  it('is null when either timestamp is missing', () => {
    expect(ageAtTaintDays(null, T0)).toBeNull();
    expect(ageAtTaintDays(T0, null)).toBeNull();
  });
});
