import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { MlHttpError, MlResponseError, MlTimeoutError, MlUnavailableError, RiskPersistError, TraceNotFoundError, UnsupportedChainError } from './errors';
import type { RiskService } from './service';
import { testSecurity, authFetch } from '../auth/testkit';

let server: Server;
let base: string;
const requests: { chain: string; addr: string; traceId?: string }[] = [];

const okResult = {
  id: 'risk-1',
  chain: 'TRON',
  addr: 'W1',
  score: 62,
  band: 'HIGH' as const,
  factors: [{ feature: 'fan_out_1h', impact: 0.31, reason: 'high fan-out within 1 hour' }],
  overrides: ['STABLECOIN_BLACKLIST'],
  typology: 'pig_butchering',
  typologyConfidence: 0.72,
  modelVersion: 'tron-xgb-v1',
  traceId: null,
  createdAt: new Date('2026-09-23T00:00:00Z'),
};

const fakeService = {
  getAddressRisk: async (chain: string, addr: string, traceId?: string) => {
    requests.push({ chain, addr, traceId });
    if (addr === 'UNSUPPORTED_CHAIN') throw new UnsupportedChainError(chain);
    if (addr === 'NO_TRACE') throw new TraceNotFoundError(traceId ?? '');
    if (addr === 'ML_TIMEOUT') throw new MlTimeoutError('timed out');
    if (addr === 'ML_DOWN') throw new MlUnavailableError('unreachable');
    if (addr === 'ML_HTTP_ERR') throw new MlHttpError(500, 'bad status');
    if (addr === 'ML_MALFORMED') throw new MlResponseError('malformed body');
    if (addr === 'DB_DOWN') throw new RiskPersistError('persist failed');
    if (addr === 'WITH_TRACE') return { ...okResult, addr, traceId: traceId ?? null };
    return { ...okResult, addr };
  },
} as unknown as RiskService;

beforeAll(() => {
  const ok = async () => undefined;
  const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
  server = createApp(deps, { risk: fakeService }, testSecurity()).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => server.close());

describe('GET /addresses/:chain/:addr/risk', () => {
  it('returns score, band, factors, overrides and typology for a valid request (no traceId, unauthenticated)', async () => {
    const res = await authFetch()(`${base}/addresses/TRON/W1/risk`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({
      chain: 'TRON',
      addr: 'W1',
      score: 62,
      band: 'HIGH',
      overrides: ['STABLECOIN_BLACKLIST'],
      typology: 'pig_butchering',
      typologyConfidence: 0.72,
      modelVersion: 'tron-xgb-v1',
    });
    expect(body.factors).toEqual([{ feature: 'fan_out_1h', impact: 0.31, reason: 'high fan-out within 1 hour' }]);
    expect(requests.at(-1)).toEqual({ chain: 'TRON', addr: 'W1', traceId: undefined });
  });

  it('passes an optional traceId query param through to the service', async () => {
    const res = await authFetch()(`${base}/addresses/TRON/WITH_TRACE/risk?traceId=trace-1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.traceId).toBe('trace-1');
    expect(requests.at(-1)).toEqual({ chain: 'TRON', addr: 'WITH_TRACE', traceId: 'trace-1' });
  });

  it('rejects an invalid chain with 400 INVALID_CHAIN', async () => {
    const res = await authFetch()(`${base}/addresses/NOTACHAIN/W1/risk`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('INVALID_CHAIN');
  });

  it('rejects an empty addr with 400 INVALID_ADDR', async () => {
    const res = await authFetch()(`${base}/addresses/TRON/%20/risk`); // whitespace-only after trim
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('INVALID_ADDR');
  });

  it('maps UnsupportedChainError to 400 UNSUPPORTED_CHAIN', async () => {
    const res = await authFetch()(`${base}/addresses/ETH/UNSUPPORTED_CHAIN/risk`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('UNSUPPORTED_CHAIN');
  });

  it('maps TraceNotFoundError to 404 TRACE_NOT_FOUND', async () => {
    const res = await authFetch()(`${base}/addresses/TRON/NO_TRACE/risk?traceId=missing`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe('TRACE_NOT_FOUND');
  });

  it('maps MlTimeoutError to 504 ML_TIMEOUT (never a fabricated 200 score)', async () => {
    const res = await authFetch()(`${base}/addresses/TRON/ML_TIMEOUT/risk`);
    expect(res.status).toBe(504);
    const body = (await res.json()) as any;
    expect(body.error).toBe('ML_TIMEOUT');
    expect(body.score).toBeUndefined();
  });

  it('maps MlUnavailableError to 503 ML_UNAVAILABLE', async () => {
    const res = await authFetch()(`${base}/addresses/TRON/ML_DOWN/risk`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toBe('ML_UNAVAILABLE');
  });

  it('maps MlHttpError to 502 ML_BAD_RESPONSE', async () => {
    const res = await authFetch()(`${base}/addresses/TRON/ML_HTTP_ERR/risk`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toBe('ML_BAD_RESPONSE');
  });

  it('maps MlResponseError (malformed ML body) to 502 ML_BAD_RESPONSE', async () => {
    const res = await authFetch()(`${base}/addresses/TRON/ML_MALFORMED/risk`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toBe('ML_BAD_RESPONSE');
  });

  it('maps RiskPersistError to 500 PERSIST_FAILED with a generic message (no internals leaked)', async () => {
    const res = await authFetch()(`${base}/addresses/TRON/DB_DOWN/risk`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.error).toBe('PERSIST_FAILED');
    expect(body.message).not.toMatch(/persist failed/); // the internal error message must not leak
  });

  it('works with no auth header at all (matches existing no-auth convention)', async () => {
    const res = await authFetch()(`${base}/addresses/TRON/W1/risk`);
    expect(res.status).toBe(200);
  });
});
