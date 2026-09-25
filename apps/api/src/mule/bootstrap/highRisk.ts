import type { Chain } from '@ps26183/shared';
import type { BlacklistEvent } from '@ps26183/workers/adapters';
import { noisyOr } from '../../attribution/confidence';
import { DEFAULT_OFAC_DIR, OFAC_ASSETS, normalizeOfacAddresses, parseOfacAddresses } from '../../attribution/loaders/ofac';
import type { BootstrapLabelRow } from '../training/types';

/**
 * B7.4 high-risk label construction (task 3): merges TronGrid USDT-TRC20 `AddedBlackList` events
 * (task 1) with OFAC TRX addresses (task 2, reused as-is) into `BootstrapLabelRow[]` rows, always
 * label='high_risk' (never 'criminal' -- BootstrapLabelValue itself forbids anything else). Every
 * row keeps its source-specific evidence; when two sources agree on the same address their
 * confidences are combined with noisy-OR (same combination B7.4's join.ts already uses for
 * agreeing labels), so an address flagged by both TronGrid and OFAC ends up with higher confidence
 * than either alone -- never silently deduped away.
 */

/** One row per address (not per event): TronGrid can blacklist the same address more than once. */
export function blacklistEventsToLabelRows(events: BlacklistEvent[], fetchedAtIso: string, confidence = 0.9): BootstrapLabelRow[] {
  const byAddr = new Map<string, BlacklistEvent[]>();
  for (const e of events) byAddr.set(e.address, [...(byAddr.get(e.address) ?? []), e]);
  return [...byAddr.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([address, evs]) => ({
      address,
      chain: 'TRON' as Chain,
      label: 'high_risk' as const,
      source: 'usdt_blacklist',
      fetchedAt: fetchedAtIso,
      confidence,
      evidence: {
        eventCount: evs.length,
        events: [...evs].sort((a, b) => a.txHash.localeCompare(b.txHash)).map((e) => ({ txHash: e.txHash, blockNumber: e.blockNumber, blockTimestampMs: e.blockTimestampMs })),
      },
    }));
}

/** Reuses OFAC_ASSETS/parseOfacAddresses/normalizeOfacAddresses as-is (task 2) -- 0 network calls, local file only. */
export async function loadOfacTronLabelRows(fetchedAtIso: string, dir: string = DEFAULT_OFAC_DIR): Promise<BootstrapLabelRow[]> {
  const asset = OFAC_ASSETS.find((a) => a.chain === 'TRON');
  if (!asset) return [];
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const p = path.join(dir, asset.file);
  const { existsSync } = await import('node:fs');
  if (!existsSync(p)) return [];
  const text = await readFile(p, 'utf8');
  const addrs = parseOfacAddresses(text);
  const normalized = normalizeOfacAddresses('TRON', addrs, asset.file);
  return normalized
    .map((n) => ({ address: n.addr, chain: n.chain, label: 'high_risk' as const, source: 'ofac', fetchedAt: fetchedAtIso, confidence: n.confidence, evidence: n.evidence }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

export interface HighRiskMergeResult {
  rows: BootstrapLabelRow[];
  counts: { addedBlackListAddresses: number; ofacAddresses: number; mergedAddresses: number; agreeingAddresses: number };
}

/**
 * Merges any number of high-risk-only label-row sets (always 'high_risk' here, so there is never a
 * label conflict at this stage -- a conflict can only arise later, in joinBootstrapLabels, once
 * these rows meet a negative/licit candidate for the same address). Deduplicates by (chain,
 * address); when several sources agree, combines confidence via noisy-OR and keeps every source's
 * evidence, exactly like join.ts's combineAgreeing. Deterministic: output sorted by (chain, address).
 */
export function mergeHighRiskLabelRows(...rowSets: BootstrapLabelRow[][]): HighRiskMergeResult {
  const all = rowSets.flat();
  const byKey = new Map<string, BootstrapLabelRow[]>();
  for (const r of all) byKey.set(`${r.chain}:${r.address}`, [...(byKey.get(`${r.chain}:${r.address}`) ?? []), r]);

  let agreeing = 0;
  const rows: BootstrapLabelRow[] = [];
  for (const entries of byKey.values()) {
    if (entries.length === 1) {
      rows.push(entries[0]);
      continue;
    }
    agreeing++;
    const [first] = entries;
    rows.push({
      ...first,
      source: [...new Set(entries.map((e) => e.source))].sort().join('+'),
      confidence: noisyOr(entries.map((e) => e.confidence)),
      evidence: entries.map((e) => ({ source: e.source, evidence: e.evidence ?? null, confidence: e.confidence })),
      fetchedAt: [...entries].map((e) => e.fetchedAt).sort()[0],
    });
  }
  rows.sort((a, b) => (a.chain === b.chain ? a.address.localeCompare(b.address) : a.chain.localeCompare(b.chain)));

  return {
    rows,
    counts: {
      addedBlackListAddresses: new Set(all.filter((r) => r.source === 'usdt_blacklist').map((r) => r.address)).size,
      ofacAddresses: new Set(all.filter((r) => r.source === 'ofac').map((r) => r.address)).size,
      mergedAddresses: rows.length,
      agreeingAddresses: agreeing,
    },
  };
}
