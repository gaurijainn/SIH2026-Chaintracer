import type { Chain, Transfer } from '@ps26183/shared';
import type { ChainLayer } from '@ps26183/workers/adapters';
import { normalizeTronscanMeta } from '../../attribution/loaders/tronscan';
import type { MuleFeatureInputs } from '../features';
import type { HopLike } from '../types';
import type { TracedAddressProvider } from '../training/types';

/** B6's HopLike is structurally identical to a normalized B3 Transfer; no data is invented in this mapping. */
function toHopLike(t: Transfer): HopLike {
  return { txHash: t.txHash, idx: t.idx, fromAddr: t.from, toAddr: t.to, token: t.token, amount: t.amount, usd: t.usd ?? null, ts: t.ts };
}

/**
 * B7.4 task 7: a real `TracedAddressProvider` backed by the B3 provider layer (TronAdapter.getTransfers
 * / getAccountMeta) instead of the join.ts test's fake. Feature inputs are precomputed once (via
 * `build()`, which does the actual awaited provider calls in replay/fixture mode) so `getFeatureInputs`
 * can stay synchronous, matching the TracedAddressProvider interface `joinBootstrapLabels` expects.
 *
 * Where a feature input genuinely cannot be derived from what B3 alone can tell us (case-graph data
 * this collector doesn't have -- hopsFromVictim, hopsToVasp, sanctionExposure, cross-case linkage),
 * the field is left null/0 exactly as MuleFeatureInputs already models "unknown", never invented:
 *   - hopsFromVictim, hopsToVasp, sanctionExposure: null (no case/graph context here)
 *   - sharedMuleCps, crossCaseCount: 0 (no cross-case linkage data available to this collector)
 *   - trxDustUsdt: false (B5's H1-H4 attribution isn't run by this collector; never guessed true)
 * These are recorded per-address in `missingFeatureInputs` for the validation report (task 9).
 */
export class ChainLayerTracedAddressProvider implements TracedAddressProvider {
  private readonly inputs = new Map<string, MuleFeatureInputs>();
  private readonly missing = new Map<string, string[]>();
  private readonly byChain = new Map<Chain, string[]>();

  private constructor() {}

  listTracedAddresses(chain: Chain): string[] {
    return this.byChain.get(chain) ?? [];
  }

  getFeatureInputs(chain: Chain, addr: string): MuleFeatureInputs | null {
    return this.inputs.get(`${chain}:${addr}`) ?? null;
  }

  /** Per-address list of MuleFeatureInputs fields this collector could not derive (never fabricated). */
  missingFieldsFor(chain: Chain, addr: string): string[] {
    return this.missing.get(`${chain}:${addr}`) ?? [];
  }

  /**
   * Fetches real transfer/account data for every address (via `layer.tron`, replay-mode in tests)
   * and builds one MuleFeatureInputs per address. Deterministic: addresses are visited in sorted order.
   */
  static async build(layer: ChainLayer, chain: Chain, addresses: readonly string[]): Promise<ChainLayerTracedAddressProvider> {
    if (chain !== 'TRON') throw new Error(`ChainLayerTracedAddressProvider: only TRON is wired up (got ${chain})`);
    const provider = new ChainLayerTracedAddressProvider();
    const sorted = [...new Set(addresses)].sort();
    provider.byChain.set(chain, sorted);

    for (const addr of sorted) {
      const [inboundPage, outboundPage, meta] = await Promise.all([layer.tron.getTransfers(addr, 'in'), layer.tron.getTransfers(addr, 'out'), layer.tron.getAccountMeta(addr)]);
      const inbound = inboundPage.items.map(toHopLike);
      const outbound = outboundPage.items.map(toHopLike);
      const tronscanLabels = normalizeTronscanMeta(meta);
      const firstTaintedAtMs = inbound.length ? Math.min(...inbound.map((h) => (h.ts instanceof Date ? h.ts.getTime() : h.ts))) : null;

      const missingHere: string[] = [];
      if (meta.createdAt === null) missingHere.push('accountCreatedAtMs');
      if (!inbound.length) missingHere.push('firstTaintedAtMs');
      missingHere.push('sanctionExposure', 'hopsFromVictim', 'hopsToVasp'); // no case-graph context available to this collector

      const mf: MuleFeatureInputs = {
        chain,
        addr,
        inbound,
        outbound,
        accountCreatedAtMs: meta.createdAt,
        firstTaintedAtMs,
        activatorLabel: meta.activator,
        sanctionExposure: null,
        externalFlags: tronscanLabels.map((l) => l.category),
        trxDustUsdt: false,
        hopsFromVictim: null,
        hopsToVasp: null,
        sharedMuleCps: 0,
        crossCaseCount: 0,
      };
      provider.inputs.set(`${chain}:${addr}`, mf);
      provider.missing.set(`${chain}:${addr}`, missingHere);
    }
    return provider;
  }
}
