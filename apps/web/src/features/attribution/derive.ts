import { vaspKey, type GEdge, type GNode, type GraphModel } from '@/features/graph/model';
import type { RegistryVasp } from './api';

export interface PathStep {
  node: GNode;
  /** The transfer that leads INTO this node (absent for the seed). */
  via?: GEdge;
}

export interface Deposit {
  node: GNode;
  /** The registry's own record for this hot wallet (source and confidence exactly as stored). */
  registry: { source: string; confidence: string };
  /** Transfers into this address, as returned by the trace graph. */
  incoming: GEdge[];
  /** Fewest-transfer route from the seed address through the loaded edges; null when the seed is not connected to it. */
  path: PathStep[] | null;
}

export interface Destination {
  vasp: RegistryVasp;
  deposits: Deposit[];
  /** Sum of the backend's per-node inUsd over this VASP's deposit addresses. */
  amountUsd: number;
  /** Smallest backend hop number of any transfer reaching one of its deposit addresses; null if none is known. */
  hops: number | null;
}

/** Fewest-edge route seed -> target over the real edges. Deterministic: edges are visited in (hopNo, ts, id) order. */
export function pathBetween(graph: GraphModel, seedId: string, targetId: string): PathStep[] | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const start = byId.get(seedId);
  if (!start || !byId.has(targetId)) return null;
  const out = new Map<string, GEdge[]>();
  for (const e of [...graph.edges].sort((a, b) => a.hopNo - b.hopNo || a.ts - b.ts || a.id.localeCompare(b.id))) (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e);
  const came = new Map<string, GEdge | null>([[seedId, null]]);
  const queue = [seedId];
  for (let i = 0; i < queue.length && !came.has(targetId); i++) {
    for (const e of out.get(queue[i]) ?? []) {
      if (!came.has(e.target)) {
        came.set(e.target, e);
        queue.push(e.target);
      }
    }
  }
  if (!came.has(targetId)) return null;
  const steps: PathStep[] = [];
  for (let id = targetId; ; ) {
    const via = came.get(id) ?? undefined;
    steps.unshift({ node: byId.get(id)!, via });
    if (!via) break;
    id = via.source;
  }
  return steps;
}

/**
 * Destination VASPs of a trace: every registry hot wallet (GET /vasps, matched on chain + address) that the trace graph
 * actually reaches. This is a registry match, not the B5 attribution heuristics, which no endpoint exposes yet.
 */
export function destinations(graph: GraphModel, registry: RegistryVasp[], seed: { chain: string; addr: string }): Destination[] {
  const seedKey = vaspKey(seed.chain, seed.addr);
  const seedNode = graph.nodes.find((n) => vaspKey(n.chain, n.addr) === seedKey);
  const nodes = new Map(graph.nodes.map((n) => [vaspKey(n.chain, n.addr), n]));
  const result: Destination[] = [];
  for (const vasp of registry) {
    const deposits: Deposit[] = [];
    for (const a of vasp.addresses) {
      const node = nodes.get(vaspKey(a.chain, a.addr));
      if (!node || deposits.some((d) => d.node.id === node.id)) continue;
      deposits.push({
        node,
        registry: { source: a.source, confidence: a.confidence },
        incoming: graph.edges.filter((e) => e.target === node.id).sort((x, y) => x.ts - y.ts),
        path: seedNode ? pathBetween(graph, seedNode.id, node.id) : null,
      });
    }
    if (deposits.length === 0) continue;
    const hops = deposits.flatMap((d) => d.incoming.map((e) => e.hopNo));
    result.push({ vasp, deposits, amountUsd: deposits.reduce((s, d) => s + d.node.inUsd, 0), hops: hops.length ? Math.min(...hops) : null });
  }
  return result.sort((a, b) => b.amountUsd - a.amountUsd || a.vasp.name.localeCompare(b.vasp.name));
}
