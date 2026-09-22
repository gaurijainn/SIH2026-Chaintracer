import type { AxiosAdapter } from 'axios';
import { describe, expect, it } from 'vitest';
import { BSC_USD, IDX_INTERNAL_BASE, USDT_ERC20, loadEnv, type Chain } from '@ps26183/shared';
import { createChainLayer, collectTransfers } from './index';
import { fakeTransport, reply } from './testing';

const ME = '0x73fE180027a6F3e1461906039b2Fa0f90E0C8863';
const YOU = '0xC26CD860769C4404e7e0C407BD93f0Dbb429264e';
const TS = 1_756_000_000;
const h = (n: number) => '0x' + n.toString(16).padStart(64, '0');

function layer(transport: AxiosAdapter, env: Record<string, string> = {}) {
  return createChainLayer({
    env: { ...loadEnv({ DATA_MODE: 'live', ETHERSCAN_KEY: 'es-secret', MEGANODE_KEY: 'mn-secret', ...env }), FIXTURES_DIR: 'unused' },
    transport,
    pricing: false,
    guard: { unlimited: true, sleep: async () => undefined, random: () => 0 },
  });
}

const tokenRow = (n: number, over: Record<string, unknown> = {}) => ({
  hash: h(n), from: ME.toLowerCase(), to: YOU.toLowerCase(), value: '2500000', tokenDecimal: '6',
  contractAddress: USDT_ERC20.toLowerCase(), blockNumber: '23000000', timeStamp: String(TS), ...over,
});
const nativeRow = (n: number, over: Record<string, unknown> = {}) => ({
  hash: h(n), from: ME.toLowerCase(), to: YOU.toLowerCase(), value: '1500000000000000000', isError: '0', blockNumber: '23000001', timeStamp: String(TS + 1), ...over,
});
const ok = (result: unknown[]) => ({ status: '1', message: 'OK', result });
const none = { status: '0', message: 'No transactions found', result: [] };
const action = (url: string) => new URL(url).searchParams.get('action');

describe('EvmAdapter (Ethereum / Polygon via Etherscan V2)', () => {
  it('requests the plan endpoints with chainid, paging params and the official token filter', async () => {
    const t = fakeTransport([[/./, () => none]]);
    const a = layer(t).adapter('ETH');
    const p1 = await a.getTransfers(ME, 'out');
    const u = new URL(t.calls[0].url);
    expect(u.origin + u.pathname).toBe('https://api.etherscan.io/v2/api');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ chainid: '1', module: 'account', action: 'tokentx', address: ME, page: '1', offset: '1000', contractaddress: USDT_ERC20, apikey: 'es-secret' });
    const p2 = await a.getTransfers(ME, 'out', { cursor: p1.next });
    expect(action(t.calls[1].url)).toBe('txlist');
    await a.getTransfers(ME, 'out', { cursor: p2.next });
    expect(action(t.calls[2].url)).toBe('txlistinternal');
  });

  it('uses chainid=137 for Polygon and never traces tokens there (no whitelisted stablecoin)', async () => {
    const t = fakeTransport([[/./, () => none]]);
    const a = layer(t).adapter('POLYGON');
    const first = await a.getTransfers(ME, 'out');
    expect(first.items).toEqual([]);
    expect(t.calls).toHaveLength(0); // token stage skipped without a call
    await a.getTransfers(ME, 'out', { cursor: first.next });
    expect(new URL(t.calls[0].url).searchParams.get('chainid')).toBe('137');
    expect(action(t.calls[0].url)).toBe('txlist');
  });

  it('walks token -> native -> internal and terminates', async () => {
    const t = fakeTransport([
      [/action=tokentx/, () => ok([tokenRow(1)])],
      [/action=txlistinternal/, () => none],
      [/action=txlist&/, () => ok([nativeRow(2)])],
    ]);
    const { items, pages, truncated } = await collectTransfers(layer(t).adapter('ETH'), ME, 'out');
    expect(items.map((i) => i.token)).toEqual([USDT_ERC20, 'ETH']);
    expect(pages).toBe(3);
    expect(truncated).toBe(false);
  });

  it('pages a stage while a full page of 1,000 comes back, and stops on the first short page', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => nativeRow(i + 1, { hash: h(i + 1) }));
    const t = fakeTransport([
      [/action=tokentx/, () => none],
      [/action=txlist&.*page=1&/, () => ok(full)],
      [/action=txlist&.*page=2&/, () => ok([nativeRow(5000)])],
      [/action=txlistinternal/, () => none],
    ]);
    const { items } = await collectTransfers(layer(t).adapter('ETH'), ME, 'out');
    expect(items).toHaveLength(1001);
    expect(t.calls.filter((c) => action(c.url) === 'txlist')).toHaveLength(2);
  });

  it('normalises: EIP-55 addresses, exact decimals, ms timestamps, block numbers', async () => {
    const t = fakeTransport([[/action=tokentx/, () => ok([tokenRow(1)])]]);
    const [x] = (await layer(t).adapter('ETH').getTransfers(ME, 'out')).items;
    expect(x).toEqual({ chain: 'ETH', txHash: h(1), idx: 1, from: ME, to: YOU, token: USDT_ERC20, amount: '2.5', ts: TS * 1000, block: 23_000_000 });
  });

  it('drops look-alike tokens, failed transactions, zero-value calls, contract creations and the wrong direction', async () => {
    const t = fakeTransport([
      [/action=tokentx/, () => ok([tokenRow(1), tokenRow(2, { contractAddress: '0x' + 'ab'.repeat(20) }), tokenRow(3, { from: YOU.toLowerCase(), to: ME.toLowerCase() })])],
      [/action=txlist&/, () => ok([nativeRow(4), nativeRow(5, { isError: '1' }), nativeRow(6, { value: '0' }), nativeRow(7, { to: '' })])],
      [/action=txlistinternal/, () => none],
    ]);
    const { items } = await collectTransfers(layer(t).adapter('ETH'), ME, 'out');
    expect(items.map((i) => i.txHash)).toEqual([h(1), h(4)]);
    const inbound = await collectTransfers(layer(fakeTransport([
      [/action=tokentx/, () => ok([tokenRow(1), tokenRow(3, { from: YOU.toLowerCase(), to: ME.toLowerCase() })])],
      [/./, () => none],
    ])).adapter('ETH'), ME, 'in');
    expect(inbound.items.map((i) => i.txHash)).toEqual([h(3)]);
  });

  it('keeps native, token and internal transfers of ONE transaction under distinct (txHash, idx) keys', async () => {
    const same = 42;
    const t = fakeTransport([
      [/action=tokentx/, () => ok([tokenRow(same)])],
      [/action=txlist&/, () => ok([nativeRow(same)])],
      [/action=txlistinternal/, () => ok([{ ...nativeRow(same), value: '7', traceId: '0_1' }])],
    ]);
    const { items } = await collectTransfers(layer(t).adapter('ETH'), ME, 'out');
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => `${i.txHash}|${i.idx}`)).size).toBe(3);
    expect(items.some((i) => i.idx >= IDX_INTERNAL_BASE)).toBe(true); // internal traces live in their own band
  });

  it('honours since', async () => {
    const t = fakeTransport([[/action=txlist&/, () => ok([nativeRow(1, { timeStamp: String(TS - 100) }), nativeRow(2, { timeStamp: String(TS + 100) })])], [/./, () => none]]);
    const { items } = await collectTransfers(layer(t).adapter('ETH'), ME, 'out', { since: TS * 1000 });
    expect(items.map((i) => i.txHash)).toEqual([h(2)]);
  });
});

