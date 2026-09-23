import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { AuthError } from './errors';
import { hashPassword, verifyPassword } from './password';
import { bearer, TEST_JWT_SECRET, testSecurity, testTokens, type TestUserRow } from './testkit';

const json = (res: Response): Promise<any> => res.json();

const users: TestUserRow[] = (['INVESTIGATOR', 'SUPERVISOR', 'ADMIN', 'VIEWER'] as const).map((role) => ({
  id: `u-${role.toLowerCase()}`,
  email: `${role.toLowerCase()}@demo.local`,
  name: role,
  role,
  passwordHash: hashPassword('Correct-Horse-1'),
}));

const sec = testSecurity({ users });
let server: Server;
let base: string;

beforeAll(() => {
  const ok = async () => undefined;
  const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
  // a single protected route so the auth layer can be exercised end to end
  const alerts = { list: async () => [] } as never;
  server = createApp(deps, { alerts }, sec).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const login = (email = 'investigator@demo.local', password = 'Correct-Horse-1') => post('/auth/login', { email, password });
const getAlerts = (authorization?: string) => fetch(`${base}/alerts`, { headers: authorization ? { authorization } : {} });

describe('password hashing', () => {
  it('verifies the scrypt format used by the demo seed, rejects wrong/malformed', () => {
    const h = hashPassword('pw');
    expect(verifyPassword('pw', h)).toBe(true);
    expect(verifyPassword('nope', h)).toBe(false);
    expect(verifyPassword('pw', null)).toBe(false);
    expect(verifyPassword('pw', 'x')).toBe(false);
    expect(h).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  });
});

describe('POST /auth/login', () => {
  it('returns short-lived access + refresh tokens and the user (no password hash) for valid credentials', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b.tokenType).toBe('Bearer');
    expect(b.expiresIn).toBe(900);
    expect(b.user).toEqual({ id: 'u-investigator', email: 'investigator@demo.local', name: 'INVESTIGATOR', role: 'INVESTIGATOR' });
    expect(JSON.stringify(b)).not.toContain('scrypt');
    const claims = testTokens().verifyAccess(b.accessToken);
    expect(claims).toEqual({ userId: 'u-investigator', email: 'investigator@demo.local', role: 'INVESTIGATOR' });
    const raw = jwt.decode(b.accessToken) as { exp: number; iat: number };
    expect(raw.exp - raw.iat).toBe(900);
  });

  it('rejects a wrong password and an unknown user identically (401 INVALID_CREDENTIALS)', async () => {
    const a = await login('investigator@demo.local', 'wrong');
    const b = await login('nobody@demo.local', 'Correct-Horse-1');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(await json(a)).toEqual(await json(b));
  });

  it('is case/whitespace-insensitive on the email', async () => {
    expect((await login('  Investigator@Demo.Local ')).status).toBe(200);
  });

  it('400s on malformed bodies (zod): missing fields, wrong types, unknown keys, bad email', async () => {
    for (const body of [{}, { email: 'a@b.co' }, { email: 1, password: 'x' }, { email: 'not-an-email', password: 'x' }, { email: 'a@b.co', password: 'x', role: 'ADMIN' }]) {
      const res = await post('/auth/login', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json(res)).error).toBe('INVALID_BODY');
    }
  });
});

