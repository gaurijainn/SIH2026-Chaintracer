import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}
import { createApp } from '../app';
import { AlertNotFoundError, InvalidAlertTransitionError } from './errors';
import type { AlertService } from './service';

let server: Server;
let base: string;

const alerts = [
  { id: 'a1', caseId: 'case1', rule: 'A1_MOVEMENT', severity: 'HIGH', status: 'NEW' },
  { id: 'a2', caseId: 'case1', rule: 'A2_VASP_LANDING', severity: 'CRITICAL', status: 'NEW' },
];

const fakeService = {
  list: async (filter: { caseId?: string; severity?: string; status?: string }) =>
    alerts.filter((a) => (!filter.caseId || a.caseId === filter.caseId) && (!filter.severity || a.severity === filter.severity) && (!filter.status || a.status === filter.status)),
  update: async (id: string, input: { action: string; assigneeId?: string; snoozedUntil?: string }) => {
    if (id === 'missing') throw new AlertNotFoundError(id);
    if (input.action === 'assign' && !input.assigneeId) throw new InvalidAlertTransitionError('assign requires assigneeId');
    return { id, status: input.action === 'acknowledge' ? 'ACKNOWLEDGED' : input.action === 'assign' ? 'ASSIGNED' : 'SNOOZED' };
  },
} as unknown as AlertService;

beforeAll(() => {
  const ok = async () => undefined;
  const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
  server = createApp(deps, { alerts: fakeService }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => server.close());

describe('GET /alerts', () => {
  it('lists every alert with no filter', async () => {
    const res = await fetch(`${base}/alerts`);
    expect((await json(res)).alerts).toHaveLength(2);
  });

  it('filters by severity', async () => {
    const res = await fetch(`${base}/alerts?severity=CRITICAL`);
    expect((await json(res)).alerts).toHaveLength(1);
  });

  it('rejects an invalid severity with 400', async () => {
    const res = await fetch(`${base}/alerts?severity=NOPE`);
    expect(res.status).toBe(400);
  });
});

describe('PATCH /alerts/:id', () => {
  it('acknowledges an alert', async () => {
    const res = await fetch(`${base}/alerts/a1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'acknowledge' }) });
    expect(res.status).toBe(200);
    expect((await json(res)).alert.status).toBe('ACKNOWLEDGED');
  });

  it('400s an assign with no assigneeId', async () => {
    const res = await fetch(`${base}/alerts/a1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'assign' }) });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('INVALID_TRANSITION');
  });

  it('404s for an unknown alert id', async () => {
    const res = await fetch(`${base}/alerts/missing`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'acknowledge' }) });
    expect(res.status).toBe(404);
  });
});