describe('EvmAdapter reliability', () => {
  it('treats "Max rate limit reached" delivered inside an HTTP 200 as a 429: retries and recovers', async () => {
    let n = 0;
    const t = fakeTransport([[/action=tokentx/, () => (n++ < 2 ? { status: '0', message: 'NOTOK', result: 'Max rate limit reached' } : ok([tokenRow(1)]))]]);
    const l = layer(t);
    const { items } = await l.adapter('ETH').getTransfers(ME, 'out');
    expect(items).toHaveLength(1);
    expect(l.stats().providers.etherscan).toMatchObject({ retries: 2, throttled: 2 });
  });

  it('fails over to Blockscout (same API on its own host, no API key) when Etherscan is down', async () => {
    const t = fakeTransport([
      [/api\.etherscan\.io/, () => reply({}, 503)],
      [/eth\.blockscout\.com\/api\?/, () => ok([tokenRow(1)])],
    ]);
    const l = layer(t);
    const { items } = await l.adapter('ETH').getTransfers(ME, 'out');
    expect(items).toHaveLength(1);
    const bs = t.calls.find((c) => c.url.includes('blockscout'))!;
    expect(bs.url).toMatch(/^https:\/\/eth\.blockscout\.com\/api\?module=account&action=tokentx&address=/);
    expect(bs.url).not.toContain('es-secret');
    expect(l.stats().providers.etherscan.failovers).toBeGreaterThanOrEqual(1);
  });

  it('reports ProviderUnavailableError (not a raw error) when both providers fail', async () => {
    const t = fakeTransport([[/./, () => reply({}, 503)]]);
    await expect(layer(t).adapter('ETH').getTransfers(ME, 'out')).rejects.toThrow(/all providers failed: etherscan.*blockscout/);
  });

  it('does not put the API key in a fixture-hash URL: URLs carry {ETHERSCAN_KEY} until the live call', async () => {
    const t = fakeTransport([[/./, () => none]]);
    const seen: string[] = [];
    const l = createChainLayer({
      env: { ...loadEnv({ DATA_MODE: 'live', ETHERSCAN_KEY: 'es-secret' }), FIXTURES_DIR: 'x' },
      transport: (async (c: never) => (seen.push((c as { url: string }).url), t(c))) as unknown as AxiosAdapter,
      pricing: false,
      guard: { unlimited: true },
    });
    await l.adapter('ETH').getTransfers(ME, 'out');
    expect(seen[0]).toContain('apikey=es-secret'); // substituted only for the real request
  });
});

