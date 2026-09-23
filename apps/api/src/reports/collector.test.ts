import { describe, expect, it } from 'vitest';
import neo4j from 'neo4j-driver';
import type { Driver } from 'neo4j-driver';
import { Prisma } from '@prisma/client';
import { collectEvidence } from './collector';
import { CaseNotFoundError } from './errors';

function fakeRecord(obj: Record<string, unknown>) {
  return { get: (k: string) => obj[k] };
}

/** Fake Neo4j driver: TRANSFER query returns `edges`, entity lookups always return none. */
function fakeDriver(edges: { chain: string; from: string; to: string; tx: string; idx: number; token: string; amount: string; usd: string | null; ts: string }[]): Driver {
  return {
    session: () => ({
      run: async (query: string) => {
        if (query.includes('TRANSFER')) {
          return { records: edges.map((e) => fakeRecord({ chain: e.chain, from: e.from, to: e.to, tx: e.tx, idx: neo4j.int(e.idx), token: e.token, amount: e.amount, usd: e.usd, ts: e.ts })) };
        }
        if (query.includes('BELONGS_TO')) {
          return { records: [] };
        }
        return { records: [] };
      },
      close: async () => undefined,
    }),
  } as unknown as Driver;
}

function fakePrisma(data: {
  cases: Record<string, { id: string; title: string; status: string; firNumber: string | null }>;
  complaints: { id: string; caseId: string; ackNo: string; amountInr: Prisma.Decimal; reportedAt: Date; createdAt: Date; addresses: { chain: string | null; address: string; kind: string }[] }[];
  traces: { id: string; caseId: string; seedChain: string; seedAddr: string; taintModel: string; maxHops: number; minValueUsd: Prisma.Decimal; windowDays: number; createdAt: Date }[];
  hops: { id: string; traceId: string; hopNo: number; chain: string; txHash: string; fromAddr: string; toAddr: string; token: string; amount: Prisma.Decimal; usd: Prisma.Decimal | null; ts: Date }[];
  attributions?: { chain: string; addr: string; vaspId: string; vasp: { name: string }; confidence: Prisma.Decimal; heuristics: unknown }[];
  riskScores?: { chain: string; addr: string; score: number; band: string; factors: unknown; typology: string | null; typologyConfidence: Prisma.Decimal | null; modelVersion: string; createdAt: Date }[];
}) {
  return {
    case: { findUnique: async ({ where }: { where: { id: string } }) => data.cases[where.id] ?? null },
    complaint: { findMany: async ({ where }: { where: { caseId: string } }) => data.complaints.filter((c) => c.caseId === where.caseId) },
    traceJob: { findMany: async ({ where }: { where: { caseId: string } }) => data.traces.filter((t) => t.caseId === where.caseId) },
    hop: { findMany: async ({ where }: { where: { traceId: { in: string[] } } }) => data.hops.filter((h) => where.traceId.in.includes(h.traceId)) },
    attribution: { findMany: async () => data.attributions ?? [] },
    riskScore: { findMany: async () => data.riskScores ?? [] },
  } as never;
}

describe('collectEvidence', () => {
  it('throws CaseNotFoundError for an unknown case', async () => {
    const prisma = fakePrisma({ cases: {}, complaints: [], traces: [], hops: [] });
    await expect(collectEvidence({ prisma, driver: fakeDriver([]) }, 'nope')).rejects.toThrow(CaseNotFoundError);
  });

  it('produces a full evidence.v1 object from complete data', async () => {
    const prisma = fakePrisma({
      cases: { c1: { id: 'c1', title: 'Case One', status: 'OPEN', firNumber: 'FIR/2026/1' } },
      complaints: [
        { id: 'cp1', caseId: 'c1', ackNo: 'ACK1', amountInr: new Prisma.Decimal('50000'), reportedAt: new Date('2026-01-01T00:00:00Z'), createdAt: new Date('2026-01-01T01:00:00Z'), addresses: [{ chain: 'TRON', address: 'TVictim', kind: 'ADDRESS' }] },
      ],
      traces: [{ id: 't1', caseId: 'c1', seedChain: 'TRON', seedAddr: 'TVictim', taintModel: 'HAIRCUT', maxHops: 6, minValueUsd: new Prisma.Decimal('10'), windowDays: 30, createdAt: new Date('2026-01-01T02:00:00Z') }],
      hops: [
        { id: 'h1', traceId: 't1', hopNo: 0, chain: 'TRON', txHash: 'tx1', fromAddr: 'TVictim', toAddr: 'TMule', token: 'USDT', amount: new Prisma.Decimal('100'), usd: new Prisma.Decimal('100'), ts: new Date('2026-01-01T03:00:00Z') },
      ],
      attributions: [{ chain: 'TRON', addr: 'TMule', vaspId: 'v1', vasp: { name: 'Binance' }, confidence: new Prisma.Decimal('0.9'), heuristics: { rule: 'direct' } }],
      riskScores: [{ chain: 'TRON', addr: 'TMule', score: 80, band: 'HIGH', factors: [], typology: 'MULE', typologyConfidence: new Prisma.Decimal('0.7'), modelVersion: 'v1', createdAt: new Date('2026-01-01T04:00:00Z') }],
    });
    const edges = [{ chain: 'TRON', from: 'TVictim', to: 'TMule', tx: 'tx1', idx: 0, token: 'USDT', amount: '100', usd: '100', ts: '2026-01-01T03:00:00.000Z' }];

    const evidence = await collectEvidence({ prisma, driver: fakeDriver(edges) }, 'c1');

    expect(evidence.schemaVersion).toBe('evidence.v1');
    expect(evidence.case).toEqual({ id: 'c1', title: 'Case One', status: 'OPEN', firNumber: 'FIR/2026/1', ackNo: 'ACK1' });
    expect(evidence.victimTransaction).toEqual({ chain: 'TRON', address: 'TVictim', ackNo: 'ACK1', amountInr: '50000', reportedAt: '2026-01-01T00:00:00.000Z' });
    expect(evidence.hops).toHaveLength(1);
    expect(evidence.hops[0].txHash).toBe('tx1');
    expect(evidence.hops[0].explorerUrl).toContain('tronscan.org');
    expect(evidence.hops[0].tsIst.display).toContain('IST');
    expect(evidence.graph.edges).toHaveLength(1);
    expect(evidence.attribution).toHaveLength(1);
    expect(evidence.attribution[0].vaspName).toBe('Binance');
    expect(evidence.risk).toHaveLength(1);
    expect(evidence.risk[0].typology).toBe('MULE');
    expect(evidence.methodology.taintModel).toBe('HAIRCUT');
    expect(evidence.limitations.length).toBeGreaterThan(0);
    expect(evidence.sources.length).toBeGreaterThan(0);
  });

  it('handles a case with no complaint/hop/attribution/risk data (all optional fields null/empty)', async () => {
    const prisma = fakePrisma({
      cases: { c2: { id: 'c2', title: 'Bare Case', status: 'OPEN', firNumber: null } },
      complaints: [],
      traces: [],
      hops: [],
    });
    const evidence = await collectEvidence({ prisma, driver: fakeDriver([]) }, 'c2');

    expect(evidence.victimTransaction).toBeNull();
    expect(evidence.hops).toEqual([]);
    expect(evidence.graph).toEqual({ nodes: [], edges: [] });
    expect(evidence.attribution).toEqual([]);
    expect(evidence.risk).toEqual([]);
    expect(evidence.methodology.taintModel).toBeNull();
    expect(evidence.methodology.description).toMatch(/No trace parameters/);
    expect(evidence.case.ackNo).toBeNull();
  });
});
