import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockSahyog } from '@ps26183/mock-server/src/app';
import { createSahyogAdapter } from './sahyogAdapter';

let server: Server;
let baseUrl: string;

beforeEach(() => {
  server = createMockSahyog().listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => server.close());

function adapter(overrides: Record<string, unknown> = {}) {
  return createSahyogAdapter({ DATA_MODE: 'live', FIXTURES_DIR: 'fixtures', SAHYOG_MODE: 'sandbox', SAHYOG_BASE_URL: baseUrl, ...overrides });
}

describe('SahyogAdapter (contract, against the mock server)', () => {
  it('implements IntegrationAdapter.submit and returns a sandbox-marked result', async () => {
    const result = await adapter().submit({ vasp: { name: 'Binance' }, depositAddresses: ['T123'] });
    expect(result.sandbox).toBe(true);
    expect(result.mode).toBe('sandbox');
    expect(typeof result.submissionId).toBe('string');
  });

  it('is idempotent: the same payload returns the same submissionId', async () => {
    const payload = { vasp: { name: 'Binance' }, depositAddresses: ['T123'], txHashes: ['tx1'] };
    const r1 = await adapter().submit(payload);
    const r2 = await adapter().submit(payload);
    expect(r1.submissionId).toBe(r2.submissionId);
  });

  it('surfaces a validation/server error from the mock as a rejected promise', async () => {
    await expect(adapter().submit({ __simulate: 'server_error' })).rejects.toThrow();
  });

  it('surfaces a timeout as a rejected promise', async () => {
    const a = createSahyogAdapter({ DATA_MODE: 'live', FIXTURES_DIR: 'fixtures', SAHYOG_MODE: 'sandbox', SAHYOG_BASE_URL: baseUrl }, 200);
    await expect(a.submit({ __simulate: 'timeout' })).rejects.toThrow();
  }, 5000);
});
