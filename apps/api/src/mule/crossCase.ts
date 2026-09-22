import type { Chain } from '@ps26183/shared';

export interface CaseTouch {
  chain: Chain;
  addr: string;
  caseId: string;
}

export interface SharedMuleCandidate {
  chain: Chain;
  addr: string;
  caseCount: number;
  caseIds: string[];
}

/**
 * Plan B6 cross-case linkage: any wallet whose hops belong to two or more cases' traces is a
 * shared-mule candidate — never "criminal", just present in more than one investigation. `rows`
 * should already be deduplicated to one row per (chain, addr, caseId) touch.
 */
export function findSharedMules(rows: CaseTouch[]): SharedMuleCandidate[] {
  const byKey = new Map<string, { chain: Chain; addr: string; caseIds: Set<string> }>();
  for (const r of rows) {
    const key = `${r.chain}:${r.addr}`;
    const entry = byKey.get(key) ?? { chain: r.chain, addr: r.addr, caseIds: new Set<string>() };
    entry.caseIds.add(r.caseId);
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .filter((e) => e.caseIds.size >= 2)
    .map((e) => ({ chain: e.chain, addr: e.addr, caseCount: e.caseIds.size, caseIds: [...e.caseIds].sort() }));
}

/** The exact subset of PrismaClient the shared-mule persister needs. */
export interface SharedMulePrisma {
  sharedMuleFlag: {
    upsert(args: {
      where: { chain_addr: { chain: string; addr: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

/** Upserts by (chain, addr) so recomputing cross-case linkage is idempotent. */
export async function persistSharedMuleFlags(deps: { prisma: SharedMulePrisma }, candidates: SharedMuleCandidate[]): Promise<void> {
  for (const c of candidates) {
    const key = { chain: c.chain, addr: c.addr };
    const data = { caseCount: c.caseCount, caseIds: c.caseIds };
    await deps.prisma.sharedMuleFlag.upsert({ where: { chain_addr: key }, create: { ...key, ...data }, update: data });
  }
}
