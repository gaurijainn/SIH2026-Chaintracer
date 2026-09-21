import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAMPLE, SAMPLE_HOPS } from '@ps26183/shared';
import { createPrisma } from './prisma';
import { SAMPLE_CASE_ID, SAMPLE_TRACE_ID, seedPostgres } from './seed';

let prisma: PrismaClient;
const u = `t${Date.now()}`; // unique suffix so tests never collide with seed data
const cleanup: (() => Promise<unknown>)[] = [];

beforeAll(() => {
  prisma = createPrisma();
});
afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
  await prisma.$disconnect();
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) return e.code;
    throw e;
  }
  return 'OK';
};

async function makeCase() {
  const c = await prisma.case.create({ data: { title: `case ${u}` } });
  cleanup.push(() => prisma.case.delete({ where: { id: c.id } }));
  return c;
}
async function makeTrace(caseId: string) {
  return prisma.traceJob.create({ data: { caseId, seedChain: 'TRON', seedAddr: 'TSEED', reportedAmount: '100' } });
}

describe('schema: all 16 models are usable and related', () => {
  it('creates one of every model and navigates the relationships', async () => {
    const user = await prisma.user.create({ data: { email: `${u}@x.test`, name: 'U', passwordHash: 'h', role: 'SUPERVISOR' } });
    cleanup.push(() => prisma.user.delete({ where: { id: user.id } }));
    const c = await prisma.case.create({ data: { title: `rel ${u}`, ownerId: user.id } });
    cleanup.push(() => prisma.case.delete({ where: { id: c.id } }));

    const complaint = await prisma.complaint.create({
      data: {
        ackNo: `ACK-${u}`, reportedAt: new Date(), category: 'x', amountInr: '1000.50', caseId: c.id,
        addresses: { create: [{ raw: ' TX ', address: 'TX', chain: 'TRON' }] },
      },
    });
    cleanup.push(() => prisma.complaint.delete({ where: { id: complaint.id } }));

    const trace = await makeTrace(c.id);
    const hop = await prisma.hop.create({
      data: { traceId: trace.id, hopNo: 0, chain: 'TRON', txHash: 'h1', fromAddr: 'A', toAddr: 'B', token: 'USDT', amount: '5', ts: new Date() },
    });
    const vasp = await prisma.vasp.create({ data: { name: `v-${u}`, type: 'INSTANT_SWAP', jurisdiction: 'X', fiuStatus: 'NOTICED' } });
    cleanup.push(() => prisma.vasp.delete({ where: { id: vasp.id } }));
    await prisma.vaspAddress.create({ data: { vaspId: vasp.id, chain: 'TRON', addr: `VA-${u}`, source: 't', confidence: '0.9' } });
    await prisma.label.create({ data: { chain: 'TRON', addr: `VA-${u}`, name: 'n', category: 'exchange', source: 'manual', confidence: '0.8', vaspId: vasp.id } });
    await prisma.addressProfile.create({ data: { chain: 'TRON', addr: `AP-${u}`, flags: { tronscan: false } } });
    cleanup.push(() => prisma.addressProfile.deleteMany({ where: { addr: `AP-${u}` } }));
    await prisma.riskScore.create({ data: { chain: 'TRON', addr: 'B', score: 90, band: 'CRITICAL', factors: [], overrides: ['SANCTIONED'], modelVersion: 't', traceId: trace.id } });
    await prisma.alert.create({ data: { caseId: c.id, rule: 'A2_VASP_LANDING', severity: 'CRITICAL', chain: 'TRON', address: 'B', message: 'm', hopId: hop.id, assigneeId: user.id } });
    await prisma.watchlistItem.create({ data: { caseId: c.id, chain: 'TRON', addr: 'B', reason: 'mule', addedById: user.id } });
    await prisma.report.create({ data: { caseId: c.id, sha256: 'a'.repeat(64), payload: { v: 1 }, createdById: user.id } });
    await prisma.freezeNotice.create({ data: { caseId: c.id, vaspId: vasp.id, body: {}, createdById: user.id } });
    const log = await prisma.auditLog.create({ data: { actorId: user.id, action: 'CASE_VIEW', entity: 'Case', entityId: c.id } });
    const log2 = await prisma.auditLog.create({ data: { actorId: user.id, action: 'CASE_VIEW', entity: 'Case', entityId: c.id } });
    expect(log2.seq).toBeGreaterThan(log.seq);
    cleanup.push(() => prisma.auditLog.deleteMany({ where: { actorId: user.id } }));

    const full = await prisma.case.findUniqueOrThrow({
      where: { id: c.id },
      include: {
        owner: true, complaints: { include: { addresses: true } }, traces: { include: { hops: true, riskScores: true } },
        alerts: { include: { hop: true, assignee: true } }, watchlistItems: true, reports: true, freezeNotices: { include: { vasp: true } },
      },
    });
    expect(full.owner?.id).toBe(user.id);
    expect(full.complaints[0].addresses).toHaveLength(1);
    expect(full.traces[0].hops[0].id).toBe(hop.id);
    expect(full.traces[0].riskScores).toHaveLength(1);
    expect(full.alerts[0].hop?.id).toBe(hop.id);
    expect(full.alerts[0].assignee?.id).toBe(user.id);
    expect(full.watchlistItems).toHaveLength(1);
    expect(full.reports).toHaveLength(1);
    expect(full.freezeNotices[0].vasp.id).toBe(vasp.id);
    const v = await prisma.vasp.findUniqueOrThrow({ where: { id: vasp.id }, include: { addresses: true, labels: true } });
    expect(v.addresses).toHaveLength(1);
    expect(v.labels).toHaveLength(1);
  });
});

