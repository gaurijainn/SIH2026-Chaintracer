import type { Chain } from '@/lib/tokens';
import { MAX_ENTRIES, classifyIdentifier, dedupeKey, guessChain, type AddressFamily, type Network } from './rules';

export type PasteStatus = 'valid' | 'invalid' | 'duplicate' | 'needs-chain';

export interface PasteRow {
  /** 1-based line number in the pasted text (blank lines are counted, then ignored). */
  line: number;
  raw: string;
  value: string;
  kind: 'ADDRESS' | 'TX_HASH' | 'INVALID';
  family?: AddressFamily;
  chain: Chain | null;
  candidates: Chain[];
  status: PasteStatus;
  error?: string;
  duplicateOfLine?: number;
}

export interface PasteSummary {
  total: number;
  valid: number;
  invalid: number;
  duplicate: number;
  needsChain: number;
  tron: number;
  tooMany: boolean;
}

/** `serverProbe`: the investigator chose to let the API probe ETH/BSC/POLYGON for EVM addresses instead of naming a network. */
export function parsePastedAddresses(text: string, network: Network | null, serverProbe = false): { rows: PasteRow[]; summary: PasteSummary } {
  const rows: PasteRow[] = [];
  const seen = new Map<string, number>();
  text.split(/\r\n|\r|\n/).forEach((line, i) => {
    const raw = line.trim();
    if (!raw) return;
    const c = classifyIdentifier(raw);
    const base = { line: i + 1, raw, value: c.normalized, chain: null as Chain | null, candidates: [] as Chain[] };
    if (c.kind === 'INVALID') {
      rows.push({ ...base, kind: 'INVALID', status: 'invalid', error: c.reason });
      return;
    }
    const key = dedupeKey(c.normalized);
    const first = seen.get(key);
    if (first !== undefined) {
      rows.push({ ...base, kind: c.kind, status: 'duplicate', duplicateOfLine: first, ...(c.kind === 'ADDRESS' ? { family: c.family } : {}) });
      return;
    }
    seen.set(key, i + 1);
    if (c.kind === 'TX_HASH') {
      rows.push({ ...base, kind: 'TX_HASH', status: 'valid' });
      return;
    }
    const g = guessChain(c.family, network);
    // An EVM address without a chosen network is not guessed: the investigator must pick a chain (or opt into server probing).
    const needsChain = !g.chain && !serverProbe;
    rows.push({ ...base, kind: 'ADDRESS', family: c.family, chain: g.chain, candidates: g.candidates, status: needsChain ? 'needs-chain' : 'valid' });
  });
  const count = (s: PasteStatus) => rows.filter((r) => r.status === s).length;
  const valid = count('valid');
  return {
    rows,
    summary: { total: rows.length, valid, invalid: count('invalid'), duplicate: count('duplicate'), needsChain: count('needs-chain'), tron: rows.filter((r) => r.chain === 'TRON' && r.status === 'valid').length, tooMany: valid > MAX_ENTRIES },
  };
}
