import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import type { IntegrationServices } from './routes';

let server: Server;
let base: string;

const fakeServices: IntegrationServices = {
  sahyog: {
    submit: async (payload) => {
      if ((payload as Record<string, unknown>).__fail) throw new Error('simulated failure');
      return { submissionId: 'sub-1', mode: 'sandbox', sandbox: true };
    },
  },
  ncrpNotice: {
    submit: async () => ({ syncId: 'sync-1', mode: 'sandbox', sandbox: true }),
  },
};

beforeAll(() => {
  const ok = async () => undefined;
  const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
  server = createApp(deps, { integrations: fakeServices }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => server.close());

describe('POST /integrations/sahyog/submit', () => {
  it('returns a sandbox-marked submission result', async () => {
    const res = await fetch(`${base}/integrations/sahyog/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notice: { a: 1 } }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ submissionId: 'sub-1', mode: 'sandbox', sandbox: true });
  });

  it('400s when notice is missing', async () => {
    const res = await fetch(`${base}/integrations/sahyog/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });
});

describe('POST /integrations/ncrp/sync', () => {
  it('returns a sandbox-marked sync result', async () => {
    const res = await fetch(`${base}/integrations/ncrp/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notice: { a: 1 } }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ syncId: 'sync-1', mode: 'sandbox', sandbox: true });
  });
});
