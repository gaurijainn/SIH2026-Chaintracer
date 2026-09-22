import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AxiosAdapter } from 'axios';
import { describe, expect, it } from 'vitest';
import { USDT_TRC20, loadEnv } from '@ps26183/shared';
import { MemoryCache } from './cache';
import { createChainLayer, collectTransfers, type ChainLayer } from './index';
import { DEMO, demoRoutes, demoTransport, fakeTransport, hexAddr, reply, throttled, tronAddr, type Route } from './testing';

const ADDR = tronAddr('unit-a');
const OTHER = tronAddr('unit-b');
const fast = { sleep: async () => undefined, random: () => 0 };

function layer(transport: AxiosAdapter, over: { mode?: 'live' | 'record' | 'replay'; dir?: string; env?: Record<string, string>; cache?: MemoryCache } = {}): ChainLayer {
  const env = { ...loadEnv({ DATA_MODE: over.mode ?? 'live', TRONGRID_KEY: 'tg-secret-123', TRONSCAN_KEY: 'ts-secret-456', ...over.env }), FIXTURES_DIR: over.dir ?? 'fixtures-unused' };
  return createChainLayer({ env, transport, cache: over.cache, pricing: false, guard: { unlimited: true, ...fast } });
}

const trc20 = (id: string, from: string, to: string, value: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id,
  token_info: { symbol: 'USDT', address: USDT_TRC20, decimals: 6 },
  block_timestamp: 1_756_000_000_000,
  from,
  to,
  type: 'Transfer',
  value,
  ...over,
});
const trx = (id: string, from: string, to: string, amount: number, over: Record<string, unknown> = {}) => ({
  txID: id,
  blockNumber: 61_000_001,
  block_timestamp: 1_756_000_100_000,
  ret: [{ contractRet: 'SUCCESS' }],
  raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { owner_address: hexAddr(from), to_address: hexAddr(to), amount } } }] },
  ...over,
});

describe('TronAdapter.getTransfers: request shape (plan B3)', () => {
  it('calls TronGrid trc20 with the documented params, USDT contract and API-key header', async () => {
    const t = fakeTransport([[/./, () => ({ data: [], success: true, meta: {} })]]);
    await layer(t).tron.getTransfers(ADDR, 'out', { since: 1_755_000_000_000 });
    const req = t.calls[0];
    const u = new URL(req.url);
    expect(u.origin + u.pathname).toBe(`https://api.trongrid.io/v1/accounts/${ADDR}/transactions/trc20`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      limit: '200', contract_address: USDT_TRC20, only_confirmed: 'true', only_from: 'true', min_timestamp: '1755000000000',
    });
    expect(req.headers['tron-pro-api-key']).toBe('tg-secret-123');
  });

  it('uses only_to for inbound and sends fingerprint when continuing', async () => {
    const t = fakeTransport([[/./, () => ({ data: [], success: true, meta: {} })]]);
    const a = layer(t).tron;
    await a.getTransfers(ADDR, 'in');
    expect(new URL(t.calls[0].url).searchParams.get('only_to')).toBe('true');
    expect(new URL(t.calls[0].url).searchParams.has('only_from')).toBe(false);
  });

  it('follows meta.fingerprint, then moves on to TRX transfers (/transactions), then stops', async () => {
    const t = fakeTransport([
      [/transactions\/trc20\?.*fingerprint=FP2/, () => ({ data: [trc20('b'.repeat(64), ADDR, OTHER, '2000000')], success: true, meta: {} })],
      [/transactions\/trc20\?/, () => ({ data: [trc20('a'.repeat(64), ADDR, OTHER, '1500000')], success: true, meta: { fingerprint: 'FP2' } })],
      [/transactions\?/, () => ({ data: [trx('c'.repeat(64), 'unit-a', 'unit-b', 3_500_000)], success: true, meta: {} })],
    ]);
    const a = layer(t).tron;
    const p1 = await a.getTransfers(ADDR, 'out');
    expect(p1.items.map((i) => i.amount)).toEqual(['1.5']);
    expect(p1.next).toBeDefined();
    const p2 = await a.getTransfers(ADDR, 'out', { cursor: p1.next });
    expect(new URL(t.calls[1].url).searchParams.get('fingerprint')).toBe('FP2');
    expect(p2.items.map((i) => i.amount)).toEqual(['2']);
    const p3 = await a.getTransfers(ADDR, 'out', { cursor: p2.next }); // USDT exhausted -> TRX
    expect(t.calls[2].url).toContain(`/v1/accounts/${ADDR}/transactions?`);
    expect(t.calls[2].url).not.toContain('/trc20');
    expect(p3).toEqual({ items: [expect.objectContaining({ token: 'TRX', amount: '3.5', block: 61_000_001 })] });
    expect(p3.next).toBeUndefined(); // pagination terminates
  });
});

