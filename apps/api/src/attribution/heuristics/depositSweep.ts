import type { Transfer } from '@ps26183/shared';

export interface KnownHotWallet {
  addr: string;
  vaspId: string;
  vaspName: string;
}

export interface DepositSweepMatch {
  vaspId: string;
  vaspName: string;
  confidence: number;
  evidence: { unrelatedSenders: number; forwardedRatio: number; withinHours: number; forwardTxHashes: string[] };
}

const value = (t: Transfer): number => t.usd ?? (Number(t.amount) || 0);
const sum = (ts: Transfer[]): number => ts.reduce((s, t) => s + value(t), 0);
const round = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * H1 (plan B5, Victor 2020): an address that receives from unrelated senders and forwards at least
 * 95% of that value to a known VASP hot wallet within 24 hours is that VASP's deposit address.
 * "Unrelated senders" is approximated as two or more distinct inbound counterparties.
 */
export function detectDepositSweep(inflows: Transfer[], outflows: Transfer[], knownHotWallets: KnownHotWallet[]): DepositSweepMatch[] {
  const distinctSenders = new Set(inflows.map((t) => t.from));
  if (distinctSenders.size < 2) return [];
  const totalIn = sum(inflows);
  if (totalIn <= 0) return [];
  const firstInflowTs = Math.min(...inflows.map((t) => t.ts));

  const byWallet = new Map(knownHotWallets.map((w) => [w.addr, w]));
  const outByTo = new Map<string, Transfer[]>();
  for (const o of outflows) outByTo.set(o.to, [...(outByTo.get(o.to) ?? []), o]);

  const matches: DepositSweepMatch[] = [];
  for (const [walletAddr, outs] of outByTo) {
    const known = byWallet.get(walletAddr);
    if (!known) continue;
    const ratio = sum(outs) / totalIn;
    const withinHours = (Math.max(...outs.map((t) => t.ts)) - firstInflowTs) / 3_600_000;
    if (ratio >= 0.95 && withinHours >= 0 && withinHours <= 24) {
      matches.push({
        vaspId: known.vaspId,
        vaspName: known.vaspName,
        confidence: 0.9,
        evidence: { unrelatedSenders: distinctSenders.size, forwardedRatio: round(ratio), withinHours: round(withinHours), forwardTxHashes: outs.map((o) => o.txHash) },
      });
    }
  }
  return matches;
}
