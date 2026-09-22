export interface DirectedEdge {
  fromAddr: string;
  toAddr: string;
}

/** BFS depth from `source` to every reachable address, following edges in their given direction. */
export function bfsDepths(edges: DirectedEdge[], source: string): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const e of edges) adj.set(e.fromAddr, [...(adj.get(e.fromAddr) ?? []), e.toAddr]);

  const depth = new Map<string, number>([[source, 0]]);
  const queue = [source];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    for (const next of adj.get(cur) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, d + 1);
      queue.push(next);
    }
  }
  return depth;
}

/** Fewest hops from `addr` to any address in `targets`; null when none is reachable. */
export function hopsToNearest(edges: DirectedEdge[], addr: string, targets: Set<string>): number | null {
  if (targets.has(addr)) return 0;
  const depths = bfsDepths(edges, addr);
  let best: number | null = null;
  for (const t of targets) {
    const d = depths.get(t);
    if (d != null && (best == null || d < best)) best = d;
  }
  return best;
}
