import type { Chain } from '@/lib/tokens';

/**
 * Client-side mirror of the intake validation in apps/api/src/intake (normalize.ts, resolve.ts) and
 * packages/shared/src/addressRules.ts. It exists so investigators see problems BEFORE submitting; the API
 * stays authoritative (it also verifies Base58Check / bech32 / EIP-55 checksums, which are not re-implemented
 * here), and intake.parity.test.ts fails if the two drift on dates, amounts, networks and address shapes.
 */

export type Network = 'TRC20' | 'ERC20' | 'BEP20';
/** Network vocabulary of the API (POST /complaints `network`). The chains POLYGON and BTC are never selected, only detected. */
export const NETWORKS: { value: Network; label: string; chain: Chain }[] = [
  { value: 'TRC20', label: 'TRC20 (TRON)', chain: 'TRON' },
  { value: 'ERC20', label: 'ERC20 (Ethereum)', chain: 'ETH' },
  { value: 'BEP20', label: 'BEP20 (BNB Smart Chain)', chain: 'BSC' },
];
export const NETWORK_CHAIN: Record<Network, Chain> = { TRC20: 'TRON', ERC20: 'ETH', BEP20: 'BSC' };
export const EVM_CHAINS: Chain[] = ['ETH', 'BSC', 'POLYGON'];

export const MAX_ENTRIES = 50;
export const MAX_ROWS = 20_000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const ACK_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,63}$/;
const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF\u00AD\u202A-\u202E]/g;
const IST = '+05:30';

