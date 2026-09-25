import { USDT_TRC20, type Chain } from '@ps26183/shared';
import type { TronAdapter } from '@ps26183/workers/adapters';
import { normalizeTronscanMeta } from '../../attribution/loaders/tronscan';
import type { BootstrapLabelRow } from '../training/types';

/**
 * B7.4 negative/licit candidate pipeline (task 4). Mirrors services/ml/app/datasets/negative_sampling.py's
 * NegativeCandidate exactly (same three-way status, same "INCLUDED requires both evidence dicts"
 * rule) so this TS-side collector's CSV output loads straight through `load_negative_candidates`.
 * Never licit-by-absence: an address only becomes INCLUDED when it has *observed* TRON activity
 * (TronAdapter.hasActivity) AND *observed* USDT-TRC20 holder/transfer evidence
 * (TronAdapter.getTransfers) -- an address with no evidence either way is UNDETERMINED, not licit.
 */

export type NegativeCandidateStatus = 'included' | 'excluded' | 'undetermined';

export interface NegativeCandidateRow {
  address: string;
  chain: Chain;
  activity_evidence: Record<string, unknown>;
  usdt_holder_evidence: Record<string, unknown>;
  status: NegativeCandidateStatus;
  exclusion_reason?: string;
  source: string;
  timestamp: string;
}

export interface NegativeCandidateDeps {
  tron: TronAdapter;
  /** known VASP/service/high-risk addresses to exclude outright (vaspRegistry seeds + OFAC/blacklist addresses already labeled high-risk) -- never sampled as negatives. */
  excludedAddresses: ReadonlySet<string>;
  nowIso: string;
}

/**
 * Builds one negative-sampling candidate row for a single TRON address, using only B3's
 * TronAdapter (getAccountMeta -> Tronscan flags, hasActivity, getTransfers), never a second HTTP
 * client. `excludedAddresses` covers the vaspRegistry.ts seed and already-known high-risk
 * addresses; Tronscan's own flags (via normalizeTronscanMeta) additionally exclude any address
 * Tronscan itself tags as an exchange/service or as fraud/blacklisted.
 */
export async function buildNegativeCandidate(addr: string, chain: Chain, deps: NegativeCandidateDeps): Promise<NegativeCandidateRow> {
  const base = { address: addr, chain, source: 'tron_negative_sampling', timestamp: deps.nowIso };

  if (deps.excludedAddresses.has(addr)) {
    return { ...base, activity_evidence: {}, usdt_holder_evidence: {}, status: 'excluded', exclusion_reason: 'known VASP/service/high-risk address (registry or prior label)' };
  }

  const meta = await deps.tron.getAccountMeta(addr);
  const tronscanLabels = normalizeTronscanMeta(meta);
  const disqualifying = tronscanLabels.find((l) => ['exchange_associated', 'high_risk', 'reported'].includes(l.category));
  if (disqualifying) {
    return { ...base, activity_evidence: {}, usdt_holder_evidence: {}, status: 'excluded', exclusion_reason: `tronscan flag: ${disqualifying.category} (${disqualifying.name})` };
  }

  const active = await deps.tron.hasActivity(addr);
  if (!active) {
    return { ...base, activity_evidence: {}, usdt_holder_evidence: {}, status: 'undetermined' };
  }

  const [outPage, inPage] = await Promise.all([deps.tron.getTransfers(addr, 'out'), deps.tron.getTransfers(addr, 'in')]);
  const usdtTransfers = [...outPage.items, ...inPage.items].filter((t) => t.token === USDT_TRC20);
  const allTransfers = [...outPage.items, ...inPage.items];

  if (usdtTransfers.length === 0) {
    // has TRON activity, but never observed holding/moving USDT -- not usable as a USDT-mule negative.
    return {
      ...base,
      activity_evidence: { txCount: allTransfers.length, lastActiveAt: allTransfers.length ? Math.max(...allTransfers.map((t) => t.ts)) : null },
      usdt_holder_evidence: {},
      status: 'undetermined',
    };
  }

  return {
    ...base,
    activity_evidence: { txCount: allTransfers.length, lastActiveAt: Math.max(...allTransfers.map((t) => t.ts)), createdAt: meta.createdAt },
    usdt_holder_evidence: { usdtTxCount: usdtTransfers.length, observedAt: Math.max(...usdtTransfers.map((t) => t.ts)), sampleAmount: usdtTransfers[0].amount },
    status: 'included',
  };
}

/** Builds every candidate for a deterministically-sorted address list. Never reorders input silently. */
export async function buildNegativeCandidates(addresses: readonly string[], chain: Chain, deps: NegativeCandidateDeps): Promise<NegativeCandidateRow[]> {
  const sorted = [...addresses].sort();
  const rows: NegativeCandidateRow[] = [];
  for (const addr of sorted) rows.push(await buildNegativeCandidate(addr, chain, deps));
  return rows;
}

export function confirmedNegatives(rows: NegativeCandidateRow[]): NegativeCandidateRow[] {
  return rows.filter((r) => r.status === 'included');
}

/** Confirmed (INCLUDED) negative candidates -> BootstrapLabelRow ('licit'), carrying their real
 * activity/USDT-holder evidence forward so the final joined training row never loses it. Confidence
 * is 1.0 because inclusion itself already required both evidence dicts to be non-empty -- there is
 * no weaker "maybe negative" tier here (see NegativeCandidate's own validator). */
export function negativeCandidatesToLabelRows(rows: NegativeCandidateRow[], fetchedAtIso: string): BootstrapLabelRow[] {
  return confirmedNegatives(rows)
    .map((r) => ({
      address: r.address,
      chain: r.chain,
      label: 'licit' as const,
      source: r.source,
      fetchedAt: fetchedAtIso,
      confidence: 1,
      evidence: { activity_evidence: r.activity_evidence, usdt_holder_evidence: r.usdt_holder_evidence },
    }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

/** CSV serialization matching services/ml/app/datasets/negative_sampling.py's REQUIRED_COLUMNS exactly. */
export function negativeCandidatesToCsvRows(rows: NegativeCandidateRow[]): Record<string, string>[] {
  return rows.map((r) => ({
    address: r.address,
    chain: r.chain,
    status: r.status,
    source: r.source,
    timestamp: r.timestamp,
    activity_evidence: JSON.stringify(r.activity_evidence ?? {}),
    usdt_holder_evidence: JSON.stringify(r.usdt_holder_evidence ?? {}),
    exclusion_reason: r.exclusion_reason ?? '',
  }));
}