describe('access-token enforcement on /api/v1', () => {
  it('401 TOKEN_MISSING without a token or with a non-Bearer scheme', async () => {
    for (const h of [undefined, 'Basic abc', 'Bearer', 'token-only']) {
      const res = await getAlerts(h);
      expect(res.status, String(h)).toBe(401);
      expect((await json(res)).error).toBe('TOKEN_MISSING');
    }
  });

  it('401 TOKEN_INVALID for garbage, a wrong-secret token, an alg=none token, and a refresh token used as access', async () => {
    const wrongSecret = jwt.sign({ email: 'e@x.co', role: 'ADMIN' }, 'another-secret-another-secret-another', { subject: 'u', issuer: 'ps26183-api', audience: 'access' });
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'u', email: 'e@x.co', role: 'ADMIN', iss: 'ps26183-api', aud: 'access' })).toString('base64url')}.`;
    const refresh = testTokens().signRefresh('u-admin').token;
    for (const t of ['garbage', wrongSecret, none, refresh]) {
      const res = await getAlerts(`Bearer ${t}`);
      expect(res.status, t.slice(0, 20)).toBe(401);
      expect((await json(res)).error).toBe('TOKEN_INVALID');
    }
  });

  it('401 TOKEN_INVALID for a validly signed token carrying an unknown role', async () => {
    const t = jwt.sign({ email: 'e@x.co', role: 'ROOT' }, TEST_JWT_SECRET, { subject: 'u', issuer: 'ps26183-api', audience: 'access', expiresIn: 60 });
    expect((await json(await getAlerts(`Bearer ${t}`))).error).toBe('TOKEN_INVALID');
  });

  it('401 TOKEN_EXPIRED for an expired access token', async () => {
    const t = jwt.sign({ email: 'e@x.co', role: 'ADMIN', exp: Math.floor(Date.now() / 1000) - 10 }, TEST_JWT_SECRET, { subject: 'u', issuer: 'ps26183-api', audience: 'access' });
    const res = await getAlerts(`Bearer ${t}`);
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe('TOKEN_EXPIRED');
  });

  it('accepts a valid access token', async () => {
    expect((await getAlerts(bearer('VIEWER'))).status).toBe(200);
  });
});

describe('refresh-token rotation and revocation', () => {
  const refresh = (refreshToken: string) => post('/auth/refresh', { refreshToken });

  it('rotates: a refresh yields a new pair and the old refresh token stops working', async () => {
    const first = await json(await login('supervisor@demo.local'));
    const res = await refresh(first.refreshToken);
    expect(res.status).toBe(200);
    const second = await json(res);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.user.role).toBe('SUPERVISOR');
    expect((await getAlerts(`Bearer ${second.accessToken}`)).status).toBe(200);
  });

  it('replaying a rotated refresh token is detected and revokes the whole family', async () => {
    const first = await json(await login('admin@demo.local'));
    const second = await json(await refresh(first.refreshToken));
    const replay = await refresh(first.refreshToken);
    expect(replay.status).toBe(401);
    expect((await json(replay)).error).toBe('REFRESH_REVOKED');
    // the legitimately rotated token was revoked too
    expect((await refresh(second.refreshToken)).status).toBe(401);
  });

  it('logout revokes the refresh token (idempotently) and never reveals validity', async () => {
    const t = await json(await login('viewer@demo.local'));
    expect((await post('/auth/logout', { refreshToken: t.refreshToken })).status).toBe(204);
    expect((await post('/auth/logout', { refreshToken: t.refreshToken })).status).toBe(204);
    expect((await post('/auth/logout', { refreshToken: 'garbage' })).status).toBe(204);
    expect((await refresh(t.refreshToken)).status).toBe(401);
  });

  it('rejects an access token, garbage and an expired refresh token; the refresh secret is never stored in plaintext', async () => {
    const t = await json(await login('investigator@demo.local'));
    expect((await refresh(t.accessToken)).status).toBe(401);
    expect((await refresh('garbage')).status).toBe(401);
    const expired = jwt.sign({ exp: Math.floor(Date.now() / 1000) - 5 }, TEST_JWT_SECRET, { subject: 'u-admin', issuer: 'ps26183-api', audience: 'refresh', jwtid: 'x' });
    const res = await refresh(expired);
    expect((await json(res)).error).toBe('TOKEN_EXPIRED');
    // store keys are SHA-256 hashes of the jti, not the token or jti themselves
    const { jti } = testTokens().verifyRefresh(t.refreshToken);
    const stored = JSON.stringify([...(sec.store as unknown as { active: Map<string, unknown> }).active.keys()]);
    expect(stored).not.toContain(jti);
    expect(stored).not.toContain(t.refreshToken);
  });

  it('a refresh re-reads the user, so a deleted user cannot rotate', async () => {
    const ghost = testTokens().signRefresh('u-deleted');
    await sec.store.save((await import('./refreshStore')).hashJti(ghost.jti), 'u-deleted', 60);
    const res = await refresh(ghost.token);
    expect(res.status).toBe(401);
  });
});

describe('AuthError', () => {
  it('maps FORBIDDEN to 403 and everything else to 401', () => {
    expect(new AuthError('FORBIDDEN', 'x').status).toBe(403);
    expect(new AuthError('TOKEN_INVALID', 'x').status).toBe(401);
  });
});

describe('in-cluster service token (B8 worker -> API compatibility fix)', () => {
  it('a token signed by the shared helper is accepted as a least-privilege VIEWER and rejected once expired or with another secret', async () => {
    const { signServiceToken } = await import('@ps26183/shared');
    const good = signServiceToken(TEST_JWT_SECRET);
    expect(testTokens().verifyAccess(good)).toEqual({ userId: 'system:workers', email: 'workers@system.local', role: 'VIEWER' });
    expect((await getAlerts(`Bearer ${good}`)).status).toBe(200); // read routes work
    const res = await fetch(`${base}/alerts/a1`, { method: 'PATCH', headers: { authorization: `Bearer ${good}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'acknowledge' }) });
    expect(res.status).toBe(403); // but it can never write
    expect(() => testTokens().verifyAccess(signServiceToken(TEST_JWT_SECRET, 'workers', 60, Date.now() - 3_600_000))).toThrow(/expired/);
    expect(() => testTokens().verifyAccess(signServiceToken('some-other-secret-some-other-secret-xx'))).toThrow(/invalid/);
  });
});
