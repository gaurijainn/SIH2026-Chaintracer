import { describe, expect, it } from 'vitest';
import type { AccountMeta, Transfer } from '@ps26183/shared';
import { attributeAddress } from './attribute';

const T0 = Date.UTC(2026, 8, 1);
const xfer = (over: Partial<Transfer>): Transfer => ({ chain: 'TRON', txHash: 'tx', idx: 1, from: 'F', to: 'T', token: 'USDT', amount: '0', usd: 0, ts: T0, block: 0, ...over });

describe('attributeAddress', () => {
  it('returns no candidates when nothing fires', () => {
    expect(attributeAddress({ chain: 'ETH', addr: 'A' })).toEqual([]);
  });

  it('returns a single candidate from one fired heuristic, confidence equal to its own', () => {
    const candidates = attributeAddress({
      chain: 'ETH',
      addr: 'A',
      directLabels: [{ addr: 'A', vaspId: 'v1', vaspName: 'Exchange One', confidence: 0.8, source: 'eth-labels', name: 'x' }],
    });
    expect(candidates).toEqual([{ chain: 'ETH', addr: 'A', vaspId: 'v1', vaspName: 'Exchange One', confidence: 0.8, heuristics: expect.any(Array) }]);
    expect(candidates[0].heuristics).toHaveLength(1);
    expect(candidates[0].heuristics[0].code).toBe('H4_DIRECT_LABEL');
  });

  it('combines H1 and H4 for the same VASP with noisy-OR, higher than either alone', () => {
    const candidates = attributeAddress({
      chain: 'TRON',
      addr: 'A',
      inflows: [xfer({ from: 's1', usd: 500 }), xfer({ from: 's2', usd: 500, ts: T0 + 1000 })],
      outflows: [xfer({ to: 'HW', usd: 1000, ts: T0 + 2000 })],
      knownHotWallets: [{ addr: 'HW', vaspId: 'v1', vaspName: 'Exchange One' }],
      directLabels: [{ addr: 'A', vaspId: 'v1', vaspName: 'Exchange One', confidence: 0.5, source: 'manual', name: 'x' }],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].heuristics.map((h) => h.code).sort()).toEqual(['H1_DEPOSIT_SWEEP', 'H4_DIRECT_LABEL']);
    expect(candidates[0].confidence).toBeGreaterThan(0.9); // 1 - (1-0.9)*(1-0.5) = 0.95
  });

  it('keeps competing VASP candidates separate and ranks the higher-confidence one first', () => {
    const meta: AccountMeta = { chain: 'TRON', addr: 'A', createdAt: 0, activator: 'ACT2', publicTag: null, flags: {}, sources: [], fetchedAt: 0 };
    const candidates = attributeAddress({
      chain: 'TRON',
      addr: 'A',
      accountMeta: meta,
      knownActivators: [{ addr: 'ACT2', vaspId: 'v2', vaspName: 'Exchange Two' }],
      directLabels: [{ addr: 'A', vaspId: 'v1', vaspName: 'Exchange One', confidence: 0.9, source: 'manual', name: 'x' }],
    });
    expect(candidates.map((c) => c.vaspId)).toEqual(['v1', 'v2']); // v1's 0.9 (H4) beats v2's 0.6 (H2)
  });

  it('never fires H1 when transfer data is missing (avoids a false "no evidence" match)', () => {
    expect(attributeAddress({ chain: 'ETH', addr: 'A', knownHotWallets: [{ addr: 'HW', vaspId: 'v1', vaspName: 'X' }] })).toEqual([]);
  });
});
