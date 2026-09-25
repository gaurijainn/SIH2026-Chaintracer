import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { authFetch, testSecurity } from '../auth/testkit';
import { DashboardService, dashboardSummarySchema } from './service';

const body = async (res: Response): Promise<any> => res.json();

type Rows = Record<string, unknown[]>;
/**
 * A Prisma stand-in that ONLY exposes reads (case.count, $queryRaw, $transaction). Touching anything else -- a create,
 * update, delete, or a model the dashboard has no business reading -- throws, which is how the "no writes" tests bite.
 */
function fakePrisma(o: { openCases?: number; rows?: Rows } = {}) {
  const sql: string[] = [];
  const countArgs: unknown[] = [];
  const rows = o.rows ?? {};
  const pick = (text: string) => {
    for (const key of ['"TraceJob"', '"Hop"', '"Attribution"', '"RiskScore"', '"ComplaintAddress"']) if (text.includes(key)) return rows[key] ?? [];
    throw new Error(`unexpected SQL: ${text}`);
  };
  const target = {
    case: { count: vi.fn((args: unknown) => (countArgs.push(args), Promise.resolve(o.openCases ?? 0))) },
    $queryRaw: vi.fn((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      sql.push(text);
      return Promise.resolve(pick(text));
    }),
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const prisma = new Proxy(target, {
    get(t, k) {
      if (k in t) return (t as Record<string | symbol, unknown>)[k];
      throw new Error(`dashboard touched prisma.${String(k)}`);
    },
  });
  return { prisma: prisma as never, sql, countArgs, target };
}

const populated: Rows = {
  '"TraceJob"': [{ day: '2026-09-22', count: 8 }, { day: '2026-09-23', count: 7 }],
  '"Hop"': [{ total: 75282.5 }],
  '"Attribution"': [{ n: 3 }],
  '"RiskScore"': [{ typology: 'investment_fraud', count: 4 }, { typology: 'mule_ring', count: 1 }],
  '"ComplaintAddress"': [{ chain: 'TRON', count: 10 }, { chain: 'ETH', count: 3 }],
};
const KEYS = ['openCases', 'tracesPerDay', 'tracedValueUsd', 'vaspsIdentified', 'typologyMix', 'timeToAttributionMedianSeconds', 'chainSplit'];

describe('DashboardService', () => {
  it('maps every aggregate into the contract', async () => {
    const { prisma } = fakePrisma({ openCases: 13, rows: populated });
    const s = await new DashboardService({ prisma }).summary();
    expect(s).toEqual({
      openCases: 13,
      tracesPerDay: [{ day: '2026-09-22', count: 8 }, { day: '2026-09-23', count: 7 }],
      tracedValueUsd: 75282.5,
      vaspsIdentified: 3,
      typologyMix: [{ typology: 'investment_fraud', count: 4 }, { typology: 'mule_ring', count: 1 }],
      timeToAttributionMedianSeconds: null,
      chainSplit: [{ chain: 'TRON', count: 10 }, { chain: 'ETH', count: 3 }],
    });
    expect(Object.keys(s)).toEqual(KEYS);
  });

  it('returns a valid zero / empty / null response for an empty database', async () => {
    const { prisma } = fakePrisma({ rows: { '"Hop"': [{ total: null }], '"Attribution"': [{ n: 0 }] } });
    const s = await new DashboardService({ prisma }).summary();
    expect(s).toEqual({ openCases: 0, tracesPerDay: [], tracedValueUsd: 0, vaspsIdentified: 0, typologyMix: [], timeToAttributionMedianSeconds: null, chainSplit: [] });
    expect(dashboardSummarySchema.safeParse(s).success).toBe(true);
  });

  it('counts open cases as "status is not CLOSED", using the CaseStatus enum value', async () => {
    const { prisma, countArgs } = fakePrisma();
    await new DashboardService({ prisma }).summary();
    expect(countArgs).toEqual([{ where: { status: { not: 'CLOSED' } } }]);
  });

  it('runs one read transaction of six statements, none of them a write', async () => {
    const { prisma, sql, target } = fakePrisma({ rows: populated });
    await new DashboardService({ prisma }).summary();
    expect(target.$transaction).toHaveBeenCalledTimes(1);
    expect(target.case.count).toHaveBeenCalledTimes(1);
    expect(sql).toHaveLength(5);
    for (const q of sql) {
      expect(q.trim().toUpperCase().startsWith('SELECT')).toBe(true);
      expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i);
    }
  });

  it('reads Hop.usd (never complaint amounts), counts each transfer once, and skips null usd', async () => {
    const { prisma, sql } = fakePrisma({ rows: populated });
    await new DashboardService({ prisma }).summary();
    const hop = sql.find((q) => q.includes('"Hop"'))!;
    expect(hop).toMatch(/sum\(usd\)/);
    expect(hop).toMatch(/DISTINCT ON \(chain, "txHash", idx, "fromAddr", "toAddr"\)/);
    expect(sql.join('\n')).not.toMatch(/amountInr|"Complaint"\b/);
  });

  it('counts distinct VASPs (not attributed addresses), latest typology per address, IST days, wallet addresses only', async () => {
    const { prisma, sql } = fakePrisma({ rows: populated });
    await new DashboardService({ prisma }).summary();
    expect(sql.find((q) => q.includes('"Attribution"'))).toMatch(/count\(DISTINCT "vaspId"\)/);
    const risk = sql.find((q) => q.includes('"RiskScore"'))!;
    expect(risk).toMatch(/DISTINCT ON \(chain, addr\)/);
    expect(risk).toMatch(/typology IS NOT NULL AND btrim\(typology\) <> ''/);
    expect(sql.find((q) => q.includes('"TraceJob"'))).toMatch(/AT TIME ZONE \?\)::date/);
    expect(sql.find((q) => q.includes('"ComplaintAddress"'))).toMatch(/kind = 'ADDRESS' AND chain IS NOT NULL/);
  });

  it('rejects values the contract forbids instead of leaking them (NaN, negative, fractional counts, bad day)', async () => {
    const base: Rows = { '"Hop"': [{ total: 0 }], '"Attribution"': [{ n: 0 }] };
    for (const rows of <Rows[]>[{ '"Hop"': [{ total: Number.NaN }] }, { '"Attribution"': [{ n: -1 }] }, { '"TraceJob"': [{ day: '2026-09-22', count: 1.5 }] }, { '"TraceJob"': [{ day: 'not-a-day', count: 1 }] }]) {
      await expect(new DashboardService({ prisma: fakePrisma({ rows: { ...base, ...rows } }).prisma }).summary()).rejects.toThrow();
    }
  });
});

