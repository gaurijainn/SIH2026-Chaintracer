import { PrismaClient, type Hop } from '@prisma/client';
import type { GraphHop } from '../graph/graph';

export function createPrisma(url?: string): PrismaClient {
  return new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
}

/** Maps a PostgreSQL Hop row to its Neo4j edge form (Decimal -> string, Date -> ISO UTC). */
export function hopToGraph(h: Hop): GraphHop {
  return {
    chain: h.chain,
    from: h.fromAddr,
    to: h.toAddr,
    tx: h.txHash,
    idx: h.idx,
    token: h.token,
    amount: h.amount.toFixed(),
    usd: h.usd ? h.usd.toFixed() : null,
    ts: h.ts.toISOString(),
  };
}
