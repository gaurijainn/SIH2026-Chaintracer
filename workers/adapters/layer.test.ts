import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AxiosAdapter } from 'axios';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '@ps26183/shared';
import { createChainLayer, collectTransfers } from './index';
import { DEMO, demoTransport } from './testing';

const NOW = DEMO.t0 + 21 * 86_400_000; // fixed clock: pricing history window is reproducible
const SECRETS = {
  TRONGRID_KEY: 'SECRET-trongrid-111', TRONSCAN_KEY: 'SECRET-tronscan-222', ETHERSCAN_KEY: 'SECRET-etherscan-333', MEGANODE_KEY: 'SECRET-meganode-444',
  COINGECKO_DEMO_KEY: 'SECRET-coingecko-555', BLOCKSCOUT_KEY: 'SECRET-blockscout-666', TRON_BACKUP_URL: 'https://node.example/SECRET-ankr-777',
};
const dead = (async () => {
  throw new Error('NETWORK MUST NOT BE USED IN REPLAY');
}) as unknown as AxiosAdapter;

const layer = (mode: 'record' | 'replay', dir: string, transport: AxiosAdapter, sleeps: number[] = []) =>
  createChainLayer({
    env: { ...loadEnv({ DATA_MODE: mode, ...SECRETS }), FIXTURES_DIR: dir },
    transport,
    synthetic: true,
    now: () => NOW,
    guard: { sleep: async (ms) => void sleeps.push(ms), unlimited: true },
  });

/** everything the layer can return for the demo wallets, in one comparable object */
async function readEverything(l: ReturnType<typeof layer>) {
  const btcTx = (await l.btc.getTransfers(DEMO.btcAddr, 'out')).items[0].txHash;
  return {
    tron: (await collectTransfers(l.tron, DEMO.tronBusy, 'out')).items,
    tronMeta: { ...(await l.tron.getAccountMeta(DEMO.tronBusy)), fetchedAt: 0 },
    eth: (await collectTransfers(l.adapter('ETH'), DEMO.ethAddr, 'out')).items,
    btc: (await collectTransfers(l.btc, DEMO.btcAddr, 'out')).items,
    outspends: await l.btc.getOutspends(btcTx),
  };
}

describe('record / replay across the whole provider layer', () => {
  it('replays byte-identical results offline after recording, including prices, metadata and outspends', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b3-all-'));
    const recorded = await readEverything(layer('record', dir, demoTransport()));
    expect(recorded.tron).toHaveLength(1050);
    expect(recorded.tron.every((t) => typeof t.usd === 'number')).toBe(true); // priced at each timestamp
    expect(recorded.eth.map((t) => t.token)).toEqual(['0xdAC17F958D2ee523a2206206994597C13D831ec7', 'ETH']);
    expect(recorded.tronMeta).toMatchObject({ activator: DEMO.tronActivator, flags: { fraudTransaction: true } });
    expect(recorded.outspends[0]).toMatchObject({ spent: true });

    const replayed = await readEverything(layer('replay', dir, dead));
    expect(replayed).toEqual(recorded);
  });

  it('never writes a secret into a fixture, and stores URLs with {KEY} placeholders', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b3-secrets-'));
    await readEverything(layer('record', dir, demoTransport()));
    let checked = 0;
    let placeholders = 0;
    for (const provider of await readdir(dir)) {
      for (const f of await readdir(path.join(dir, provider))) {
        const text = await readFile(path.join(dir, provider, f), 'utf8');
        for (const secret of Object.values(SECRETS)) expect(text, `${provider}/${f}`).not.toContain(secret.replace('https://node.example/', ''));
        const fx = JSON.parse(text);
        expect(fx.synthetic).toBe(true);
        if (/\{[A-Z_]+_KEY\}/.test(fx.request.url)) placeholders++;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(15);
    expect(placeholders).toBeGreaterThan(0); // e.g. Etherscan's apikey={ETHERSCAN_KEY}
  });

  it('a replay miss fails fast: no retries, no back-off, a clear message', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b3-miss-'));
    const sleeps: number[] = [];
    const l = layer('replay', dir, dead, sleeps);
    await expect(l.tron.getTransfers(DEMO.tronBusy, 'out')).rejects.toThrow(/replay fixture missing for trongrid/);
    expect(sleeps).toEqual([]);
    expect(l.stats().providers.trongrid.retries).toBe(0);
  });

  it('replay mode applies no rate limiting or back-off (local reads only)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b3-fast-'));
    await collectTransfers(layer('record', dir, demoTransport()).tron, DEMO.tronBusy, 'out');
    const t0 = Date.now();
    const l = createChainLayer({ env: { ...loadEnv({ DATA_MODE: 'replay' }), FIXTURES_DIR: dir }, transport: dead, pricing: false, now: () => NOW });
    expect((await collectTransfers(l.tron, DEMO.tronBusy, 'out')).items).toHaveLength(1050);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a rerun over the Redis-style cache reports a high hit rate (plan target: above 60%)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b3-hit-'));
    const l = layer('record', dir, demoTransport());
    await collectTransfers(l.tron, DEMO.tronBusy, 'out');
    await collectTransfers(l.tron, DEMO.tronBusy, 'out');
    expect(l.stats().cache.hitRate).toBeGreaterThan(0.6);
  });
});
