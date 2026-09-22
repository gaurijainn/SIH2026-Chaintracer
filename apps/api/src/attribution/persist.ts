import type { Driver } from 'neo4j-driver';
import { linkToEntity } from '../graph/graph';
import type { AttributionCandidate } from './types';

/** The exact subset of PrismaClient the attribution persister needs. */
export interface AttributionPrisma {
  attribution: {
    upsert(args: {
      where: { chain_addr_vaspId: { chain: string; addr: string; vaspId: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

/**
 * Writes one attribution candidate to both stores: Postgres gets the queryable summary row
 * (idempotent — upserts by (chain, addr, vaspId)); Neo4j gets one BELONGS_TO edge per fired
 * heuristic (so an officer can see exactly which evidence contributed) plus one "COMBINED" edge
 * carrying the final noisy-OR confidence.
 */
export async function persistAttribution(deps: { prisma: AttributionPrisma; driver?: Driver }, candidate: AttributionCandidate): Promise<void> {
  const key = { chain: candidate.chain, addr: candidate.addr, vaspId: candidate.vaspId };
  const data = { confidence: candidate.confidence, heuristics: candidate.heuristics as unknown as Record<string, unknown> };
  await deps.prisma.attribution.upsert({ where: { chain_addr_vaspId: key }, create: { ...key, ...data }, update: data });

  if (!deps.driver) return;
  const entity = { name: candidate.vaspName, type: 'VASP' };
  for (const h of candidate.heuristics) {
    await linkToEntity(deps.driver, { chain: candidate.chain, addr: candidate.addr, entity, heuristic: h.code, confidence: h.confidence, evidence: JSON.stringify(h.evidence) });
  }
  await linkToEntity(deps.driver, {
    chain: candidate.chain,
    addr: candidate.addr,
    entity,
    heuristic: 'COMBINED',
    confidence: candidate.confidence,
    evidence: JSON.stringify(candidate.heuristics.map((h) => h.code)),
  });
}
