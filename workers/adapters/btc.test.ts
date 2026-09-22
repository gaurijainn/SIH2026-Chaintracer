import type { AxiosAdapter } from 'axios';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '@ps26183/shared';
import { createChainLayer, collectTransfers } from './index';
import { fakeTransport, reply } from './testing';

const ME = '1BWrhsLSGTPoM9vsiaFPtDahPQ73fhUdFN';
const A = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const B = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const txid = (n: number) => n.toString(16).padStart(64, '0');
const BLOCK_TIME = 1_756_000_000;

const tx = (n: number, vin: [string, number][], vout: [string | undefined, number][], confirmed = true) => ({
  txid: txid(n),
  vin: vin.map(([a, v]) => ({ prevout: { scriptpubkey_address: a, value: v } })),
  vout: vout.map(([a, v]) => ({ scriptpubkey_address: a, value: v })),
  status: confirmed ? { confirmed: true, block_height: 900_000 + n, block_time: BLOCK_TIME + n } : { confirmed: false },
});

function layer(transport: AxiosAdapter) {
  return createChainLayer({
    env: { ...loadEnv({ DATA_MODE: 'live' }), FIXTURES_DIR: 'unused' },
    transport,
    pricing: false,
    guard: { unlimited: true, sleep: async () => undefined, random: () => 0 },
  }).btc;
}

