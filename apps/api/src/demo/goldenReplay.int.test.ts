import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { PrismaClient, Role } from '@prisma/client';
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockSahyog } from '@ps26183/mock-server/src/app';
import { BACKUP_CASE_1, BACKUP_CASE_2, GOLDEN_CASE, canonicalize, loadEnv, sha256Hex, type AlertEventEnvelope, type DemoCase } from '@ps26183/shared';
import { AlertService } from '../alerts/service';
import { createApp } from '../app';
import { AuditService } from '../audit/service';
import type { AppSecurity } from '../auth/http';
import { PiiCipher } from '../auth/pii';
import { InMemoryRefreshStore } from '../auth/refreshStore';
import { AuthService } from '../auth/service';
import { ensureTestUsers, TEST_PASSWORD, testTokens } from '../auth/testkit';
import { CaseService } from '../cases/service';
import { createPrisma } from '../db/prisma';
import { FreezeNoticeService } from '../freeze-notices/service';
import { createDriver } from '../graph/graph';
import { TraceGraphService } from '../graph/service';
import { createSahyogAdapter } from '../integrations/sahyogAdapter';
import { createIntakeService } from '../intake/service';
import { LabelAdminService } from '../labels/service';
import { ReportService } from '../reports/service';
import { VaspService } from '../vasps/service';
import { WatchlistService } from '../watchlist/service';
import { demoReplayLayer, runDemoAttribution, runDemoMonitor, runDemoTrace } from './pipeline';
import { seedDemoCase } from './seedDemo';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * B11 golden replay end-to-end: complaint -> trace -> attribution -> alert -> freeze notice -> report -> verification,
 * driven through the real HTTP API (JWT + RBAC) for every step that has a route and through the real engines
 * (B4 trace over the DATA_MODE=replay provider layer, B5 attribution, B8 monitor) for the rest, against real
 * Postgres/Neo4j. Provider data comes only from recorded synthetic fixtures. Outbound networking is disabled for the
 * whole test: any socket to a non-loopback address is refused and counted, and the count must be zero.
 */
const key = Buffer.alloc(32, 7);
const pii = new PiiCipher(key);

let prisma: PrismaClient;
let driver: Driver;
let server: Server;
let sahyogServer: Server;
let base: string;
let audit: AuditService;
let users: Record<Role, string>;
const token = {} as Record<Role, string>;
let startSeq = 0;

