export interface BtcTx {
  txid: string;
  inputs: string[]; // addresses spent as inputs
  outputs: { addr: string; value: number }[];
}

/** Plain union-find (path compression, no union-by-rank; clusters here are small enough not to need it). */
export class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x)!;
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  clusterOf(x: string): string {
    return this.find(x);
  }
}

/**
 * A CoinJoin-like transaction (plan B5) has several outputs of the same value — the whole point being
 * that an observer cannot tell which input paid which output. Clustering its inputs together would be
 * wrong (they very likely belong to different, mutually distrusting participants), so H3 skips it.
 */
export function isCoinJoinLike(tx: BtcTx, minEqualOutputs = 3): boolean {
  if (tx.outputs.length < minEqualOutputs) return false;
  const counts = new Map<number, number>();
  for (const o of tx.outputs) counts.set(o.value, (counts.get(o.value) ?? 0) + 1);
  return Math.max(...counts.values()) >= minEqualOutputs;
}

export interface ClusterResult {
  uf: UnionFind;
  /** txids skipped as CoinJoin-like */
  skipped: string[];
  /** txids whose inputs were unioned */
  clustered: string[];
}

/**
 * H3 (plan B5): union-find clustering over Bitcoin multi-input transactions ("common-input
 * ownership" — a transaction can only be signed by whoever controls every one of its inputs, so they
 * are the same wallet). Single-input transactions carry no clustering signal and are left alone.
 */
export function clusterBtcTransactions(txs: BtcTx[]): ClusterResult {
  const uf = new UnionFind();
  const skipped: string[] = [];
  const clustered: string[] = [];
  for (const tx of txs) {
    if (tx.inputs.length < 2) {
      for (const a of tx.inputs) uf.find(a);
      continue;
    }
    if (isCoinJoinLike(tx)) {
      skipped.push(tx.txid);
      continue;
    }
    const [first, ...rest] = tx.inputs;
    for (const a of rest) uf.union(first, a);
    clustered.push(tx.txid);
  }
  return { uf, skipped, clustered };
}