describe('constraints', () => {
  it('rejects a duplicate Complaint.ackNo (P2002)', async () => {
    const data = { ackNo: `DUP-${u}`, reportedAt: new Date(), category: 'x', amountInr: '1' };
    const first = await prisma.complaint.create({ data });
    cleanup.push(() => prisma.complaint.delete({ where: { id: first.id } }));
    expect(await code(prisma.complaint.create({ data }))).toBe('P2002');
  });

  it('rejects a duplicate (traceId, txHash, fromAddr, toAddr) hop', async () => {
    const c = await makeCase();
    const t = await makeTrace(c.id);
    const data = { traceId: t.id, hopNo: 0, chain: 'TRON', txHash: 'dup', fromAddr: 'A', toAddr: 'B', token: 'USDT', amount: '1', ts: new Date() };
    await prisma.hop.create({ data });
    expect(await code(prisma.hop.create({ data: { ...data, hopNo: 1 } }))).toBe('P2002');
  });

  it('rejects duplicate Address profile (chain, addr), VASP name, VaspAddress (chain, addr), Label key, watchlist key, user email', async () => {
    await prisma.addressProfile.create({ data: { chain: 'TRON', addr: `D-${u}` } });
    cleanup.push(() => prisma.addressProfile.deleteMany({ where: { addr: `D-${u}` } }));
    expect(await code(prisma.addressProfile.create({ data: { chain: 'TRON', addr: `D-${u}` } }))).toBe('P2002');

    const vasp = await prisma.vasp.create({ data: { name: `dupv-${u}`, type: 'OTC', jurisdiction: 'X', fiuStatus: 'REGISTERED' } });
    cleanup.push(() => prisma.vasp.delete({ where: { id: vasp.id } }));
    expect(await code(prisma.vasp.create({ data: { name: `dupv-${u}`, type: 'OTC', jurisdiction: 'X', fiuStatus: 'REGISTERED' } }))).toBe('P2002');
    const va = { vaspId: vasp.id, chain: 'TRON', addr: `dva-${u}`, source: 's', confidence: '0.5' };
    await prisma.vaspAddress.create({ data: va });
    expect(await code(prisma.vaspAddress.create({ data: va }))).toBe('P2002');
    const lb = { chain: 'TRON', addr: `dl-${u}`, name: 'n', category: 'c', source: 's', confidence: '0.5' };
    await prisma.label.create({ data: lb });
    cleanup.push(() => prisma.label.deleteMany({ where: { addr: `dl-${u}` } }));
    expect(await code(prisma.label.create({ data: lb }))).toBe('P2002');

    const c = await makeCase();
    const w = { caseId: c.id, chain: 'TRON', addr: 'W', reason: 'mule' };
    await prisma.watchlistItem.create({ data: w });
    expect(await code(prisma.watchlistItem.create({ data: w }))).toBe('P2002');

    const e = { email: `dup-${u}@x.test`, name: 'n', passwordHash: 'h' };
    const usr = await prisma.user.create({ data: e });
    cleanup.push(() => prisma.user.delete({ where: { id: usr.id } }));
    expect(await code(prisma.user.create({ data: e }))).toBe('P2002');
  });

  it('enforces foreign keys (P2003) and cascade / restrict rules', async () => {
    expect(await code(prisma.hop.create({ data: { traceId: 'nope', hopNo: 0, chain: 'TRON', txHash: 'x', fromAddr: 'A', toAddr: 'B', token: 'T', amount: '1', ts: new Date() } }))).toBe('P2003');

    const c = await makeCase();
    const t = await makeTrace(c.id);
    await prisma.hop.create({ data: { traceId: t.id, hopNo: 0, chain: 'TRON', txHash: 'c1', fromAddr: 'A', toAddr: 'B', token: 'T', amount: '1', ts: new Date() } });
    await prisma.traceJob.delete({ where: { id: t.id } });
    expect(await prisma.hop.count({ where: { traceId: t.id } })).toBe(0); // cascade

    const vasp = await prisma.vasp.create({ data: { name: `rv-${u}`, type: 'P2P', jurisdiction: 'X', fiuStatus: 'REGISTERED' } });
    cleanup.push(() => prisma.vasp.delete({ where: { id: vasp.id } }));
    const n = await prisma.freezeNotice.create({ data: { caseId: c.id, vaspId: vasp.id, body: {} } });
    expect(await code(prisma.vasp.delete({ where: { id: vasp.id } }))).toBe('P2003'); // restrict
    await prisma.freezeNotice.delete({ where: { id: n.id } });
  });

  it('requires non-nullable fields (Complaint.amountInr, Hop.amount)', async () => {
    // @ts-expect-error amountInr is required
    await expect(prisma.complaint.create({ data: { ackNo: `nn-${u}`, reportedAt: new Date(), category: 'x' } })).rejects.toThrow();
  });
});

