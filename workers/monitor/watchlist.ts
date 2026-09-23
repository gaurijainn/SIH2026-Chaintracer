import type { Chain } from '@ps26183/shared';

/** Mirrors the Prisma WatchTier enum without a runtime dependency on @prisma/client from this module. */
export type WatchTier = 'HOT' | 'WARM' | 'COLD';

export interface WatchlistUpsertPrisma {
  watchlistItem: {
    upsert(args: {
      where: { caseId_chain_addr: { caseId: string; chain: string; addr: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

/**
 * Idempotent watchlist add, shared by both B8 auto-population hooks:
 *  - B4 (workers/trace/engine.ts onTerminal, wired in workers/src/index.ts): frontier terminals
 *    (reason === 'max_hops') -- the trace stopped only because it ran out of hops, so B8 keeps
 *    watching past where B4 stopped looking.
 *  - B6 (apps/api/src/mule/analyzeCase.ts): addresses flagged by mule/layering rules.
 * Uses `upsert` against WatchlistItem's existing @@unique([caseId, chain, addr]), so calling this
 * again for the same (case, chain, addr) is always safe -- matches the create-or-upsert idempotency
 * convention already used throughout B4-B6 (Hop.skipDuplicates, MuleFlag.upsert, etc).
 */
export async function upsertWatchlistItem(
  prisma: WatchlistUpsertPrisma,
  input: { caseId: string; chain: Chain; addr: string; reason: 'frontier' | 'mule' | 'manual'; tier?: WatchTier },
): Promise<void> {
  await prisma.watchlistItem.upsert({
    where: { caseId_chain_addr: { caseId: input.caseId, chain: input.chain, addr: input.addr } },
    create: { caseId: input.caseId, chain: input.chain, addr: input.addr, reason: input.reason, tier: input.tier ?? 'HOT' },
    // Do not downgrade an existing manual/mule reason back to frontier, or a case-configured tier down;
    // reason/tier are informational bookkeeping, not something a rerun should silently overwrite.
    update: {},
  });
}
