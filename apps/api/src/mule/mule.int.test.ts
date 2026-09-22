import type { PrismaClient } from '@prisma/client';
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '@ps26183/shared';
import { applySchema, createDriver, writeHops } from '../graph/graph';
import { createPrisma, hopToGraph } from '../db/prisma';
import { analyzeMuleRings } from './analyzeCase';

// Isolated namespace per test run so reruns never collide with leftover data or each other.
const run = `b6${Date.now().toString(36)}`;
const id = (label: string) => `${run}-${label}`;
const addr = (label: string) => `${run.toUpperCase()}${label}`;
const T0 = Date.UTC(2026, 8, 1);

let prisma: PrismaClient;
let driver: Driver;

async function makeCase(caseTitle: string) {
  return prisma.case.create({ data: { id: id(caseTitle), title: `B6 int test: ${caseTitle}` } });
}

async function makeTrace(caseId: string, traceIdSuffix: string, seedAddr: string) {
  return prisma.traceJob.create({
    data: { id: id(traceIdSuffix), caseId, seedChain: 'TRON', seedAddr, status: 'COMPLETED', reportedAmount: '1000' },
  });
}

interface HopSpec {
  traceId: string;
  hopNo: number;
  txHash: string;
  from: string;
  to: string;
  amount: string;
  ts: string;
}

async function writeHopsBoth(specs: HopSpec[]) {
  for (const h of specs) {
    await prisma.hop.create({
      data: { traceId: h.traceId, hopNo: h.hopNo, chain: 'TRON', txHash: h.txHash, idx: 0, fromAddr: h.from, toAddr: h.to, token: 'USDT', amount: h.amount, usd: h.amount, ts: new Date(h.ts) },
    });
  }
  const rows = await prisma.hop.findMany({ where: { traceId: { in: [...new Set(specs.map((s) => s.traceId))] } } });
  await writeHops(driver, rows.map(hopToGraph));
}

beforeAll(async () => {
  prisma = createPrisma();
  driver = createDriver(loadEnv());
  await applySchema(driver);
});

afterAll(async () => {
  await prisma.muleFlag.deleteMany({ where: { addr: { startsWith: run.toUpperCase() } } });
  await prisma.sharedMuleFlag.deleteMany({ where: { addr: { startsWith: run.toUpperCase() } } });
  await prisma.case.deleteMany({ where: { id: { startsWith: run } } }); // cascades TraceJob -> Hop, AddressCommunity
  const session = driver.session();
  try {
    await session.run('MATCH (a:Address) WHERE a.addr STARTS WITH $p DETACH DELETE a', { p: run.toUpperCase() });
  } finally {
    await session.close();
  }
  await driver.close();
  await prisma.$disconnect();
});

