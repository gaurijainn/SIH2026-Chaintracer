import {
  NATIVE_SYMBOL,
  formatUnits,
  type AccountMeta,
  type ChainAdapter,
  type GetTransfersOpts,
  type ProbeCapable,
  type Transfer,
  type TransferPage,
} from '@ps26183/shared';
import { TTL_ACCOUNT_META_S, TTL_FOREVER } from './cache';
import { ProviderHttpError } from './errors';
import type { HttpFactory } from './http';
import { decodeCursor, encodeCursor } from './paginate';
import type { PricingService } from './pricing';
import type { ProviderGuard, Step } from './providerGuard';

/** Blockstream Esplora is primary; mempool.space (same API) is the mirror. */
export const ESPLORA_BASE = { esplora: 'https://blockstream.info/api', mempool: 'https://mempool.space/api' } as const;
export const esploraTxUrl = (hash: string) => `${ESPLORA_BASE.esplora}/tx/${hash}`;
const CHAIN_PAGE = 25; // Esplora returns 25 confirmed transactions per page
const META_SCAN_PAGES = 10; // bounded scan for the account's earliest transaction

interface Vin {
  prevout?: { scriptpubkey_address?: string; value: number } | null;
  is_coinbase?: boolean;
}
interface Vout {
  scriptpubkey_address?: string;
  value: number;
}
interface EsploraTx {
  txid: string;
  vin: Vin[];
  vout: Vout[];
  status: { confirmed: boolean; block_height?: number; block_time?: number };
}

export interface Outspend {
  vout: number;
  spent: boolean;
  /** the transaction that spent this output (the key call for forward tracing) */
  spendingTx?: string;
  spendingVin?: number;
  block?: number;
  ts?: number;
}

type Provider = keyof typeof ESPLORA_BASE;
const PROVIDERS: Provider[] = ['esplora', 'mempool'];

export interface BtcDeps {
  guard: ProviderGuard;
  http: HttpFactory;
  pricing?: PricingService;
}

export class BtcAdapter implements ChainAdapter, ProbeCapable {
  constructor(private d: BtcDeps) {}

  private call<T>(path: string, parse: (data: unknown, status: number) => T, opts: { allow404?: boolean } = {}): Promise<T> {
    const steps: Step<T>[] = PROVIDERS.map((provider) => ({
      provider,
      run: async () => {
        const r = await this.d.http(provider).get(ESPLORA_BASE[provider] + path, opts.allow404 ? { validateStatus: (s: number) => s === 200 || s === 404 } : undefined);
        return parse(r.data, r.status);
      },
    }));
    return this.d.guard.call(steps);
  }

  private txs(path: string): Promise<EsploraTx[]> {
    return this.call(path, (data) => {
      if (!Array.isArray(data)) throw new ProviderHttpError('esplora: unexpected response', 'esplora', undefined, undefined, false);
      return data as EsploraTx[];
    });
  }

  /**
   * Page 1 is /address/:a/txs; later pages are /address/:a/txs/chain/:last_seen_txid (25 confirmed each).
   * Only confirmed transactions are returned. A transaction becomes one Transfer per counterparty output,
   * with the amount split across input addresses in proportion to the value each contributed.
   */
  async getTransfers(addr: string, dir: 'in' | 'out', o: GetTransfersOpts = {}): Promise<TransferPage> {
    const key = `xfer:BTC:${addr}:${dir}:${o.since ?? ''}:${o.cursor ?? ''}`;
    const page = await this.d.guard.cached(key, TTL_FOREVER, async (): Promise<TransferPage> => {
      const cur = decodeCursor(o.cursor);
      const raw = await this.txs(cur.c ? `/address/${addr}/txs/chain/${cur.c}` : `/address/${addr}/txs`);
      const confirmed = raw.filter((t) => t.status.confirmed);
      const items = confirmed.flatMap((t) => this.transfersOf(t, addr, dir)).filter((t) => o.since === undefined || t.ts >= o.since);
      const last = confirmed.at(-1);
      const more = confirmed.length >= CHAIN_PAGE && last && last.txid !== cur.c;
      return more ? { items, next: encodeCursor({ s: 0, c: last.txid }) } : { items };
    });
    return this.d.pricing ? { ...page, items: await this.d.pricing.enrich(page.items) } : page;
  }

