import { describe, expect, it } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { Prisma, type Hop } from '@prisma/client';
import { applySchema } from './graph';
import { hopToGraph } from '../db/prisma';

describe('applySchema', () => {
  it('runs every statement of constraints.cypher (comments stripped) against the driver', async () => {
    const ran: string[] = [];
    const driver = {
      session: () => ({
        run: async (q: string) => void ran.push(q),
        close: async () => undefined,
      }),
    } as unknown as Driver;
    const n = await applySchema(driver);
    expect(n).toBe(3);
    expect(ran.filter((q) => q.includes('CONSTRAINT') && q.includes('(a.chain, a.addr) IS UNIQUE'))).toHaveLength(1);
    expect(ran.every((q) => q.startsWith('CREATE') && q.includes('IF NOT EXISTS'))).toBe(true);
  });
});

describe('hopToGraph', () => {
  it('keeps amounts as exact decimal strings and timestamps as UTC ISO', () => {
    const hop = {
      id: 'x', traceId: 't', hopNo: 0, chain: 'TRON', txHash: 'ab', idx: 2, fromAddr: 'A', toAddr: 'B', token: 'T',
      amount: new Prisma.Decimal('123456789.123456789012345678'),
      usd: null,
      ts: new Date('2026-09-01T08:10:00.000Z'),
    } as Hop;
    expect(hopToGraph(hop)).toEqual({
      chain: 'TRON', from: 'A', to: 'B', tx: 'ab', idx: 2, token: 'T',
      amount: '123456789.123456789012345678', usd: null, ts: '2026-09-01T08:10:00.000Z',
    });
  });
});
