import { describe, expect, it } from 'vitest';
import { detectMuleActivity } from './detect';
import type { HopLike } from './types';

const T0 = Date.UTC(2026, 8, 1);
const hop = (over: Partial<HopLike>): HopLike => ({ txHash: 'tx', idx: 0, fromAddr: 'F', toAddr: 'T', token: 'USDT', amount: '0', usd: 0, ts: T0, ...over });

describe('detectMuleActivity', () => {
  it('fires multiple independent rules on the same wallet (pass-through + fresh wallet)', () => {
    const inbound = [hop({ usd: 1000, ts: T0 })];
    const outbound = [hop({ usd: 990, ts: T0 + 20 * 60_000 })]; // ~1% off, 20 min dwell -> pass-through
    const results = detectMuleActivity({
      chain: 'TRON',
      addr: 'W1',
      inbound,
      outbound,
      accountCreatedAtMs: T0 - 2 * 86_400_000, // 2 days old -> fresh wallet
      firstTaintedAtMs: T0,
    });
    const rules = results.map((r) => r.rule).sort();
    expect(rules).toEqual(['FRESH_WALLET', 'PASS_THROUGH']);
    expect(results.every((r) => r.chain === 'TRON' && r.addr === 'W1')).toBe(true);
  });

  it('fires TRX-dust USDT alongside fan-out when trxDust input is supplied', () => {
    const inbound = [hop({ usd: 500, ts: T0 })];
    const outbound = Array.from({ length: 5 }, (_, i) => hop({ txHash: `o${i}`, toAddr: `R${i}`, usd: 90, ts: T0 + (i + 1) * 60_000 }));
    const results = detectMuleActivity({
      chain: 'TRON',
      addr: 'W2',
      inbound,
      outbound,
      accountCreatedAtMs: null,
      firstTaintedAtMs: T0,
      trxDust: { chain: 'TRON', trxBalance: 0.2, usdtBalance: 500, energyDelegated: true },
    });
    expect(results.map((r) => r.rule).sort()).toEqual(['FAN_OUT', 'TRX_DUST_USDT']);
  });

  it('returns no flags for ordinary activity that matches no rule', () => {
    const inbound = [hop({ usd: 1000, ts: T0 })];
    const outbound = [hop({ usd: 200, ts: T0 + 5 * 86_400_000 })]; // most of the value kept, days later
    const results = detectMuleActivity({ chain: 'ETH', addr: 'W3', inbound, outbound, accountCreatedAtMs: T0 - 365 * 86_400_000, firstTaintedAtMs: T0 });
    expect(results).toEqual([]);
  });

  it('picks the strongest fan-out match when more than one inbound event qualifies', () => {
    const inbound = [hop({ txHash: 'in1', ts: T0 }), hop({ txHash: 'in2', ts: T0 + 5 * 60_000 })];
    const outbound = [
      ...Array.from({ length: 5 }, (_, i) => hop({ txHash: `a${i}`, toAddr: `RA${i}`, ts: T0 + 10 * 60_000 })), // 5 recipients after in1
      ...Array.from({ length: 8 }, (_, i) => hop({ txHash: `b${i}`, toAddr: `RB${i}`, ts: T0 + 8 * 60_000 })), // 8+5=13 recipients after in2 (also within in1's window)
    ];
    const [fanOut] = detectMuleActivity({ chain: 'ETH', addr: 'W4', inbound, outbound, accountCreatedAtMs: null, firstTaintedAtMs: T0 });
    expect(fanOut.rule).toBe('FAN_OUT');
    expect((fanOut.evidence as { distinctRecipients: number }).distinctRecipients).toBeGreaterThanOrEqual(8);
  });
});
