import { describe, expect, it, vi } from 'vitest';
import { lookupSanctionEvidence, type SanctionLookupPrisma } from './sanctionLookup';

describe('lookupSanctionEvidence', () => {
  it('returns sanctioned: true when a Label row has category "sanctioned"', async () => {
    const findMany = vi.fn().mockResolvedValue([{ category: 'sanctioned', name: 'OFAC SDN' }]);
    const prisma: SanctionLookupPrisma = { label: { findMany } };
    const evidence = await lookupSanctionEvidence({ prisma }, 'TRON', 'TX1');
    expect(evidence).toEqual({ sanctioned: true });
    expect(findMany).toHaveBeenCalledWith({ where: { chain: 'TRON', addr: 'TX1' } });
  });

  it('returns stablecoinBlacklisted: true only for the exact tronscan.ts evidence shape (category high_risk + Tether name)', async () => {
    const findMany = vi.fn().mockResolvedValue([{ category: 'high_risk', name: 'Tether: stablecoin blacklist' }]);
    const prisma: SanctionLookupPrisma = { label: { findMany } };
    const evidence = await lookupSanctionEvidence({ prisma }, 'TRON', 'TX1');
    expect(evidence).toEqual({ stablecoinBlacklisted: true });
  });

  it('does not fire stablecoinBlacklisted for an unrelated high_risk label', async () => {
    const findMany = vi.fn().mockResolvedValue([{ category: 'high_risk', name: 'Tronscan: memo-spam flag' }]);
    const prisma: SanctionLookupPrisma = { label: { findMany } };
    const evidence = await lookupSanctionEvidence({ prisma }, 'TRON', 'TX1');
    expect(evidence).toEqual({});
  });

  it('leaves both fields undefined (unknown), never false, when there is no matching label at all', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma: SanctionLookupPrisma = { label: { findMany } };
    const evidence = await lookupSanctionEvidence({ prisma }, 'TRON', 'TX1');
    expect(evidence.sanctioned).toBeUndefined();
    expect(evidence.stablecoinBlacklisted).toBeUndefined();
    expect('sanctioned' in evidence).toBe(false);
    expect('stablecoinBlacklisted' in evidence).toBe(false);
  });

  it('can return both flags true at once', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { category: 'sanctioned', name: 'OFAC SDN' },
      { category: 'high_risk', name: 'Tether: stablecoin blacklist' },
    ]);
    const prisma: SanctionLookupPrisma = { label: { findMany } };
    const evidence = await lookupSanctionEvidence({ prisma }, 'TRON', 'TX1');
    expect(evidence).toEqual({ sanctioned: true, stablecoinBlacklisted: true });
  });
});