describe('analyzeMuleRings (B6 integration)', () => {
  it('detects pass-through, fan-out and fresh-wallet, runs GDS on the case subgraph, and is idempotent on rerun', async () => {
    const kase = await makeCase('c1');
    const trace = await makeTrace(kase.id, 't1', addr('VICTIM'));

    const mule1 = addr('MULE1');
    const mule2 = addr('MULE2'); // fresh wallet + fan-out
    const deposit = addr('DEPOSIT');
    const fanTargets = Array.from({ length: 5 }, (_, i) => addr(`FAN${i}`));

    await writeHopsBoth([
      { traceId: trace.id, hopNo: 1, txHash: id('tx1'), from: addr('VICTIM'), to: mule1, amount: '1000', ts: new Date(T0).toISOString() },
      // mule1: pass-through (in ~= out, dwell 20 min)
      { traceId: trace.id, hopNo: 2, txHash: id('tx2'), from: mule1, to: mule2, amount: '985', ts: new Date(T0 + 20 * 60_000).toISOString() },
      // mule2: fan-out to 5 distinct recipients within an hour (well below the pass-through value tolerance)
      ...fanTargets.map((t, i) => ({ traceId: trace.id, hopNo: 3 + i, txHash: id(`tx3-${i}`), from: mule2, to: t, amount: '100', ts: new Date(T0 + 20 * 60_000 + (i + 1) * 60_000).toISOString() })),
      { traceId: trace.id, hopNo: 20, txHash: id('tx20'), from: fanTargets[0], to: deposit, amount: '100', ts: new Date(T0 + 2 * 3_600_000).toISOString() },
    ]);

    // mule2 was 2 days old when it first received tainted funds -> FRESH_WALLET
    await prisma.addressProfile.upsert({
      where: { chain_addr: { chain: 'TRON', addr: mule2 } },
      update: {},
      create: { chain: 'TRON', addr: mule2, createdAt: new Date(T0 + 20 * 60_000 - 2 * 86_400_000) },
    });

    const result = await analyzeMuleRings({ prisma, driver }, kase.id);

    const rulesFor = (a: string) => result.flags.filter((f) => f.addr === a).map((f) => f.rule).sort();
    expect(rulesFor(mule1)).toEqual(['PASS_THROUGH']);
    expect(rulesFor(mule2)).toEqual(['FAN_OUT', 'FRESH_WALLET']);

    // persisted to Postgres
    const stored = await prisma.muleFlag.findMany({ where: { addr: { in: [mule1, mule2] } } });
    expect(stored.map((s) => s.rule).sort()).toEqual(['FAN_OUT', 'FRESH_WALLET', 'PASS_THROUGH']);

    // GDS ran on the case subgraph: victim, mule1, mule2 and the fan-out targets share one weakly-connected component
    expect(result.communities.length).toBeGreaterThan(0);
    const wccOf = (a: string) => result.communities.find((c) => c.addr === a)?.wccId;
    expect(wccOf(mule1)).toBeDefined();
    expect(wccOf(mule1)).toBe(wccOf(mule2));
    expect(wccOf(mule1)).toBe(wccOf(deposit));

    const storedCommunities = await prisma.addressCommunity.findMany({ where: { caseId: kase.id } });
    expect(storedCommunities.length).toBe(result.communities.length);

    // idempotent rerun: same rule rows, no duplicates, same community row count
    const again = await analyzeMuleRings({ prisma, driver }, kase.id);
    const storedAfterRerun = await prisma.muleFlag.findMany({ where: { addr: { in: [mule1, mule2] } } });
    expect(storedAfterRerun).toHaveLength(stored.length);
    const communitiesAfterRerun = await prisma.addressCommunity.findMany({ where: { caseId: kase.id } });
    expect(communitiesAfterRerun).toHaveLength(storedCommunities.length);
    expect(again.flags.length).toBe(result.flags.length);
  }, 60_000);

  it('flags a wallet shared across two cases as a shared-mule candidate with both case ids', async () => {
    const caseA = await makeCase('ca');
    const caseB = await makeCase('cb');
    const traceA = await makeTrace(caseA.id, 'ta', addr('VICTIMA'));
    const traceB = await makeTrace(caseB.id, 'tb', addr('VICTIMB'));
    const sharedMule = addr('SHARED');

    await writeHopsBoth([
      { traceId: traceA.id, hopNo: 1, txHash: id('sx1'), from: addr('VICTIMA'), to: sharedMule, amount: '500', ts: new Date(T0).toISOString() },
      { traceId: traceA.id, hopNo: 2, txHash: id('sx2'), from: sharedMule, to: addr('OUTA'), amount: '490', ts: new Date(T0 + 3_600_000).toISOString() },
      { traceId: traceB.id, hopNo: 1, txHash: id('sx3'), from: addr('VICTIMB'), to: sharedMule, amount: '300', ts: new Date(T0).toISOString() },
      { traceId: traceB.id, hopNo: 2, txHash: id('sx4'), from: sharedMule, to: addr('OUTB'), amount: '295', ts: new Date(T0 + 3_600_000).toISOString() },
    ]);

    const result = await analyzeMuleRings({ prisma, driver }, caseA.id);
    const shared = result.sharedMules.find((s) => s.addr === sharedMule);
    expect(shared).toBeDefined();
    expect(shared!.caseCount).toBe(2);
    expect(shared!.caseIds.sort()).toEqual([caseA.id, caseB.id].sort());

    const storedShared = await prisma.sharedMuleFlag.findUnique({ where: { chain_addr: { chain: 'TRON', addr: sharedMule } } });
    expect(storedShared).toMatchObject({ caseCount: 2 });
  }, 60_000);
});