export interface Issue {
  field: string;
  code: string;
  message: string;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
export const clean = (v: unknown) => text(v).replace(ZERO_WIDTH, '').trim();

/** Splits a delimited cell (`a;b|c,d` or newlines), exactly like the API. */
export const toList = (v: unknown): string[] => text(v).split(/[;,|\n\r]+/).filter((p) => p.replace(ZERO_WIDTH, '').trim() !== '');

/** ISO-8601 with offset/Z, DD/MM/YYYY[ HH:mm[:ss]] or offset-less ISO (read as IST). */
export function parseReportedAt(v: unknown): Date | null {
  const s = clean(v);
  if (!s) return null;
  let iso: string | null = null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/))) {
    const [, d, mo, y, h = '0', mi = '00', se = '0'] = m;
    iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:${se.padStart(2, '0')}${IST}`;
  } else if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(s)) {
    iso = (s.includes(':') ? s.replace(' ', 'T') : `${s}T00:00:00`) + IST;
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    iso = s.replace(' ', 'T');
  }
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const dm = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dm) {
    const ist = new Date(d.getTime() + 5.5 * 3600_000);
    if (ist.getUTCDate() !== Number(dm[1]) || ist.getUTCMonth() + 1 !== Number(dm[2])) return null;
  }
  return d;
}

/** Money as a decimal string, never a float. */
export function parseAmountInr(v: unknown): string | null {
  const s = clean(v)
    .replace(/^(₹|rs\.?|inr)\s*/i, '')
    .replace(/,/g, '')
    .replace(/\s+/g, '');
  if (!/^\d{1,18}(\.\d{1,2})?$/.test(s)) return null;
  const [int, frac = ''] = s.split('.');
  const out = `${int.replace(/^0+(?=\d)/, '')}.${frac.padEnd(2, '0')}`;
  return Number(out) > 0 ? out : null;
}

export function parseNetwork(v: unknown): Network | null | 'INVALID' {
  const s = clean(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  return NETWORKS.some((n) => n.value === s) ? (s as Network) : 'INVALID';
}

/** Date checks shared by the CSV row validator and the form schema. Returns an Issue-shaped problem or null. */
export function dateProblem(v: unknown, now: Date): { code: string; message: string } | null {
  const d = parseReportedAt(v);
  if (clean(v) === '') return { code: 'REQUIRED', message: 'Enter the complaint date' };
  if (!d) return { code: 'INVALID_DATE', message: 'Use YYYY-MM-DD[ HH:mm] or DD/MM/YYYY [HH:mm] (IST unless an offset is given)' };
  if (d.getTime() > now.getTime() + 5 * 60_000) return { code: 'DATE_IN_FUTURE', message: 'The complaint date is in the future' };
  if (d.getUTCFullYear() < 2009) return { code: 'DATE_TOO_OLD', message: 'The complaint date predates cryptocurrencies' };
  return null;
}

// ---------- addresses ----------

export const RULES = {
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  evm: /^0x[a-fA-F0-9]{40}$/,
  btcLegacy: /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/,
  btcBech32: /^bc1[ac-hj-np-z02-9]{11,71}$/,
  evmTx: /^0x[a-fA-F0-9]{64}$/,
  hex64: /^[a-fA-F0-9]{64}$/,
} as const;

export type AddressFamily = 'TRON' | 'EVM' | 'BTC';

export type Classified =
  | { kind: 'ADDRESS'; family: AddressFamily; normalized: string }
  | { kind: 'TX_HASH'; normalized: string }
  | { kind: 'INVALID'; normalized: string; reason: string };

/** trim, strip zero-width characters and whitespace, fix a leading 0X. Same as the API. */
export function normalizeIdentifier(raw: string): string {
  const s = raw.replace(ZERO_WIDTH, '').replace(/\s+/g, '');
  return /^0X/.test(s) ? `0x${s.slice(2)}` : s;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

function diagnose(s: string): string {
  if (s === '') return 'empty value';
  if (/^0x/.test(s)) {
    const hex = s.slice(2);
    if (!/^[a-fA-F0-9]*$/.test(hex)) return '0x value contains non-hex characters';
    return `0x value has ${hex.length} hex characters; an address has 40 and a transaction hash 64`;
  }
  if (s[0] === 'T') {
    if (s.length !== 34) return `TRON address must be 34 characters, got ${s.length}`;
    if (![...s].every((c) => BASE58.test(c))) return 'contains characters outside the Base58 alphabet (0, O, I and l are never valid)';
    return 'not a valid TRON address';
  }
  if (/^(bc1|BC1)/.test(s)) return 'invalid bech32 Bitcoin address (length, characters or mixed case)';
  if (/^[13]/.test(s)) return 'invalid Bitcoin address (length or Base58 characters)';
  if (/^[a-fA-F0-9]+$/.test(s)) return `hex value of length ${s.length}; a transaction hash has 64`;
  return 'not a recognised TRON, EVM or Bitcoin address';
}

/** Format-level classification (TRON, then EVM, then Bitcoin, then transaction hashes). Checksums are verified by the API. */
export function classifyIdentifier(raw: string): Classified {
  let s = normalizeIdentifier(raw);
  if (RULES.tron.test(s)) return { kind: 'ADDRESS', family: 'TRON', normalized: s };
  if (RULES.evm.test(s)) return { kind: 'ADDRESS', family: 'EVM', normalized: s };
  if (RULES.evmTx.test(s)) return { kind: 'TX_HASH', normalized: s.toLowerCase() };
  if (/^BC1/.test(s) && s === s.toUpperCase()) s = s.toLowerCase();
  if (RULES.btcBech32.test(s) || RULES.btcLegacy.test(s)) return { kind: 'ADDRESS', family: 'BTC', normalized: s };
  if (RULES.hex64.test(s)) return { kind: 'TX_HASH', normalized: s.toLowerCase() };
  return { kind: 'INVALID', normalized: s, reason: diagnose(s) };
}

/** Comparison key: EVM addresses are case-insensitive. */
export const dedupeKey = (normalized: string) => (normalized.startsWith('0x') ? normalized.toLowerCase() : normalized);

export interface ChainGuess {
  /** The one chain the address is on, when format and network decide it. */
  chain: Chain | null;
  /** Possible chains when `chain` is null (an EVM address without a network). */
  candidates: Chain[];
}

/** Mirrors resolve.ts without probing: TRON and BTC by format, EVM by the network field, otherwise ambiguous (server probes). */
export function guessChain(family: AddressFamily, network: Network | null): ChainGuess {
  if (family === 'TRON') return { chain: 'TRON', candidates: [] };
  if (family === 'BTC') return { chain: 'BTC', candidates: [] };
  if (network === 'ERC20' || network === 'BEP20') return { chain: NETWORK_CHAIN[network], candidates: [] };
  return { chain: null, candidates: EVM_CHAINS };
}
