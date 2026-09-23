import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { canonicalize, sha256Hex } from '@ps26183/shared';
import { collectEvidence } from './collector';
import { evidenceV1Schema } from './schema';
import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';

/**
 * Fixture-scale performance check (not a production-scale benchmark): builds a case with a
 * realistically-sized hop table (200 hops across a handful of addresses -- roughly what a single
 * B4 trace run produces) and asserts collect+validate+canonicalize+hash completes well under the
 * plan's 5s PDF+JSON export budget. PDF rendering itself needs a Chromium binary (see pdf.ts) and is
 * therefore measured separately/optionally in service.test.ts-adjacent manual runs, not here, to
 * keep this suite runnable without a browser install.
 */
function fakeRecord(obj: Record<string, unknown>) {
  return { get: (k: string) => obj[k] };
}

function buildFixture(hopCount: number) {
  const hops = Array.from({ length: hopCount }, (_, i) => ({
    id: `h${i}`,
    traceId: 't1',
    hopNo: i,
    chain: 'TRON',
    txHash: `tx${i}`,
    fromAddr: `addr${i}`,
    toAddr: `addr${i + 1}`,
    token: 'USDT',
    amount: new Prisma.Decimal('100'),
    usd: new Prisma.Decimal('100'),
    ts: new Date(Date.now() - (hopCount - i) * 60000),
  }));
  const edges = hops.map((h) => ({ chain: h.chain, from: h.fromAddr, to: h.toAddr, tx: h.txHash, idx: 0, token: h.token, amount: '100', usd: '100', ts: h.ts.toISOString() }));

  const prisma = {
    case: { findUnique: async () => ({ id: 'perf-case', title: 'Perf Case', status: 'OPEN', firNumber: null }) },
    complaint: { findMany: async () => [{ id: 'cp1', caseId: 'perf-case', ackNo: 'ACK', amountInr: new Prisma.Decimal('50000'), reportedAt: new Date(), createdAt: new Date(), addresses: [{ chain: 'TRON', address: 'addr0', kind: 'ADDRESS' }] }] },
    traceJob: { findMany: async () => [{ id: 't1', caseId: 'perf-case', seedChain: 'TRON', seedAddr: 'addr0', taintModel: 'HAIRCUT', maxHops: 6, minValueUsd: new Prisma.Decimal('10'), windowDays: 30, createdAt: new Date() }] },
    hop: { findMany: async () => hops },
    attribution: { findMany: async () => [] },
    riskScore: { findMany: async () => [] },
  } as never;

  const driver = {
    session: () => ({
      run: async (query: string) => {
        if (query.includes('TRANSFER')) return { records: edges.map((e) => fakeRecord({ ...e, idx: neo4j.int(e.idx) })) };
        return { records: [] };
      },
      close: async () => undefined,
    }),
  } as unknown as Driver;

  return { prisma, driver };
}

describe('reports pipeline performance (fixture-scale)', () => {
  it('collect + validate + canonicalize + hash completes well under the 5s export budget', async () => {
    const { prisma, driver } = buildFixture(200);

    const t0 = performance.now();
    const evidence = await collectEvidence({ prisma, driver }, 'perf-case');
    const tCollect = performance.now();

    const parsed = evidenceV1Schema.parse(evidence);
    const tValidate = performance.now();

    const canonical = canonicalize(parsed);
    const tCanonicalize = performance.now();

    const hash = sha256Hex(canonical);
    const tHash = performance.now();

    const total = tHash - t0;

    // eslint-disable-next-line no-console
    console.log(
      `[B9 perf] collect=${(tCollect - t0).toFixed(1)}ms validate=${(tValidate - tCollect).toFixed(1)}ms ` +
        `canonicalize=${(tCanonicalize - tValidate).toFixed(1)}ms hash=${(tHash - tCanonicalize).toFixed(1)}ms total=${total.toFixed(1)}ms`,
    );

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.hops).toHaveLength(200);
    expect(total).toBeLessThan(5000);
  });
});
