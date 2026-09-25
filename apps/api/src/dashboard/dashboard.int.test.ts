import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { authFetch, testSecurity } from '../auth/testkit';
import { createPrisma } from '../db/prisma';
import { DashboardService, type DashboardSummary } from './service';

/**
 * The dashboard SQL against REAL Postgres. The shared dev database already holds demo data, so every assertion is either a
 * delta over a before/after summary or an exact row in a namespace only this run uses (a 2001 calendar day, unique typology
 * names, a unique chain string). Fixtures are removed afterwards; audit rows are never touched.
 */
const u = `d${Date.now().toString(36)}`;
const CHAIN = `Z${u}`.toUpperCase();
let prisma: PrismaClient;
let server: Server;
let base: string;
const cleanup: (() => Promise<unknown>)[] = [];

const summary = async (): Promise<DashboardSummary> => {
  const res = await authFetch('VIEWER')(`${base}/dashboard/summary`);
  expect(res.status).toBe(200);
  return (await res.json()) as DashboardSummary;
};
const rowCounts = async () => ({
  audit: await prisma.auditLog.count(),
  cases: await prisma.case.count(),
  traces: await prisma.traceJob.count(),
  hops: await prisma.hop.count(),
  risk: await prisma.riskScore.count(),
  attributions: await prisma.attribution.count(),
  complaints: await prisma.complaint.count(),
});

let before: DashboardSummary;
let counts: Awaited<ReturnType<typeof rowCounts>>;
let after: DashboardSummary;

beforeAll(async () => {
  prisma = createPrisma(process.env.DATABASE_URL);
  const ok = async () => undefined;
  const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
  server = createApp(deps, { dashboard: new DashboardService({ prisma }) }, testSecurity()).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  before = await summary();

  // cases: one OPEN, one CLOSED -> openCases +1. The complaint amount is huge so any use of it would show in tracedValueUsd.
  const open = await prisma.case.create({ data: { title: `open ${u}`, status: 'OPEN' } });
  const closed = await prisma.case.create({ data: { title: `closed ${u}`, status: 'CLOSED' } });
  cleanup.push(() => prisma.case.deleteMany({ where: { id: { in: [open.id, closed.id] } } }));
  const c1 = await prisma.complaint.create({ data: { ackNo: `ACK-${u}-1`, reportedAt: new Date('2001-03-01T00:00:00Z'), category: 'x', amountInr: '99999999.00', caseId: open.id } });
  const c2 = await prisma.complaint.create({ data: { ackNo: `ACK-${u}-2`, reportedAt: new Date('2001-03-01T00:00:00Z'), category: 'x', amountInr: '99999999.00', caseId: closed.id } });
  cleanup.push(() => prisma.complaint.deleteMany({ where: { id: { in: [c1.id, c2.id] } } }));

  // chain split: A1 appears in both complaints (counted once), A2 once; a tx hash and an unresolved-chain address are excluded.
  await prisma.complaintAddress.createMany({
    data: [
      { complaintId: c1.id, raw: 'A1', address: `A1${u}`, chain: CHAIN, kind: 'ADDRESS' },
      { complaintId: c1.id, raw: 'A2', address: `A2${u}`, chain: CHAIN, kind: 'ADDRESS' },
      { complaintId: c2.id, raw: 'A1', address: `A1${u}`, chain: CHAIN, kind: 'ADDRESS' },
      { complaintId: c1.id, raw: 'TX', address: `TX${u}`, chain: CHAIN, kind: 'TX_HASH' },
      { complaintId: c1.id, raw: 'U', address: `U${u}`, chain: null, kind: 'ADDRESS' },
    ],
  });

  // traces per day (IST): 17:00Z on 4 Mar is 22:30 IST on 4 Mar; 19:00Z on 4 Mar is 00:30 IST on 5 Mar.
  const t1 = await prisma.traceJob.create({ data: { caseId: open.id, seedChain: CHAIN, seedAddr: 'S1', createdAt: new Date('2001-03-04T17:00:00Z') } });
  const t2 = await prisma.traceJob.create({ data: { caseId: open.id, seedChain: CHAIN, seedAddr: 'S2', createdAt: new Date('2001-03-04T19:00:00Z') } });
  const t3 = await prisma.traceJob.create({ data: { caseId: closed.id, seedChain: CHAIN, seedAddr: 'S3', createdAt: new Date('2001-03-05T02:00:00Z') } });

  // traced value: the same transfer stored under two traces counts once (100.25); one null-usd hop adds nothing; one 50 hop.
  const hop = (traceId: string, txHash: string, usd: string | null) => ({ traceId, hopNo: 1, chain: CHAIN, txHash, idx: 0, fromAddr: 'F', toAddr: 'T', token: 'USDT', amount: '1', usd, ts: new Date('2001-03-04T00:00:00Z') });
  await prisma.hop.createMany({ data: [hop(t1.id, `tx-a-${u}`, '100.25'), hop(t2.id, `tx-a-${u}`, '100.25'), hop(t3.id, `tx-b-${u}`, '50'), hop(t1.id, `tx-c-${u}`, null)] });

  // VASPs: 3 attributed addresses on one VASP + 1 on another -> two distinct VASPs.
  const v1 = await prisma.vasp.create({ data: { name: `V1 ${u}`, type: 'CENTRALISED_EXCHANGE', jurisdiction: 'IN', fiuStatus: 'REGISTERED' } });
  const v2 = await prisma.vasp.create({ data: { name: `V2 ${u}`, type: 'OTC', jurisdiction: 'IN', fiuStatus: 'REGISTERED' } });
  cleanup.push(() => prisma.vasp.deleteMany({ where: { id: { in: [v1.id, v2.id] } } }));
  const attr = (vaspId: string, addr: string) => ({ chain: CHAIN, addr, vaspId, confidence: '0.9', heuristics: [] });
  await prisma.attribution.createMany({ data: [attr(v1.id, 'a1'), attr(v1.id, 'a2'), attr(v1.id, 'a3'), attr(v2.id, 'a4')] });

  // typology: addr r1 re-scored (older tz_a, newer tz_b) -> counts once as tz_b; r2 tz_b; r3 null and r4 '' are ignored.
  const score = (addr: string, typology: string | null, createdAt: string) => ({ chain: CHAIN, addr, score: 50, band: 'MEDIUM' as const, factors: [], overrides: [], typology, modelVersion: 'test', createdAt: new Date(createdAt) });
  await prisma.riskScore.createMany({
    data: [score('r1', `tz_a_${u}`, '2001-03-01T00:00:00Z'), score('r1', `tz_b_${u}`, '2001-03-02T00:00:00Z'), score('r2', `tz_b_${u}`, '2001-03-02T00:00:00Z'), score('r3', null, '2001-03-02T00:00:00Z'), score('r4', '', '2001-03-02T00:00:00Z')],
  });
  cleanup.push(async () => {
    await prisma.riskScore.deleteMany({ where: { chain: CHAIN } });
    await prisma.attribution.deleteMany({ where: { chain: CHAIN } });
  });

  counts = await rowCounts();
  after = await summary();
});

afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
  server.close();
  await prisma.$disconnect();
});

describe('GET /api/v1/dashboard/summary against real Postgres', () => {
  it('counts open cases as not CLOSED', () => {
    expect(after.openCases - before.openCases).toBe(1);
  });

  it('groups traces by IST calendar day, ascending', () => {
    expect(after.tracesPerDay.filter((d) => d.day.startsWith('2001-03'))).toEqual([{ day: '2001-03-04', count: 1 }, { day: '2001-03-05', count: 2 }]);
    const days = after.tracesPerDay.map((d) => d.day);
    expect(days).toEqual([...days].sort());
  });

  it('sums Hop.usd once per transfer, ignoring nulls and complaint amounts', () => {
    expect(Number((after.tracedValueUsd - before.tracedValueUsd).toFixed(2))).toBe(150.25);
  });

  it('counts distinct VASPs from Attribution, not attributed addresses', () => {
    expect(after.vaspsIdentified - before.vaspsIdentified).toBe(2);
  });

  it('groups the latest persisted typology per address and ignores null / empty ones', () => {
    const mine = after.typologyMix.filter((t) => t.typology.endsWith(u));
    expect(mine).toEqual([{ typology: `tz_b_${u}`, count: 2 }]);
    expect(after.typologyMix.some((t) => t.typology === '')).toBe(false);
  });

  it('counts distinct wallet addresses per resolved chain, excluding tx hashes and unresolved chains', () => {
    expect(after.chainSplit.find((c) => c.chain === CHAIN)).toEqual({ chain: CHAIN, count: 2 });
    expect(after.chainSplit.some((c) => c.chain === '' || c.chain === 'null')).toBe(false);
  });

  it('keeps time-to-attribution null', () => {
    expect(after.timeToAttributionMedianSeconds).toBeNull();
  });

  it('is finite, integer-valued where required, and identical when repeated', async () => {
    expect(Number.isFinite(after.tracedValueUsd)).toBe(true);
    for (const n of [after.openCases, after.vaspsIdentified, ...after.tracesPerDay.map((d) => d.count), ...after.chainSplit.map((c) => c.count)]) expect(Number.isInteger(n)).toBe(true);
    expect(await summary()).toEqual(after);
  });

  it('writes nothing: no audit entries and no row-count changes across repeated calls', async () => {
    await summary();
    await summary();
    expect(await rowCounts()).toEqual(counts);
  });
});
