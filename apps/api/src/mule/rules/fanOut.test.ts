import { describe, expect, it } from 'vitest';
import type { HopLike } from '../types';
import { detectFanOut } from './fanOut';

const T0 = Date.UTC(2026, 8, 1);
const hop = (over: Partial<HopLike>): HopLike => ({ txHash: 'tx', idx: 0, fromAddr: 'F', toAddr: 'T', token: 'USDT', amount: '10', usd: 10, ts: T0, ...over });

describe('detectFanOut', () => {
  it('fires when an inbound is followed by 5+ distinct outputs within the window', () => {
    const inbound = [hop({ txHash: 'in1', ts: T0 })];
    const outbound = Array.from({ length: 5 }, (_, i) => hop({ txHash: `out${i}`, toAddr: `R${i}`, ts: T0 + (i + 1) * 60_000 }));
    const [m] = detectFanOut(inbound, outbound);
    expect(m).toMatchObject({ confidence: 0.85 });
    expect(m.evidence).toMatchObject({ triggerTxHash: 'in1', distinctRecipients: 5 });
  });

  it('does not fire with only 4 distinct outputs', () => {
    const inbound = [hop({ txHash: 'in1', ts: T0 })];
    const outbound = Array.from({ length: 4 }, (_, i) => hop({ txHash: `out${i}`, toAddr: `R${i}`, ts: T0 + 60_000 }));
    expect(detectFanOut(inbound, outbound)).toEqual([]);
  });

  it('does not count outputs outside the 1-hour window', () => {
    const inbound = [hop({ txHash: 'in1', ts: T0 })];
    const outbound = [
      ...Array.from({ length: 4 }, (_, i) => hop({ txHash: `out${i}`, toAddr: `R${i}`, ts: T0 + 30 * 60_000 })),
      hop({ txHash: 'late', toAddr: 'R5', ts: T0 + 90 * 60_000 }), // outside the 60-min window
    ];
    expect(detectFanOut(inbound, outbound)).toEqual([]);
  });

  it('does not count repeated transfers to the same recipient as distinct outputs', () => {
    const inbound = [hop({ txHash: 'in1', ts: T0 })];
    const outbound = Array.from({ length: 5 }, (_, i) => hop({ txHash: `out${i}`, toAddr: 'SAME', ts: T0 + (i + 1) * 60_000 }));
    expect(detectFanOut(inbound, outbound)).toEqual([]);
  });

  it('does not count an outflow that happened before the inbound', () => {
    const inbound = [hop({ txHash: 'in1', ts: T0 + 100_000 })];
    const outbound = Array.from({ length: 5 }, (_, i) => hop({ txHash: `out${i}`, toAddr: `R${i}`, ts: T0 })); // before inbound
    expect(detectFanOut(inbound, outbound)).toEqual([]);
  });

  it('respects a configured minDistinctOutputs override', () => {
    const inbound = [hop({ txHash: 'in1', ts: T0 })];
    const outbound = Array.from({ length: 3 }, (_, i) => hop({ txHash: `out${i}`, toAddr: `R${i}`, ts: T0 + 60_000 }));
    expect(detectFanOut(inbound, outbound, { minDistinctOutputs: 3, windowMinutes: 60 })).toHaveLength(1);
  });
});
