import type { PrismaClient } from '@prisma/client';
import type { Driver } from 'neo4j-driver';
import { analyzeMuleRings, type AnalyzeCaseResult } from './analyzeCase';
import type { MuleRuleConfig } from './config';

export interface MuleServiceDeps {
  prisma: PrismaClient;
  driver?: Driver;
  config?: MuleRuleConfig;
}

/** B6 service used by the mule routes: analysis plus read-only queries over its persisted results. */
export class MuleService {
  constructor(private readonly deps: MuleServiceDeps) {}

  analyzeCase(caseId: string): Promise<AnalyzeCaseResult> {
    return analyzeMuleRings(this.deps, caseId);
  }

  async listFlagsForCase(caseId: string) {
    const traces = await this.deps.prisma.traceJob.findMany({ where: { caseId }, select: { id: true } });
    const traceIds = traces.map((t) => t.id);
    if (traceIds.length === 0) return [];
    const addrs = await this.deps.prisma.hop.findMany({
      where: { traceId: { in: traceIds } },
      select: { chain: true, fromAddr: true, toAddr: true },
      distinct: ['chain', 'fromAddr', 'toAddr'],
    });
    const keys = new Set<string>();
    for (const a of addrs) {
      keys.add(`${a.chain}:${a.fromAddr}`);
      keys.add(`${a.chain}:${a.toAddr}`);
    }
    if (keys.size === 0) return [];
    const where = [...keys].map((k) => { const i = k.indexOf(':'); return { chain: k.slice(0, i), addr: k.slice(i + 1) }; });
    return this.deps.prisma.muleFlag.findMany({ where: { OR: where }, orderBy: [{ addr: 'asc' }, { rule: 'asc' }] });
  }

  listCommunitiesForCase(caseId: string) {
    return this.deps.prisma.addressCommunity.findMany({ where: { caseId }, orderBy: [{ wccId: 'asc' }, { degree: 'desc' }] });
  }

  getSharedMule(chain: string, addr: string) {
    return this.deps.prisma.sharedMuleFlag.findUnique({ where: { chain_addr: { chain, addr } } });
  }
}
