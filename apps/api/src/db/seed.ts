import { randomBytes, scryptSync } from 'node:crypto';
import type { PrismaClient, Role } from '@prisma/client';
import type { Driver } from 'neo4j-driver';
import { SAMPLE, SAMPLE_HOPS } from '@ps26183/shared';
import { applySchema, linkToEntity, writeHops } from '../graph/graph';
import { hopToGraph } from './prisma';

export const SAMPLE_CASE_ID = 'sample-case';
export const SAMPLE_TRACE_ID = 'sample-trace';

const DEMO_PASSWORD = 'ChangeMe!123'; // demo accounts only; real credentials arrive with B10

function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(pw, salt, 32).toString('hex')}`;
}

const USERS: { email: string; name: string; role: Role }[] = [
  { email: 'investigator@demo.local', name: 'Demo Investigator', role: 'INVESTIGATOR' },
  { email: 'supervisor@demo.local', name: 'Demo Supervisor', role: 'SUPERVISOR' },
  { email: 'admin@demo.local', name: 'Demo Admin', role: 'ADMIN' },
  { email: 'viewer@demo.local', name: 'Demo Viewer', role: 'VIEWER' },
];

/** Loads the sample case into PostgreSQL. Idempotent (upserts on natural keys / fixed ids). */
export async function seedPostgres(prisma: PrismaClient): Promise<{ caseId: string; traceId: string }> {
  const { addr } = SAMPLE;
  const users: Record<string, string> = {};
  for (const u of USERS) {
    const row = await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, role: u.role },
      create: { ...u, passwordHash: hashPassword(DEMO_PASSWORD) },
    });
    users[u.role] = row.id;
  }

  await prisma.case.upsert({
    where: { id: SAMPLE_CASE_ID },
    update: {},
    create: {
      id: SAMPLE_CASE_ID,
      title: 'Sample case: investment fraud (synthetic)',
      firNumber: 'FIR-DEMO-001',
      ownerId: users.INVESTIGATOR,
    },
  });

  const complaint = await prisma.complaint.upsert({
    where: { ackNo: SAMPLE.ackNo },
    update: { caseId: SAMPLE_CASE_ID },
    create: {
      ackNo: SAMPLE.ackNo,
      reportedAt: new Date(SAMPLE.reportedAt),
      category: SAMPLE.category,
      amountInr: SAMPLE.amountInr,
      network: SAMPLE.network,
      caseId: SAMPLE_CASE_ID,
    },
  });
  await prisma.complaintAddress.upsert({
    where: { complaintId_address: { complaintId: complaint.id, address: addr.mule1 } },
    update: {},
    create: { complaintId: complaint.id, raw: addr.mule1, address: addr.mule1, chain: 'TRON' },
  });

  await prisma.traceJob.upsert({
    where: { id: SAMPLE_TRACE_ID },
    update: {},
    create: {
      id: SAMPLE_TRACE_ID,
      caseId: SAMPLE_CASE_ID,
      seedChain: 'TRON',
      seedAddr: addr.mule1,
      status: 'COMPLETED',
      reportedAmount: '5700',
      startedAt: new Date('2026-09-01T10:00:00.000Z'),
      finishedAt: new Date('2026-09-01T10:00:20.000Z'),
    },
  });

  for (const h of SAMPLE_HOPS) {
    const data = {
      hopNo: h.hopNo,
      chain: 'TRON',
      idx: h.idx,
      token: SAMPLE.token,
      amount: h.amount,
      usd: h.usd,
      ts: new Date(h.ts),
    };
    await prisma.hop.upsert({
      where: {
        traceId_txHash_fromAddr_toAddr: { traceId: SAMPLE_TRACE_ID, txHash: h.txHash, fromAddr: h.from, toAddr: h.to },
      },
      update: data,
      create: { traceId: SAMPLE_TRACE_ID, txHash: h.txHash, fromAddr: h.from, toAddr: h.to, ...data },
    });
  }

  const vasp = await prisma.vasp.upsert({
    where: { name: SAMPLE.vasp.name },
    update: {},
    create: {
      ...SAMPLE.vasp,
      type: 'CENTRALISED_EXCHANGE',
      fiuSource: 'synthetic demo data',
      contactEmail: 'compliance@demo-exchange.invalid',
    },
  });
  await prisma.vaspAddress.upsert({
    where: { chain_addr: { chain: 'TRON', addr: addr.hotWallet } },
    update: {},
    create: { vaspId: vasp.id, chain: 'TRON', addr: addr.hotWallet, kind: 'HOT_WALLET', source: 'synthetic', confidence: '0.990' },
  });
  await prisma.label.upsert({
    where: { chain_addr_source_name: { chain: 'TRON', addr: addr.hotWallet, source: 'manual', name: SAMPLE.vasp.name } },
    update: {},
    create: {
      chain: 'TRON',
      addr: addr.hotWallet,
      name: SAMPLE.vasp.name,
      category: 'exchange',
      source: 'manual',
      confidence: '0.990',
      vaspId: vasp.id,
    },
  });
  await prisma.addressProfile.upsert({
    where: { chain_addr: { chain: 'TRON', addr: addr.mule1 } },
    update: {},
    create: {
      chain: 'TRON',
      addr: addr.mule1,
      createdAt: new Date('2026-08-30T00:00:00.000Z'),
      activator: addr.mule2,
      flags: { source: 'synthetic' },
    },
  });

  const existingScore = await prisma.riskScore.findFirst({
    where: { chain: 'TRON', addr: addr.mule1, modelVersion: 'seed' },
  });
  if (!existingScore) {
    await prisma.riskScore.create({
      data: {
        chain: 'TRON',
        addr: addr.mule1,
        score: 82,
        band: 'CRITICAL',
        factors: [{ feature: 'dwell_median_min', impact: 0.21, reason: 'Forwards funds a median 32 min after receiving them' }],
        overrides: [],
        typology: 'investment_fraud',
        typologyConfidence: '0.700',
        modelVersion: 'seed',
        traceId: SAMPLE_TRACE_ID,
      },
    });
  }

  await prisma.watchlistItem.upsert({
    where: { caseId_chain_addr: { caseId: SAMPLE_CASE_ID, chain: 'TRON', addr: addr.mule2 } },
    update: {},
    create: { caseId: SAMPLE_CASE_ID, chain: 'TRON', addr: addr.mule2, reason: 'mule', addedById: users.INVESTIGATOR },
  });

  if ((await prisma.alert.count({ where: { caseId: SAMPLE_CASE_ID } })) === 0) {
    const landing = await prisma.hop.findFirstOrThrow({ where: { traceId: SAMPLE_TRACE_ID, toAddr: addr.hotWallet } });
    await prisma.alert.create({
      data: {
        caseId: SAMPLE_CASE_ID,
        rule: 'A2_VASP_LANDING',
        severity: 'CRITICAL',
        chain: 'TRON',
        address: addr.hotWallet,
        amount: landing.amount,
        message: 'Freeze window open: tainted funds reached an exchange-attributed address',
        hopId: landing.id,
      },
    });
  }

  return { caseId: SAMPLE_CASE_ID, traceId: SAMPLE_TRACE_ID };
}

/** Copies the sample trace's hops from PostgreSQL into Neo4j and adds the exchange entity. Idempotent. */
export async function seedGraph(prisma: PrismaClient, driver: Driver, traceId = SAMPLE_TRACE_ID): Promise<number> {
  await applySchema(driver);
  const hops = await prisma.hop.findMany({ where: { traceId }, orderBy: { hopNo: 'asc' } });
  await writeHops(driver, hops.map(hopToGraph));
  const entity = { name: SAMPLE.vasp.name, type: 'CENTRALISED_EXCHANGE' };
  await linkToEntity(driver, {
    chain: 'TRON',
    addr: SAMPLE.addr.hotWallet,
    entity,
    heuristic: 'H4_DIRECT_LABEL',
    confidence: 0.99,
  });
  await linkToEntity(driver, {
    chain: 'TRON',
    addr: SAMPLE.addr.deposit,
    entity,
    heuristic: 'H1_DEPOSIT_SWEEP',
    confidence: 0.9,
  });
  return hops.length;
}