  private transfersOf(t: EsploraTx, addr: string, dir: 'in' | 'out'): Transfer[] {
    const inputs = new Map<string, bigint>();
    let totalIn = 0n;
    for (const v of t.vin) {
      const a = v.prevout?.scriptpubkey_address;
      if (!a || !v.prevout) continue;
      inputs.set(a, (inputs.get(a) ?? 0n) + BigInt(v.prevout.value));
      totalIn += BigInt(v.prevout.value);
    }
    const base = { chain: 'BTC' as const, txHash: t.txid, token: NATIVE_SYMBOL.BTC, ts: (t.status.block_time ?? 0) * 1000, block: t.status.block_height ?? 0 };
    const out: Transfer[] = [];

    if (dir === 'out') {
      const mine = inputs.get(addr);
      if (mine === undefined || totalIn === 0n) return out;
      t.vout.forEach((o, n) => {
        if (!o.scriptpubkey_address || o.scriptpubkey_address === addr) return; // OP_RETURN / change back to self
        out.push({ ...base, idx: n * 1000, from: addr, to: o.scriptpubkey_address, amount: formatUnits((BigInt(o.value) * mine) / totalIn, 8) });
      });
      return out;
    }
    t.vout.forEach((o, n) => {
      if (o.scriptpubkey_address !== addr) return;
      if (t.vin.some((v) => v.is_coinbase) || totalIn === 0n) {
        out.push({ ...base, idx: n * 1000, from: 'coinbase', to: addr, amount: formatUnits(BigInt(o.value), 8) });
        return;
      }
      [...inputs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([from, sum], rank) => {
          if (from === addr) return; // spending and receiving in one transaction is change
          out.push({ ...base, idx: n * 1000 + rank, from, to: addr, amount: formatUnits((BigInt(o.value) * sum) / totalIn, 8) });
        });
    });
    return out;
  }

  /** /tx/:id/outspends: which transaction spent each output of a transaction. The key call for forward tracing. */
  async getOutspends(txid: string): Promise<Outspend[]> {
    return this.d.guard.cached(`outspends:BTC:${txid}`, TTL_ACCOUNT_META_S, () =>
      this.call(`/tx/${txid}/outspends`, (data) => {
        if (!Array.isArray(data)) throw new ProviderHttpError('esplora: unexpected outspends response', 'esplora', undefined, undefined, false);
        return (data as { spent: boolean; txid?: string; vin?: number; status?: { block_height?: number; block_time?: number } }[]).map((s, vout) => ({
          vout,
          spent: !!s.spent,
          ...(s.spent && s.txid ? { spendingTx: s.txid, spendingVin: s.vin, block: s.status?.block_height, ts: s.status?.block_time ? s.status.block_time * 1000 : undefined } : {}),
        }));
      }),
    );
  }

  /** Bitcoin has no activation concept or public tags; createdAt comes from a bounded scan for the oldest transaction. */
  async getAccountMeta(addr: string): Promise<AccountMeta> {
    return this.d.guard.cached(`meta:BTC:${addr}`, TTL_ACCOUNT_META_S, async () => {
      const meta: AccountMeta = { chain: 'BTC', addr, createdAt: null, activator: null, publicTag: null, flags: {}, sources: ['esplora'], fetchedAt: Date.now() };
      try {
        let cursor: string | undefined;
        let oldest: EsploraTx | undefined;
        for (let i = 0; i < META_SCAN_PAGES; i++) {
          const raw = await this.txs(cursor ? `/address/${addr}/txs/chain/${cursor}` : `/address/${addr}/txs`);
          const confirmed = raw.filter((t) => t.status.confirmed);
          if (confirmed.length) oldest = confirmed.at(-1);
          if (confirmed.length < CHAIN_PAGE) {
            meta.createdAt = oldest?.status.block_time ? oldest.status.block_time * 1000 : null;
            return meta;
          }
          cursor = confirmed.at(-1)!.txid;
        }
        meta.partial = ['createdAt']; // more history than the scan bound: age unknown rather than wrong
      } catch {
        meta.partial = ['createdAt'];
      }
      return meta;
    });
  }

  async hasActivity(addr: string): Promise<boolean> {
    return this.d.guard.cached(`active:BTC:${addr}`, TTL_ACCOUNT_META_S, () =>
      this.call(`/address/${addr}`, (data) => {
        const d = data as { chain_stats?: { tx_count?: number }; mempool_stats?: { tx_count?: number } };
        if (!d?.chain_stats) throw new ProviderHttpError('esplora: unexpected response', 'esplora', undefined, undefined, false);
        return (d.chain_stats.tx_count ?? 0) + (d.mempool_stats?.tx_count ?? 0) > 0;
      }),
    );
  }

  async txExists(hash: string): Promise<boolean> {
    return this.d.guard.cached(`tx:BTC:${hash}`, TTL_ACCOUNT_META_S, () => this.call(`/tx/${hash}`, (_d, status) => status === 200, { allow404: true }));
  }
}
