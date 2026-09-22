import { describe, expect, it, vi } from 'vitest';
import { persistMuleFlag, persistMuleFlags, type MulePrisma } from './persist';
import type { MuleFlagResult } from './types';

describe('persistMuleFlag', () => {
  it('upserts one row keyed by (chain, addr, rule) with confidence, evidence and traceId', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const prisma: MulePrisma = { muleFlag: { upsert } };
    const flag: MuleFlagResult = { chain: 'TRON', addr: 'W1', rule: 'PASS_THROUGH', confidence: 0.8, evidence: { ratio: 1 } };

    await persistMuleFlag({ prisma }, flag, 'trace-1');

    expect(upsert).toHaveBeenCalledWith({
      where: { chain_addr_rule: { chain: 'TRON', addr: 'W1', rule: 'PASS_THROUGH' } },
      create: { chain: 'TRON', addr: 'W1', rule: 'PASS_THROUGH', confidence: 0.8, evidence: { ratio: 1 }, traceId: 'trace-1' },
      update: { confidence: 0.8, evidence: { ratio: 1 }, traceId: 'trace-1' },
    });
  });

  it('re-running with fresh evidence for the same (chain, addr, rule) still only ever targets one row (idempotent rerun)', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const prisma: MulePrisma = { muleFlag: { upsert } };
    const flag: MuleFlagResult = { chain: 'TRON', addr: 'W1', rule: 'FAN_OUT', confidence: 0.85, evidence: { distinctRecipients: 5 } };

    await persistMuleFlag({ prisma }, flag);
    await persistMuleFlag({ prisma }, { ...flag, evidence: { distinctRecipients: 7 } });

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0][0].where).toEqual(upsert.mock.calls[1][0].where);
    expect(upsert.mock.calls[1][0].update.evidence).toEqual({ distinctRecipients: 7 });
  });
});

describe('persistMuleFlags', () => {
  it('persists every flag in the list', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const prisma: MulePrisma = { muleFlag: { upsert } };
    const flags: MuleFlagResult[] = [
      { chain: 'TRON', addr: 'W1', rule: 'PASS_THROUGH', confidence: 0.8, evidence: {} },
      { chain: 'TRON', addr: 'W1', rule: 'FRESH_WALLET', confidence: 0.75, evidence: {} },
    ];
    await persistMuleFlags({ prisma }, flags);
    expect(upsert).toHaveBeenCalledTimes(2);
  });
});
