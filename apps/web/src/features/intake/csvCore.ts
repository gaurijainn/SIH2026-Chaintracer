import Papa from 'papaparse';
import type { Chain } from '@/lib/tokens';
import { ACK_RE, MAX_ENTRIES, MAX_FILE_BYTES, MAX_ROWS, clean, classifyIdentifier, dateProblem, dedupeKey, guessChain, parseAmountInr, parseNetwork, toList, type AddressFamily, type Issue, type Network } from './rules';

/** Canonical complaint fields, exactly the keys of the API's complaint body (apps/api/src/intake/routes.ts). */
export type Field = 'ackNo' | 'reportedAt' | 'category' | 'amountInr' | 'network' | 'addresses' | 'txHashes' | 'tokenContract' | 'firNumber';
export const FIELDS: Field[] = ['ackNo', 'reportedAt', 'category', 'amountInr', 'network', 'addresses', 'txHashes', 'tokenContract', 'firNumber'];
export const REQUIRED_COLUMNS: Field[] = ['ackNo', 'reportedAt', 'category', 'amountInr'];

/** Header aliases, copied from apps/api/src/intake/csv.ts (matched lower-cased with non-alphanumerics stripped). intake.parity.test.ts guards drift. */
export const ALIASES: Record<string, Field> = {
  ackno: 'ackNo', acknumber: 'ackNo', acknowledgementnumber: 'ackNo', acknowledgmentnumber: 'ackNo', ncrpackno: 'ackNo',
  reportedat: 'reportedAt', reporteddate: 'reportedAt', date: 'reportedAt', incidentdate: 'reportedAt', complaintdate: 'reportedAt',
  category: 'category', complaintcategory: 'category', crimecategory: 'category',
  amountinr: 'amountInr', amount: 'amountInr', amountlost: 'amountInr', amountinrs: 'amountInr',
  network: 'network',
  addresses: 'addresses', address: 'addresses', walletaddresses: 'addresses', wallets: 'addresses', wallet: 'addresses',
  txhashes: 'txHashes', txhash: 'txHashes', transactionhashes: 'txHashes', transactionhash: 'txHashes', txids: 'txHashes',
  tokencontract: 'tokenContract', token: 'tokenContract', contract: 'tokenContract',
  firnumber: 'firNumber', fir: 'firNumber', firno: 'firNumber',
};

