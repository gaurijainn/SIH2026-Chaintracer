import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { hashPassword } from './password';
import { bearer, TEST_ORIGIN, testSecurity, type TestUserRow } from './testkit';

const ok = async () => undefined;
const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
const started: Server[] = [];
const start = (app: ReturnType<typeof createApp>) => {
  const s = app.listen(0);
  started.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
afterAll(() => Promise.all(started.map((s) => new Promise<void>((r) => s.close(() => r())))));

const captured: { draft?: unknown; approve?: unknown[]; edit?: unknown[]; report?: unknown[] } = {};
const freezeNotices = {
  draft: async (_c: string, input: unknown) => ((captured.draft = input), { id: 'n1' }),
  edit: async (...a: unknown[]) => ((captured.edit = a), { id: 'n1' }),
  submitForApproval: async () => ({ id: 'n1' }),
  approve: async (...a: unknown[]) => ((captured.approve = a), { id: 'n1' }),
  send: async () => ({ id: 'n1' }),
} as never;
const reports = {
  generate: async (...a: unknown[]) => ((captured.report = a), { report: { id: 'r1', sha256: 'h' }, json: {} }),
  verify: async () => ({ match: true, report: null }),
} as never;
const alerts = { list: async () => [], update: async () => ({}) } as never;
const watchlist = { list: async () => [], create: async () => ({}), remove: async () => undefined } as never;
const integrations = { sahyog: { submit: async () => ({}) }, ncrpNotice: { submit: async () => ({}) } } as never;

let base: string;
beforeAll(() => {
  base = `${start(createApp(deps, { freezeNotices, reports, alerts, watchlist, integrations }, testSecurity()))}`;
});

const H = (role: 'SUPERVISOR' | 'INVESTIGATOR' = 'SUPERVISOR', userId = 'u-real') => ({ authorization: bearer(role, userId), 'content-type': 'application/json' });
const json = (r: Response): Promise<any> => r.json();

describe('security headers (helmet)', () => {
  it('sets hardening headers and hides X-Powered-By', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=/);
    expect(res.headers.get('x-frame-options')).toBeTruthy();
    expect(res.headers.get('content-security-policy')).toBeTruthy();
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('CORS allowlist', () => {
  it('echoes an allow-listed origin and no credentials header', async () => {
    const res = await fetch(`${base}/api/v1/alerts`, { headers: { origin: TEST_ORIGIN, authorization: bearer('VIEWER') } });
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('gives a foreign origin no CORS grant (never a wildcard)', async () => {
    const res = await fetch(`${base}/api/v1/alerts`, { headers: { origin: 'https://evil.example', authorization: bearer('VIEWER') } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a preflight for an allowed origin and denies a foreign one', async () => {
    const pre = (origin: string) => fetch(`${base}/api/v1/watchlist`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    const good = await pre(TEST_ORIGIN);
    expect(good.status).toBe(204);
    expect(good.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
    expect(good.headers.get('access-control-allow-methods')).toMatch(/POST/);
    expect((await pre('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('request-body validation (zod) and parsing', () => {
  const post = (path: string, body: string, headers = H()) => fetch(`${base}/api/v1${path}`, { method: 'POST', headers, body });

  it('400 INVALID_JSON for malformed JSON on an authenticated route', async () => {
    const res = await post('/watchlist', '{"caseId": ');
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('INVALID_JSON');
  });

  it('413 for a body over the 1 MB limit', async () => {
    const res = await post('/watchlist', JSON.stringify({ caseId: 'x'.repeat(1_200_000) }));
    expect(res.status).toBe(413);
    expect((await json(res)).error).toBe('PAYLOAD_TOO_LARGE');
  });

  it('every JSON-body write route rejects unknown/invalid fields with a clean 400', async () => {
    const cases: [string, string, unknown][] = [
      ['POST', '/watchlist', { unexpected: 1 }],
      ['POST', '/watchlist', { caseId: 'c', chain: 'DOGE', addr: 'x' }],
      ['PATCH', '/alerts/a1', { action: 'delete' }],
      ['PATCH', '/alerts/a1', { action: 'acknowledge', extra: true }],
      ['POST', '/cases/c1/freeze-notices', {}],
      ['POST', '/cases/c1/freeze-notices', { vaspId: 'v', actorId: 'someone-else' }],
      ['PATCH', '/freeze-notices/n1', { unexpected: 1 }],
      ['PATCH', '/freeze-notices/n1', { legalProvision: 42 }],
      ['POST', '/freeze-notices/n1/approve', { approvedById: 'someone-else' }],
      ['POST', '/freeze-notices/n1/send', { actorId: 'someone-else' }],
      ['POST', '/cases/c1/reports', { actorId: 'someone-else' }],
      ['POST', '/integrations/sahyog/submit', { notice: 'not-an-object' }],
      ['POST', '/integrations/ncrp/sync', {}],
    ];
    for (const [method, path, body] of cases) {
      const res = await fetch(`${base}/api/v1${path}`, { method, headers: H(), body: JSON.stringify(body) });
      expect(res.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
    }
  });

  it('the actor on a write is always the authenticated user (never a client-supplied id)', async () => {
    await fetch(`${base}/api/v1/cases/c1/freeze-notices`, { method: 'POST', headers: H('INVESTIGATOR', 'u-inv'), body: JSON.stringify({ vaspId: 'v1' }) });
    expect(captured.draft).toMatchObject({ vaspId: 'v1', actorId: 'u-inv' });

    await fetch(`${base}/api/v1/freeze-notices/n1/approve`, { method: 'POST', headers: H('SUPERVISOR', 'u-sup'), body: '{}' });
    expect(captured.approve).toEqual(['n1', { approvedById: 'u-sup' }, 'u-sup']);

    await fetch(`${base}/api/v1/freeze-notices/n1`, { method: 'PATCH', headers: H('INVESTIGATOR', 'u-inv'), body: JSON.stringify({ legalProvision: 'x' }) });
    expect(captured.edit?.[2]).toBe('u-inv');

    await fetch(`${base}/api/v1/cases/c1/reports`, { method: 'POST', headers: H('INVESTIGATOR', 'u-inv'), body: '{}' });
    expect(captured.report?.[1]).toMatchObject({ actorId: 'u-inv', format: 'json' });
  });
});

describe('rate limiting', () => {
  const users: TestUserRow[] = [{ id: 'u1', email: 'a@demo.local', name: 'A', role: 'VIEWER', passwordHash: hashPassword('right-password') }];

  it('throttles failed logins per IP (429 RATE_LIMITED) but not successful ones', async () => {
    const url = start(createApp(deps, {}, testSecurity({ users, rateLimit: { windowS: 60, max: 1000, authMax: 3 } })));
    const login = (password: string) => fetch(`${url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@demo.local', password }) });
    for (let i = 0; i < 5; i++) expect((await login('right-password')).status).toBe(200); // successes are free
    for (let i = 0; i < 3; i++) expect((await login('wrong')).status).toBe(401);
    const blocked = await login('wrong');
    expect(blocked.status).toBe(429);
    expect((await json(blocked)).error).toBe('RATE_LIMITED');
    // even the correct password is refused once the failure budget is spent
    expect((await login('right-password')).status).toBe(429);
  });

  it('applies a general per-IP limit to the API and exposes standard RateLimit headers', async () => {
    const url = start(createApp(deps, { alerts }, testSecurity({ rateLimit: { windowS: 60, max: 4, authMax: 100 } })));
    const get = () => fetch(`${url}/api/v1/alerts`, { headers: { authorization: bearer('VIEWER') } });
    const first = await get();
    expect(first.headers.get('ratelimit') ?? first.headers.get('ratelimit-policy')).toBeTruthy();
    for (let i = 0; i < 3; i++) expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(429);
    // /health is outside the API limiter
    expect((await fetch(`${url}/health`)).status).toBeLessThan(500);
  });
});
