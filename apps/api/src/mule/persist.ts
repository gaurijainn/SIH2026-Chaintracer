import type { MuleFlagResult } from './types';

/** The exact subset of PrismaClient the mule persister needs. */
export interface MulePrisma {
  muleFlag: {
    upsert(args: {
      where: { chain_addr_rule: { chain: string; addr: string; rule: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

/**
 * Writes one fired rule to Postgres, keyed by (chain, addr, rule) — re-running detection for an
 * address upserts each rule's row afresh with the freshest evidence, so a rerun never duplicates and
 * always reflects the current state of the trace (idempotent, plan B6 "safe to rerun").
 */
export async function persistMuleFlag(deps: { prisma: MulePrisma }, flag: MuleFlagResult, traceId?: string): Promise<void> {
  const key = { chain: flag.chain, addr: flag.addr, rule: flag.rule };
  const data = { confidence: flag.confidence, evidence: flag.evidence as Record<string, unknown>, traceId: traceId ?? null };
  await deps.prisma.muleFlag.upsert({ where: { chain_addr_rule: key }, create: { ...key, ...data }, update: data });
}

export async function persistMuleFlags(deps: { prisma: MulePrisma }, flags: MuleFlagResult[], traceId?: string): Promise<void> {
  for (const f of flags) await persistMuleFlag(deps, f, traceId);
}