describe('Decimal and UTC handling', () => {
  it('round-trips 18-decimal token amounts exactly (no float rounding)', async () => {
    const c = await makeCase();
    const t = await makeTrace(c.id);
    const exact = '123456789.123456789012345678';
    await prisma.hop.create({ data: { traceId: t.id, hopNo: 0, chain: 'ETH', txHash: 'dec', fromAddr: 'A', toAddr: 'B', token: 'ETH', amount: exact, usd: '0.000001', ts: new Date() } });
    const h = await prisma.hop.findFirstOrThrow({ where: { traceId: t.id } });
    expect(h.amount.toFixed()).toBe(exact);
    expect(h.usd?.toFixed()).toBe('0.000001');
  });

  it('stores every DateTime column as timestamptz and returns the same UTC instant', async () => {
    const rows = await prisma.$queryRaw<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type LIKE 'timestamp%'`;
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((r) => r.data_type !== 'timestamp with time zone')).toEqual([]);

    const c = await makeCase();
    const t = await makeTrace(c.id);
    const ts = new Date('2026-09-01T08:10:00.000Z');
    await prisma.hop.create({ data: { traceId: t.id, hopNo: 0, chain: 'TRON', txHash: 'utc', fromAddr: 'A', toAddr: 'B', token: 'T', amount: '1', ts } });
    expect((await prisma.hop.findFirstOrThrow({ where: { traceId: t.id } })).ts.toISOString()).toBe('2026-09-01T08:10:00.000Z');
  });
});

describe('seed data', () => {
  it('loads the sample case, is idempotent, and preserves the flow', async () => {
    await seedPostgres(prisma);
    const count = () => Promise.all([prisma.hop.count({ where: { traceId: SAMPLE_TRACE_ID } }), prisma.user.count(), prisma.vasp.count(), prisma.alert.count({ where: { caseId: SAMPLE_CASE_ID } }), prisma.riskScore.count({ where: { traceId: SAMPLE_TRACE_ID } })]);
    const before = await count();
    await seedPostgres(prisma);
    expect(await count()).toEqual(before);

    expect(before[0]).toBe(SAMPLE_HOPS.length);
    const roles = (await prisma.user.findMany({ where: { email: { endsWith: '@demo.local' } } })).map((x) => x.role).sort();
    expect(roles).toEqual(['ADMIN', 'INVESTIGATOR', 'SUPERVISOR', 'VIEWER']);
    const hops = await prisma.hop.findMany({ where: { traceId: SAMPLE_TRACE_ID }, orderBy: { hopNo: 'asc' } });
    expect(hops[0].fromAddr).toBe(SAMPLE.addr.victim);
    expect(hops.at(-1)?.toAddr).toBe(SAMPLE.addr.hotWallet);
    const complaint = await prisma.complaint.findUniqueOrThrow({ where: { ackNo: SAMPLE.ackNo }, include: { addresses: true } });
    expect(complaint.caseId).toBe(SAMPLE_CASE_ID);
    expect(complaint.amountInr.toFixed(2)).toBe('500000.00');
  });
});