export const canonicalHeader = (h: string): Field | null => ALIASES[h.replace(/[\u200B-\u200F\uFEFF]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')] ?? null;

export interface PreviewEntry {
  raw: string;
  value: string;
  kind: 'ADDRESS' | 'TX_HASH';
  family?: AddressFamily;
  chain: Chain | null;
  candidates: Chain[];
}

export type RowStatus = 'valid' | 'invalid' | 'duplicate';

export interface PreviewRow {
  /** 1-based data-row number (the header is not counted). */
  index: number;
  fields: Record<Field, string>;
  entries: PreviewEntry[];
  errors: Issue[];
  warnings: Issue[];
  status: RowStatus;
  duplicate?: { ofRow: number; identical: boolean };
  /** Other data rows that list one of the same wallets; the API puts these complaints in one case. */
  linkedRows: number[];
  /** Distinct resolved chains for display (TRON first). */
  chains: Chain[];
  /** True when the row carries at least one TRON address: the TRON fast path. */
  tron: boolean;
}

const MAX_LINKED = 5;
const emptyFields = (): Record<Field, string> => Object.fromEntries(FIELDS.map((f) => [f, ''])) as Record<Field, string>;

/** Validates one complaint's fields and resolves its entries. Mirrors normalizeComplaint() + the no-probe part of resolveEntries(). */
export function validateFields(fields: Record<Field, string>, now: Date): { entries: PreviewEntry[]; errors: Issue[]; warnings: Issue[]; network: Network | null } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (field: string, code: string, message: string) => errors.push({ field, code, message });

  const ackNo = clean(fields.ackNo);
  if (!ackNo) err('ackNo', 'REQUIRED', 'NCRP acknowledgement number is required');
  else if (!ACK_RE.test(ackNo)) err('ackNo', 'INVALID_ACK_NO', 'Acknowledgement number must be 3-64 letters, digits or . _ / -');

  const dp = dateProblem(fields.reportedAt, now);
  if (dp) err('reportedAt', dp.code, dp.message);

  const category = clean(fields.category);
  if (!category) err('category', 'REQUIRED', 'Complaint category is required');
  else if (category.length > 100) err('category', 'TOO_LONG', 'Category is limited to 100 characters');

  if (clean(fields.amountInr) === '') err('amountInr', 'REQUIRED', 'Amount in INR is required');
  else if (!parseAmountInr(fields.amountInr)) err('amountInr', 'INVALID_AMOUNT', 'Amount must be a positive number with at most 2 decimals');

  const net = parseNetwork(fields.network);
  if (net === 'INVALID') err('network', 'INVALID_NETWORK', 'Unsupported chain/network: use TRC20, ERC20 or BEP20 (or leave blank to auto-detect)');
  const network = net === 'INVALID' ? null : net;

  const entries: PreviewEntry[] = [];
  const seen = new Set<string>();
  let entryErrors = 0;
  const add = (items: string[], field: 'addresses' | 'txHashes') =>
    items.forEach((rawItem, i) => {
      const c = classifyIdentifier(rawItem);
      const at = `${field}[${i}]`;
      if (c.kind === 'INVALID') {
        entryErrors++;
        err(at, field === 'addresses' ? 'INVALID_ADDRESS' : 'INVALID_TX_HASH', `${rawItem.trim()}: ${c.reason}`);
        return;
      }
      const key = dedupeKey(c.normalized);
      if (seen.has(key)) {
        warnings.push({ field: at, code: 'DUPLICATE_ENTRY', message: `${c.normalized} appears more than once in this complaint; kept once` });
        return;
      }
      seen.add(key);
      if (c.kind === 'TX_HASH') {
        entries.push({ raw: rawItem.trim(), value: c.normalized, kind: 'TX_HASH', chain: null, candidates: [] });
        return;
      }
      const g = guessChain(c.family, network);
      entries.push({ raw: rawItem.trim(), value: c.normalized, kind: 'ADDRESS', family: c.family, chain: g.chain, candidates: g.candidates });
    });
  add(toList(fields.addresses), 'addresses');
  add(toList(fields.txHashes), 'txHashes');

  if (entries.length === 0 && entryErrors === 0) err('addresses', 'NO_IDENTIFIERS', 'At least one wallet address or transaction hash is required');
  if (entries.length > MAX_ENTRIES) err('addresses', 'TOO_MANY', `At most ${MAX_ENTRIES} addresses/hashes per complaint`);
  if (clean(fields.firNumber).length > 64) err('firNumber', 'TOO_LONG', 'FIR number is limited to 64 characters');

  for (const e of entries) {
    if (e.kind === 'ADDRESS' && !e.chain && e.candidates.length) {
      warnings.push({ field: e.value, code: 'AMBIGUOUS_CHAIN', message: `${e.value} is an EVM address: valid on ETH, BSC and POLYGON. The server will probe the chains unless a network is given` });
    }
  }
  return { entries, errors, warnings, network };
}

export const chainsOf = (entries: PreviewEntry[]): Chain[] => {
  const set = new Set<Chain>();
  for (const e of entries) if (e.kind === 'ADDRESS') for (const c of e.chain ? [e.chain] : e.candidates) set.add(c);
  const order: Chain[] = ['TRON', 'ETH', 'BSC', 'POLYGON', 'BTC'];
  return order.filter((c) => set.has(c));
};

/**
 * Stateful row validator: feed it rows in order, then call finish() for the cross-row markers.
 * Duplicate rows (same acknowledgement number, the API's dedupe key) are flagged and excluded from import;
 * a wallet shared by different complaints is marked as a linked case (the API groups those into one case).
 */
export function createRowValidator(now: Date = new Date()) {
  const rows: PreviewRow[] = [];
  const firstByAck = new Map<string, PreviewRow>();
  const byWallet = new Map<string, number[]>();

  function add(fields: Record<Field, string>, cellCount: number, headerCount: number, extraErrors: Issue[] = []): PreviewRow {
    const v = validateFields(fields, now);
    const errors = [...extraErrors, ...v.errors];
    const requiredMissing = cellCount < headerCount && REQUIRED_COLUMNS.some((f) => clean(fields[f]) === '');
    if (cellCount > headerCount) errors.unshift({ field: 'row', code: 'MALFORMED_ROW', message: `Row has ${cellCount} cells but the header has ${headerCount}; likely an unquoted comma` });
    else if (requiredMissing) errors.unshift({ field: 'row', code: 'MALFORMED_ROW', message: `Row has only ${cellCount} of ${headerCount} cells` });
    const row: PreviewRow = {
      index: rows.length + 1,
      fields,
      entries: v.entries,
      errors,
      warnings: v.warnings,
      status: errors.length ? 'invalid' : 'valid',
      linkedRows: [],
      chains: chainsOf(v.entries),
      tron: v.entries.some((e) => e.chain === 'TRON'),
    };
    const ack = clean(fields.ackNo);
    if (ack && errors.length === 0) {
      const first = firstByAck.get(ack);
      if (first) {
        row.status = 'duplicate';
        row.duplicate = { ofRow: first.index, identical: FIELDS.every((f) => clean(fields[f]) === clean(first.fields[f])) };
      } else firstByAck.set(ack, row);
    }
    if (row.status === 'valid') {
      for (const key of new Set(v.entries.filter((e) => e.kind === 'ADDRESS').map((e) => dedupeKey(e.value)))) byWallet.set(key, [...(byWallet.get(key) ?? []), row.index]);
    }
    rows.push(row);
    return row;
  }

  function finish(): PreviewRow[] {
    // Capped at MAX_LINKED per row: a wallet shared by thousands of complaints must not make this quadratic.
    for (const idxs of byWallet.values()) {
      if (idxs.length < 2) continue;
      const head = idxs.slice(0, MAX_LINKED + 1);
      for (const i of idxs) {
        const r = rows[i - 1];
        for (const o of head) if (o !== i && r.linkedRows.length < MAX_LINKED && !r.linkedRows.includes(o)) r.linkedRows.push(o);
      }
    }
    return rows;
  }
  return { add, finish, get count() { return rows.length; } };
}

// ---------- papaparse driver (runs inside the Web Worker; also usable on the main thread as a fallback) ----------

export interface ParseProgress {
  rows: number;
  /** 0..100, or null when the size is unknown. */
  percent: number | null;
}

export interface CsvParseResult {
  rows: PreviewRow[];
  /** Whole-file problems (missing columns, unreadable quotes, over the limits). Import is blocked while any exist. */
  fileErrors: string[];
  recognisedColumns: Field[];
  ignoredColumns: string[];
  /** True when parsing stopped at the API's row limit. */
  truncated: boolean;
}

const CHUNK_BYTES = 256 * 1024;

/**
 * Streams the source through Papa Parse in chunks so progress can be reported and memory stays flat.
 * `header: false` on purpose: the header is mapped with the API's own alias table, and malformed rows
 * (wrong cell count, broken quotes) are detected here instead of being silently repaired.
 */
export function parseCsvSource(source: File | string, onProgress?: (p: ParseProgress) => void, now: Date = new Date()): Promise<CsvParseResult> {
  return new Promise((resolve) => {
    const validator = createRowValidator(now);
    const fileErrors: string[] = [];
    let cols: (Field | null)[] | null = null;
    let headerCount = 0;
    let ignored: string[] = [];
    let truncated = false;
    let quoteErrorRow: number | null = null;
    const size = typeof source === 'string' ? source.length : source.size;

    if (typeof source !== 'string' && source.size > MAX_FILE_BYTES) {
      resolve({ rows: [], fileErrors: [`File is ${(source.size / 1048576).toFixed(1)} MB; the import limit is 25 MB. Split it into smaller files.`], recognisedColumns: [], ignoredColumns: [], truncated: false });
      return;
    }

    const finish = () => {
      const rows = validator.finish();
      if (cols === null) fileErrors.push(rows.length === 0 && !fileErrors.length ? 'The file has no data rows.' : 'The file has no header row.');
      else if (rows.length === 0 && !fileErrors.length) fileErrors.push('The file has a header but no data rows.');
      resolve({ rows, fileErrors, recognisedColumns: [...new Set((cols ?? []).filter((c): c is Field => c !== null))], ignoredColumns: ignored, truncated });
    };

    Papa.parse<string[]>(source as never, {
      header: false,
      delimiter: ',',
      skipEmptyLines: 'greedy',
      chunkSize: CHUNK_BYTES,
      worker: false,
      chunk: (results, parser) => {
        const errs = results.errors.filter((e) => e.type === 'Quotes');
        if (errs.length && quoteErrorRow === null) {
          quoteErrorRow = validator.count + Math.max(0, (errs[0].row ?? 0) - (cols === null ? 1 : 0)) + 1;
          fileErrors.push(`A quoted value is not closed near data row ${quoteErrorRow}; that row and the rows after it could not be read. Fix the quote and upload again.`);
        }
        let data = results.data;
        if (cols === null) {
          if (data.length && data[0].every((c) => !c.trim())) data = data.slice(1);
          if (data.length === 0) return;
          const [head, ...rest] = data;
          data = rest;
          const mapped = (head ?? []).map(canonicalHeader);
          const missing = REQUIRED_COLUMNS.filter((c) => !mapped.includes(c));
          ignored = (head ?? []).filter((_, i) => mapped[i] === null).map((h) => h.trim()).filter(Boolean);
          cols = mapped;
          headerCount = mapped.length;
          if (missing.length) {
            fileErrors.push(`Missing required column(s): ${missing.join(', ')}`);
            parser.abort();
            return;
          }
        }
        for (const cells of data) {
          if (validator.count >= MAX_ROWS) {
            truncated = true;
            fileErrors.push(`The file has more than ${MAX_ROWS.toLocaleString()} rows; split it into smaller files.`);
            parser.abort();
            return;
          }
          const fields = emptyFields();
          cells.forEach((cell, i) => {
            const f = cols![i];
            if (f) fields[f] = cell;
          });
          validator.add(fields, cells.length, headerCount);
        }
        onProgress?.({ rows: validator.count, percent: size ? Math.min(100, Math.round((results.meta.cursor / size) * 100)) : null });
      },
      complete: finish,
      error: (e: unknown) => {
        fileErrors.push(`The file could not be read${e instanceof Error && e.message ? ` (${e.message})` : ''}.`);
        finish();
      },
    });
  });
}

/** Serialises the rows the API will be sent (valid ones only) back to CSV, using the API's canonical column names and the original cell text. */
export function toImportCsv(rows: PreviewRow[]): string {
  return Papa.unparse({ fields: FIELDS, data: rows.map((r) => FIELDS.map((f) => r.fields[f])) }, { newline: '\n' });
}
