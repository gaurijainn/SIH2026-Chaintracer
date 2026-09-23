import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Role } from '@prisma/client';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { can, ROLE_PERMISSIONS, type Permission } from './permissions';
import { bearer, testSecurity } from './testkit';

const ROLES: Role[] = ['VIEWER', 'INVESTIGATOR', 'SUPERVISOR', 'ADMIN'];

/** Every protected route once, with the permission it requires and a syntactically valid request. */
const ROUTES: { method: string; path: string; url: string; permission: Permission; body?: unknown }[] = [
  { method: 'GET', path: '/complaints', url: '/complaints', permission: 'complaint:read' },
  { method: 'POST', path: '/complaints', url: '/complaints', permission: 'complaint:create', body: { ackNo: 'A1' } },
  { method: 'POST', path: '/complaints/import', url: '/complaints/import', permission: 'complaint:create' },
  { method: 'GET', path: '/cases/:id', url: '/cases/c1', permission: 'case:read' },
  { method: 'GET', path: '/traces/:id/graph', url: '/traces/t1/graph', permission: 'graph:read' },
  { method: 'POST', path: '/cases/:id/mule/analyze', url: '/cases/c1/mule/analyze', permission: 'mule:analyze', body: {} },
  { method: 'GET', path: '/cases/:id/mule/flags', url: '/cases/c1/mule/flags', permission: 'mule:read' },
  { method: 'GET', path: '/cases/:id/mule/communities', url: '/cases/c1/mule/communities', permission: 'mule:read' },
  { method: 'GET', path: '/addresses/:chain/:addr/shared-mule', url: '/addresses/TRON/Tx/shared-mule', permission: 'mule:read' },
  { method: 'GET', path: '/addresses/:chain/:addr/risk', url: '/addresses/TRON/Tx/risk', permission: 'risk:read' },
  { method: 'GET', path: '/watchlist', url: '/watchlist', permission: 'watchlist:read' },
  { method: 'POST', path: '/watchlist', url: '/watchlist', permission: 'watchlist:write', body: { caseId: 'c1', chain: 'TRON', addr: 'Tx' } },
  { method: 'DELETE', path: '/watchlist/:id', url: '/watchlist/w1', permission: 'watchlist:write' },
  { method: 'GET', path: '/alerts', url: '/alerts', permission: 'alert:read' },
  { method: 'PATCH', path: '/alerts/:id', url: '/alerts/a1', permission: 'alert:update', body: { action: 'acknowledge' } },
  { method: 'POST', path: '/cases/:id/reports', url: '/cases/c1/reports', permission: 'report:generate', body: {} },
  { method: 'POST', path: '/cases/:id/freeze-notices', url: '/cases/c1/freeze-notices', permission: 'notice:draft', body: { vaspId: 'v1' } },
  { method: 'PATCH', path: '/freeze-notices/:id', url: '/freeze-notices/n1', permission: 'notice:draft', body: { legalProvision: 'x' } },
  { method: 'POST', path: '/freeze-notices/:id/submit', url: '/freeze-notices/n1/submit', permission: 'notice:draft', body: {} },
  { method: 'POST', path: '/freeze-notices/:id/approve', url: '/freeze-notices/n1/approve', permission: 'notice:approve', body: {} },
  { method: 'POST', path: '/freeze-notices/:id/send', url: '/freeze-notices/n1/send', permission: 'notice:send', body: {} },
  { method: 'POST', path: '/integrations/sahyog/submit', url: '/integrations/sahyog/submit', permission: 'notice:send', body: { notice: {} } },
  { method: 'POST', path: '/integrations/ncrp/sync', url: '/integrations/ncrp/sync', permission: 'notice:send', body: { notice: {} } },
  { method: 'POST', path: '/labels', url: '/labels', permission: 'label:write', body: { chain: 'TRON', addr: 'Tx', name: 'n', category: 'scam' } },
  { method: 'DELETE', path: '/labels/:id', url: '/labels/l1', permission: 'label:write' },
  { method: 'GET', path: '/vasps', url: '/vasps', permission: 'vasp:read' },
  { method: 'POST', path: '/vasps', url: '/vasps', permission: 'vasp:write', body: { name: 'V', type: 'OTC', jurisdiction: 'IN', fiuStatus: 'REGISTERED' } },
];
const PUBLIC = ['POST /auth/login', 'POST /auth/refresh', 'POST /auth/logout', 'GET /verify/:hash'];

let server: Server;
let app: Express;
let base: string;
let serviceCalls = 0;

/** Any method resolves to {} and counts as a "handler reached" signal; 401/403 must happen before it. */
const fake = () => new Proxy({}, { get: () => async () => { serviceCalls++; return {}; } }) as never;

