import { describe, expect, it } from 'vitest';
import type { Driver } from 'neo4j-driver';
import type { AttributionPrisma } from './persist';
import { persistAttribution } from './persist';
import type { AttributionCandidate } from './types';

const candidate: AttributionCandidate = {
  chain: 'ETH',
  addr: '0xabc',
  vaspId: 'v1',
  vaspName: 'Some Exchange',
  confidence: 0.95,
  heuristics: [
    { code: 'H1_DEPOSIT_SWEEP', vaspId: 'v1', vaspName: 'Some Exchange', confidence: 0.9, evidence: { forwardTxHashes: ['t1'] } },
    { code: 'H4_DIRECT_LABEL', vaspId: 'v1', vaspName: 'Some Exchange', confidence: 0.5, evidence: { viaAddr: '0xabc' } },
  ],
};

function fakePrisma() {
  const upserts: unknown[] = [];
  const prisma: AttributionPrisma = { attribution: { async upsert(args) { upserts.push(args); return args; } } };
  return { prisma, upserts };
}

function fakeDriver() {
  const queries: { q: string; params: Record<string, unknown> }[] = [];
  const driver = {
    session: () => ({
      executeWrite: async (fn: (tx: { run: (q: string, p: Record<string, unknown>) => Promise<void> }) => Promise<void>) =>
        fn({ run: async (q, p) => void queries.push({ q, params: p }) }),
      close: async () => undefined,
    }),
  } as unknown as Driver;
  return { driver, queries };
}

describe('persistAttribution', () => {
  it('upserts the Postgres summary row by (chain, addr, vaspId)', async () => {
    const { prisma, upserts } = fakePrisma();
    await persistAttribution({ prisma }, candidate);
    expect(upserts).toEqual([
      {
        where: { chain_addr_vaspId: { chain: 'ETH', addr: '0xabc', vaspId: 'v1' } },
        create: { chain: 'ETH', addr: '0xabc', vaspId: 'v1', confidence: 0.95, heuristics: candidate.heuristics },
        update: { confidence: 0.95, heuristics: candidate.heuristics },
      },
    ]);
  });

  it('skips Neo4j entirely when no driver is given', async () => {
    const { prisma } = fakePrisma();
    await expect(persistAttribution({ prisma }, candidate)).resolves.toBeUndefined();
  });

  it('writes one BELONGS_TO edge per fired heuristic plus one COMBINED summary edge', async () => {
    const { prisma } = fakePrisma();
    const { driver, queries } = fakeDriver();
    await persistAttribution({ prisma, driver }, candidate);
    expect(queries).toHaveLength(3); // H1 + H4 + COMBINED
    expect(queries.every((q) => q.q.includes('BELONGS_TO'))).toBe(true);
    const heuristicParam = queries.map((q) => q.params.heuristic);
    expect(heuristicParam.sort()).toEqual(['COMBINED', 'H1_DEPOSIT_SWEEP', 'H4_DIRECT_LABEL'].sort());
    const combined = queries.find((q) => q.params.heuristic === 'COMBINED')!;
    expect(combined.params.confidence).toBe(0.95);
    expect(JSON.parse(combined.params.evidence as string)).toEqual(['H1_DEPOSIT_SWEEP', 'H4_DIRECT_LABEL']);
  });
});
