import { describe, expect, it, vi } from 'vitest';
import { InvalidAddressError, WatchlistNotFoundError } from './errors';
import { WatchlistService } from './service';

const VALID_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const VALID_ETH = '0x1234567890123456789012345678901234567890';

function fakePrisma() {
  const rows: { id: string; caseId: string; chain: string; addr: string; reason: string; tier: string }[] = [];
  let seq = 0;
  return {
    prisma: {
      watchlistItem: {
        findMany: vi.fn(async ({ where }: { where?: { caseId?: string } }) => rows.filter((r) => !where?.caseId || r.caseId === where.caseId)),
        upsert: vi.fn(async ({ where, create }: { where: { caseId_chain_addr: { caseId: string; chain: string; addr: string } }; create: Record<string, unknown> }) => {
          const existing = rows.find((r) => r.caseId === where.caseId_chain_addr.caseId && r.chain === where.caseId_chain_addr.chain && r.addr === where.caseId_chain_addr.addr);
          if (existing) return existing;
          const row = { id: `w${++seq}`, caseId: create.caseId as string, chain: create.chain as string, addr: create.addr as string, reason: create.reason as string, tier: create.tier as string };
          rows.push(row);
          return row;
        }),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          const idx = rows.findIndex((r) => r.id === where.id);
          if (idx === -1) throw new Error('not found');
          rows.splice(idx, 1);
        }),
      },
    } as never,
    rows,
  };
}

describe('WatchlistService.create', () => {
  it('adds a valid TRON address with reason defaulting to manual and tier defaulting to HOT', async () => {
    const { prisma, rows } = fakePrisma();
    const service = new WatchlistService({ prisma });
    const item = await service.create({ caseId: 'case1', chain: 'TRON', addr: VALID_TRON });
    expect(item.reason).toBe('manual');
    expect(item.tier).toBe('HOT');
    expect(rows).toHaveLength(1);
  });

  it('normalizes an EVM address to its checksummed form', async () => {
    const { prisma } = fakePrisma();
    const service = new WatchlistService({ prisma });
    const item = await service.create({ caseId: 'case1', chain: 'ETH', addr: VALID_ETH.toLowerCase() });
    expect(item.addr).toBe(VALID_ETH);
  });

  it('rejects a malformed address with InvalidAddressError', async () => {
    const { prisma } = fakePrisma();
    const service = new WatchlistService({ prisma });
    await expect(service.create({ caseId: 'case1', chain: 'TRON', addr: 'not-an-address' })).rejects.toThrow(InvalidAddressError);
  });

  it('rejects an address whose family does not match the given chain (e.g. an EVM address on TRON)', async () => {
    const { prisma } = fakePrisma();
    const service = new WatchlistService({ prisma });
    await expect(service.create({ caseId: 'case1', chain: 'TRON', addr: VALID_ETH })).rejects.toThrow(InvalidAddressError);
  });

  it('is idempotent: adding the same (case, chain, addr) twice does not create a duplicate row', async () => {
    const { prisma, rows } = fakePrisma();
    const service = new WatchlistService({ prisma });
    await service.create({ caseId: 'case1', chain: 'TRON', addr: VALID_TRON });
    await service.create({ caseId: 'case1', chain: 'TRON', addr: VALID_TRON, reason: 'mule' });
    expect(rows).toHaveLength(1);
  });
});

describe('WatchlistService.list/remove', () => {
  it('lists only rows for the given caseId when supplied', async () => {
    const { prisma } = fakePrisma();
    const service = new WatchlistService({ prisma });
    await service.create({ caseId: 'case1', chain: 'TRON', addr: VALID_TRON });
    await service.create({ caseId: 'case2', chain: 'ETH', addr: VALID_ETH });
    expect(await service.list('case1')).toHaveLength(1);
    expect(await service.list()).toHaveLength(2);
  });

  it('remove() on an unknown id throws WatchlistNotFoundError', async () => {
    const { prisma } = fakePrisma();
    const service = new WatchlistService({ prisma });
    await expect(service.remove('nope')).rejects.toThrow(WatchlistNotFoundError);
  });
});
