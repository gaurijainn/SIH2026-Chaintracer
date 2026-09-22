import { describe, expect, it } from 'vitest';
import type { AccountMeta } from '@ps26183/shared';
import type { LabelPrisma } from '../labelStore';
import { loadTronscanLabel, normalizeTronscanMeta } from './tronscan';

const baseMeta: AccountMeta = { chain: 'TRON', addr: 'TABC', createdAt: 1000, activator: null, publicTag: null, flags: {}, sources: ['tronscan'], fetchedAt: 2000 };

describe('normalizeTronscanMeta', () => {
  it('produces no labels for a clean account with no tag and no flags', () => {
    expect(normalizeTronscanMeta(baseMeta)).toEqual([]);
  });

  it('labels a public tag as exchange_associated (neutral wording, not "criminal")', () => {
    const labels = normalizeTronscanMeta({ ...baseMeta, publicTag: 'Binance Hot Wallet' });
    expect(labels).toEqual([{ chain: 'TRON', addr: 'TABC', name: 'Binance Hot Wallet', category: 'exchange_associated', source: 'tronscan', confidence: 0.7, evidence: { publicTag: 'Binance Hot Wallet' } }]);
  });

  it('maps each security flag to its own neutral label', () => {
    const labels = normalizeTronscanMeta({ ...baseMeta, flags: { fraudTransaction: true, fraudTokenCreator: true, stablecoinBlacklist: true, sendAdByMemo: true } });
    expect(labels.map((l) => l.category).sort()).toEqual(['high_risk', 'reported', 'reported', 'reported'].sort());
    expect(labels.every((l) => l.source === 'tronscan')).toBe(true);
  });

  it('ignores flags that are false or null', () => {
    const labels = normalizeTronscanMeta({ ...baseMeta, flags: { fraudTransaction: false, fraudTokenCreator: null } });
    expect(labels).toEqual([]);
  });
});

describe('loadTronscanLabel', () => {
  it('upserts the normalized labels for one address (never a bulk crawl)', async () => {
    const rows: Record<string, unknown>[] = [];
    const prisma: LabelPrisma = { label: { async upsert({ create }) { rows.push(create); return create; } } };
    const n = await loadTronscanLabel(prisma, { ...baseMeta, publicTag: 'Some Exchange' });
    expect(n).toBe(1);
    expect(rows).toHaveLength(1);
  });
});
