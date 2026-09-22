import { describe, expect, it } from 'vitest';
import type { LabelPrisma } from '../labelStore';
import { insertManualLabel } from './manual';

describe('insertManualLabel', () => {
  it('defaults confidence to 1 (an investigator directly asserted this)', async () => {
    const rows: Record<string, unknown>[] = [];
    const prisma: LabelPrisma = { label: { async upsert({ create }) { rows.push(create); return create; } } };
    await insertManualLabel(prisma, { chain: 'TRON', addr: 'TABC', name: 'Confirmed mule wallet', category: 'reported' });
    expect(rows[0]).toMatchObject({ chain: 'TRON', addr: 'TABC', name: 'Confirmed mule wallet', category: 'reported', source: 'manual', confidence: 1 });
  });

  it('accepts an explicit lower confidence and evidence', async () => {
    const rows: Record<string, unknown>[] = [];
    const prisma: LabelPrisma = { label: { async upsert({ create }) { rows.push(create); return create; } } };
    await insertManualLabel(prisma, { chain: 'ETH', addr: '0xabc', name: 'Suspected exchange', category: 'exchange_associated', confidence: 0.6, evidence: { note: 'investigator hunch' } });
    expect(rows[0]).toMatchObject({ confidence: 0.6, evidence: { note: 'investigator hunch' } });
  });

  it('reuses the shared label store, so it is idempotent by (chain, addr, source, name)', async () => {
    const rows = new Map<string, unknown>();
    const prisma: LabelPrisma = {
      label: {
        async upsert({ where, create, update }) {
          const k = JSON.stringify(where.chain_addr_source_name);
          rows.set(k, rows.has(k) ? update : create);
          return rows.get(k);
        },
      },
    };
    await insertManualLabel(prisma, { chain: 'TRON', addr: 'TABC', name: 'Mule', category: 'reported', confidence: 0.5 });
    await insertManualLabel(prisma, { chain: 'TRON', addr: 'TABC', name: 'Mule', category: 'reported', confidence: 0.9 });
    expect(rows.size).toBe(1);
  });
});
