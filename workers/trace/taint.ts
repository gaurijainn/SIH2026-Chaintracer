export type TaintModel = 'HAIRCUT' | 'FIFO';

export interface TaintableEdge {
  /** USD value of this outflow; null when pricing could not be determined for it. */
  usd: number | null;
}

/**
 * Splits a node's incoming tainted balance across its selected outflows.
 *
 * HAIRCUT (proportional, default): every outflow is assumed to carry the same proportion of tainted
 * money as the node's total tainted balance bears to its total outflow value (Chainalysis-style
 * "haircut" taint). `Infinity` as the parent taint (the trace seed, before any amount is known)
 * means "fully tainted": every outflow's share equals its own value.
 *
 * FIFO: tainted funds are consumed oldest-outflow-first; edges must already be sorted chronologically
 * ascending. Each edge gets `min(remaining balance, its own value)`; once the balance is exhausted,
 * later edges get zero (they are funded by money that arrived after the tainted deposit was spent).
 *
 * Edges with unknown (`null`) USD value get a zero share under both models — taint cannot be
 * allocated to an amount that cannot be compared to anything else.
 */
export function allocateTaint(model: TaintModel, parentTaint: number, edges: TaintableEdge[]): number[] {
  if (model === 'FIFO') {
    let remaining = parentTaint;
    return edges.map((e) => {
      if (e.usd === null || remaining <= 0) return 0;
      const share = Math.min(remaining, e.usd);
      remaining -= share;
      return share;
    });
  }
  const totalOut = edges.reduce((sum, e) => sum + (e.usd ?? 0), 0);
  const proportion = totalOut > 0 ? Math.min(1, parentTaint / totalOut) : 0;
  return edges.map((e) => (e.usd === null ? 0 : e.usd * proportion));
}
