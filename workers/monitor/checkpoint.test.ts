import { describe, expect, it } from 'vitest';
import { advanceCheckpoint, findDueTronAddresses, type CheckpointRow, type MonitorPrisma, type WatchTier } from './checkpoint';
import { DEFAULT_MONITOR_CONFIG } from './config';

function fakePrisma(items: { caseId: string; chain: string; addr: string; tier: WatchTier; reason: string }[], checkpoints: CheckpointRow[]): MonitorPrisma {
  const cpStore = new Map(checkpoints.map((c) => [`${c.chain}:${c.addr}`, c]));
  return {
    watchlistItem: {
      findMany: async ({ where }) => items.filter((i) => i.chain === where.chain).map((i) => ({ id: `${i.caseId}-${i.addr}`, ...i })),
    },
    monitorCheckpoint: {
      findMany: async ({ where }) => where.addr.in.map((a) => cpStore.get(`${where.chain}:${a}`)).filter((c): c is CheckpointRow => !!c),
      upsert: async ({ create }) => {
        cpStore.set(`${create.chain}:${create.addr}`, { chain: create.chain as string, addr: create.addr as string, lastCheckedAt: create.lastCheckedAt as Date, lastCursor: (create.lastCursor as string) ?? null });
      },
    },
  };
}

describe('findDueTronAddresses', () => {
  it('is due on first poll (no checkpoint yet)', async () => {
    const prisma = fakePrisma([{ caseId: 'case1', chain: 'TRON', addr: 'Taddr1', tier: 'HOT', reason: 'manual' }], []);
    const due = await findDueTronAddresses(prisma, Date.now());
    expect(due).toHaveLength(1);
    expect(due[0].addr).toBe('Taddr1');
    expect(due[0].caseIds).toEqual(['case1']);
  });

  it('is NOT due when the HOT interval has not elapsed', async () => {
    const now = 1_700_000_000_000;
    const prisma = fakePrisma(
      [{ caseId: 'case1', chain: 'TRON', addr: 'Taddr1', tier: 'HOT', reason: 'manual' }],
      [{ chain: 'TRON', addr: 'Taddr1', lastCheckedAt: new Date(now - 5_000), lastCursor: null }],
    );
    const due = await findDueTronAddresses(prisma, now);
    expect(due).toHaveLength(0);
  });

  it('is due once the HOT interval (30s) has elapsed', async () => {
    const now = 1_700_000_000_000;
    const prisma = fakePrisma(
      [{ caseId: 'case1', chain: 'TRON', addr: 'Taddr1', tier: 'HOT', reason: 'manual' }],
      [{ chain: 'TRON', addr: 'Taddr1', lastCheckedAt: new Date(now - DEFAULT_MONITOR_CONFIG.tierPollIntervalMs.HOT), lastCursor: null }],
    );
    const due = await findDueTronAddresses(prisma, now);
    expect(due).toHaveLength(1);
  });

  it('a COLD-tier address is not due after only 5 minutes (WARM interval)', async () => {
    const now = 1_700_000_000_000;
    const prisma = fakePrisma(
      [{ caseId: 'case1', chain: 'TRON', addr: 'Taddr1', tier: 'COLD', reason: 'frontier' }],
      [{ chain: 'TRON', addr: 'Taddr1', lastCheckedAt: new Date(now - DEFAULT_MONITOR_CONFIG.tierPollIntervalMs.WARM), lastCursor: null }],
    );
    const due = await findDueTronAddresses(prisma, now);
    expect(due).toHaveLength(0);
  });

  it('the same (chain, addr) watched by two cases (different tiers) is polled once, at the more urgent tier, fanning out to both caseIds', async () => {
    const now = 1_700_000_000_000;
    const prisma = fakePrisma(
      [
        { caseId: 'case1', chain: 'TRON', addr: 'Tshared', tier: 'COLD', reason: 'manual' },
        { caseId: 'case2', chain: 'TRON', addr: 'Tshared', tier: 'HOT', reason: 'manual' },
      ],
      [{ chain: 'TRON', addr: 'Tshared', lastCheckedAt: new Date(now - DEFAULT_MONITOR_CONFIG.tierPollIntervalMs.HOT), lastCursor: null }],
    );
    const due = await findDueTronAddresses(prisma, now);
    expect(due).toHaveLength(1);
    expect(due[0].tier).toBe('HOT');
    expect(due[0].caseIds.sort()).toEqual(['case1', 'case2']);
  });
});

describe('advanceCheckpoint', () => {
  it('upserts lastCheckedAt and lastCursor', async () => {
    const prisma = fakePrisma([], []);
    await advanceCheckpoint(prisma, 'TRON', 'Taddr1', 1_700_000_000_000, 'txHashAbc');
    const due = await findDueTronAddresses(
      fakePrisma([{ caseId: 'c', chain: 'TRON', addr: 'Taddr1', tier: 'HOT', reason: 'manual' }], [{ chain: 'TRON', addr: 'Taddr1', lastCheckedAt: new Date(1_700_000_000_000), lastCursor: 'txHashAbc' }]),
      1_700_000_000_000,
    );
    expect(due).toHaveLength(0); // just checked, not due again immediately
  });
});
