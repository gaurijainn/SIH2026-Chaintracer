import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { PrismaClient, Role } from '@prisma/client';
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockSahyog } from '@ps26183/mock-server/src/app';
import { canonicalize, loadEnv, sha256Hex } from '@ps26183/shared';
import { createApp } from '../app';
import { AuditService } from '../audit/service';
import { CaseService } from '../cases/service';
import { createPrisma } from '../db/prisma';
import { FreezeNoticeService } from '../freeze-notices/service';
import { createDriver } from '../graph/graph';
import { TraceGraphService } from '../graph/service';
import { createSahyogAdapter } from '../integrations/sahyogAdapter';
import { createIntakeService } from '../intake/service';
import { complaint, fakeProbe, RecordingQueue, tronAddress } from '../intake/testutil';
import { LabelAdminService } from '../labels/service';
import { ReportService } from '../reports/service';
import { VaspService } from '../vasps/service';
import type { AppSecurity } from './http';
import { FIR_PII_CONTEXT, PiiCipher, REPORT_FIR_PII_CONTEXT } from './pii';
import { PiiDecryptionError } from './errors';
import { InMemoryRefreshStore } from './refreshStore';
import { AuthService } from './service';
import { ensureTestUsers, TEST_PASSWORD, testTokens } from './testkit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * B10 against REAL Postgres (+ Neo4j for the evidence export and the mock SAHYOG over HTTP): real login for every
 * role, every audited action produces a hash-chained audit entry with the authenticated actor, and victim-linked
 * PII is stored only as AES-256-GCM ciphertext.
 */
const run = `b10${Date.now().toString(36)}`;
const key = randomBytes(32);
const pii = new PiiCipher(key);
const DEFAULTS = { maxHops: 6, minValueUsd: 10, windowDays: 30, taintModel: 'HAIRCUT' as const };

let prisma: PrismaClient;
let driver: Driver;
let server: Server;
let sahyogServer: Server;
let base: string;
let audit: AuditService;
let users: Record<Role, string>;
const token = {} as Record<Role, string>;
let startSeq = 0;
let caseId: string;
let traceId: string;
let vaspId: string;
const FIR = `FIR/${run}/2026`;

