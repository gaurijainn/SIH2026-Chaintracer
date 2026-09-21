import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createMockNcrp } from './app';

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
