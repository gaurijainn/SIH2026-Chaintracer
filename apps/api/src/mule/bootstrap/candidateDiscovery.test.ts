import { describe, expect, it } from 'vitest';
import { loadEnv } from '@ps26183/shared';
import { createChainLayer } from '@ps26183/workers/adapters';
import { fakeTransport, tronAddr, type Route } from '@ps26183/workers/adapters/testing';
import { discoverCandidateAddresses } from './candidateDiscovery';

const NOW_MS = 1_756_000_000_000;
const SEED_A = tronAddr('seed-a');
const SEED_B = tronAddr('seed-b');
const CP1 = tronAddr('counterparty-1');
const CP2 = tronAddr('counterparty-2');
const CP3 = tronAddr('counterparty-3');
const EXCLUDED = tronAddr('excluded-cp');

function layer(routes: Route[]) {
  const env = { ...loadEnv({ DATA_MODE: 'live' }), FIXTURES_DIR: 'unused' };
  return createChainLayer({ env, transport: fakeTransport(routes), pricing: false, guard: { unlimited: true, sleep: async () => undefined, random: () => 0 } });
}

const trc20 = (id: string, from: string, to: string) => ({ transaction_id: id, token_info: { symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 }, block_timestamp: NOW_MS, from, to, type: 'Transfer', value: '1000000' });

function routesFor(seed: string, inFrom: string[], outTo: string[]): Route[] {
  return [
    [new RegExp(`v1/accounts/${seed}/transactions/trc20\\?.*only_to=true`), () => ({ data: inFrom.map((f, i) => trc20(`${seed}-in-${i}`.padEnd(64, '0'), f, seed)), success: true, meta: {} })],
    [new RegExp(`v1/accounts/${seed}/transactions/trc20\\?.*only_from=true`), () => ({ data: outTo.map((t, i) => trc20(`${seed}-out-${i}`.padEnd(64, '0'), seed, t)), success: true, meta: {} })],
    [new RegExp(`v1/accounts/${seed}/transactions\\?`), () => ({ data: [], success: true, meta: {} })],
  ];
}

describe('discoverCandidateAddresses', () => {
  it('harvests unique counterparties from seed transfers, excluding seeds/excluded/dupes', async () => {
    const l = layer([...routesFor(SEED_A, [CP1], [CP2, EXCLUDED]), ...routesFor(SEED_B, [CP2, SEED_A], [CP3])]);
    const found = await discoverCandidateAddresses(l.tron, [SEED_A, SEED_B], { excludedAddresses: new Set([EXCLUDED]) });
    expect(found).toEqual([CP1, CP2, CP3].sort());
  });

  it('stops once maxCandidates is reached and never exceeds it', async () => {
    const l = layer([...routesFor(SEED_A, [CP1], [CP2, CP3])]);
    const found = await discoverCandidateAddresses(l.tron, [SEED_A], { excludedAddresses: new Set(), maxCandidates: 2 });
    expect(found.length).toBe(2);
  });

  it('respects maxSeeds, never querying beyond it', async () => {
    const l = layer(routesFor(SEED_A, [CP1], []));
    // SEED_B has no route registered; if maxSeeds were ignored, fakeTransport would throw on an unmatched URL.
    const found = await discoverCandidateAddresses(l.tron, [SEED_A, SEED_B], { excludedAddresses: new Set(), maxSeeds: 1 });
    expect(found).toEqual([CP1]);
  });

  it('is deterministic: same input always yields the same sorted output', async () => {
    const routes = [...routesFor(SEED_A, [CP2, CP1], [CP3])];
    const found1 = await discoverCandidateAddresses(layer(routes).tron, [SEED_A], { excludedAddresses: new Set() });
    const found2 = await discoverCandidateAddresses(layer(routes).tron, [SEED_A], { excludedAddresses: new Set() });
    expect(found1).toEqual(found2);
    expect(found1).toEqual([...found1].sort());
  });
});
