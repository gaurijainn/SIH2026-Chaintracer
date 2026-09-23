import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockSahyog } from '@ps26183/mock-server/src/app';
import { AuditService } from '../audit/service';
import { createApp } from '../app';
import { createPrisma } from '../db/prisma';
import { createSahyogAdapter } from '../integrations/sahyogAdapter';
import { FreezeNoticeService } from './service';
import { testSecurity, authFetch, ensureTestUsers } from '../auth/testkit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}

/**
 * B9 freeze-notice golden path against REAL Postgres: draft -> approve -> send, where `send` calls
 * a real (local, sandboxed) mock SAHYOG server over HTTP and persists the returned submissionId.
 */
const run = `b9fn${Date.now().toString(36)}`;
let prisma: PrismaClient;
let server: Server;
let base: string;
let sahyogServer: Server;
let caseId: string;
let vaspId: string;
let asInvestigator: ReturnType<typeof authFetch>;
let asSupervisor: ReturnType<typeof authFetch>;

beforeAll(async () => {
  prisma = createPrisma(process.env.DATABASE_URL);
  const users = await ensureTestUsers(prisma);
  asInvestigator = authFetch('INVESTIGATOR', users.INVESTIGATOR);
  asSupervisor = authFetch('SUPERVISOR', users.SUPERVISOR);

  const c = await prisma.case.create({ data: { id: `${run}-case1`, title: 'B9 freeze-notice int test' } });
  caseId = c.id;

  const vasp = await prisma.vasp.create({
    data: { name: `${run}-Binance`, type: 'CENTRALISED_EXCHANGE', jurisdiction: 'IN', fiuStatus: 'REGISTERED', contactEmail: 'legal@example.test', addresses: { create: [{ chain: 'TRON', addr: 'TDepositReal', source: 'test', confidence: '0.99' }] } },
  });
  vaspId = vasp.id;

  const trace = await prisma.traceJob.create({ data: { caseId, seedChain: 'TRON', seedAddr: 'TVictimAddr', status: 'COMPLETED' } });
  await prisma.hop.create({ data: { traceId: trace.id, hopNo: 0, chain: 'TRON', txHash: `${run}-tx1`, fromAddr: 'TVictimAddr', toAddr: 'TDepositReal', token: 'USDT', amount: '250', usd: '250', ts: new Date('2026-01-01T00:00:00Z') } });

  sahyogServer = createMockSahyog().listen(0);
  const sahyogBase = `http://127.0.0.1:${(sahyogServer.address() as AddressInfo).port}`;
  const sahyog = createSahyogAdapter({ DATA_MODE: 'live', FIXTURES_DIR: 'fixtures', SAHYOG_MODE: 'sandbox', SAHYOG_BASE_URL: sahyogBase });

  const audit = new AuditService({ prisma });
  const freezeNotices = new FreezeNoticeService({ prisma, audit, sahyog });

  const ok = async () => undefined;
  const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
  server = createApp(deps, { freezeNotices }, testSecurity()).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
}, 30000);

afterAll(async () => {
  await prisma.freezeNotice.deleteMany({ where: { caseId } });
  await prisma.hop.deleteMany({ where: { trace: { caseId } } });
  await prisma.traceJob.deleteMany({ where: { caseId } });
  await prisma.case.delete({ where: { id: caseId } });
  await prisma.vaspAddress.deleteMany({ where: { vaspId } });
  await prisma.vasp.delete({ where: { id: vaspId } });
  await prisma.$disconnect();
  await new Promise<void>((resolve) => sahyogServer.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
}, 30000);

describe('B9 freeze-notice golden path (real Postgres + real mock SAHYOG server)', () => {
  it('drafts, approves, and sends a freeze notice, persisting a real submissionId', async () => {
    const draftRes = await asInvestigator(`${base}/cases/${caseId}/freeze-notices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vaspId }) });
    expect(draftRes.status).toBe(201);
    const drafted = (await json(draftRes)).freezeNotice;
    expect(drafted.status).toBe('DRAFT');
    expect(drafted.legalProvision).toBeNull();
    expect(drafted.body.depositAddresses).toEqual(['TDepositReal']);
    expect(drafted.body.txHashes).toEqual([`${run}-tx1`]);

    // send() before approval must be rejected -- the state machine IS the guard.
    const earlySend = await asSupervisor(`${base}/freeze-notices/${drafted.id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(earlySend.status).toBe(400);

    const submitRes = await asInvestigator(`${base}/freeze-notices/${drafted.id}/submit`, { method: 'POST' });
    expect(submitRes.status).toBe(200);
    expect((await json(submitRes)).freezeNotice.status).toBe('PENDING_APPROVAL');

    const approveRes = await asSupervisor(`${base}/freeze-notices/${drafted.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(approveRes.status).toBe(200);
    expect((await json(approveRes)).freezeNotice.status).toBe('APPROVED');

    const sendRes = await asSupervisor(`${base}/freeze-notices/${drafted.id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(sendRes.status).toBe(200);
    const sent = (await json(sendRes)).freezeNotice;
    expect(sent.status).toBe('SENT');
    expect(typeof sent.submissionId).toBe('string');

    const dbRow = await prisma.freezeNotice.findUniqueOrThrow({ where: { id: drafted.id } });
    expect(dbRow.submissionId).toBe(sent.submissionId);
    expect(dbRow.status).toBe('SENT');

    // The audit chain for this notice is untampered.
    const audit = new AuditService({ prisma });
    const verified = await audit.verifyChain('FreezeNotice', drafted.id);
    expect(verified.valid).toBe(true);
  });
});
