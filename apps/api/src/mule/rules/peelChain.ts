import { DEFAULT_MULE_RULE_CONFIG, type MuleRuleConfig } from '../config';
import type { HopLike } from '../types';

export interface PeelChainMatch {
  /** every address on the chain, from the first peel to the last. */
  addresses: string[];
  confidence: number;
  evidence: Record<string, unknown>;
}

interface TxGroup {
  txHash: string;
  fromAddr: string;
  hops: HopLike[];
}

/** Groups BTC hops by transaction; a "peel transaction" spends one address's UTXOs into few outputs. */
function groupByTx(hops: HopLike[]): Map<string, TxGroup> {
  const byTx = new Map<string, TxGroup>();
  for (const h of hops) {
    const g = byTx.get(h.txHash) ?? { txHash: h.txHash, fromAddr: h.fromAddr, hops: [] };
    g.hops.push(h);
    byTx.set(h.txHash, g);
  }
  return byTx;
}

function isPeelTx(g: TxGroup, cfg: MuleRuleConfig['peelChain']): boolean {
  return g.hops.length >= 2 && g.hops.length <= cfg.maxOutputsPerTx && new Set(g.hops.map((h) => h.fromAddr)).size === 1;
}

/**
 * Plan B6, rule C (Bitcoin peel chain): detects the classic peel-chain pattern — a sequence of
 * single-input, few-output transactions where the larger output ("the peel") keeps moving most of
 * the balance forward to a fresh address while the smaller output is split off as change — by
 * walking, from every candidate starting address, as far as that peel output itself goes on to spend
 * the same way. Requires at least `minChainLength` consecutive hand-offs, so ordinary BTC activity
 * (a single multi-output payment, or two unrelated hops) never qualifies.
 */
export function detectBtcPeelChain(hops: HopLike[], cfg: MuleRuleConfig['peelChain'] = DEFAULT_MULE_RULE_CONFIG.peelChain): PeelChainMatch[] {
  const byTx = groupByTx(hops);

  const peelTxByFromAddr = new Map<string, TxGroup>();
  for (const g of byTx.values()) {
    if (isPeelTx(g, cfg)) peelTxByFromAddr.set(g.fromAddr, g);
  }

  const visited = new Set<string>();
  const matches: PeelChainMatch[] = [];

  for (const startAddr of peelTxByFromAddr.keys()) {
    if (visited.has(startAddr)) continue;

    const chainAddrs: string[] = [startAddr];
    const chainTxs: string[] = [];
    const amounts: number[] = [];
    let current = startAddr;

    while (true) {
      const g = peelTxByFromAddr.get(current);
      if (!g) break;
      if (chainAddrs.length > 200) break; // safety valve against a malformed/circular fixture
      chainTxs.push(g.txHash);
      // the "peel" output carries most of the balance forward; the rest is split off as change.
      const peelOut = [...g.hops].sort((a, b) => Number(b.amount) - Number(a.amount))[0];
      amounts.push(Number(peelOut.amount));
      chainAddrs.push(peelOut.toAddr);
      current = peelOut.toAddr;
    }

    if (chainAddrs.length - 1 >= cfg.minChainLength) {
      for (const a of chainAddrs) visited.add(a);
      matches.push({
        addresses: chainAddrs,
        confidence: 0.8,
        evidence: {
          chainLength: chainAddrs.length - 1,
          addresses: chainAddrs,
          txHashes: chainTxs,
          amounts,
          minChainLength: cfg.minChainLength,
        },
      });
    }
  }

  return matches;
}
