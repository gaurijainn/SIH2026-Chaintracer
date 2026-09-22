import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import type { MuleService } from './service';

let server: Server;
let base: string;
const analyzeCalls: string[] = [];

const fakeService = {
  analyzeCase: async (caseId: string) => {
    analyzeCalls.push(caseId);
    return { addresses: 2, flags: [{ chain: 'TRON', addr: 'W1', rule: 'PASS_THROUGH', confidence: 0.8, evidence: { ratio: 1 } }], features: {}, communities: [], sharedMules: [] };
  },
  listFlagsForCase: async (caseId: string) => (caseId === 'case-1' ? [{ id: 'f1', chain: 'TRON', addr: 'W1', rule: 'PASS_THROUGH' }] : []),
  listCommunitiesForCase: async () => [{ id: 'c1', chain: 'TRON', addr: 'W1', wccId: 0, louvainId: 0, degree: 2, betweenness: 0 }],
  getSharedMule: async (chain: string, addr: string) => (addr === 'SHARED' ? { chain, addr, caseCount: 2, caseIds: ['caseA', 'caseB'] } : null),
} as unknown as MuleService;

beforeAll(() => {
  const ok = async () => undefined;
  const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
  server = createApp(deps, { mule: fakeService }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => server.close());

describe('mule routes', () => {
  it('POST /cases/:id/mule/analyze runs analysis and returns flags/communities/sharedMules', async () => {
    const res = await fetch(`${base}/cases/case-1/mule/analyze`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ caseId: 'case-1', addresses: 2 });
    expect(body.flags).toHaveLength(1);
    expect(analyzeCalls).toContain('case-1');
  });

  it('GET /cases/:id/mule/flags lists fired rules for the case', async () => {
    const res = await fetch(`${base}/cases/case-1/mule/flags`);
    const body = (await res.json()) as any;
    expect(body.flags).toHaveLength(1);
  });

  it('GET /cases/:id/mule/communities lists WCC/Louvain membership', async () => {
    const res = await fetch(`${base}/cases/case-1/mule/communities`);
    const body = (await res.json()) as any;
    expect(body.communities[0]).toMatchObject({ wccId: 0, degree: 2 });
  });

  it('GET /addresses/:chain/:addr/shared-mule returns null when not shared', async () => {
    const res = await fetch(`${base}/addresses/TRON/SOLO/shared-mule`);
    const body = (await res.json()) as any;
    expect(body.sharedMule).toBeNull();
  });

  it('GET /addresses/:chain/:addr/shared-mule returns caseCount and caseIds when shared', async () => {
    const res = await fetch(`${base}/addresses/TRON/SHARED/shared-mule`);
    const body = (await res.json()) as any;
    expect(body.sharedMule).toEqual({ caseCount: 2, caseIds: ['caseA', 'caseB'] });
  });

  it('rejects an invalid chain', async () => {
    const res = await fetch(`${base}/addresses/NOTACHAIN/X/shared-mule`);
    expect(res.status).toBe(400);
  });
});
