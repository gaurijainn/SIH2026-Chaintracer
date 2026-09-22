import { describe, expect, it } from 'vitest';
import { FIU_IND_INSTANT_SWAP_SEED, loadVaspRegistrySeed, upsertVasp, type VaspPrisma } from './vaspRegistry';

function fakePrisma() {
  const vasps = new Map<string, Record<string, unknown> & { id: string }>();
  const addresses = new Map<string, Record<string, unknown>>();
  let n = 0;
  const prisma: VaspPrisma = {
    vasp: {
      async upsert({ where, create, update }) {
        const existing = vasps.get(where.name);
        const row = existing ? { ...existing, ...update } : { id: `v${++n}`, name: where.name, ...create };
        vasps.set(where.name, row as never);
        return row;
      },
    },
    vaspAddress: {
      async upsert({ where, create, update }) {
        const k = `${where.chain_addr.chain}|${where.chain_addr.addr}`;
        addresses.set(k, addresses.has(k) ? { ...addresses.get(k), ...update } : create);
        return addresses.get(k);
      },
    },
  };
  return { prisma, vasps, addresses };
}

describe('upsertVasp', () => {
  it('creates a VASP with its FIU-IND status and date', async () => {
    const { prisma, vasps } = fakePrisma();
    await upsertVasp(prisma, { name: 'ChangeNow', type: 'INSTANT_SWAP', jurisdiction: 'Offshore', fiuStatus: 'NOTICED', fiuStatusDate: '2026-09-09', fiuSource: 'FIU-IND' });
    expect(vasps.get('ChangeNow')).toMatchObject({ type: 'INSTANT_SWAP', fiuStatus: 'NOTICED', fiuSource: 'FIU-IND' });
  });

  it('is idempotent: upserting the same name twice does not create a second row', async () => {
    const { prisma, vasps } = fakePrisma();
    await upsertVasp(prisma, { name: 'X', type: 'CENTRALISED_EXCHANGE', jurisdiction: 'IN', fiuStatus: 'REGISTERED' });
    await upsertVasp(prisma, { name: 'X', type: 'CENTRALISED_EXCHANGE', jurisdiction: 'IN', fiuStatus: 'REGISTERED' });
    expect(vasps.size).toBe(1);
  });

  it('upserts hot wallets per chain under the VASP', async () => {
    const { prisma, addresses } = fakePrisma();
    await upsertVasp(prisma, {
      name: 'X',
      type: 'CENTRALISED_EXCHANGE',
      jurisdiction: 'IN',
      fiuStatus: 'REGISTERED',
      hotWallets: [{ chain: 'TRON', addr: 'THOT', source: 'manual', confidence: 1 }],
    });
    expect(addresses.get('TRON|THOT')).toMatchObject({ chain: 'TRON', addr: 'THOT', kind: 'HOT_WALLET' });
  });
});

describe('FIU_IND_INSTANT_SWAP_SEED', () => {
  it('names exactly the three instant-swap providers the plan calls out, all distinguishable from centralised exchanges', () => {
    expect(FIU_IND_INSTANT_SWAP_SEED.map((v) => v.name).sort()).toEqual(['ChangeNow', 'FixedFloat', 'SimpleSwap']);
    expect(FIU_IND_INSTANT_SWAP_SEED.every((v) => v.type === 'INSTANT_SWAP')).toBe(true);
  });
});

describe('loadVaspRegistrySeed', () => {
  it('loads every seed entry and returns the count', async () => {
    const { prisma, vasps } = fakePrisma();
    const n = await loadVaspRegistrySeed(prisma);
    expect(n).toBe(3);
    expect(vasps.size).toBe(3);
  });
});
