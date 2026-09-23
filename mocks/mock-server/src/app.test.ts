import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createMockNcrp, createMockSahyog } from './app';

const records = Array.from({ length: 250 }, (_, i) => ({ acknowledgementNumber: `M-${i}` }));

async function get(path: string) {
  const server = createMockNcrp({ records }).listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe('mock NCRP feed', () => {
  it('pages the complaint list and reports hasMore', async () => {
    const p1 = await get('/ncrp/v1/complaints?page=1&perPage=100');
    expect(p1.body).toMatchObject({ page: 1, perPage: 100, total: 250, hasMore: true });
    expect((p1.body.items as unknown[]).length).toBe(100);
    const p3 = await get('/ncrp/v1/complaints?page=3&perPage=100');
    expect(p3.body).toMatchObject({ hasMore: false });
    expect((p3.body.items as unknown[]).length).toBe(50);
  });

  it('is deterministic and answers /health', async () => {
    expect((await get('/ncrp/v1/complaints?page=1&perPage=5')).body.items).toEqual((await get('/ncrp/v1/complaints?page=1&perPage=5')).body.items);
    expect((await get('/health')).body).toMatchObject({ status: 'ok', records: 250 });
  });
});

async function post(app: ReturnType<typeof createMockNcrp> | ReturnType<typeof createMockSahyog>, path: string, body: unknown) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = await res.json();
    } catch {
      /* empty body (e.g. simulated timeout never responds -- caller should race a timeout) */
    }
    return { status: res.status, body: parsed };
  } finally {
    server.close();
  }
}

describe('mock NCRP outbound notice sync', () => {
  it('accepts a notice and returns a deterministic syncId', async () => {
    const notice = { vasp: { name: 'X' } };
    const r1 = await post(createMockNcrp(), '/ncrp/v1/notices/sync', { notice });
    const r2 = await post(createMockNcrp(), '/ncrp/v1/notices/sync', { notice });
    expect(r1.status).toBe(201);
    expect(r1.body.syncId).toBe(r2.body.syncId);
  });

  it('400s when notice is missing', async () => {
    const r = await post(createMockNcrp(), '/ncrp/v1/notices/sync', {});
    expect(r.status).toBe(400);
  });

  it('500s when the notice requests a simulated server error', async () => {
    const r = await post(createMockNcrp(), '/ncrp/v1/notices/sync', { notice: { __simulate: 'server_error' } });
    expect(r.status).toBe(500);
  });
});

describe('mock SAHYOG submissions', () => {
  it('accepts a notice and returns a deterministic submissionId', async () => {
    const notice = { vasp: { name: 'Binance' }, depositAddresses: ['T123'] };
    const r1 = await post(createMockSahyog(), '/sahyog/v1/submissions', { notice });
    const r2 = await post(createMockSahyog(), '/sahyog/v1/submissions', { notice });
    expect(r1.status).toBe(201);
    expect(typeof r1.body.submissionId).toBe('string');
    expect(r1.body.submissionId).toBe(r2.body.submissionId);
  });

  it('400s when notice is missing', async () => {
    const r = await post(createMockSahyog(), '/sahyog/v1/submissions', {});
    expect(r.status).toBe(400);
  });

  it('500s when the notice requests a simulated server error', async () => {
    const r = await post(createMockSahyog(), '/sahyog/v1/submissions', { notice: { __simulate: 'server_error' } });
    expect(r.status).toBe(500);
  });

  it('answers /health', async () => {
    const server = createMockSahyog().listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`);
      expect((await res.json()).status).toBe('ok');
    } finally {
      server.close();
    }
  });
});