beforeAll(() => {
  const ok = async () => undefined;
  const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
  app = createApp(
    deps,
    { intake: { ingest: async () => { serviceCalls++; return { rows: [{ status: 'CREATED' }], summary: {} }; }, list: async () => { serviceCalls++; return {}; } } as never, mule: fake(), risk: fake(), watchlist: fake(), alerts: fake(), reports: fake(), freezeNotices: fake(), integrations: { sahyog: fake(), ncrpNotice: fake() }, cases: fake(), traceGraph: fake(), labels: fake(), vasps: fake() },
    testSecurity(),
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = (r: (typeof ROUTES)[number], role?: Role) =>
  fetch(`${base}${r.url}`, {
    method: r.method,
    headers: { ...(r.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(role ? { authorization: bearer(role) } : {}) },
    body: r.body !== undefined ? JSON.stringify(r.body) : undefined,
  });

/** Every `METHOD /path` registered under /api/v1, read from the live Express router. */
function registeredRoutes(): string[] {
  const out: string[] = [];
  const walk = (stack: any[]) => {
    for (const l of stack) {
      if (l.route) for (const m of Object.keys(l.route.methods)) out.push(`${m.toUpperCase()} ${l.route.path}`);
      else if (l.name === 'router' && l.handle?.stack) walk(l.handle.stack);
    }
  };
  walk((app as any)._router.stack);
  return out.filter((r) => !r.startsWith('GET /health'));
}

describe('role -> permission matrix', () => {
  it('matches the documented matrix exactly', () => {
    expect([...ROLE_PERMISSIONS.VIEWER].sort()).toEqual(['alert:read', 'case:read', 'complaint:read', 'graph:read', 'mule:read', 'risk:read', 'vasp:read', 'watchlist:read']);
    // Investigator = Viewer + investigation actions
    const investigatorOnly = [...ROLE_PERMISSIONS.INVESTIGATOR].filter((p) => !ROLE_PERMISSIONS.VIEWER.has(p)).sort();
    expect(investigatorOnly).toEqual(['alert:update', 'complaint:create', 'label:write', 'mule:analyze', 'notice:draft', 'report:generate', 'watchlist:write']);
    // Supervisor = Investigator + approve/send
    const supervisorOnly = [...ROLE_PERMISSIONS.SUPERVISOR].filter((p) => !ROLE_PERMISSIONS.INVESTIGATOR.has(p)).sort();
    expect(supervisorOnly).toEqual(['notice:approve', 'notice:send']);
    expect([...ROLE_PERMISSIONS.INVESTIGATOR].every((p) => ROLE_PERMISSIONS.SUPERVISOR.has(p))).toBe(true);
    // Admin = Viewer + configuration only (labels, VASP registry); cannot approve/send notices or run investigations
    const adminOnly = [...ROLE_PERMISSIONS.ADMIN].filter((p) => !ROLE_PERMISSIONS.VIEWER.has(p)).sort();
    expect(adminOnly).toEqual(['label:write', 'vasp:write']);
    expect(can('ADMIN', 'notice:approve')).toBe(false);
    expect(can('INVESTIGATOR', 'notice:approve')).toBe(false);
    expect(can('VIEWER', 'report:generate')).toBe(false);
  });

  it('every protected route in the live router is in the matrix (no unguarded route can be added silently)', () => {
    const known = new Set([...ROUTES.map((r) => `${r.method} ${r.path}`), ...PUBLIC]);
    const live = registeredRoutes();
    expect(live.filter((r) => !known.has(r))).toEqual([]);
    expect(ROUTES.map((r) => `${r.method} ${r.path}`).filter((r) => !live.includes(r))).toEqual([]);
  });
});

describe('every protected route x every role', () => {
  for (const route of ROUTES) {
    describe(`${route.method} ${route.path} (${route.permission})`, () => {
      it('401 without a token, before the service is touched', async () => {
        const before = serviceCalls;
        expect((await call(route)).status).toBe(401);
        expect(serviceCalls).toBe(before);
      });
      for (const role of ROLES) {
        const allowed = can(role, route.permission);
        it(`${role}: ${allowed ? 'allowed' : '403 forbidden, service untouched'}`, async () => {
          const before = serviceCalls;
          const res = await call(route, role);
          if (allowed) {
            expect([401, 403]).not.toContain(res.status);
          } else {
            expect(res.status).toBe(403);
            expect(((await res.json()) as { error: string }).error).toBe('FORBIDDEN');
            expect(serviceCalls).toBe(before);
          }
        });
      }
    });
  }
});

describe('headline restrictions', () => {
  const find = (m: string, p: string) => ROUTES.find((r) => r.method === m && r.path === p)!;

  it('Viewer is read-only: every write route is 403, every read route works', async () => {
    for (const r of ROUTES) {
      const res = await call(r, 'VIEWER');
      if (r.method === 'GET') expect(res.status, `${r.method} ${r.path}`).not.toBe(403);
      else expect(res.status, `${r.method} ${r.path}`).toBe(403);
    }
  });

  it('only a Supervisor can approve and send freeze notices; Investigator can draft/edit/submit only', async () => {
    const approve = find('POST', '/freeze-notices/:id/approve');
    const send = find('POST', '/freeze-notices/:id/send');
    const draft = find('POST', '/cases/:id/freeze-notices');
    for (const role of ['VIEWER', 'INVESTIGATOR', 'ADMIN'] as Role[]) {
      expect((await call(approve, role)).status).toBe(403);
      expect((await call(send, role)).status).toBe(403);
    }
    expect((await call(approve, 'SUPERVISOR')).status).toBe(200);
    expect((await call(send, 'SUPERVISOR')).status).toBe(200);
    expect((await call(draft, 'INVESTIGATOR')).status).toBe(201);
  });

  it('only an Admin can change the VASP registry', async () => {
    const post = find('POST', '/vasps');
    for (const role of ['VIEWER', 'INVESTIGATOR', 'SUPERVISOR'] as Role[]) expect((await call(post, role)).status).toBe(403);
    expect((await call(post, 'ADMIN')).status).toBe(201);
  });

  it('public routes stay reachable without a token: /verify/:hash and /auth/*', async () => {
    expect((await fetch(`${base}/verify/${'a'.repeat(64)}`)).status).not.toBe(401);
    expect((await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
  });

  it('unknown /api/v1 routes are a JSON 404 for authenticated users and 401 for anonymous ones', async () => {
    expect((await fetch(`${base}/nope`, { headers: { authorization: bearer('ADMIN') } })).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(401);
  });
});
