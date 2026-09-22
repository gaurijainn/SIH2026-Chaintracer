import {
  IDX_INTERNAL_BASE,
  IDX_NATIVE,
  IDX_TOKEN_BASE,
  NATIVE_SYMBOL,
  assignIdx,
  evmChecksum,
  formatUnits,
  trustedTokenFor,
  type AccountMeta,
  type Chain,
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

export type EvmChain = 'ETH' | 'POLYGON' | 'BSC';

/** Etherscan V2 covers Ethereum and Polygon on the free tier via chainid. */
export const ETHERSCAN_CHAIN_ID: Partial<Record<Chain, number>> = { ETH: 1, POLYGON: 137 };
/** Blockscout serves the same module/action API per chain. Hosts are configuration, not logic. */
export const BLOCKSCOUT_HOST: Record<EvmChain, string> = {
  ETH: 'https://eth.blockscout.com',
  POLYGON: 'https://polygon.blockscout.com',
  BSC: 'https://bsc.blockscout.com',
};
export const MEGANODE_URL = 'https://bsc-mainnet.nodereal.io/v1/{MEGANODE_KEY}';

// URL builders (exported: fixture seeding must hash exactly the strings the adapter requests)
export const etherscanUrl = (chain: Chain, query: string) =>
  `https://api.etherscan.io/v2/api?chainid=${ETHERSCAN_CHAIN_ID[chain]}&${query}&apikey={ETHERSCAN_KEY}`;
export const blockscoutUrl = (chain: EvmChain, query: string) => `${BLOCKSCOUT_HOST[chain]}/api?${query}`;
export const txlistQuery = (action: 'txlist' | 'tokentx' | 'txlistinternal', addr: string, page = 1, offset = 1, extra = '') =>
  `module=account&action=${action}&address=${addr}&startblock=0&endblock=99999999&page=${page}&offset=${offset}&sort=asc${extra}`;
export const txByHashQuery = (hash: string) => `module=proxy&action=eth_getTransactionByHash&txhash=${hash}`;
export const bscActivityBody = (addr: string) => [
  { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [addr, 'latest'] },
  { jsonrpc: '2.0', id: 2, method: 'eth_getBalance', params: [addr, 'latest'] },
];

const PAGE = 1000; // Etherscan maximum offset
const MAX_WINDOW = 10_000; // Etherscan cannot page past 10,000 rows per query
type Stage = 0 | 1 | 2; // token (official stablecoin first), native, internal
const STAGES: Stage[] = [0, 1, 2];
const ACTIONS = { 0: 'tokentx', 1: 'txlist', 2: 'txlistinternal' } as const;
const MEGA_CATEGORY = { 0: ['20'], 1: ['external'], 2: ['internal'] } as const;

interface Row {
  hash: string;
  from: string;
  to: string;
  value: string;
  blockNumber: string;
  timeStamp: string;
  isError?: string;
  tokenDecimal?: string;
  contractAddress?: string;
}
interface StageResult {
  items: Transfer[];
  nextC?: string;
  provider: string;
}
interface MegaTransfer {
  hash: string;
  from: string;
  to: string;
  value: string;
  blockNum: string;
  blockTimeStamp: string | number;
  contractAddress?: string;
  logIndex?: string | number;
}

const num = (v: unknown): number => (typeof v === 'string' && v.startsWith('0x') ? Number(BigInt(v)) : Number(v));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const nonZeroHex = (v: unknown) => typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) && BigInt(v) > 0n;

/** Etherscan and Blockscout share a response envelope; some failures arrive as HTTP 200 with a message. */
export function parseEtherscanRows(data: unknown, provider: string): Row[] {
  const d = data as { status?: string; message?: string; result?: unknown };
  if (d?.status === '1' && Array.isArray(d.result)) return d.result as Row[];
  if (d?.status === '0' && Array.isArray(d.result)) return []; // "No transactions found"
  const msg = typeof d?.result === 'string' ? d.result : (d?.message ?? 'unexpected response');
  if (/rate limit|max calls|too many/i.test(msg)) throw new ProviderHttpError(`${provider}: ${msg}`, provider, 429);
  if (/result window is too large/i.test(msg)) return []; // paged past the provider's window: end of data
  throw new ProviderHttpError(`${provider}: ${msg}`, provider, undefined, undefined, false);
}

