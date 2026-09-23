import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}
import { createApp } from '../app';
import type { WatchlistService } from './service';
import { InvalidAddressError, WatchlistNotFoundError } from './errors';
import { testSecurity, authFetch } from '../auth/testkit';

let server: Server;
let base: string;

const items = [{ id: 'w1', caseId: 'case1', chain: 'TRON', addr: 'T111', reason: 'manual', tier: 'HOT' }];

const fakeService = {
  list: async (caseId?: string) => (caseId ? items.filter((i) => i.caseId === caseId) : items),
  create: async (input: { addr: string; caseId: string; chain: string }) => {
    if (input.addr === 'BAD') throw new InvalidAddressError(input.addr, ['not recognised']);
    return { id: 'w2', caseId: input.caseId, chain: input.chain, addr: input.addr, reason: 'manual', tier: 'HOT' };
  },
  remove: async (id: string) => {
    if (id === 'missing') throw new WatchlistNotFoundError(id);
  },
} as unknown as WatchlistService;

beforeAll(() => {
  const ok = async () => undefined;
  const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
  server = createApp(deps, { watchlist: fakeService }, testSecurity()).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => server.close());

describe('GET /watchlist', () => {
  it('lists every item with no filter', async () => {
    const res = await authFetch()(`${base}/watchlist`);
    expect(res.status).toBe(200);
    expect((await json(res)).items).toHaveLength(1);
  });

  it('filters by caseId', async () => {
    const res = await authFetch()(`${base}/watchlist?caseId=case1`);
    expect((await json(res)).items).toHaveLength(1);
    const res2 = await authFetch()(`${base}/watchlist?caseId=nope`);
    expect((await json(res2)).items).toHaveLength(0);
  });
});

describe('POST /watchlist', () => {
  it('creates an item and returns 201', async () => {
    const res = await authFetch()(`${base}/watchlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caseId: 'case1', chain: 'TRON', addr: 'T222' }),
    });
    expect(res.status).toBe(201);
    expect((await json(res)).item.addr).toBe('T222');
  });

  it('rejects a malformed body with 400 INVALID_BODY', async () => {
    const res = await authFetch()(`${base}/watchlist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ caseId: 'case1' }) });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('INVALID_BODY');
  });

  it('rejects an invalid address with 400 INVALID_ADDRESS', async () => {
    const res = await authFetch()(`${base}/watchlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caseId: 'case1', chain: 'TRON', addr: 'BAD' }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('INVALID_ADDRESS');
  });
});

describe('DELETE /watchlist/:id', () => {
  it('returns 204 on success', async () => {
    const res = await authFetch()(`${base}/watchlist/w1`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await authFetch()(`${base}/watchlist/missing`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe('WATCHLIST_ITEM_NOT_FOUND');
  });
});