// ---- "networking disabled": refuse every non-loopback connection, count attempts -------------------
const blockedConnections: string[] = [];
const realConnect = net.Socket.prototype.connect;
const isLoopback = (h: unknown) => h === undefined || h === null || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
function disableNetwork() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    const a = Array.isArray(args[0]) ? args[0][0] : args[0]; // Node passes socket.connect() the normalised [options, cb] array
    const host = typeof a === 'object' && a !== null ? (a.path ? undefined : a.host) : typeof a === 'number' ? args[1] : undefined;
    if (!isLoopback(host)) {
      blockedConnections.push(String(host));
      throw new Error(`network disabled: refused connection to ${String(host)}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (realConnect as any).apply(this, args);
  } as never;
}
const restoreNetwork = () => void (net.Socket.prototype.connect = realConnect);

const listen = (app: { listen: (port: number, host: string, cb: () => void) => Server }) => new Promise<Server>((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});

const call = (role: Role | null, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(role ? { authorization: `Bearer ${token[role]}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const j = (r: Response): Promise<Json> => r.json();
const auditSince = (where: object = {}) => prisma.auditLog.findMany({ where: { seq: { gt: startSeq }, ...where }, orderBy: { seq: 'asc' } });

async function verifySegment() {
  const rows = await auditSince();
  let prev = (await prisma.auditLog.findFirst({ where: { seq: { lte: startSeq } }, orderBy: { seq: 'desc' } }))?.hash ?? null;
  for (const r of rows) {
    const expected = sha256Hex(canonicalize({ actorId: r.actorId, action: r.action, entity: r.entity, entityId: r.entityId, meta: r.meta ?? null, prevHash: r.prevHash, createdAt: r.createdAt.toISOString() }));
    if (r.prevHash !== prev || r.hash !== expected) return { valid: false, seq: r.seq };
    prev = r.hash;
  }
  return { valid: true, count: rows.length };
}

/** A test owns the demo cases: drop their previous rows (never the append-only audit log) so every run starts clean. */
async function resetDemoCase(c: DemoCase) {
  const complaints = await prisma.complaint.findMany({ where: { ackNo: c.ackNo }, select: { caseId: true } });
  const caseIds = complaints.map((x) => x.caseId).filter(Boolean) as string[];
  await prisma.alert.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.watchlistItem.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.complaint.deleteMany({ where: { ackNo: c.ackNo } });
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  await prisma.monitorCheckpoint.deleteMany({ where: { addr: c.watch } });
  await prisma.attribution.deleteMany({ where: { addr: c.vasp.deposit } });
  await prisma.label.deleteMany({ where: { addr: { in: [c.vasp.deposit, c.vasp.hotWallet] } } });
}

beforeAll(async () => {
  disableNetwork();
  const env = loadEnv();
  prisma = createPrisma(process.env.DATABASE_URL);
  driver = createDriver(env);
  users = await ensureTestUsers(prisma);
  startSeq = (await prisma.auditLog.aggregate({ _max: { seq: true } }))._max.seq ?? 0;
  audit = new AuditService({ prisma });
  for (const c of [GOLDEN_CASE, BACKUP_CASE_1, BACKUP_CASE_2]) await resetDemoCase(c);

  sahyogServer = await listen(createMockSahyog());
  const sahyog = createSahyogAdapter({ DATA_MODE: 'live', FIXTURES_DIR: 'fixtures', SAHYOG_MODE: 'sandbox', SAHYOG_BASE_URL: `http://127.0.0.1:${(sahyogServer.address() as AddressInfo).port}` });

  const tokens = testTokens();
  const security: AppSecurity = {
    config: { corsOrigins: [], rateLimit: { windowS: 60, max: 100000, authMax: 100000 } },
    tokens,
    auth: new AuthService({ prisma, tokens, store: new InMemoryRefreshStore(), audit }),
  };
  const ok = async () => undefined;
  const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
  server = await listen(createApp(
    deps,
    {
      intake: createIntakeService({ prisma, queue: null, probe: null, defaults: { maxHops: 6, minValueUsd: 10, windowDays: 30, taintModel: 'HAIRCUT' }, pii }),
      cases: new CaseService({ prisma, audit, pii }),
      traceGraph: new TraceGraphService({ prisma }),
      labels: new LabelAdminService({ prisma, audit }),
      vasps: new VaspService({ prisma, audit }),
      watchlist: new WatchlistService({ prisma }),
      alerts: new AlertService({ prisma }),
      reports: new ReportService({ prisma, driver, audit, pii }),
      freezeNotices: new FreezeNoticeService({ prisma, audit, sahyog }),
    },
    security,
  ));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  for (const role of ['VIEWER', 'INVESTIGATOR', 'SUPERVISOR', 'ADMIN'] as Role[]) {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `b10-${role.toLowerCase()}@test.local`, password: TEST_PASSWORD }) });
    token[role] = (await j(res)).accessToken;
  }
}, 60000);

afterAll(async () => {
  restoreNetwork();
  // This test encrypts with a throwaway key, so it must not leave its cases behind for a stack that uses the real PII key
  // (`pnpm --filter @ps26183/api demo:seed` loads the demo data properly). Audit rows are append-only and stay.
  for (const c of [GOLDEN_CASE, BACKUP_CASE_1, BACKUP_CASE_2]) await resetDemoCase(c);
  await prisma.$disconnect();
  await driver.close();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => sahyogServer.close(() => r()));
}, 30000);

