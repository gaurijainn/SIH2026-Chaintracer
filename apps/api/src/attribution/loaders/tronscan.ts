import type { AccountMeta } from '@ps26183/shared';
import { upsertLabels, type LabelPrisma } from '../labelStore';
import type { NormalizedLabel } from '../types';

/**
 * Tronscan public tags and Security Service flags. Reuses B3's TronAdapter.getAccountMeta (no new
 * HTTP client): call it for a specific address under investigation, then normalize the result here.
 * Neutral vocabulary only — a flag is "reported"/"high_risk", never "criminal".
 */
export function normalizeTronscanMeta(meta: AccountMeta): NormalizedLabel[] {
  const labels: NormalizedLabel[] = [];
  const base = { chain: meta.chain, addr: meta.addr, source: 'tronscan' as const, evidence: { fetchedAt: meta.fetchedAt } };

  if (meta.publicTag) {
    labels.push({ ...base, name: meta.publicTag, category: 'exchange_associated', confidence: 0.7, evidence: { publicTag: meta.publicTag } });
  }
  if (meta.flags.fraudTransaction) {
    labels.push({ ...base, name: 'Tronscan: fraud-transaction flag', category: 'reported', confidence: 0.6 });
  }
  if (meta.flags.fraudTokenCreator) {
    labels.push({ ...base, name: 'Tronscan: fraud-token-creator flag', category: 'reported', confidence: 0.6 });
  }
  if (meta.flags.stablecoinBlacklist) {
    labels.push({ ...base, name: 'Tether: stablecoin blacklist', category: 'high_risk', confidence: 0.85 });
  }
  if (meta.flags.sendAdByMemo) {
    labels.push({ ...base, name: 'Tronscan: memo-spam flag', category: 'reported', confidence: 0.3 });
  }
  return labels;
}

/** One address at a time by design (plan Section 10: never crawl Tronscan in bulk). */
export async function loadTronscanLabel(prisma: LabelPrisma, meta: AccountMeta): Promise<number> {
  const labels = normalizeTronscanMeta(meta);
  await upsertLabels(prisma, labels);
  return labels.length;
}