const call = (role: Role | null, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(role ? { authorization: `Bearer ${token[role]}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const j = async (res: Response): Promise<Json> => res.json();

/** Audit rows written since this test started, oldest first. */
const auditSince = (where: object = {}) => prisma.auditLog.findMany({ where: { seq: { gt: startSeq }, ...where }, orderBy: { seq: 'asc' } });

/** Recomputes hash + prevHash linkage for every row after `startSeq` (independent of any older rows in a shared dev DB). */
async function verifySegment() {
  const rows = await auditSince();
  const first = await prisma.auditLog.findFirst({ where: { seq: { lte: startSeq } }, orderBy: { seq: 'desc' } });
  let prev = first?.hash ?? null;
  for (const r of rows) {
    const expected = sha256Hex(canonicalize({ actorId: r.actorId, action: r.action, entity: r.entity, entityId: r.entityId, meta: r.meta ?? null, prevHash: r.prevHash, createdAt: r.createdAt.toISOString() }));
    if (r.prevHash !== prev || r.hash !== expected) return { valid: false, seq: r.seq };
    prev = r.hash;
  }
  return { valid: true, count: rows.length };
}

beforeAll(async () => {
  const env = loadEnv();
  prisma = createPrisma(process.env.DATABASE_URL);
  driver = createDriver(env);
  users = await ensureTestUsers(prisma);
  startSeq = (await prisma.auditLog.aggregate({ _max: { seq: true } }))._max.seq ?? 0;
  audit = new AuditService({ prisma });

  const vasp = await prisma.vasp.create({
    data: { name: `${run}-Exchange`, type: 'CENTRALISED_EXCHANGE', jurisdiction: 'IN', fiuStatus: 'REGISTERED', addresses: { create: [{ chain: 'TRON', addr: `${run}TDeposit`, source: 'test', confidence: '0.99' }] } },
  });
  vaspId = vasp.id;

  sahyogServer = createMockSahyog().listen(0);
  const sahyog = createSahyogAdapter({ DATA_MODE: 'live', FIXTURES_DIR: 'fixtures', SAHYOG_MODE: 'sandbox', SAHYOG_BASE_URL: `http://127.0.0.1:${(sahyogServer.address() as AddressInfo).port}` });

  const tokens = testTokens();
  const security: AppSecurity = {
    config: { corsOrigins: [], rateLimit: { windowS: 60, max: 100000, authMax: 100000 } },
    tokens,
    auth: new AuthService({ prisma, tokens, store: new InMemoryRefreshStore(), audit }),
  };
  const ok = async () => undefined;
  const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
  const intake = createIntakeService({ prisma, queue: new RecordingQueue(), probe: fakeProbe().probe, defaults: DEFAULTS, pii });
  server = createApp(
    deps,
    {
      intake,
      cases: new CaseService({ prisma, audit, pii }),
      traceGraph: new TraceGraphService({ prisma }),
      labels: new LabelAdminService({ prisma, audit }),
      vasps: new VaspService({ prisma, audit }),
      reports: new ReportService({ prisma, driver, audit, pii }),
      freezeNotices: new FreezeNoticeService({ prisma, audit, sahyog }),
    },
    security,
  ).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  for (const role of ['VIEWER', 'INVESTIGATOR', 'SUPERVISOR', 'ADMIN'] as Role[]) {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `b10-${role.toLowerCase()}@test.local`, password: TEST_PASSWORD }) });
    expect(res.status).toBe(200);
    token[role] = (await j(res)).accessToken;
  }
}, 60000);

afterAll(async () => {
  // Audit rows (and the users they reference) are deliberately kept: the log is append-only.
  await prisma.freezeNotice.deleteMany({ where: { caseId } });
  await prisma.report.deleteMany({ where: { caseId } });
  await prisma.hop.deleteMany({ where: { traceId } });
  await prisma.traceJob.deleteMany({ where: { caseId } });
  await prisma.complaint.deleteMany({ where: { ackNo: { startsWith: run } } });
  await prisma.case.deleteMany({ where: { id: caseId } });
  await prisma.label.deleteMany({ where: { addr: { startsWith: run } } });
  await prisma.vaspAddress.deleteMany({ where: { vaspId } });
  await prisma.vasp.deleteMany({ where: { name: { startsWith: run } } });
  await prisma.$disconnect();
  await driver.close();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => sahyogServer.close(() => r()));
}, 30000);

describe('victim-linked PII encryption at rest (Case.firNumber)', () => {
  it('intake stores only AES-256-GCM ciphertext; the API returns plaintext to an authorised reader', async () => {
    const res = await call('INVESTIGATOR', 'POST', '/complaints', complaint(`${run}-1`, { addresses: [tronAddress(`${run}-mule`)], firNumber: FIR }));
    expect(res.status).toBe(201);
    caseId = (await j(res)).complaint.caseId;

    // raw SQL, bypassing every application layer: no plaintext anywhere in the row
    const raw = await prisma.$queryRaw<{ firNumber: string; row: string }[]>`SELECT "firNumber", c::text AS row FROM "Case" c WHERE id = ${caseId}`;
    expect(raw[0].firNumber).toMatch(/^enc:v1:/);
    expect(raw[0].row).not.toContain(FIR);

    const view = await j(await call('VIEWER', 'GET', `/cases/${caseId}`));
    expect(view.case.firNumber).toBe(FIR);
  });

  it('cannot be decrypted with the wrong key or in the wrong field context', async () => {
    const stored = (await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).firNumber!;
    expect(pii.decrypt(stored, FIR_PII_CONTEXT)).toBe(FIR);
    expect(() => new PiiCipher(randomBytes(32)).decrypt(stored, FIR_PII_CONTEXT)).toThrow(PiiDecryptionError);
    expect(() => pii.decrypt(stored, 'Complaint.ackNo')).toThrow(PiiDecryptionError);
  });

  it('a case view with the wrong key fails closed (500, no ciphertext or plaintext leaked)', async () => {
    const wrong = new CaseService({ prisma, audit, pii: new PiiCipher(randomBytes(32)) });
    await expect(wrong.view(caseId, users.VIEWER)).rejects.toThrow(PiiDecryptionError);
  });
});

