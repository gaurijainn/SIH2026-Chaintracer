import { describe, expect, it } from 'vitest';
import type { Transfer } from '@ps26183/shared';
import { detectDepositSweep, type KnownHotWallet } from './depositSweep';

const T0 = Date.UTC(2026, 8, 1);
const xfer = (over: Partial<Transfer>): Transfer => ({ chain: 'ETH', txHash: 'tx', idx: 1, from: 'F', to: 'T', token: 'USDT', amount: '0', usd: 0, ts: T0, block: 0, ...over });
const HW: KnownHotWallet = { addr: 'HW', vaspId: 'v1', vaspName: 'Some Exchange' };

describe('detectDepositSweep (H1)', () => {
  it('fires when >=2 unrelated senders and >=95% is forwarded to a known hot wallet within 24h', () => {
    const inflows = [xfer({ from: 's1', usd: 500, ts: T0 }), xfer({ from: 's2', usd: 500, ts: T0 + 1000 })];
    const outflows = [xfer({ to: 'HW', usd: 1000, ts: T0 + 60_000, txHash: 'sweep' })];
    const [m] = detectDepositSweep(inflows, outflows, [HW]);
    expect(m).toMatchObject({ vaspId: 'v1', vaspName: 'Some Exchange', confidence: 0.9 });
    expect(m.evidence).toMatchObject({ unrelatedSenders: 2, forwardedRatio: 1, forwardTxHashes: ['sweep'] });
  });

  it('does not fire with only a single sender', () => {
    const inflows = [xfer({ from: 's1', usd: 1000, ts: T0 })];
    const outflows = [xfer({ to: 'HW', usd: 1000, ts: T0 + 1000 })];
    expect(detectDepositSweep(inflows, outflows, [HW])).toEqual([]);
  });

  it('does not fire below the 95% forwarded threshold', () => {
    const inflows = [xfer({ from: 's1', usd: 500 }), xfer({ from: 's2', usd: 500, ts: T0 + 1000 })];
    const outflows = [xfer({ to: 'HW', usd: 940, ts: T0 + 2000 })]; // 94%
    expect(detectDepositSweep(inflows, outflows, [HW])).toEqual([]);
  });

  it('does not fire when the forward happens more than 24 hours after the first inflow', () => {
    const inflows = [xfer({ from: 's1', usd: 500 }), xfer({ from: 's2', usd: 500, ts: T0 + 1000 })];
    const outflows = [xfer({ to: 'HW', usd: 1000, ts: T0 + 25 * 3_600_000 })];
    expect(detectDepositSweep(inflows, outflows, [HW])).toEqual([]);
  });

  it('ignores an outflow to an address that is not a known hot wallet', () => {
    const inflows = [xfer({ from: 's1', usd: 500 }), xfer({ from: 's2', usd: 500, ts: T0 + 1000 })];
    const outflows = [xfer({ to: 'SOMEONE_ELSE', usd: 1000, ts: T0 + 2000 })];
    expect(detectDepositSweep(inflows, outflows, [HW])).toEqual([]);
  });

  it('sums multiple outgoing transfers to the same hot wallet toward the 95% ratio', () => {
    const inflows = [xfer({ from: 's1', usd: 500 }), xfer({ from: 's2', usd: 500, ts: T0 + 1000 })];
    const outflows = [xfer({ to: 'HW', usd: 500, ts: T0 + 2000, txHash: 'a' }), xfer({ to: 'HW', usd: 500, ts: T0 + 3000, txHash: 'b' })];
    const [m] = detectDepositSweep(inflows, outflows, [HW]);
    expect(m.evidence.forwardTxHashes.sort()).toEqual(['a', 'b']);
  });

  it('picks the wallet that clears 95% and ignores a small dust transfer to a second known wallet', () => {
    const HW2: KnownHotWallet = { addr: 'HW2', vaspId: 'v2', vaspName: 'Other Exchange' };
    const inflows = [xfer({ from: 's1', usd: 500 }), xfer({ from: 's2', usd: 500, ts: T0 + 1000 })];
    const outflows = [xfer({ to: 'HW', usd: 970, ts: T0 + 2000 }), xfer({ to: 'HW2', usd: 30, ts: T0 + 2000 })];
    const matches = detectDepositSweep(inflows, outflows, [HW, HW2]);
    expect(matches).toHaveLength(1);
    expect(matches[0].vaspId).toBe('v1');
  });
});