export interface EvmDeps {
  guard: ProviderGuard;
  http: HttpFactory;
  chain: EvmChain;
  pricing?: PricingService;
}

export class EvmAdapter implements ChainAdapter, ProbeCapable {
  private chain: EvmChain;
  constructor(private d: EvmDeps) {
    this.chain = d.chain;
  }

  // ---- provider plumbing -------------------------------------------------------------------------------

  /** primary first, Blockscout as the fallback */
  private providers(): ('etherscan' | 'meganode' | 'blockscout')[] {
    return this.chain === 'BSC' ? ['meganode', 'blockscout'] : ['etherscan', 'blockscout'];
  }

  private async explorer(provider: 'etherscan' | 'blockscout', query: string): Promise<unknown> {
    const url = provider === 'etherscan' ? etherscanUrl(this.chain, query) : blockscoutUrl(this.chain, query);
    return (await this.d.http(provider).get(url)).data;
  }

  private async mega(body: unknown): Promise<unknown> {
    const { data } = await this.d.http('meganode').post(MEGANODE_URL, body);
    const err = (data as { error?: { message?: string; code?: number } })?.error;
    if (err) {
      const rate = /rate|limit|too many|exceed/i.test(err.message ?? '');
      throw new ProviderHttpError(`meganode: ${err.message ?? 'error'}`, 'meganode', rate ? 429 : undefined, undefined, rate ? true : false);
    }
    return data;
  }

  // ---- transfers ---------------------------------------------------------------------------------------

  /** One provider page of one stage. Stage 0 = official stablecoin, 1 = native coin, 2 = internal native transfers. */
  async getTransfers(addr: string, dir: 'in' | 'out', o: GetTransfersOpts = {}): Promise<TransferPage> {
    const key = `xfer:${this.chain}:${addr}:${dir}:${o.since ?? ''}:${o.cursor ?? ''}`;
    const page = await this.d.guard.cached(key, TTL_FOREVER, async (): Promise<TransferPage> => {
      const cur = decodeCursor(o.cursor);
      const stage = (STAGES.includes(cur.s as Stage) ? cur.s : 0) as Stage;
      const official = trustedTokenFor(this.chain);
      // chains without a whitelisted stablecoin never trace tokens (fake-token guard)
      if (stage === 0 && !official) return { items: [], next: encodeCursor({ s: 1 }) };

      // a cursor is only valid for the provider that issued it; on failover that stage restarts on the new provider
      const steps: Step<StageResult>[] = this.providers().map((provider) => ({
        provider,
        run: async () => ({ ...(await this.fetchStage(provider, stage, addr, dir, o.since, cur.p === provider ? cur.c : undefined)), provider }),
      }));
      const { items, nextC, provider } = await this.d.guard.call(steps);
      let next: string | undefined;
      if (nextC) next = encodeCursor({ s: stage, c: nextC, p: provider });
      else if (stage < 2) next = encodeCursor({ s: stage + 1 });
      return next ? { items, next } : { items };
    });
    return this.d.pricing ? { ...page, items: await this.d.pricing.enrich(page.items) } : page;
  }

  private async fetchStage(provider: 'etherscan' | 'meganode' | 'blockscout', stage: Stage, addr: string, dir: 'in' | 'out', since?: number, c?: string) {
    return provider === 'meganode' ? this.megaStage(stage, addr, dir, since, c) : this.explorerStage(provider, stage, addr, dir, since, c);
  }