describe('golden demo case (replay, network disabled): complaint -> trace -> attribution -> alert -> notice -> report -> verify', () => {
  const c = GOLDEN_CASE;
  const ids = {} as { caseId: string; traceId: string; vaspId: string; alertId: string; noticeId: string; reportId: string; sha256: string };
  const published: AlertEventEnvelope[] = [];

  it('1. registry: an Admin registers the exchange and its hot wallet; Investigators cannot', async () => {
    const seed = { name: c.vasp.name, type: c.vasp.type, jurisdiction: c.vasp.jurisdiction, fiuStatus: c.vasp.fiuStatus, hotWallets: [{ chain: 'TRON', addr: c.vasp.hotWallet, source: 'demo-fixture', confidence: 0.95 }] };
    expect((await call('INVESTIGATOR', 'POST', '/vasps', seed)).status).toBe(403);
    const res = await call('ADMIN', 'POST', '/vasps', seed);
    expect(res.status).toBe(201);
    ids.vaspId = (await j(res)).vasp.id;
    // the hot wallet is a labelled service, which is what stops the trace there
    const label = await call('ADMIN', 'POST', '/labels', { chain: 'TRON', addr: c.vasp.hotWallet, name: c.vasp.name, category: 'exchange', confidence: 0.95, vaspId: ids.vaspId });
    expect(label.status).toBe(201);
  });

  it('2. complaint: an Investigator files it; the FIR reference is stored encrypted', async () => {
    const res = await call('INVESTIGATOR', 'POST', '/complaints', { ackNo: c.ackNo, reportedAt: c.reportedAt, category: c.category, amountInr: c.amountInr, network: 'TRC20', addresses: [c.seed], firNumber: c.firNumber });
    expect(res.status).toBe(201);
    ids.caseId = (await j(res)).complaint.caseId;
    ids.traceId = (await prisma.traceJob.findFirstOrThrow({ where: { caseId: ids.caseId } })).id;
    expect((await prisma.case.findUniqueOrThrow({ where: { id: ids.caseId } })).firNumber).toMatch(/^enc:v1:/);
    expect((await call('VIEWER', 'POST', '/complaints', {})).status).toBe(403);
  });

  it('3. trace: the real B4 engine over DATA_MODE=replay follows the funds to the exchange hot wallet', async () => {
    const result = await runDemoTrace({ prisma, driver }, ids.traceId);
    expect(result.hopsWritten).toBe(3);
    expect(result.terminals.map((t) => t.reason)).toEqual(['exchange']);
    expect((await prisma.traceJob.findUniqueOrThrow({ where: { id: ids.traceId } })).status).toBe('COMPLETED');

    const graph = await j(await call('VIEWER', 'GET', `/traces/${ids.traceId}/graph`));
    expect(graph.edges).toHaveLength(3);
    expect(graph.nodes.map((n: { addr: string }) => n.addr).sort()).toEqual([c.seed, c.watch, c.vasp.deposit, c.vasp.hotWallet].sort());
  });

  it('4. attribution: H1 deposit-sweep attributes the deposit address to the exchange', async () => {
    const [top] = await runDemoAttribution({ prisma, driver }, c);
    expect(top.vaspName).toBe(c.vasp.name);
    expect(top.confidence).toBeGreaterThanOrEqual(0.9);
    expect(top.heuristics[0].code).toBe('H1_DEPOSIT_SWEEP');
    expect(await prisma.attribution.count({ where: { addr: c.vasp.deposit, vaspId: ids.vaspId } })).toBe(1);
  });

  it('5. alert: the analyst confirms the label and watches the last mule; funds landing on the exchange raise a CRITICAL A2 alert', async () => {
    expect((await call('INVESTIGATOR', 'POST', '/labels', { chain: 'TRON', addr: c.vasp.deposit, name: c.vasp.name, category: 'exchange', confidence: 0.9, vaspId: ids.vaspId })).status).toBe(201);
    expect((await call('INVESTIGATOR', 'POST', '/watchlist', { caseId: ids.caseId, chain: 'TRON', addr: c.watch })).status).toBe(201);

    const poll = await runDemoMonitor({ prisma, publish: async (e) => void published.push(e) }, [c]);
    expect(poll.alertsCreated).toBe(2); // A1 movement + A2 VASP landing

    const alerts = (await j(await call('VIEWER', 'GET', `/alerts?caseId=${ids.caseId}&severity=CRITICAL`))).alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].rule).toBe('A2_VASP_LANDING');
    expect(alerts[0].metadata).toMatchObject({ freezeWindowOpen: true, vaspName: c.vasp.name });
    ids.alertId = alerts[0].id;
    expect(published.map((e) => e.event)).toContain('alert.new');
    expect((await call('VIEWER', 'PATCH', `/alerts/${ids.alertId}`, { action: 'acknowledge' })).status).toBe(403);
    expect((await call('INVESTIGATOR', 'PATCH', `/alerts/${ids.alertId}`, { action: 'acknowledge' })).status).toBe(200);
  });

  it('6. freeze notice: Investigator drafts, Supervisor approves and sends to the (mock) SAHYOG; the gate holds', async () => {
    const draft = await call('INVESTIGATOR', 'POST', `/cases/${ids.caseId}/freeze-notices`, { vaspId: ids.vaspId, alertId: ids.alertId });
    expect(draft.status).toBe(201);
    const notice = (await j(draft)).freezeNotice;
    ids.noticeId = notice.id;
    expect(notice.body.depositAddresses).toEqual([c.vasp.deposit]);
    expect((await call('INVESTIGATOR', 'POST', `/freeze-notices/${ids.noticeId}/submit`, {})).status).toBe(200);
    expect((await call('INVESTIGATOR', 'POST', `/freeze-notices/${ids.noticeId}/approve`, {})).status).toBe(403);
    expect((await call('SUPERVISOR', 'POST', `/freeze-notices/${ids.noticeId}/approve`, {})).status).toBe(200);
    const sent = await j(await call('SUPERVISOR', 'POST', `/freeze-notices/${ids.noticeId}/send`, {}));
    expect(sent.freezeNotice.status).toBe('SENT');
    expect(typeof sent.freezeNotice.submissionId).toBe('string');
  });

  it('7. report + verification: the evidence report exports, carries the whole story, and its hash verifies publicly', async () => {
    const res = await call('INVESTIGATOR', 'POST', `/cases/${ids.caseId}/reports?format=json`, {});
    expect(res.status).toBe(201);
    const body = await j(res);
    ids.reportId = body.report.id;
    ids.sha256 = body.report.sha256;
    expect(body.evidence.case.firNumber).toBe(c.firNumber);
    expect(body.evidence.hops).toHaveLength(3);
    expect(body.evidence.attribution.some((a: { vaspName?: string; vasp?: string }) => JSON.stringify(a).includes(c.vasp.name))).toBe(true);
    // the hash covers the persisted form, where the FIR is ciphertext; substituting the disclosed value reproduces it
    expect(sha256Hex(canonicalize({ ...body.evidence, case: { ...body.evidence.case, firNumber: body.integrity.firNumberAsHashed } }))).toBe(ids.sha256);

    const verify = await fetch(`${base}/verify/${ids.sha256}`); // no token: public
    expect(verify.status).toBe(200);
    expect((await j(verify)).match).toBe(true);
    expect((await call('VIEWER', 'POST', `/cases/${ids.caseId}/reports`, {})).status).toBe(403);
  });

  it('8. chain of custody: every audited step is recorded with its actor and the hash chain is intact', async () => {
    expect((await call('SUPERVISOR', 'GET', `/cases/${ids.caseId}`)).status).toBe(200);
    const view = await j(await call('VIEWER', 'GET', `/cases/${ids.caseId}`));
    expect(view.case.firNumber).toBe(c.firNumber);

    const trail = (await auditSince()).map((r) => `${r.action}|${r.actorId}`);
    expect(trail.some((t) => t === `vasp created|${users.ADMIN}` || t === `vasp updated|${users.ADMIN}`)).toBe(true); // an existing registry entry is updated, not duplicated
    for (const expected of [
      `label created|${users.ADMIN}`,
      `label created|${users.INVESTIGATOR}`,
      `freeze notice drafted|${users.INVESTIGATOR}`,
      `freeze notice approved|${users.SUPERVISOR}`,
      `freeze notice submitted|${users.SUPERVISOR}`,
      `evidence exported|${users.INVESTIGATOR}`,
      `case viewed|${users.SUPERVISOR}`,
    ]) expect(trail, expected).toContain(expected);
    const exported = await auditSince({ action: 'evidence exported', entityId: ids.reportId });
    expect(exported).toHaveLength(1);
    expect((await verifySegment()).valid).toBe(true);
  });

  it('9. the whole scenario made zero non-loopback connections (networking disabled)', () => {
    expect(blockedConnections).toEqual([]);
    // self-test: the guard really refuses an external connection (and records it), so "zero" above is meaningful
    expect(() => net.connect({ host: '93.184.216.34', port: 80 })).toThrow(/network disabled/);
    expect(blockedConnections.splice(0)).toEqual(['93.184.216.34']);
    expect(net.Socket.prototype.connect).not.toBe(realConnect); // the guard was active throughout
  });
});

