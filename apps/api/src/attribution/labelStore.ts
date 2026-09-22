import type { NormalizedLabel } from './types';

/** The exact subset of PrismaClient the label store needs; a real PrismaClient satisfies this structurally. */
export interface LabelPrisma {
  label: {
    upsert(args: {
      where: { chain_addr_source_name: { chain: string; addr: string; source: string; name: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

/**
 * The single write path for every B5 label source. Idempotent: re-importing the same
 * (chain, addr, source, name) tuple updates confidence/evidence/fetchedAt in place rather than
 * creating a duplicate row (Label's unique key), so loaders are safe to rerun.
 */
export async function upsertLabel(prisma: LabelPrisma, l: NormalizedLabel): Promise<void> {
  const data = {
    chain: l.chain,
    addr: l.addr,
    name: l.name,
    category: l.category,
    source: l.source,
    confidence: l.confidence,
    evidence: l.evidence === undefined ? null : (l.evidence as never),
    fetchedAt: new Date(),
    ...(l.vaspId ? { vaspId: l.vaspId } : {}),
  };
  await prisma.label.upsert({
    where: { chain_addr_source_name: { chain: l.chain, addr: l.addr, source: l.source, name: l.name } },
    create: data,
    update: data,
  });
}

export async function upsertLabels(prisma: LabelPrisma, labels: NormalizedLabel[]): Promise<number> {
  for (const l of labels) await upsertLabel(prisma, l);
  return labels.length;
}