describe('GET /api/v1/dashboard/summary', () => {
  let server: Server;
  let base: string;
  let target: ReturnType<typeof fakePrisma>['target'];

  beforeAll(() => {
    const f = fakePrisma({ openCases: 2, rows: populated });
    target = f.target;
    const ok = async () => undefined;
    const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
    server = createApp(deps, { dashboard: new DashboardService({ prisma: f.prisma }) }, testSecurity()).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(() => server.close());

  it('401s without a token', async () => {
    expect((await fetch(`${base}/dashboard/summary`)).status).toBe(401);
  });

  it('401s with a malformed token', async () => {
    expect((await fetch(`${base}/dashboard/summary`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it.each(['INVESTIGATOR', 'SUPERVISOR', 'VIEWER', 'ADMIN'] as Role[])('%s (holds case:read) gets 200 and the stable shape', async (role) => {
    const res = await authFetch(role)(`${base}/dashboard/summary`);
    expect(res.status).toBe(200);
    const s = await body(res);
    expect(Object.keys(s)).toEqual(KEYS);
    expect(s.openCases).toBe(2);
    expect(s.timeToAttributionMedianSeconds).toBeNull();
    expect(dashboardSummarySchema.safeParse(s).success).toBe(true);
  });

  it('exposes only the seven aggregate fields: no PII or internals', async () => {
    const text = await (await authFetch()(`${base}/dashboard/summary`)).text();
    expect(text).not.toMatch(/firNumber|ackNo|amountInr|password|hash/i);
  });

  it('served the requests through read-only transactions', () => {
    expect(target.$transaction.mock.calls.length).toBeGreaterThan(0);
  });
});
