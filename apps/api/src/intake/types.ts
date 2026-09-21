import type { Chain } from '@ps26183/shared';

/** A complaint as received (CSV row, JSON body or NCRP feed record), before any validation. */
export interface RawComplaint {
  ackNo?: unknown;
  reportedAt?: unknown;
  category?: unknown;
  amountInr?: unknown;
  network?: unknown;
  addresses?: unknown;
  txHashes?: unknown;
  tokenContract?: unknown;
  firNumber?: unknown;
}

export interface Issue {
  field: string;
  code: string;
  message: string;
}

export type Network = 'TRC20' | 'ERC20' | 'BEP20';

export interface NormalizedEntry {
  raw: string;
  value: string;
  kind: 'ADDRESS' | 'TX_HASH';
  family: 'TRON' | 'EVM' | 'BTC' | 'TRON_OR_BTC';
}

export interface NormalizedComplaint {
  ackNo: string;
  reportedAt: Date;
  category: string;
  amountInr: string;
  network?: Network;
  firNumber?: string;
  tokenContract?: string;
  entries: NormalizedEntry[];
}

export interface ResolvedEntry extends NormalizedEntry {
  /** Single resolved chain, or null when ambiguous / unknown. */
  chain: Chain | null;
  /** Chains still possible when `chain` is null (EVM ambiguity, unverified tx hash). */
  candidateChains: Chain[];
  flags: string[];
}

/** Chains an entry should be traced on: the resolved chain, or every kept candidate. Tx hashes are never seeds. */
export function seedChainsOf(e: Pick<ResolvedEntry, 'kind' | 'chain' | 'candidateChains' | 'flags'>): Chain[] {
  if (e.kind !== 'ADDRESS') return [];
  if (e.chain) return [e.chain];
  return e.flags.includes('NO_ACTIVITY') ? [] : e.candidateChains;
}
