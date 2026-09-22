import { describe, expect, it } from 'vitest';
import { loadEnv } from '@ps26183/shared';
import { createChainLayer } from '@ps26183/workers/adapters';
import { fakeTransport, reply, type Route } from '@ps26183/workers/adapters/testing';
import type { LabelPrisma } from '../labelStore';
import { ChainabuseClient, loadChainabuseLabel, normalizeChainabuseReports } from './chainabuse';

function layer(routes: Route[]) {
  const env = { ...loadEnv({ DATA_MODE: 'live', CHAINABUSE_KEY: 'ca-secret' }), FIXTURES_DIR: 'unused' };
  return createChainLayer({ env, transport: fakeTransport(routes), pricing: false, guard: { unlimited: true, sleep: async () => undefined, random: () => 0 } });
}

// Shape confirmed by one live read-only call during B5 development: {count, reports: [...]}.
const REPORTS_ROUTE: Route = [/api\.chainabuse\.com\/v0\/reports\?address=0xdead&page=1&perPage=20/, () => ({
  count: 2,
  reports: [
    { id: 'r1', category: 'SCAM', isVerified: true, createdAt: '2026-09-01T00:00:00Z' },
    { id: 'r2', category: 'PHISHING', isVerified: false, createdAt: '2026-09-02T00:00:00Z' },
  ],
})];

describe('ChainabuseClient.reportsFor', () => {
  it('sends the address as a query param with Basic auth built from the key', async () => {
    const l = layer([REPORTS_ROUTE]);
    const client = new ChainabuseClient({ guard: l.guard, http: l.http });
    const reports = await client.reportsFor('0xdead');
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ id: 'r1', category: 'SCAM', isVerified: true });
  });

  it('never repeats the request for the same address (cached forever, per plan Section 10)', async () => {
    const l = layer([REPORTS_ROUTE]);
    const client = new ChainabuseClient({ guard: l.guard, http: l.http });
    await client.reportsFor('0xdead');
    await client.reportsFor('0xdead');
    expect(l.stats().providers.chainabuse?.calls ?? 0).toBe(1);
  });

  it('returns an empty list for an address with no reports', async () => {
    const l = layer([[/api\.chainabuse\.com/, () => reply({ count: 0, reports: [] })]]);
    const client = new ChainabuseClient({ guard: l.guard, http: l.http });
    expect(await client.reportsFor('0xclean')).toEqual([]);
  });
});

describe('normalizeChainabuseReports', () => {
  it('gives a verified report higher confidence than an unverified one, both category "reported"', () => {
    const labels = normalizeChainabuseReports('ETH', '0xdead', [
      { id: 'r1', category: 'SCAM', isVerified: true },
      { id: 'r2', category: 'PHISHING', isVerified: false },
    ]);
    expect(labels[0]).toMatchObject({ category: 'reported', source: 'chainabuse', confidence: 0.75, name: 'Chainabuse: SCAM' });
    expect(labels[1]).toMatchObject({ category: 'reported', confidence: 0.4, name: 'Chainabuse: PHISHING' });
  });
});

describe('loadChainabuseLabel', () => {
  it('normalizes and upserts every report for one address', async () => {
    const l = layer([REPORTS_ROUTE]);
    const client = new ChainabuseClient({ guard: l.guard, http: l.http });
    const rows: Record<string, unknown>[] = [];
    const prisma: LabelPrisma = { label: { async upsert({ create }) { rows.push(create); return create; } } };
    const n = await loadChainabuseLabel(prisma, client, 'ETH', '0xdead');
    expect(n).toBe(2);
    expect(rows).toHaveLength(2);
  });
});