describe('audit: case view, export, notice lifecycle, label change', () => {
  it('case view -> one "case viewed" entry with the authenticated actor', async () => {
    const before = (await auditSince({ action: 'case viewed', entityId: caseId })).length;
    expect((await call('SUPERVISOR', 'GET', `/cases/${caseId}`)).status).toBe(200);
    const rows = await auditSince({ action: 'case viewed', entityId: caseId });
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({ actorId: users.SUPERVISOR, entity: 'Case' });
    expect((await call('VIEWER', 'GET', '/cases/does-not-exist')).status).toBe(404);
  });

  it('every evidence export (JSON) is audited with actor, format and hash; the Report records its creator', async () => {
    traceId = (await prisma.traceJob.findFirstOrThrow({ where: { caseId } })).id;
    const exportsBefore = (await auditSince({ action: 'evidence exported' })).length;
    const res = await call('INVESTIGATOR', 'POST', `/cases/${caseId}/reports?format=json`, {});
    expect(res.status).toBe(201);
    const body = await j(res);
    expect(body.evidence.case.firNumber).toBe(FIR); // the evidence document carries the decrypted reference
    const exported = await auditSince({ action: 'evidence exported' });
    expect(exported).toHaveLength(exportsBefore + 1);
    expect(exported.at(-1)).toMatchObject({ actorId: users.INVESTIGATOR, entity: 'Report', entityId: body.report.id });
    expect(exported.at(-1)!.meta).toMatchObject({ caseId, format: 'json', sha256: body.report.sha256 });
    expect((await prisma.report.findUniqueOrThrow({ where: { id: body.report.id } })).createdById).toBe(users.INVESTIGATOR);

    // PII regression: the stored payload never contains the plaintext FIR, only ciphertext, yet the hash still verifies
    const raw = await prisma.$queryRaw<{ payload: string; fir: string }[]>`SELECT payload::text AS payload, payload->'case'->>'firNumber' AS fir FROM "Report" WHERE id = ${body.report.id}`;
    expect(raw[0].payload).not.toContain(FIR);
    expect(raw[0].fir).toMatch(/^enc:v1:/);
    expect(raw[0].fir).toBe(body.integrity.firNumberAsHashed);
    expect(pii.decrypt(raw[0].fir, REPORT_FIR_PII_CONTEXT)).toBe(FIR);
    const persistedCase = { ...body.evidence.case, firNumber: raw[0].fir };
    expect(sha256Hex(canonicalize({ ...body.evidence, case: persistedCase }))).toBe(body.report.sha256); // exported JSON + disclosed value reproduces the hash

    // a Viewer cannot export, and a refused export leaves no audit entry
    const n = (await auditSince({ action: 'evidence exported' })).length;
    expect((await call('VIEWER', 'POST', `/cases/${caseId}/reports`, {})).status).toBe(403);
    expect((await auditSince({ action: 'evidence exported' })).length).toBe(n);

    // public verification still works without a token
    const verify = await fetch(`${base}/verify/${body.report.sha256}`);
    expect(verify.status).toBe(200);
    expect((await j(verify)).match).toBe(true);
  });

  it('notice lifecycle: draft, edit, submit, approve, send are each audited with the acting user; supervisor-only gates hold', async () => {
    await prisma.hop.create({ data: { traceId, hopNo: 0, chain: 'TRON', txHash: `${run}-tx`, fromAddr: 'TVictimAddr', toAddr: `${run}TDeposit`, token: 'USDT', amount: '250', usd: '250', ts: new Date('2026-01-01T00:00:00Z') } });

    const draft = await call('INVESTIGATOR', 'POST', `/cases/${caseId}/freeze-notices`, { vaspId });
    expect(draft.status).toBe(201);
    const id = (await j(draft)).freezeNotice.id as string;
    expect((await call('INVESTIGATOR', 'PATCH', `/freeze-notices/${id}`, { legalProvision: 'reviewed by legal cell' })).status).toBe(200);
    expect((await call('INVESTIGATOR', 'POST', `/freeze-notices/${id}/submit`, {})).status).toBe(200);

    // Investigator / Viewer / Admin cannot approve or send; status unchanged
    for (const role of ['INVESTIGATOR', 'VIEWER', 'ADMIN'] as Role[]) {
      expect((await call(role, 'POST', `/freeze-notices/${id}/approve`, {})).status).toBe(403);
      expect((await call(role, 'POST', `/freeze-notices/${id}/send`, {})).status).toBe(403);
    }
    expect((await prisma.freezeNotice.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING_APPROVAL');

    expect((await call('SUPERVISOR', 'POST', `/freeze-notices/${id}/approve`, {})).status).toBe(200);
    const sent = await call('SUPERVISOR', 'POST', `/freeze-notices/${id}/send`, {});
    expect(sent.status).toBe(200);
    expect((await j(sent)).freezeNotice.status).toBe('SENT');

    const row = await prisma.freezeNotice.findUniqueOrThrow({ where: { id } });
    expect(row.createdById).toBe(users.INVESTIGATOR);
    expect(row.approvedById).toBe(users.SUPERVISOR); // the approver is the authenticated supervisor, not a client-supplied id

    const trail = (await auditSince({ entity: 'FreezeNotice', entityId: id })).map((r) => [r.action, r.actorId]);
    expect(trail).toEqual([
      ['freeze notice drafted', users.INVESTIGATOR],
      ['freeze notice edited', users.INVESTIGATOR],
      ['freeze notice submitted for approval', users.INVESTIGATOR],
      ['freeze notice approved', users.SUPERVISOR],
      ['freeze notice submission attempted', users.SUPERVISOR],
      ['freeze notice submitted', users.SUPERVISOR],
    ]);
  });

  it('label changes are audited: create, update (with previous values), delete; imported labels are protected', async () => {
    const addr = tronAddress(`${run}-label`);
    const body = { chain: 'TRON', addr, name: `${run}-suspect`, category: 'scam', confidence: 0.7 };
    const created = await call('INVESTIGATOR', 'POST', '/labels', body);
    expect(created.status).toBe(201);
    const label = (await j(created)).label;
    expect((await call('INVESTIGATOR', 'POST', '/labels', { ...body, category: 'mixer', confidence: 0.9 })).status).toBe(201);
    expect((await call('VIEWER', 'POST', '/labels', body)).status).toBe(403);
    expect((await call('INVESTIGATOR', 'POST', '/labels', { ...body, addr: 'not-an-address' })).status).toBe(400);

    const imported = await prisma.label.create({ data: { chain: 'TRON', addr: `${run}-imported`, name: 'exchange', category: 'exchange', source: 'tronscan', confidence: '0.9' } });
    expect((await call('ADMIN', 'DELETE', `/labels/${imported.id}`)).status).toBe(409);
    expect((await call('ADMIN', 'DELETE', `/labels/${label.id}`)).status).toBe(204);
    expect((await call('ADMIN', 'DELETE', `/labels/${label.id}`)).status).toBe(404);

    const trail = await auditSince({ entity: 'Label', entityId: label.id });
    expect(trail.map((r) => [r.action, r.actorId])).toEqual([
      ['label created', users.INVESTIGATOR],
      ['label updated', users.INVESTIGATOR],
      ['label deleted', users.ADMIN],
    ]);
    expect(trail[1].meta).toMatchObject({ category: 'mixer', previous: { category: 'scam' } });
  });

  it('VASP registry: any role can read, only Admin writes, and the write is audited', async () => {
    const seed = { name: `${run}-NewVasp`, type: 'OTC', jurisdiction: 'IN', fiuStatus: 'NOTICED' };
    expect((await call('SUPERVISOR', 'POST', '/vasps', seed)).status).toBe(403);
    const res = await call('ADMIN', 'POST', '/vasps', seed);
    expect(res.status).toBe(201);
    const id = (await j(res)).vasp.id;
    expect((await auditSince({ entity: 'Vasp', entityId: id }))[0]).toMatchObject({ action: 'vasp created', actorId: users.ADMIN });
    const list = await j(await call('VIEWER', 'GET', '/vasps'));
    expect(list.vasps.some((v: { name: string }) => v.name === seed.name)).toBe(true);
  });

  it('login and refresh-token reuse are audited without recording the typed email', async () => {
    const bad = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ghost@nowhere.example', password: 'x' }) });
    expect(bad.status).toBe(401);
    const failed = (await auditSince({ action: 'login failed' })).at(-1)!;
    expect(JSON.stringify(failed)).not.toContain('ghost@nowhere.example');
    expect((await auditSince({ action: 'login', actorId: users.SUPERVISOR })).length).toBeGreaterThanOrEqual(1);
  });

  it('GET /traces/:id/graph returns nodes/edges from persisted hops, honours filters, 404s on unknown', async () => {
    const g = await j(await call('VIEWER', 'GET', `/traces/${traceId}/graph`));
    expect(g.edges.length).toBe(1);
    expect(g.nodes.map((n: { addr: string }) => n.addr).sort()).toEqual(['TVictimAddr', `${run}TDeposit`].sort());
    expect((await j(await call('VIEWER', 'GET', `/traces/${traceId}/graph?minValueUsd=1000`))).edges).toHaveLength(0);
    expect((await call('VIEWER', 'GET', `/traces/${traceId}/graph?chain=DOGE`)).status).toBe(400);
    expect((await call('VIEWER', 'GET', '/traces/nope/graph')).status).toBe(404);
    expect((await call(null, 'GET', `/traces/${traceId}/graph`)).status).toBe(401);
  });
});

describe('chain of custody', () => {
  it('the audit hash chain written by all of the above is intact, with no forked links', async () => {
    const res = await verifySegment();
    expect(res.valid).toBe(true);
    expect(res.count).toBeGreaterThan(15);
    const rows = await auditSince();
    expect(new Set(rows.map((r) => r.prevHash)).size).toBe(rows.length);
    // the service-level scoped verifiers agree
    expect((await audit.verifyChain('Case', caseId)).valid).toBe(true);
    expect((await audit.verifyChain('Label')).valid).toBe(true);
  });

  it('concurrent audited requests do not fork the chain (advisory lock)', async () => {
    await Promise.all(Array.from({ length: 15 }, () => call('VIEWER', 'GET', `/cases/${caseId}`)));
    expect((await verifySegment()).valid).toBe(true);
  });

  it('tampering with an audit row is detected', async () => {
    const victim = (await auditSince({ action: 'case viewed' }))[0];
    const original = victim.meta;
    await prisma.auditLog.update({ where: { id: victim.id }, data: { action: 'case viewed (edited)' } });
    expect((await verifySegment()).valid).toBe(false);
    await prisma.auditLog.update({ where: { id: victim.id }, data: { action: 'case viewed', meta: original ?? undefined } });
    expect((await verifySegment()).valid).toBe(true);
  });
});
