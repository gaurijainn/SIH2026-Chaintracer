import type { PrismaClient } from '@prisma/client';

export class TraceNotFoundError extends Error {
  constructor(id: string) {
    super(`trace not found: ${id}`);
  }
}

export interface TraceGraphFilter {
  chain?: string;
  minValueUsd?: number;
  from?: Date;
  to?: Date;
}

export interface TraceGraph {
  traceId: string;
  nodes: { id: string; chain: string; addr: string; inUsd: number; outUsd: number }[];
  edges: { id: string; chain: string; txHash: string; from: string; to: string; token: string; amount: string; usd: number | null; hopNo: number; ts: string }[];
}

/** Graph JSON for one trace (plan: GET /traces/:id/graph, filters chain / minValue / time), read from the persisted hops. */
export class TraceGraphService {
  constructor(private readonly deps: { prisma: PrismaClient }) {}

  async graph(traceId: string, f: TraceGraphFilter = {}): Promise<TraceGraph> {
    const trace = await this.deps.prisma.traceJob.findUnique({ where: { id: traceId }, select: { id: true } });
    if (!trace) throw new TraceNotFoundError(traceId);

    const hops = await this.deps.prisma.hop.findMany({
      where: {
        traceId,
        chain: f.chain,
        usd: f.minValueUsd !== undefined ? { gte: f.minValueUsd } : undefined,
        ts: f.from || f.to ? { gte: f.from, lte: f.to } : undefined,
      },
      orderBy: [{ hopNo: 'asc' }, { ts: 'asc' }],
    });

    const nodes = new Map<string, TraceGraph['nodes'][number]>();
    const node = (chain: string, addr: string) => {
      const id = `${chain}:${addr}`;
      let n = nodes.get(id);
      if (!n) nodes.set(id, (n = { id, chain, addr, inUsd: 0, outUsd: 0 }));
      return n;
    };
    const edges = hops.map((h) => {
      const usd = h.usd ? Number(h.usd) : null;
      node(h.chain, h.fromAddr).outUsd += usd ?? 0;
      node(h.chain, h.toAddr).inUsd += usd ?? 0;
      return { id: h.id, chain: h.chain, txHash: h.txHash, from: `${h.chain}:${h.fromAddr}`, to: `${h.chain}:${h.toAddr}`, token: h.token, amount: h.amount.toString(), usd, hopNo: h.hopNo, ts: h.ts.toISOString() };
    });
    return { traceId, nodes: [...nodes.values()], edges };
  }
}