describe('backup demo cases and seeding (replay, network disabled)', () => {
  for (const c of [GOLDEN_CASE, BACKUP_CASE_1, BACKUP_CASE_2]) {
    it(`${c.key}: seedDemoCase runs the whole pipeline, reaches the CRITICAL landing, and is idempotent`, async () => {
      await resetDemoCase(c);
      const deps = { prisma, driver, audit, pii, layer: demoReplayLayer(), actorId: users.INVESTIGATOR };
      const first = await seedDemoCase(deps, c);
      expect(first.attributedVasp).toBe(c.vasp.name);
      expect(first.hops).toBe({ golden: 3, 'backup-1': 5, 'backup-2': 4 }[c.key]);
      expect(first.alerts.map((a) => a.rule).sort()).toEqual(['A1_MOVEMENT', 'A2_VASP_LANDING']);
      expect(first.alerts.find((a) => a.rule === 'A2_VASP_LANDING')?.severity).toBe('CRITICAL');

      const again = await seedDemoCase(deps, c);
      expect(again.caseId).toBe(first.caseId);
      expect(again.hops).toBe(first.hops);
      expect(again.alerts).toHaveLength(2); // no duplicate alerts on re-seed
      expect(await prisma.complaint.count({ where: { ackNo: c.ackNo } })).toBe(1);

      const graph = await j(await call('VIEWER', 'GET', `/traces/${first.traceId}/graph`));
      const addrs = new Set(graph.nodes.map((n: { addr: string }) => n.addr));
      for (const a of c.expectedAddresses) expect(addrs.has(a), a).toBe(true);
      expect(blockedConnections).toEqual([]);
    }, 60000);
  }
});