  private async explorerStage(provider: 'etherscan' | 'blockscout', stage: Stage, addr: string, dir: 'in' | 'out', since?: number, c?: string) {
    const page = c ? Number(c) : 1;
    const official = trustedTokenFor(this.chain);
    const extra = stage === 0 && official ? `&contractaddress=${official.contract}` : '';
    const rows = parseEtherscanRows(await this.explorer(provider, txlistQuery(ACTIONS[stage], addr, page, PAGE, extra)), provider);
    const base: Omit<Transfer, 'idx'>[] = [];
    for (const r of rows) {
      if (r.isError === '1' || !r.to || !r.from) continue; // failed transaction / contract creation: no value moved
      if (dir === 'out' ? !same(r.from, addr) : !same(r.to, addr)) continue;
      const ts = num(r.timeStamp) * 1000;
      if (since !== undefined && ts < since) continue;
      if (stage === 0) {
        if (!official || !r.contractAddress || !same(r.contractAddress, official.contract)) continue; // fake-token guard
        base.push(this.transfer(r, evmChecksum(official.contract), formatUnits(r.value, Number(r.tokenDecimal ?? 18)), ts));
      } else {
        if (BigInt(r.value) === 0n) continue; // contract calls without value
        base.push(this.transfer(r, NATIVE_SYMBOL[this.chain], formatUnits(r.value, 18), ts));
      }
    }
    const items = assignIdx(base, stage === 0 ? IDX_TOKEN_BASE : stage === 1 ? IDX_NATIVE : IDX_INTERNAL_BASE);
    const more = rows.length === PAGE && page * PAGE < MAX_WINDOW;
    return { items, nextC: more ? String(page + 1) : undefined };
  }

  private async megaStage(stage: Stage, addr: string, dir: 'in' | 'out', since?: number, c?: string) {
    const official = trustedTokenFor(this.chain);
    const params: Record<string, unknown> = {
      category: MEGA_CATEGORY[stage],
      [dir === 'out' ? 'fromAddress' : 'toAddress']: addr,
      order: 'asc',
      maxCount: '0x' + PAGE.toString(16),
    };
    if (stage === 0 && official) params.contractAddresses = [official.contract];
    if (stage !== 0) params.excludeZeroValue = true;
    if (c) params.pageKey = c;
    const data = (await this.mega({ jsonrpc: '2.0', id: 1, method: 'nr_getAssetTransfers', params: [params] })) as {
      result?: { transfers?: MegaTransfer[]; pageKey?: string };
    };
    if (!data.result || !Array.isArray(data.result.transfers)) throw new ProviderHttpError('meganode: unexpected response', 'meganode', undefined, undefined, false);
    const base: Omit<Transfer, 'idx'>[] = [];
    const logIdx = new Map<Omit<Transfer, 'idx'>, number>();
    for (const t of data.result.transfers) {
      if (!t.to || !t.from) continue;
      const ts = num(t.blockTimeStamp) * 1000;
      if (since !== undefined && ts < since) continue;
      if (stage === 0 && (!official || !t.contractAddress || !same(t.contractAddress, official.contract))) continue; // fake-token guard
      const row = this.transfer(
        { hash: t.hash, from: t.from, to: t.to, blockNumber: String(num(t.blockNum)) },
        stage === 0 ? evmChecksum(official!.contract) : NATIVE_SYMBOL.BSC,
        formatUnits(BigInt(t.value), 18),
        ts,
      );
      base.push(row);
      if (t.logIndex !== undefined) logIdx.set(row, num(t.logIndex));
    }
    const banded = assignIdx(base, stage === 0 ? IDX_TOKEN_BASE : stage === 1 ? IDX_NATIVE : IDX_INTERNAL_BASE);
    const items = banded.map((it, i) => (logIdx.has(base[i]) ? { ...it, idx: (stage === 0 ? IDX_TOKEN_BASE : IDX_INTERNAL_BASE) + logIdx.get(base[i])! } : it));
    return { items, nextC: data.result.pageKey || undefined };
  }

  private transfer(r: Pick<Row, 'hash' | 'from' | 'to' | 'blockNumber'>, token: string, amount: string, ts: number): Omit<Transfer, 'idx'> {
    return { chain: this.chain, txHash: r.hash.toLowerCase(), from: evmChecksum(r.from), to: evmChecksum(r.to), token, amount, ts, block: num(r.blockNumber) };
  }

  // ---- account meta / probes ---------------------------------------------------------------------------

