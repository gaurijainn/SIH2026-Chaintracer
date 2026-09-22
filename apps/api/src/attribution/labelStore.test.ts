import { describe, expect, it } from 'vitest';
import { upsertLabel, upsertLabels, type LabelPrisma } from './labelStore';
import type { NormalizedLabel } from './types';

function fakeLabelPrisma() {
  const rows = new Map<string, Record<string, unknown>>();
  const key = (w: { chain: string; addr: string; source: string; name: string }) => `${w.chain}|${w.addr}|${w.source}|${w.name}`;
  const prisma: LabelPrisma & { rows: typeof rows } = {
    rows,
    label: {
      async upsert({ where, create, update }) {
        const k = key(where.chain_addr_source_name);
        rows.set(k, rows.has(k) ? { ...rows.get(k), ...update } : create);
        return rows.get(k);
      },
    },
  };
  return prisma;
}

const base: NormalizedLabel = { chain: 'ETH', addr: '0xabc', name: 'Some Exchange', category: 'exchange', source: 'eth-labels', confidence: 0.9 };

describe('upsertLabel', () => {
  it('creates a new row preserving chain/addr/category/source/confidence/evidence/fetchedAt', async () => {
    const prisma = fakeLabelPrisma();
    await upsertLabel(prisma, { ...base, evidence: { ref: 'x' } });
    const row = [...prisma.rows.values()][0];
    expect(row).toMatchObject({ chain: 'ETH', addr: '0xabc', name: 'Some Exchange', category: 'exchange', source: 'eth-labels', confidence: 0.9, evidence: { ref: 'x' } });
    expect(row.fetchedAt).toBeInstanceOf(Date);
  });

  it('is idempotent: re-importing the same (chain, addr, source, name) updates in place, not a duplicate row', async () => {
    const prisma = fakeLabelPrisma();
    await upsertLabel(prisma, { ...base, confidence: 0.5 });
    await upsertLabel(prisma, { ...base, confidence: 0.9 });
    expect(prisma.rows.size).toBe(1);
    expect([...prisma.rows.values()][0].confidence).toBe(0.9);
  });

  it('treats a different source for the same address as a separate label', async () => {
    const prisma = fakeLabelPrisma();
    await upsertLabel(prisma, { ...base, source: 'eth-labels' });
    await upsertLabel(prisma, { ...base, source: 'chainabuse' });
    expect(prisma.rows.size).toBe(2);
  });

  it('sets a vaspId when given one, and omits it otherwise', async () => {
    const prisma = fakeLabelPrisma();
    await upsertLabel(prisma, { ...base, vaspId: 'v1' });
    expect([...prisma.rows.values()][0].vaspId).toBe('v1');
  });
});

describe('upsertLabels', () => {
  it('writes every label and returns the count', async () => {
    const prisma = fakeLabelPrisma();
    const n = await upsertLabels(prisma, [base, { ...base, name: 'Second' }]);
    expect(n).toBe(2);
    expect(prisma.rows.size).toBe(2);
  });
});
