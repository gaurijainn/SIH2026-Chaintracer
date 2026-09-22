import { describe, expect, it, vi } from 'vitest';
import { findSharedMules, persistSharedMuleFlags, type SharedMulePrisma } from './crossCase';

describe('findSharedMules', () => {
  it('flags an address that touches two or more distinct cases', () => {
    const rows = [
      { chain: 'TRON' as const, addr: 'W1', caseId: 'caseA' },
      { chain: 'TRON' as const, addr: 'W1', caseId: 'caseB' },
      { chain: 'TRON' as const, addr: 'W2', caseId: 'caseA' },
    ];
    const shared = findSharedMules(rows);
    expect(shared).toEqual([{ chain: 'TRON', addr: 'W1', caseCount: 2, caseIds: ['caseA', 'caseB'] }]);
  });

  it('does not flag an address touching only one case', () => {
    expect(findSharedMules([{ chain: 'TRON', addr: 'W1', caseId: 'caseA' }])).toEqual([]);
  });

  it('deduplicates repeated (chain, addr, caseId) touches without inflating the case count', () => {
    const rows = [
      { chain: 'TRON' as const, addr: 'W1', caseId: 'caseA' },
      { chain: 'TRON' as const, addr: 'W1', caseId: 'caseA' },
      { chain: 'TRON' as const, addr: 'W1', caseId: 'caseB' },
    ];
    expect(findSharedMules(rows)).toEqual([{ chain: 'TRON', addr: 'W1', caseCount: 2, caseIds: ['caseA', 'caseB'] }]);
  });

  it('keeps chains separate: the same address string on two chains is not conflated', () => {
    const rows = [
      { chain: 'TRON' as const, addr: 'SAME', caseId: 'caseA' },
      { chain: 'ETH' as const, addr: 'SAME', caseId: 'caseB' },
    ];
    expect(findSharedMules(rows)).toEqual([]);
  });
});

describe('persistSharedMuleFlags', () => {
  it('upserts each candidate by (chain, addr), and reruns are idempotent', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const prisma: SharedMulePrisma = { sharedMuleFlag: { upsert } };
    const candidates = [{ chain: 'TRON' as const, addr: 'W1', caseCount: 2, caseIds: ['caseA', 'caseB'] }];

    await persistSharedMuleFlags({ prisma }, candidates);
    await persistSharedMuleFlags({ prisma }, candidates);

    expect(upsert).toHaveBeenCalledTimes(2);
    for (const call of upsert.mock.calls) {
      expect(call[0]).toMatchObject({ where: { chain_addr: { chain: 'TRON', addr: 'W1' } }, create: { caseCount: 2, caseIds: ['caseA', 'caseB'] } });
    }
  });
});