describe('BtcAdapter transfers', () => {
  it('outbound: one transfer per counterparty output, change and OP_RETURN excluded, exact 8-decimal amounts', async () => {
    const t = fakeTransport([[/address\/.+\/txs$/, () => [tx(1, [[ME, 50_000_000]], [[A, 30_000_000], [ME, 19_990_000], [undefined, 0]])]]]);
    const { items } = await layer(t).getTransfers(ME, 'out');
    expect(items).toEqual([{ chain: 'BTC', txHash: txid(1), idx: 0, from: ME, to: A, token: 'BTC', amount: '0.3', ts: (BLOCK_TIME + 1) * 1000, block: 900_001 }]);
  });

  it('inbound with several senders splits each output across the senders in proportion to their inputs', async () => {
    const t = fakeTransport([[/address\/.+\/txs$/, () => [tx(2, [[A, 30_000_000], [B, 10_000_000]], [[ME, 39_000_000], [A, 900_000]])]]]);
    const { items } = await layer(t).getTransfers(ME, 'in');
    expect(items.map((i) => [i.from, i.amount]).sort()).toEqual([[A, '0.2925'], [B, '0.0975']]);
    expect(new Set(items.map((i) => i.idx)).size).toBe(2); // distinct (txHash, idx) per sender
    const total = items.reduce((s, i) => s + Number(i.amount) * 1e8, 0);
    expect(Math.round(total)).toBe(39_000_000); // nothing created or lost
  });

  it('a spend that goes back to the same address is change, not a transfer', async () => {
    const t = fakeTransport([[/address\/.+\/txs$/, () => [tx(3, [[ME, 10_000_000]], [[ME, 9_990_000]])]]]);
    expect((await layer(t).getTransfers(ME, 'in')).items).toEqual([]);
    expect((await layer(t).getTransfers(ME, 'out')).items).toEqual([]);
  });

  it('ignores unconfirmed (mempool) transactions', async () => {
    const t = fakeTransport([[/address\/.+\/txs$/, () => [tx(4, [[ME, 5_000_000]], [[A, 4_000_000]], false), tx(5, [[ME, 5_000_000]], [[A, 4_000_000]])]]]);
    expect((await layer(t).getTransfers(ME, 'out')).items.map((i) => i.txHash)).toEqual([txid(5)]);
  });

  it('pages with /address/:a/txs then /txs/chain/:last_seen_txid (25 confirmed each) and stops on a short page', async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => tx(100 + i, [[ME, 2_000_000]], [[A, 1_000_000]]));
    const page2 = Array.from({ length: 25 }, (_, i) => tx(200 + i, [[ME, 2_000_000]], [[A, 1_000_000]]));
    const page3 = [tx(300, [[ME, 2_000_000]], [[A, 1_000_000]])];
    const t = fakeTransport([
      [new RegExp(`/txs/chain/${txid(224)}$`), () => page3],
      [new RegExp(`/txs/chain/${txid(124)}$`), () => page2],
      [/address\/.+\/txs$/, () => page1],
    ]);
    const { items, pages } = await collectTransfers(layer(t), ME, 'out');
    expect(items).toHaveLength(51);
    expect(pages).toBe(3);
    expect(t.calls.map((c) => c.url.replace(/^.*\/address\//, ''))).toEqual([`${ME}/txs`, `${ME}/txs/chain/${txid(124)}`, `${ME}/txs/chain/${txid(224)}`]);
  });
});

describe('BtcAdapter.getOutspends: /tx/:id/outspends', () => {
  it('says which transaction spent each output', async () => {
    const t = fakeTransport([[/outspends$/, () => [{ spent: true, txid: txid(9), vin: 1, status: { confirmed: true, block_height: 900_050, block_time: BLOCK_TIME + 60 } }, { spent: false }]]]);
    const out = await layer(t).getOutspends(txid(1));
    expect(t.calls[0].url).toBe(`https://blockstream.info/api/tx/${txid(1)}/outspends`);
    expect(out).toEqual([
      { vout: 0, spent: true, spendingTx: txid(9), spendingVin: 1, block: 900_050, ts: (BLOCK_TIME + 60) * 1000 },
      { vout: 1, spent: false },
    ]);
  });
});

describe('BtcAdapter reliability, meta and probes', () => {
  it('fails over to the mempool.space mirror when Esplora is unavailable', async () => {
    const t = fakeTransport([
      [/blockstream\.info/, () => reply({}, 503)],
      [/mempool\.space\/api\/address\/.+\/txs$/, () => [tx(1, [[ME, 5_000_000]], [[A, 4_000_000]])]],
    ]);
    const { items } = await layer(t).getTransfers(ME, 'out');
    expect(items).toHaveLength(1);
    expect(t.calls.some((c) => c.url.startsWith('https://mempool.space/api/'))).toBe(true);
  });

  it('createdAt comes from the oldest confirmed transaction; no activator or tag on Bitcoin', async () => {
    const t = fakeTransport([[/address\/.+\/txs$/, () => [tx(1, [[ME, 1]], [[A, 1]]), tx(7, [[ME, 1]], [[A, 1]])]]]);
    const m = await layer(t).getAccountMeta(ME);
    expect(m).toMatchObject({ chain: 'BTC', createdAt: (BLOCK_TIME + 7) * 1000, activator: null, publicTag: null });
    expect(m.partial).toBeUndefined();
  });

  it('marks createdAt partial (unknown, not wrong) when the history is longer than the bounded scan', async () => {
    const full = Array.from({ length: 25 }, (_, i) => tx(i + 1, [[ME, 1]], [[A, 1]]));
    const t = fakeTransport([[/./, () => full]]);
    const m = await layer(t).getAccountMeta(ME);
    expect(m.createdAt).toBeNull();
    expect(m.partial).toEqual(['createdAt']);
  });

  it('tx existence: 200 -> true, 404 -> false (not an error); address activity from chain + mempool stats', async () => {
    const t = fakeTransport([
      [new RegExp(`/tx/${txid(1)}$`), () => ({ txid: txid(1) })],
      [/\/tx\/[0-9a-f]{64}$/, () => reply({}, 404)],
      [/\/address\/[^/]+$/, () => ({ chain_stats: { tx_count: 0 }, mempool_stats: { tx_count: 2 } })],
    ]);
    const a = layer(t);
    expect(await a.txExists(txid(1))).toBe(true);
    expect(await a.txExists(txid(2))).toBe(false);
    expect(await a.hasActivity(ME)).toBe(true);
  });
});
