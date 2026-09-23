import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertService } from '../alerts/service';
import { createApp } from '../app';
import { createPrisma } from '../db/prisma';
import { WatchlistService } from '../watchlist/service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}

/** B8/F4 + B8/F7 HTTP-level integration test against a REAL Postgres, through createApp + real services. */
const run = `b8api${Date.now().toString(36)}`;
let prisma: PrismaClient;
let server: Server;
let base: string;
let caseId: string;
let userId: string;

beforeAll(async () => {
  prisma = createPrisma(process.env.DATABASE_URL);
  const c = await prisma.case.create({ data: { id: `${run}-case1`, title: 'B8 CRUD API int test' } });
  caseId = c.id;
  const u = await prisma.user.create({ data: { id: `${run}-user1`, email: `${run}@example.test`, name: 'B8 Int Test User', passwordHash: 'x', role: 'INVESTIGATOR' } });
  userId = u.id;
  const ok = async () => undefined;
  const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
  server = createApp(deps, { watchlist: new WatchlistService({ prisma }), alerts: new AlertService({ prisma }) }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await prisma.alert.deleteMany({ where: { caseId } });
  await prisma.watchlistItem.deleteMany({ where: { caseId } });
  await prisma.case.delete({ where: { id: caseId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('POST/GET/DELETE /watchlist against real Postgres', () => {
  it('adds, lists, dedups, and removes a watchlist item end to end', async () => {
    const addr = 'TSrXKizpGQmFnfUTZvH8EK2C73jPzkNMPS';

    const createRes = await fetch(`${base}/watchlist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ caseId, chain: 'TRON', addr }) });
    expect(createRes.status).toBe(201);
    const created = (await json(createRes)).item;
    expect(created.reason).toBe('manual');

    // Dedup: same (case, chain, addr) again -> 201 (idempotent create), still only one row in Postgres.
    const dupRes = await fetch(`${base}/watchlist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ caseId, chain: 'TRON', addr }) });
    expect(dupRes.status).toBe(201);

    const listRes = await fetch(`${base}/watchlist?caseId=${caseId}`);
    const items = (await json(listRes)).items as { id: string; addr: string }[];
    expect(items.filter((i) => i.addr === addr)).toHaveLength(1);

    const delRes = await fetch(`${base}/watchlist/${created.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(204);

    const listAfterDelete = await fetch(`${base}/watchlist?caseId=${caseId}`);
    const itemsAfterDelete = (await json(listAfterDelete)).items as { id: string }[];
    expect(itemsAfterDelete.find((i) => i.id === created.id)).toBeUndefined();
  });
});

describe('GET/PATCH /alerts against real Postgres', () => {
  it('lists, filters and transitions a real Alert row', async () => {
    const alertRow = await prisma.alert.create({
      data: { caseId, rule: 'A1_MOVEMENT', severity: 'MEDIUM', chain: 'TRON', address: 'TWcpBhHqFVtpAY1pT16QneLnLNXzTHTpbV', amount: '5000', message: 'int test alert' },
    });

    const listRes = await fetch(`${base}/alerts?caseId=${caseId}&severity=MEDIUM`);
    expect(listRes.status).toBe(200);
    const alerts = (await json(listRes)).alerts as { id: string; status: string }[];
    expect(alerts.map((a) => a.id)).toContain(alertRow.id);

    const patchRes = await fetch(`${base}/alerts/${alertRow.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'assign', assigneeId: userId }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await json(patchRes)).alert;
    expect(patched.status).toBe('ASSIGNED');

    const dbRow = await prisma.alert.findUniqueOrThrow({ where: { id: alertRow.id } });
    expect(dbRow.status).toBe('ASSIGNED');
    expect(dbRow.assigneeId).toBe(userId);
  });
});
