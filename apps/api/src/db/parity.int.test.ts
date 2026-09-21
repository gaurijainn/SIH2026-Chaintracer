import type { Driver } from 'neo4j-driver';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAMPLE, SAMPLE_HOPS, loadEnv } from '@ps26183/shared';
import { createDriver, getEntityOf, getTransfersByTx, pathBetween } from '../graph/graph';
import { createPrisma, hopToGraph } from './prisma';
import { SAMPLE_CASE_ID, SAMPLE_TRACE_ID, seedGraph, seedPostgres } from './seed';

let prisma: PrismaClient;
let driver: Driver;

beforeAll(async () => {
  prisma = createPrisma();
  driver = createDriver(loadEnv());
  await seedPostgres(prisma);
  await seedGraph(prisma, driver);
});
afterAll(async () => {
  await prisma.$disconnect();
  await driver.close();
});

// B1 "done when": a seed script loads one sample case and the same hops are queryable in both stores.
describe('sample case is queryable in both PostgreSQL and Neo4j', () => {
  it('returns the same hops from both stores', async () => {
    const pgHops = await prisma.hop.findMany({ where: { trace: { caseId: SAMPLE_CASE_ID } }, orderBy: { hopNo: 'asc' } });
    expect(pgHops).toHaveLength(SAMPLE_HOPS.length);

    const graphHops = await getTransfersByTx(driver, pgHops.map((h) => h.txHash));
    expect(graphHops).toHaveLength(pgHops.length);

    for (const h of pgHops) {
      const g = graphHops.find((x) => x.tx === h.txHash && x.idx === h.idx);
      expect(g, h.txHash).toBeDefined();
      expect(g).toMatchObject({ chain: h.chain, from: h.fromAddr, to: h.toAddr, token: h.token });
      expect(g!.amount).toBe(h.amount.toFixed());
      expect(g!.usd).toBe(h.usd!.toFixed());
      expect(new Date(g!.ts).toISOString()).toBe(h.ts.toISOString());
      expect(hopToGraph(h)).toMatchObject({ from: g!.from, to: g!.to, tx: g!.tx });
    }
  });

  it('shows the same victim-to-exchange flow as a graph path and as ordered rows', async () => {
    const rows = await prisma.hop.findMany({ where: { traceId: SAMPLE_TRACE_ID }, orderBy: { hopNo: 'asc' } });
    const pgPath = [rows[0].fromAddr, ...rows.map((r) => r.toAddr)];
    const a = SAMPLE.addr;
    expect(pgPath).toEqual([a.victim, a.mule1, a.mule2, a.deposit, a.hotWallet]);
    expect(await pathBetween(driver, 'TRON', SAMPLE.addr.victim, SAMPLE.addr.hotWallet)).toEqual(pgPath);
  });

  it('attributes the deposit and hot wallet to the same exchange in Neo4j as in PostgreSQL', async () => {
    const vasp = await prisma.vasp.findUniqueOrThrow({ where: { name: SAMPLE.vasp.name }, include: { addresses: true } });
    expect(vasp.addresses.map((a) => a.addr)).toContain(SAMPLE.addr.hotWallet);
    const hot = await getEntityOf(driver, 'TRON', SAMPLE.addr.hotWallet);
    const dep = await getEntityOf(driver, 'TRON', SAMPLE.addr.deposit);
    expect(hot[0]).toMatchObject({ name: vasp.name, heuristic: 'H4_DIRECT_LABEL' });
    expect(dep[0]).toMatchObject({ name: vasp.name, heuristic: 'H1_DEPOSIT_SWEEP' });
  });

  it('re-seeding both stores leaves the graph unchanged', async () => {
    const txs = SAMPLE_HOPS.map((h) => h.txHash);
    const before = await getTransfersByTx(driver, txs);
    await seedPostgres(prisma);
    await seedGraph(prisma, driver);
    expect(await getTransfersByTx(driver, txs)).toEqual(before);
  });
});
