import {
  IDX_NATIVE,
  IDX_TOKEN_BASE,
  USDT_TRC20,
  assignIdx,
  formatUnits,
  tronHexToBase58,
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
import type { ProviderGuard } from './providerGuard';
import type { PricingService } from './pricing';
import { decodeCursor, encodeCursor } from './paginate';

export const TRONGRID = 'https://api.trongrid.io';
export const TRONSCAN = 'https://apilist.tronscanapi.com';
export const TRONGRID_TX_URL = `${TRONGRID}/wallet/gettransactionbyid`;
const PAGE = 200;
const TRONGRID_HEADERS = { 'TRON-PRO-API-KEY': '{TRONGRID_KEY}' };
const TRONSCAN_HEADERS = { 'TRON-PRO-API-KEY': '{TRONSCAN_KEY}' };

const STAGE_TRC20 = 0; // USDT first
const STAGE_TRX = 1;

interface TronGridList<T> {
  data?: T[];
  success?: boolean;
  error?: string;
  meta?: { fingerprint?: string };
}
interface Trc20Item {
  transaction_id: string;
  token_info?: { address?: string; decimals?: number };
  block_timestamp: number;
  from: string;
  to: string;
  type?: string;
  value: string;
}
interface TrxItem {
  txID: string;
  blockNumber?: number;
  block_timestamp: number;
  ret?: { contractRet?: string }[];
  raw_data?: { contract?: { type?: string; parameter?: { value?: { owner_address?: string; to_address?: string; amount?: number | string } } }[] };
}

const BLACKLIST_EVENT = 'AddedBlackList';

interface TronGridEventItem {
  transaction_id: string;
  block_number: number;
  block_timestamp: number;
  event_name: string;
  /** TronGrid's contract-event decoder names the indexed param after the ABI; USDT-TRC20's
   * AddedBlackList(address _user) surfaces it as `result._user` (hex, 41-prefixed). Fall back to
   * any other single-value result shape rather than assuming the exact key never changes. */
  result?: Record<string, string>;
}

/** One `AddedBlackList` event: the address Tether blacklisted, and the tx/block evidence for it. */
export interface BlacklistEvent {
  address: string;
  txHash: string;
  blockNumber: number;
  blockTimestampMs: number;
}

export interface BlacklistEventPage {
  items: BlacklistEvent[];
  next?: string;
}

function normalizeBlacklistEvent(r: TronGridEventItem): BlacklistEvent | null {
  const raw = r.result?._user ?? r.result?.user ?? r.result?.addr ?? Object.values(r.result ?? {})[0];
  if (!raw) return null;
  const clean = raw.replace(/^0x/, '');
  let address: string;
  if (/^41[0-9a-fA-F]{40}$/.test(clean)) {
    // Tron's own 21-byte hex convention (0x41-prefixed), as used by its REST account APIs.
    address = tronHexToBase58(clean);
  } else if (/^[0-9a-fA-F]{40}$/.test(clean)) {
    // TronGrid's contract-event decoder emits the ABI `address` type as a bare 20-byte EVM value
    // (no Tron 0x41 version byte) -- unlike its REST APIs. Prepend the version byte before converting.
    address = tronHexToBase58(`41${clean}`);
  } else {
    address = raw; // already base58, or an unrecognized shape -- pass through rather than drop
  }
  return { address, txHash: r.transaction_id, blockNumber: r.block_number, blockTimestampMs: r.block_timestamp };
}

export interface TronDeps {
  guard: ProviderGuard;
  http: HttpFactory;
  pricing?: PricingService;
  /** Chainstack/Ankr TRON full node; only used as a backup for account creation time */
}

export class TronAdapter implements ChainAdapter, ProbeCapable {
  constructor(private d: TronDeps) {}

  private listUrl(path: 'trc20' | 'trx', addr: string, dir: 'in' | 'out', since?: number, cursor?: string, extra: string[] = []) {
    const q = [`limit=${PAGE}`];
    if (path === 'trc20') q.push(`contract_address=${USDT_TRC20}`);
    q.push('only_confirmed=true', dir === 'out' ? 'only_from=true' : 'only_to=true');
    if (since !== undefined) q.push(`min_timestamp=${since}`);
    if (cursor) q.push(`fingerprint=${encodeURIComponent(cursor)}`);
    q.push(...extra);
    return `${TRONGRID}/v1/accounts/${addr}/transactions${path === 'trc20' ? '/trc20' : ''}?${q.join('&')}`;
  }

  private async trongrid<T>(url: string): Promise<TronGridList<T>> {
    return this.d.guard.call([
      {
        provider: 'trongrid',
        run: async () => {
          const { data } = await this.d.http('trongrid').get<TronGridList<T>>(url, { headers: TRONGRID_HEADERS });
          if (!data || data.success === false || !Array.isArray(data.data)) {
            throw new ProviderHttpError(`trongrid: ${data?.error ?? 'unexpected response'}`, 'trongrid', undefined, undefined, false);
          }
          return data;
        },
      },
    ]);
  }

  /** One page of USDT-TRC20 (stage 0) then TRX (stage 1) transfers, following meta.fingerprint. */
  async getTransfers(addr: string, dir: 'in' | 'out', o: GetTransfersOpts = {}): Promise<TransferPage> {
    const key = `xfer:TRON:${addr}:${dir}:${o.since ?? ''}:${o.cursor ?? ''}`;
    const page = await this.d.guard.cached(key, TTL_FOREVER, async (): Promise<TransferPage> => {
      const cur = decodeCursor(o.cursor);
      const stage = cur.s === STAGE_TRX ? STAGE_TRX : STAGE_TRC20;
      const isTrc20 = stage === STAGE_TRC20;
      const res = await this.trongrid<Trc20Item | TrxItem>(this.listUrl(isTrc20 ? 'trc20' : 'trx', addr, dir, o.since, cur.c));
      const items = isTrc20 ? this.normalizeTrc20(res.data as Trc20Item[]) : this.normalizeTrx(res.data as TrxItem[]);
      const fp = res.meta?.fingerprint;
      let next: string | undefined;
      if (fp && fp !== cur.c) next = encodeCursor({ s: stage, c: fp });
      else if (isTrc20) next = encodeCursor({ s: STAGE_TRX });
      return next ? { items, next } : { items };
    });
    return this.d.pricing ? { ...page, items: await this.d.pricing.enrich(page.items) } : page;
  }

  private normalizeTrc20(rows: Trc20Item[]): Transfer[] {
    const base = rows
      .filter((r) => (r.type ?? 'Transfer') === 'Transfer' && r.token_info?.address === USDT_TRC20) // official contract only
      .map((r) => ({
        chain: 'TRON' as const,
        txHash: r.transaction_id,
        from: r.from,
        to: r.to,
        token: USDT_TRC20,
        amount: formatUnits(r.value, r.token_info?.decimals ?? 6),
        ts: r.block_timestamp,
        block: 0, // TronGrid's TRC-20 history does not report the block number
      }));
    return assignIdx(base, IDX_TOKEN_BASE);
  }

  private normalizeTrx(rows: TrxItem[]): Transfer[] {
    const out: Omit<Transfer, 'idx'>[] = [];
    for (const r of rows) {
      const c = r.raw_data?.contract?.[0];
      const v = c?.parameter?.value;
      if (c?.type !== 'TransferContract' || !v?.owner_address || !v.to_address || v.amount === undefined) continue; // contract calls carry no TRX value transfer
      if (r.ret?.[0]?.contractRet && r.ret[0].contractRet !== 'SUCCESS') continue; // failed transactions move nothing
      out.push({
        chain: 'TRON',
        txHash: r.txID,
        from: tronHexToBase58(v.owner_address),
        to: tronHexToBase58(v.to_address),
        token: 'TRX',
        amount: formatUnits(BigInt(v.amount), 6),
        ts: r.block_timestamp,
        block: r.blockNumber ?? 0,
      });
    }
    return assignIdx(out, IDX_NATIVE);
  }

  /**
   * Account detail and public tag (Tronscan), security flags (Tronscan Security Service), and the activator:
   * the sender of the account's earliest inbound TRX transfer (TronGrid). Cached one hour. A failing part is
   * reported in `partial` instead of failing the whole record.
   */
  async getAccountMeta(addr: string): Promise<AccountMeta> {
    return this.d.guard.cached(`meta:TRON:${addr}`, TTL_ACCOUNT_META_S, async () => {
      const meta: AccountMeta = { chain: 'TRON', addr, createdAt: null, activator: null, publicTag: null, flags: {}, sources: [], partial: [], fetchedAt: Date.now() };
      const tron = this.d.http('tronscan');

      await this.part(meta, 'detail', async () => {
        const data = await this.d.guard.call([
          {
            provider: 'tronscan',
            run: async () => (await tron.get(`${TRONSCAN}/api/accountv2?address=${addr}`, { headers: TRONSCAN_HEADERS })).data as Record<string, unknown>,
          },
          {
            // backup: the TRON full node can still tell when the account was created
            provider: 'ankr',
            run: async () => {
              const r = await this.d.http('ankr').post('{TRON_BACKUP_URL}/wallet/getaccount', { address: addr, visible: true });
              const created = (r.data as { create_time?: number })?.create_time;
              if (!created) throw new ProviderHttpError('ankr: account not found', 'ankr', 404, undefined, false);
              return { date_created: created, _via: 'ankr' } as Record<string, unknown>;
            },
          },
        ]);
        const created = Number(data.date_created);
        meta.createdAt = Number.isFinite(created) && created > 0 ? created : null;
        const tag = data.addressTag ?? data.address_tag;
        meta.publicTag = typeof tag === 'string' && tag.trim() ? tag.trim() : null;
        meta.sources.push(data._via === 'ankr' ? 'ankr' : 'tronscan');
      });

      await this.part(meta, 'securityFlags', async () => {
        const data = await this.d.guard.call([
          {
            provider: 'tronscan',
            run: async () =>
              (await tron.get(`${TRONSCAN}/api/security/account/data?address=${addr}`, { headers: TRONSCAN_HEADERS })).data as Record<string, unknown>,
          },
        ]);
        const b = (v: unknown) => (typeof v === 'boolean' ? v : null);
        meta.flags = {
          fraudTransaction: b(data.has_fraud_transaction),
          fraudTokenCreator: b(data.fraud_token_creator),
          stablecoinBlacklist: b(data.is_black_list),
          sendAdByMemo: b(data.send_ad_by_memo),
        };
        if (!meta.sources.includes('tronscan')) meta.sources.push('tronscan');
      });

      await this.part(meta, 'activator', async () => {
        const url = this.listUrl('trx', addr, 'in', undefined, undefined, ['order_by=block_timestamp,asc']).replace(`limit=${PAGE}`, 'limit=1');
        const res = await this.trongrid<TrxItem>(url);
        const first = this.normalizeTrx(res.data ?? [])[0];
        if (first) {
          meta.activator = first.from;
          if (meta.createdAt === null) meta.createdAt = first.ts;
        }
        meta.sources.push('trongrid');
      });

      if (!meta.partial?.length) delete meta.partial;
      return meta;
    });
  }

  private async part(meta: AccountMeta, name: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch {
      meta.partial!.push(name);
    }
  }

  /** TronGrid account record exists once the address has been activated. */
  async hasActivity(addr: string): Promise<boolean> {
    return this.d.guard.cached(`active:TRON:${addr}`, TTL_ACCOUNT_META_S, async () => {
      const res = await this.trongrid<unknown>(`${TRONGRID}/v1/accounts/${addr}`);
      return (res.data?.length ?? 0) > 0;
    });
  }

  async txExists(hash: string): Promise<boolean> {
    return this.d.guard.cached(`tx:TRON:${hash}`, TTL_ACCOUNT_META_S, async () => {
      const data = await this.d.guard.call([
        {
          provider: 'trongrid',
          run: async () => (await this.d.http('trongrid').post(TRONGRID_TX_URL, { value: hash }, { headers: TRONGRID_HEADERS })).data as { txID?: string },
        },
      ]);
      return !!data?.txID;
    });
  }

  private blacklistUrl(cursor?: string): string {
    const q = [`event_name=${BLACKLIST_EVENT}`, 'only_confirmed=true', `limit=${PAGE}`];
    if (cursor) q.push(`fingerprint=${encodeURIComponent(cursor)}`);
    return `${TRONGRID}/v1/contracts/${USDT_TRC20}/events?${q.join('&')}`;
  }

  /**
   * One page of USDT-TRC20 `AddedBlackList` contract events (Tether's on-chain blacklist), newest
   * first as TronGrid returns them, following `meta.fingerprint` exactly like `getTransfers`'s
   * TRC-20 stage. Cached forever per cursor (blacklist events never change once confirmed).
   */
  async getAddedBlackListEvents(o: { cursor?: string } = {}): Promise<BlacklistEventPage> {
    const key = `blacklist:TRON:${USDT_TRC20}:${o.cursor ?? ''}`;
    return this.d.guard.cached(key, TTL_FOREVER, async () => {
      const res = await this.trongrid<TronGridEventItem>(this.blacklistUrl(o.cursor));
      const items = (res.data ?? []).filter((r) => r.event_name === BLACKLIST_EVENT).map(normalizeBlacklistEvent).filter((e): e is BlacklistEvent => e !== null);
      const fp = res.meta?.fingerprint;
      return fp ? { items, next: fp } : { items };
    });
  }
}

/**
 * Walks every page of USDT-TRC20 `AddedBlackList` events and returns them de-duplicated by
 * (txHash, address) — a provider retry/failover can otherwise resurface the same event twice.
 * Terminates when TronGrid stops returning a fingerprint, when a fingerprint repeats, or at the
 * page ceiling (same shape as `collectTransfers` in paginate.ts).
 */
export async function collectAddedBlackListEvents(tron: TronAdapter, opts: { maxPages?: number } = {}): Promise<{ items: BlacklistEvent[]; pages: number; truncated: boolean }> {
  const maxPages = opts.maxPages ?? 500;
  const seen = new Set<string>();
  const items: BlacklistEvent[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await tron.getAddedBlackListEvents({ cursor });
    pages++;
    for (const e of page.items) {
      const k = `${e.txHash}|${e.address}`;
      if (!seen.has(k)) {
        seen.add(k);
        items.push(e);
      }
    }
    if (!page.next) return { items, pages, truncated: false };
    if (cursors.has(page.next) || page.next === cursor) return { items, pages, truncated: false };
    cursors.add(page.next);
    cursor = page.next;
    if (pages >= maxPages) return { items, pages, truncated: true };
  }
}