  /** EVM has no activation concept: createdAt is the earliest transaction (or token transfer) on record. */
  async getAccountMeta(addr: string): Promise<AccountMeta> {
    return this.d.guard.cached(`meta:${this.chain}:${addr}`, TTL_ACCOUNT_META_S, async () => {
      const meta: AccountMeta = { chain: this.chain, addr, createdAt: null, activator: null, publicTag: null, flags: {}, sources: [], fetchedAt: Date.now() };
      try {
        const first = await this.earliest(addr);
        meta.createdAt = first;
        meta.sources.push(this.chain === 'BSC' ? 'meganode' : 'etherscan');
      } catch {
        meta.partial = ['createdAt'];
      }
      return meta;
    });
  }

  private async earliest(addr: string): Promise<number | null> {
    if (this.chain === 'BSC') {
      const first = async (dir: 'fromAddress' | 'toAddress') => {
        const data = (await this.mega({
          jsonrpc: '2.0', id: 1, method: 'nr_getAssetTransfers',
          params: [{ category: ['external', '20'], [dir]: addr, order: 'asc', maxCount: '0x1' }],
        })) as { result?: { transfers?: MegaTransfer[] } };
        const t = data.result?.transfers?.[0];
        return t ? num(t.blockTimeStamp) * 1000 : null;
      };
      const [a, b] = await Promise.all([first('fromAddress'), first('toAddress')]);
      return [a, b].filter((x): x is number => x !== null).sort((x, y) => x - y)[0] ?? null;
    }
    for (const action of ['txlist', 'tokentx'] as const) {
      const rows = await this.rows(txlistQuery(action, addr));
      if (rows[0]) return num(rows[0].timeStamp) * 1000;
    }
    return null;
  }

  private rows(query: string): Promise<Row[]> {
    return this.d.guard.call(
      (['etherscan', 'blockscout'] as const).map((provider) => ({
        provider,
        run: async () => parseEtherscanRows(await this.explorer(provider, query), provider),
      })),
    );
  }

  /** Any transaction or token transfer on this chain (B2 uses this to tell which EVM chain a wallet lives on). */
  async hasActivity(addr: string): Promise<boolean> {
    return this.d.guard.cached(`active:${this.chain}:${addr}`, TTL_ACCOUNT_META_S, async () => {
      if (this.chain === 'BSC') {
        return this.d.guard.call<boolean>([
          {
            provider: 'meganode',
            run: async () => {
              const { data } = await this.d.http('meganode').post(MEGANODE_URL, bscActivityBody(addr));
              if (!Array.isArray(data)) throw new ProviderHttpError('meganode: unexpected response', 'meganode', undefined, undefined, false);
              return (data as { result?: unknown }[]).some((r) => nonZeroHex(r.result)); // sent a transaction, or holds BNB
            },
          },
          {
            provider: 'blockscout',
            run: async () => parseEtherscanRows(await this.explorer('blockscout', txlistQuery('txlist', addr)), 'blockscout').length > 0,
          },
        ]);
      }
      for (const action of ['txlist', 'tokentx'] as const) if ((await this.rows(txlistQuery(action, addr))).length > 0) return true;
      return false;
    });
  }

  async txExists(hash: string): Promise<boolean> {
    return this.d.guard.cached(`tx:${this.chain}:${hash}`, TTL_ACCOUNT_META_S, async () => {
      const steps: Step<boolean>[] = this.providers().map((provider) => ({
        provider,
        run: async () => {
          if (provider === 'meganode') {
            const data = (await this.mega({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [hash] })) as { result?: unknown };
            return !!data.result;
          }
          const d = (await this.explorer(provider, txByHashQuery(hash))) as { result?: unknown; message?: string };
          if (d.result && typeof d.result === 'object') return true;
          if (d.result === null) return false;
          throw new ProviderHttpError(`${provider}: ${typeof d.result === 'string' ? d.result : 'unexpected response'}`, provider, /rate/i.test(String(d.result)) ? 429 : undefined);
        },
      }));
      return this.d.guard.call(steps);
    });
  }
}