describe('EvmAdapter: BSC through MegaNode (nr_getAssetTransfers), Blockscout as fallback', () => {
  const mega = (transfers: unknown[], pageKey?: string) => ({ jsonrpc: '2.0', id: 1, result: { transfers, ...(pageKey ? { pageKey } : {}) } });
  const megaTx = (n: number, over: Record<string, unknown> = {}) => ({
    hash: h(n), from: ME.toLowerCase(), to: YOU.toLowerCase(), value: '0x' + (5n * 10n ** 18n).toString(16), blockNum: '0x1e8480',
    blockTimeStamp: TS, contractAddress: BSC_USD.toLowerCase(), ...over,
  });

  it('asks for BSC-USD by category "20" and contract, from the address, and follows pageKey', async () => {
    const t = fakeTransport([
      [/nodereal\.io/, (r) => {
        const p = (r.body as { params: [Record<string, unknown>] }).params[0];
        return p.pageKey ? mega([megaTx(2)]) : mega([megaTx(1)], 'KEY2');
      }],
    ]);
    const a = layer(t).adapter('BSC');
    const p1 = await a.getTransfers(ME, 'out');
    const body = t.calls[0].body as { method: string; params: [Record<string, unknown>] };
    expect(t.calls[0].url).toBe('https://bsc-mainnet.nodereal.io/v1/mn-secret');
    expect(body.method).toBe('nr_getAssetTransfers');
    expect(body.params[0]).toMatchObject({ category: ['20'], fromAddress: ME, contractAddresses: [BSC_USD], order: 'asc' });
    expect(p1.items[0]).toMatchObject({ chain: 'BSC', token: '0x55d398326f99059fF775485246999027B3197955', amount: '5', block: 2_000_000, ts: TS * 1000 });
    const p2 = await a.getTransfers(ME, 'out', { cursor: p1.next });
    expect((t.calls[1].body as { params: [Record<string, unknown>] }).params[0].pageKey).toBe('KEY2');
    expect(p2.items).toHaveLength(1);
  });

  it('a look-alike token from the provider is dropped', async () => {
    const t = fakeTransport([[/nodereal/, () => mega([megaTx(1, { contractAddress: '0x' + 'cd'.repeat(20) })])]]);
    expect((await layer(t).adapter('BSC').getTransfers(ME, 'out')).items).toEqual([]);
  });

  it('on failover the MegaNode cursor is not sent to Blockscout: that stage restarts on the new provider', async () => {
    let meganodeUp = true;
    const t = fakeTransport([
      [/nodereal/, () => (meganodeUp ? mega([megaTx(1)], 'KEY2') : reply({}, 503))],
      [/bsc\.blockscout\.com\/api\?/, () => ok([tokenRow(9, { contractAddress: BSC_USD.toLowerCase() })])],
    ]);
    const a = layer(t).adapter('BSC');
    const p1 = await a.getTransfers(ME, 'out');
    meganodeUp = false;
    const p2 = await a.getTransfers(ME, 'out', { cursor: p1.next });
    const bs = t.calls.find((c) => c.url.includes('blockscout'))!;
    expect(new URL(bs.url).searchParams.get('page')).toBe('1'); // not "KEY2"
    expect(p2.items).toHaveLength(1);
  });
});

describe('EvmAdapter.getAccountMeta / probes', () => {
  it('createdAt is the earliest transaction; there is no activator on EVM', async () => {
    const t = fakeTransport([[/action=txlist&/, () => ok([nativeRow(1, { timeStamp: '1600000000' })])]]);
    const m = await layer(t).adapter('ETH').getAccountMeta(ME);
    expect(m).toMatchObject({ chain: 'ETH', addr: ME, createdAt: 1_600_000_000_000, activator: null, publicTag: null });
    const u = new URL(t.calls[0].url);
    expect([u.searchParams.get('sort'), u.searchParams.get('offset')]).toEqual(['asc', '1']);
  });

  it('hasActivity looks at native transactions then token transfers, and is cached', async () => {
    const t = fakeTransport([[/action=txlist&/, () => none], [/action=tokentx/, () => ok([tokenRow(1)])]]);
    const a = layer(t).adapter('ETH');
    expect(await a.hasActivity(ME)).toBe(true);
    const n = t.calls.length;
    expect(await a.hasActivity(ME)).toBe(true);
    expect(t.calls.length).toBe(n);
  });

  it.each<[Chain, string]>([['ETH', 'etherscan'], ['BSC', 'nodereal']])('txExists on %s', async (chain, host) => {
    const t = fakeTransport([[new RegExp(host), () => (chain === 'BSC' ? { result: { hash: h(1) } } : { jsonrpc: '2.0', id: 1, result: { hash: h(1) } })]]);
    expect(await layer(t).adapter(chain).txExists(h(1))).toBe(true);
  });
});
