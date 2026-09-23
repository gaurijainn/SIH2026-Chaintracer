import type { PrismaClient, WatchTier } from '@prisma/client';
import { classifyIdentifier, FAMILY_CHAINS, type Chain } from '@ps26183/shared';
import { InvalidAddressError, WatchlistNotFoundError } from './errors';

export interface CreateWatchlistInput {
  caseId: string;
  chain: Chain;
  addr: string;
  reason?: string; // free text; 'manual' is the convention for API-added rows (mule/frontier come from B6/B4 hooks)
  tier?: WatchTier;
  addedById?: string | null;
}

export interface WatchlistServiceDeps {
  prisma: PrismaClient;
}

/**
 * B8/F4: manage monitored addresses. Reuses `classifyIdentifier` (B2's address validation) rather
 * than re-implementing chain/format checks; normalizes the same way intake does. Creation is
 * idempotent against WatchlistItem's existing @@unique([caseId, chain, addr]).
 */
export class WatchlistService {
  constructor(private readonly deps: WatchlistServiceDeps) {}

  async list(caseId?: string) {
    return this.deps.prisma.watchlistItem.findMany({
      where: caseId ? { caseId } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(input: CreateWatchlistInput) {
    const classified = classifyIdentifier(input.addr);
    if (classified.kind !== 'ADDRESS') {
      const reasons = classified.kind === 'INVALID' ? classified.reasons : [`identifier is a ${classified.kind}, not an address`];
      throw new InvalidAddressError(input.addr, reasons);
    }
    if (!FAMILY_CHAINS[classified.family].includes(input.chain)) {
      throw new InvalidAddressError(input.addr, [`address family ${classified.family} does not include chain ${input.chain}`]);
    }

    return this.deps.prisma.watchlistItem.upsert({
      where: { caseId_chain_addr: { caseId: input.caseId, chain: input.chain, addr: classified.normalized } },
      create: {
        caseId: input.caseId,
        chain: input.chain,
        addr: classified.normalized,
        reason: input.reason ?? 'manual',
        tier: input.tier ?? 'HOT',
        addedById: input.addedById ?? undefined,
      },
      update: {}, // idempotent: re-adding an already-watched address is a no-op, not an error
    });
  }

  async remove(id: string) {
    try {
      await this.deps.prisma.watchlistItem.delete({ where: { id } });
    } catch {
      throw new WatchlistNotFoundError(id);
    }
  }
}
