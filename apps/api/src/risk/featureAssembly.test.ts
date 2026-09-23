import { describe, expect, it, vi } from 'vitest';
import { assembleAddressFeatures, type FeatureAssemblyPrisma } from './featureAssembly';
import { TraceNotFoundError } from './errors';

const T0 = Date.UTC(2026, 8, 1);

function decimal(v: string) {
  return { toFixed: () => v };
}

function makePrisma(overrides: Partial<FeatureAssemblyPrisma> = {}): FeatureAssemblyPrisma {
  return {
    traceJob: { findUnique: vi.fn().mockResolvedValue(null) },
    hop: { findMany: vi.fn().mockResolvedValue([]) },
    addressProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    label: { findMany: vi.fn().mockResolvedValue([]) },
    muleFlag: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    complaint: { findFirst: vi.fn().mockResolvedValue(null) },
    ...overrides,
  } as FeatureAssemblyPrisma;
}

describe('assembleAddressFeatures — no traceId', () => {
  it('nulls/zeros the case-scoped fields and derives the rest from all-history hops for the address', async () => {
    const hopRows = [
      { chain: 'TRON', txHash: 'tx1', idx: 0, fromAddr: 'S1', toAddr: 'W1', token: 'USDT', amount: decimal('100'), usd: decimal('100'), ts: new Date(T0) },
      { chain: 'TRON', txHash: 'tx2', idx: 0, fromAddr: 'W1', toAddr: 'D1', token: 'USDT', amount: decimal('95'), usd: decimal('95'), ts: new Date(T0 + 600_000) },
    ];
    const prisma = makePrisma({
      hop: { findMany: vi.fn().mockResolvedValue(hopRows) } as never,
      label: { findMany: vi.fn().mockResolvedValue([{ addr: 'W1', category: 'reported', name: 'Tronscan: fraud-transaction flag' }]) } as never,
    });

    const result = await assembleAddressFeatures({ prisma }, 'TRON', 'W1');

    expect(prisma.traceJob.findUnique).not.toHaveBeenCalled();
    expect(prisma.hop.findMany).toHaveBeenCalledWith({
      where: { chain: 'TRON', OR: [{ fromAddr: 'W1' }, { toAddr: 'W1' }] },
      orderBy: { ts: 'asc' },
    });

    expect(result.features.hops_from_victim).toBeNull();
    expect(result.features.hops_to_vasp).toBeNull();
    expect(result.features.shared_mule_cps).toBe(0);
    expect(result.features.cross_case_count).toBe(0);
    expect(result.features.external_flags).toEqual(['reported']);
    expect(result.features.fan_out_1h).toBeGreaterThanOrEqual(0);
    expect(result.typologyContext.caseFeatures).toEqual({});
    expect(result.typologyContext.complaintCategory).toBeUndefined();
  });

  it('leaves sanction/blacklist evidence undefined when no matching label exists', async () => {
    const prisma = makePrisma();
    const result = await assembleAddressFeatures({ prisma }, 'TRON', 'W1');
    expect(result.evidence).toEqual({});
  });
});

describe('assembleAddressFeatures — with traceId', () => {
  it('throws TraceNotFoundError when the traceId does not exist', async () => {
    const prisma = makePrisma({ traceJob: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(assembleAddressFeatures({ prisma }, 'TRON', 'W1', 'missing-trace')).rejects.toBeInstanceOf(TraceNotFoundError);
  });

  it('derives hopsFromVictim/hopsToVasp/sharedMuleCps/crossCaseCount from the trace graph', async () => {
    const trace = { id: 'trace-1', seedChain: 'TRON', seedAddr: 'VICTIM', caseId: 'case-1' };
    const hopRows = [
      { chain: 'TRON', txHash: 'tx1', idx: 0, fromAddr: 'VICTIM', toAddr: 'W1', token: 'USDT', amount: decimal('100'), usd: decimal('100'), ts: new Date(T0) },
      { chain: 'TRON', txHash: 'tx2', idx: 0, fromAddr: 'W1', toAddr: 'VASP1', token: 'USDT', amount: decimal('95'), usd: decimal('95'), ts: new Date(T0 + 600_000) },
    ];
    const crossCaseHops = [
      { trace: { caseId: 'case-1' } },
      { trace: { caseId: 'case-2' } },
    ];

    const hopFindMany = vi.fn(async (args: { where: Record<string, unknown>; include?: unknown }) => {
      if (args.include) return crossCaseHops;
      return hopRows;
    });
    const labelFindMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
      const where = args.where as { addr?: string; OR?: { addr: string }[] };
      if (where.OR) {
        return [{ addr: 'VASP1', category: 'exchange', name: 'Some VASP' }];
      }
      return [];
    });
    const muleFlagFindMany = vi.fn().mockResolvedValue([{ addr: 'VICTIM' }]);

    const prisma = makePrisma({
      traceJob: { findUnique: vi.fn().mockResolvedValue(trace) },
      hop: { findMany: hopFindMany } as never,
      label: { findMany: labelFindMany } as never,
      muleFlag: { findMany: muleFlagFindMany, findFirst: vi.fn().mockResolvedValue(null) },
      complaint: { findFirst: vi.fn().mockResolvedValue({ category: 'Investment or trading fraud' }) },
    });

    const result = await assembleAddressFeatures({ prisma }, 'TRON', 'W1', 'trace-1');

    expect(result.features.hops_from_victim).toBe(1);
    expect(result.features.hops_to_vasp).toBe(1);
    expect(result.features.shared_mule_cps).toBe(1); // VICTIM is a counterparty and has a mule flag
    expect(result.features.cross_case_count).toBe(2); // case-1 and case-2
    expect(result.typologyContext.complaintCategory).toBe('Investment or trading fraud');
  });

  it('sets bitcoin_heavy in typologyContext only for BTC, never fabricated false for other chains', async () => {
    const trace = { id: 'trace-1', seedChain: 'BTC', seedAddr: 'VICTIM', caseId: 'case-1' };
    const prisma = makePrisma({ traceJob: { findUnique: vi.fn().mockResolvedValue(trace) } });
    const result = await assembleAddressFeatures({ prisma }, 'BTC', 'W1', 'trace-1');
    expect(result.typologyContext.caseFeatures.bitcoin_heavy).toBe(true);

    const traceTron = { id: 'trace-2', seedChain: 'TRON', seedAddr: 'VICTIM', caseId: 'case-1' };
    const prismaTron = makePrisma({ traceJob: { findUnique: vi.fn().mockResolvedValue(traceTron) } });
    const resultTron = await assembleAddressFeatures({ prisma: prismaTron }, 'TRON', 'W1', 'trace-2');
    expect(resultTron.typologyContext.caseFeatures.bitcoin_heavy).toBeUndefined();
  });

  it('marks trxDustUsdt true only when a persisted MuleFlag TRX_DUST_USDT row already exists', async () => {
    const trace = { id: 'trace-1', seedChain: 'TRON', seedAddr: 'VICTIM', caseId: 'case-1' };
    const prisma = makePrisma({
      traceJob: { findUnique: vi.fn().mockResolvedValue(trace) },
      muleFlag: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue({ id: 'flag-1' }) },
    });
    const result = await assembleAddressFeatures({ prisma }, 'TRON', 'W1', 'trace-1');
    expect(result.features.trx_dust_usdt).toBe(true);
  });
});
