import type { Chain } from '@ps26183/shared';
import { DEFAULT_MONITOR_CONFIG, type MonitorConfig } from './config';

export type WatchTier = 'HOT' | 'WARM' | 'COLD';

export interface CheckpointRow {
  chain: string;
  addr: string;
  lastCheckedAt: Date;
  lastCursor: string | null;
}

/** The exact subset of PrismaClient the B8 checkpoint/watchlist scan needs. */
export interface MonitorPrisma {
  watchlistItem: {
    findMany(args: { where: { chain: string } }): Promise<{ id: string; caseId: string; chain: string; addr: string; tier: WatchTier; reason: string }[]>;
  };
  monitorCheckpoint: {
    findMany(args: { where: { chain: string; addr: { in: string[] } } }): Promise<CheckpointRow[]>;
    upsert(args: { where: { chain_addr: { chain: string; addr: string } }; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface DueAddress {
  chain: Chain;
  addr: string;
  tier: WatchTier;
  since: number; // epoch ms: lastCheckedAt if known, else "the start of time" for a first poll
  caseIds: string[]; // every case watching this (chain, addr) -- alerts fan out to all of them
}

/** The highest-urgency tier among a set of WatchlistItem rows sharing one (chain, addr). */
function combineTier(tiers: WatchTier[]): WatchTier {
  if (tiers.includes('HOT')) return 'HOT';
  if (tiers.includes('WARM')) return 'WARM';
  return 'COLD';
}

/**
 * Scans every TRON WatchlistItem, groups by unique (chain, addr) (the same address can be watched by
 * several cases as separate WatchlistItem rows), and returns only the addresses that are "due" given
 * their tier's poll interval and MonitorCheckpoint.lastCheckedAt -- so a single 30s repeatable job
 * never polls every address every tick, only the ones whose tier window has elapsed.
 */
export async function findDueTronAddresses(
  prisma: MonitorPrisma,
  now: number,
  config: MonitorConfig = DEFAULT_MONITOR_CONFIG,
): Promise<DueAddress[]> {
  const items = await prisma.watchlistItem.findMany({ where: { chain: 'TRON' } });
  if (items.length === 0) return [];

  const byAddr = new Map<string, { tiers: WatchTier[]; caseIds: string[] }>();
  for (const it of items) {
    const cur = byAddr.get(it.addr) ?? { tiers: [], caseIds: [] };
    cur.tiers.push(it.tier);
    cur.caseIds.push(it.caseId);
    byAddr.set(it.addr, cur);
  }

  const addrs = [...byAddr.keys()];
  const checkpoints = await prisma.monitorCheckpoint.findMany({ where: { chain: 'TRON', addr: { in: addrs } } });
  const cpByAddr = new Map(checkpoints.map((c) => [c.addr, c]));

  const due: DueAddress[] = [];
  for (const [addr, meta] of byAddr) {
    const tier = combineTier(meta.tiers);
    const cp = cpByAddr.get(addr);
    const intervalMs = config.tierPollIntervalMs[tier];
    const lastCheckedAt = cp ? cp.lastCheckedAt.getTime() : 0;
    if (now - lastCheckedAt >= intervalMs) {
      due.push({ chain: 'TRON', addr, tier, since: lastCheckedAt, caseIds: [...new Set(meta.caseIds)] });
    }
  }
  return due;
}

export async function advanceCheckpoint(prisma: MonitorPrisma, chain: Chain, addr: string, checkedAt: number, lastCursor: string | null): Promise<void> {
  await prisma.monitorCheckpoint.upsert({
    where: { chain_addr: { chain, addr } },
    create: { chain, addr, lastCheckedAt: new Date(checkedAt), lastCursor },
    update: { lastCheckedAt: new Date(checkedAt), lastCursor },
  });
}