describe('TronAdapter: normalisation', () => {
  it('returns exact decimal-string amounts, ms timestamps and the official token contract', async () => {
    const t = fakeTransport([[/trc20/, () => ({ data: [trc20('a'.repeat(64), ADDR, OTHER, '123456789')], success: true, meta: {} })]]);
    const [x] = (await layer(t).tron.getTransfers(ADDR, 'out')).items;
    expect(x).toEqual({ chain: 'TRON', txHash: 'a'.repeat(64), idx: 1, from: ADDR, to: OTHER, token: USDT_TRC20, amount: '123.456789', ts: 1_756_000_000_000, block: 0 });
    expect(typeof x.amount).toBe('string');
  });

  it('drops look-alike tokens even if a provider returns them (fake-token guard)', async () => {
    const t = fakeTransport([
      [/trc20/, () => ({
        data: [
          trc20('a'.repeat(64), ADDR, OTHER, '1000000'),
          trc20('f'.repeat(64), ADDR, OTHER, '9000000', { token_info: { symbol: 'USDT', address: 'TKX4tuVb4ApiutoibSFugfFW9nBcXaMNDe', decimals: 6 } }),
        ],
        success: true, meta: {},
      })],
    ]);
    const { items } = await layer(t).tron.getTransfers(ADDR, 'out');
    expect(items.map((i) => i.txHash)).toEqual(['a'.repeat(64)]);
  });

  it('gives several transfers of one transaction distinct, stable idx values', async () => {
    const same = 'd'.repeat(64);
    const rows = [trc20(same, ADDR, tronAddr('r1'), '1000000'), trc20(same, ADDR, tronAddr('r2'), '2000000'), trc20(same, ADDR, tronAddr('r1'), '3000000')];
    const one = async (order: unknown[]) => {
      const t = fakeTransport([[/trc20/, () => ({ data: order, success: true, meta: {} })]]);
      return (await layer(t).tron.getTransfers(ADDR, 'out')).items;
    };
    const a = await one(rows);
    const b = await one([...rows].reverse());
    expect(new Set(a.map((i) => i.idx)).size).toBe(3);
    const key = (i: { idx: number; amount: string }) => `${i.amount}@${i.idx}`;
    expect(a.map(key).sort()).toEqual(b.map(key).sort()); // same key whatever order the provider used
  });

  it('keeps only successful TransferContract transactions when reading TRX and converts hex addresses', async () => {
    const t = fakeTransport([
      [/transactions\?/, () => ({
        data: [
          trx('1'.repeat(64), 'unit-a', 'unit-b', 5_000_000),
          trx('2'.repeat(64), 'unit-a', 'unit-b', 1_000_000, { ret: [{ contractRet: 'OUT_OF_ENERGY' }] }),
          { txID: '3'.repeat(64), block_timestamp: 1, raw_data: { contract: [{ type: 'TriggerSmartContract', parameter: { value: { owner_address: hexAddr('unit-a') } } }] } },
        ],
        success: true, meta: {},
      })],
    ]);
    const { items } = await layer(t).tron.getTransfers(ADDR, 'out', { cursor: Buffer.from(JSON.stringify({ s: 1 })).toString('base64url') });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ from: ADDR, to: OTHER, amount: '5', token: 'TRX', idx: 0 });
  });

  it('rejects an unusable provider answer as a non-retried error instead of returning junk', async () => {
    const t = fakeTransport([[/trc20/, () => ({ success: false, error: 'bad address' })]]);
    await expect(layer(t).tron.getTransfers(ADDR, 'out')).rejects.toThrow(/bad address/);
    expect(t.calls).toHaveLength(1);
  });
});

