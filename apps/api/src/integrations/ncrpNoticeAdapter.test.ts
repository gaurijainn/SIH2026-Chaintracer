import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockNcrp } from '@ps26183/mock-server/src/app';
import { createNcrpNoticeAdapter } from './ncrpNoticeAdapter';

let server: Server;
let baseUrl: string;

beforeEach(() => {
  server = createMockNcrp().listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => server.close());

function adapter() {
  return createNcrpNoticeAdapter({ DATA_MODE: 'live', FIXTURES_DIR: 'fixtures', NCRP_BASE_URL: baseUrl });
}

describe('NcrpNoticeAdapter (contract, against the mock server)', () => {
  it('implements IntegrationAdapter.submit and returns a sandbox-marked result', async () => {
    const result = await adapter().submit({ caseId: 'c1' });
    expect(result.sandbox).toBe(true);
    expect(result.mode).toBe('sandbox');
    expect(typeof result.syncId).toBe('string');
  });

  it('is idempotent: the same payload returns the same syncId', async () => {
    const payload = { caseId: 'c1', status: 'DRAFT' };
    const r1 = await adapter().submit(payload);
    const r2 = await adapter().submit(payload);
    expect(r1.syncId).toBe(r2.syncId);
  });

  it('surfaces a server error from the mock as a rejected promise', async () => {
    await expect(adapter().submit({ __simulate: 'server_error' })).rejects.toThrow();
  });
});
