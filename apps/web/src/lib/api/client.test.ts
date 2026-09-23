import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type TokenPair } from './client';
import { ApiError } from './errors';

const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

function setup(responses: Response[], tokens: TokenPair | null = { accessToken: 'a1', refreshToken: 'r1' }) {
  const fetchImpl = vi.fn(async () => responses.shift()!);
  const state = { tokens, authFailed: false };
  const client = createApiClient({
    baseUrl: 'http://api.test',
    getTokens: () => state.tokens,
    onTokens: (t) => (state.tokens = t),
    onAuthFailure: () => (state.authFailed = true),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, fetchImpl, state };
}

describe('api client', () => {
  it('initialises and prefixes /api/v1 with a bearer token and query string', async () => {
    const { client, fetchImpl } = setup([json(200, { ok: true })]);
    await expect(client.get('/cases', { query: { page: 2, q: undefined } })).resolves.toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/cases?page=2');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer a1');
  });

  it('sends JSON bodies', async () => {
    const { client, fetchImpl } = setup([json(201, { id: 1 })]);
    await client.post('/cases', { a: 1 });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('refreshes once on 401, rotates tokens and retries', async () => {
    const { client, fetchImpl, state } = setup([json(401, { error: 'TOKEN_EXPIRED' }), json(200, { accessToken: 'a2', refreshToken: 'r2' }), json(200, { done: true })]);
    await expect(client.get('/cases')).resolves.toEqual({ done: true });
    expect(state.tokens).toEqual({ accessToken: 'a2', refreshToken: 'r2' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const retry = fetchImpl.mock.calls[2] as unknown as [string, RequestInit];
    expect((retry[1].headers as Record<string, string>).Authorization).toBe('Bearer a2');
  });

  it('shares one refresh between concurrent 401s', async () => {
    const { client, fetchImpl } = setup([json(401), json(401), json(200, { accessToken: 'a2', refreshToken: 'r2' }), json(200, 1), json(200, 2)]);
    await Promise.all([client.get('/x'), client.get('/y')]);
    const refreshCalls = fetchImpl.mock.calls.filter((c) => String((c as unknown[])[0]).endsWith('/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
  });

  it('signals auth failure and throws a typed error when refresh is rejected', async () => {
    const { client, state } = setup([json(401), json(401, { error: 'REFRESH_REVOKED' })]);
    await expect(client.get('/cases')).rejects.toMatchObject({ status: 401, isUnauthorized: true });
    expect(state.authFailed).toBe(true);
  });

  it('does not refresh for public endpoints', async () => {
    const { client, fetchImpl, state } = setup([json(401, { error: 'INVALID_CREDENTIALS', message: 'bad' })]);
    await expect(client.post('/auth/login', {}, { auth: false })).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(state.authFailed).toBe(false);
  });

  it('hides server internals on 5xx', async () => {
    const { client } = setup([json(500, { error: 'INTERNAL', message: 'PrismaClientKnownRequestError: relation "x" does not exist' })]);
    const err = (await client.get('/cases').catch((e) => e)) as ApiError;
    expect(err.status).toBe(500);
    expect(err.message).not.toMatch(/prisma|relation/i);
  });

  it('carries validation issues and maps network failures', async () => {
    const a = setup([json(400, { error: 'INVALID_BODY', issues: [{ path: 'email', message: 'bad' }] })]);
    const err = (await a.client.post('/x', {}).catch((e) => e)) as ApiError;
    expect(err.code).toBe('INVALID_BODY');
    expect(err.issues).toEqual([{ path: 'email', message: 'bad' }]);

    const client = createApiClient({ getTokens: () => null, onTokens() {}, onAuthFailure() {}, fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(client.get('/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK', isNetwork: true });
  });

  it('returns undefined for 204', async () => {
    const { client } = setup([new Response(null, { status: 204 })]);
    await expect(client.post('/auth/logout', {})).resolves.toBeUndefined();
  });
});