describe('TronAdapter.getAccountMeta', () => {
  const routes: Route[] = [
    [/tronscanapi\.com\/api\/accountv2/, () => ({ date_created: 1_700_000_000_000, addressTag: 'Some Exchange' })],
    [/api\/security\/account\/data/, () => ({ is_black_list: true, has_fraud_transaction: false, fraud_token_creator: false, send_ad_by_memo: true })],
    [/transactions\?.*order_by=block_timestamp,asc/, () => ({ data: [trx('e'.repeat(64), 'unit-b', 'unit-a', 1_000_000, { block_timestamp: 1_690_000_000_000 })], success: true, meta: {} })],
  ];

  it('combines Tronscan detail + tag + flags with the earliest inbound TRX sender as activator', async () => {
    const t = fakeTransport(routes);
    const meta = await layer(t).tron.getAccountMeta(ADDR);
    expect(meta).toMatchObject({
      chain: 'TRON', addr: ADDR, createdAt: 1_700_000_000_000, activator: OTHER, publicTag: 'Some Exchange',
      flags: { fraudTransaction: false, fraudTokenCreator: false, stablecoinBlacklist: true, sendAdByMemo: true },
      sources: ['tronscan', 'trongrid'],
    });
    expect(meta.partial).toBeUndefined();
    const act = t.calls.find((c) => c.url.includes('order_by'))!;
    expect(new URL(act.url).searchParams.get('limit')).toBe('1');
    expect(new URL(act.url).searchParams.get('only_to')).toBe('true');
  });

  it('reports parts that failed instead of failing the whole record', async () => {
    const t = fakeTransport([[/api\/security/, () => reply({}, 500)], ...routes]);
    const meta = await layer(t).tron.getAccountMeta(ADDR);
    expect(meta.partial).toEqual(['securityFlags']);
    expect(meta.publicTag).toBe('Some Exchange');
    expect(meta.activator).toBe(OTHER);
  });

  it('falls back to the TRON full node for the creation time when Tronscan is down', async () => {
    const t = fakeTransport([
      [/tronscanapi\.com\/api\/accountv2/, () => reply({}, 503)],
      [/\/wallet\/getaccount/, () => ({ create_time: 1_650_000_000_000 })],
      ...routes.slice(1),
    ]);
    const meta = await layer(t, { env: { TRON_BACKUP_URL: 'https://node.example/key-789' } }).tron.getAccountMeta(ADDR);
    expect(meta.createdAt).toBe(1_650_000_000_000);
    expect(meta.sources).toContain('ankr');
    const backup = t.calls.find((c) => c.url.includes('getaccount'))!;
    expect(backup.url).toBe('https://node.example/key-789/wallet/getaccount');
    expect(backup.body).toEqual({ address: ADDR, visible: true });
  });

  it('is cached for one hour', async () => {
    const t = fakeTransport(routes);
    const a = layer(t).tron;
    await a.getAccountMeta(ADDR);
    const n = t.calls.length;
    await a.getAccountMeta(ADDR);
    expect(t.calls.length).toBe(n);
  });
});

describe('B3 done-when: page 1,000+ transfers of a busy TRON address', () => {
  it('never leaks a 429 (or 403) to the caller while providers throttle heavily', async () => {
    const t = throttled(demoTransport(), { every: 3, status: 429 }); // every third request is throttled
    const l = layer(t, { env: {} });
    const { items, pages, truncated } = await collectTransfers(l.tron, DEMO.tronBusy, 'out');
    expect(items).toHaveLength(1050);
    expect(new Set(items.map((i) => `${i.txHash}|${i.idx}`)).size).toBe(1050); // no duplicates, none missing
    expect(pages).toBeGreaterThanOrEqual(6);
    expect(truncated).toBe(false);
    expect(l.stats().providers.trongrid.throttled).toBeGreaterThanOrEqual(3); // it really was throttled, and recovered
    expect(items.every((i) => i.token === USDT_TRC20 && /^\d+(\.\d+)?$/.test(i.amount))).toBe(true);
  });

  it('survives a mix of 403 and 5xx as well', async () => {
    const l403 = layer(throttled(demoTransport(), { every: 4, status: 403 }));
    expect((await collectTransfers(l403.tron, DEMO.tronBusy, 'out')).items).toHaveLength(1050);
    const l502 = layer(throttled(demoTransport(), { every: 5, status: 502 }));
    expect((await collectTransfers(l502.tron, DEMO.tronBusy, 'out')).items).toHaveLength(1050);
  });

  it('a rerun is served from the cache (no provider calls)', async () => {
    const t = demoTransport();
    const l = layer(t);
    await collectTransfers(l.tron, DEMO.tronBusy, 'out');
    const calls = t.calls.length;
    const again = await collectTransfers(l.tron, DEMO.tronBusy, 'out');
    expect(again.items).toHaveLength(1050);
    expect(t.calls.length).toBe(calls);
    expect(l.stats().cache.hitRate).toBeGreaterThan(0.4);
  });

  it('replay mode returns identical results offline (recorded under throttling, replayed with the network dead)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b3-replay-'));
    const recorded = await collectTransfers(layer(throttled(demoTransport(), { every: 3 }), { mode: 'record', dir }).tron, DEMO.tronBusy, 'out');
    expect(recorded.items).toHaveLength(1050);

    const files = await readdir(path.join(dir, 'trongrid'));
    expect(files.length).toBeGreaterThanOrEqual(7); // trc20 pages + the TRX page
    // secrets never reach the fixtures
    for (const f of files) {
      const text = await readFile(path.join(dir, 'trongrid', f), 'utf8');
      expect(text).not.toContain('tg-secret-123');
    }

    const dead = (async () => {
      throw new Error('NETWORK MUST NOT BE USED IN REPLAY');
    }) as unknown as AxiosAdapter;
    const replayed = await collectTransfers(layer(dead, { mode: 'replay', dir }).tron, DEMO.tronBusy, 'out');
    expect(replayed.items).toEqual(recorded.items);
    expect(replayed.pages).toBe(recorded.pages);
  });

  it('honours min_timestamp (since) end to end', async () => {
    const since = DEMO.t0 - 99 * 60_000; // newest 100 transfers
    const { items } = await collectTransfers(layer(demoTransport()).tron, DEMO.tronBusy, 'out', { since });
    expect(items).toHaveLength(100);
    expect(Math.min(...items.map((i) => i.ts))).toBeGreaterThanOrEqual(since);
  });
});

describe('probes used by complaint intake', () => {
  it('txExists / hasActivity answer from TronGrid and are cached', async () => {
    const t = fakeTransport(demoRoutes());
    const a = layer(t).tron;
    expect(await a.hasActivity(DEMO.tronBusy)).toBe(true);
    expect(await a.txExists('0'.repeat(64))).toBe(false);
    const n = t.calls.length;
    await a.hasActivity(DEMO.tronBusy);
    expect(t.calls.length).toBe(n);
  });
});
