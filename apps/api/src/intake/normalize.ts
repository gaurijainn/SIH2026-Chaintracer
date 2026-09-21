import { classifyIdentifier, normalizeIdentifier } from '@ps26183/shared';
import type { Issue, NormalizedComplaint, NormalizedEntry, Network, RawComplaint } from './types';

const MAX_ENTRIES = 50;
const NETWORKS: Network[] = ['TRC20', 'ERC20', 'BEP20'];
const ACK_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,63}$/;
const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF\u00AD\u202A-\u202E]/g;
const IST = '+05:30';

const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : '');
const clean = (v: unknown) => text(v).replace(ZERO_WIDTH, '').trim();

/** Splits a delimited cell (`a;b|c,d` or newlines) or takes an array as-is. */
export function toList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const parts = Array.isArray(v) ? v.map(text) : text(v).split(/[;,|\n\r]+/);
  return parts.filter((p) => p.replace(ZERO_WIDTH, '').trim() !== '');
}

/**
 * Accepts ISO-8601 with an offset/Z, or DD/MM/YYYY[ HH:mm[:ss]] and offset-less ISO.
 * Anything without an explicit offset is read as IST (the reporting authority's zone) and stored as UTC.
 */
export function parseReportedAt(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
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
  // reject overflow such as 31/02/2026, which Date silently rolls into March
  if (Number.isNaN(d.getTime())) return null;
  const dm = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dm) {
    const ist = new Date(d.getTime() + 5.5 * 3600_000);
    if (ist.getUTCDate() !== Number(dm[1]) || ist.getUTCMonth() + 1 !== Number(dm[2])) return null;
  }
  return d;
}

/** Money is a decimal string end to end; never a float. */
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
  return (NETWORKS as string[]).includes(s) ? (s as Network) : 'INVALID';
}

export interface NormalizeResult {
  value?: NormalizedComplaint;
  errors: Issue[];
  warnings: Issue[];
}

/** Pure validation and normalisation of one complaint. Never mutates or "repairs" an address. */
export function normalizeComplaint(raw: RawComplaint, now: Date = new Date()): NormalizeResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (field: string, code: string, message: string) => errors.push({ field, code, message });

  const ackNo = clean(raw.ackNo);
  if (!ackNo) err('ackNo', 'REQUIRED', 'NCRP acknowledgement number is required');
  else if (!ACK_RE.test(ackNo)) err('ackNo', 'INVALID_ACK_NO', 'acknowledgement number must be 3-64 letters, digits or . _ / -');

  const reportedAt = parseReportedAt(raw.reportedAt);
  if (clean(raw.reportedAt) === '' && !(raw.reportedAt instanceof Date)) err('reportedAt', 'REQUIRED', 'reported date is required');
  else if (!reportedAt) err('reportedAt', 'INVALID_DATE', 'use ISO-8601 (2026-09-01T08:30:00+05:30) or DD/MM/YYYY [HH:mm]');
  else if (reportedAt.getTime() > now.getTime() + 5 * 60_000) err('reportedAt', 'DATE_IN_FUTURE', 'reported date is in the future');
  else if (reportedAt.getUTCFullYear() < 2009) err('reportedAt', 'DATE_TOO_OLD', 'reported date predates cryptocurrencies');

  const category = clean(raw.category);
  if (!category) err('category', 'REQUIRED', 'complaint category is required');
  else if (category.length > 100) err('category', 'TOO_LONG', 'category is limited to 100 characters');

  const amountInr = parseAmountInr(raw.amountInr);
  if (clean(raw.amountInr) === '') err('amountInr', 'REQUIRED', 'amount in INR is required');
  else if (!amountInr) err('amountInr', 'INVALID_AMOUNT', 'amount must be a positive number with at most 2 decimals');

  const net = parseNetwork(raw.network);
  if (net === 'INVALID') err('network', 'INVALID_NETWORK', 'network must be one of TRC20, ERC20, BEP20');

  const entries: NormalizedEntry[] = [];
  const seen = new Set<string>();
  const addList = (items: string[], field: 'addresses' | 'txHashes') =>
    items.forEach((rawItem, i) => {
      const c = classifyIdentifier(rawItem);
      const at = `${field}[${i}]`;
      if (c.kind === 'INVALID') {
        err(at, field === 'addresses' ? 'INVALID_ADDRESS' : 'INVALID_TX_HASH', `${rawItem.trim()}: ${c.reasons.join('; ')}`);
        return;
      }
      if (seen.has(c.normalized)) {
        warnings.push({ field: at, code: 'DUPLICATE_ENTRY', message: `${c.normalized} appears more than once in this complaint; kept once` });
        return;
      }
      seen.add(c.normalized);
      if ((field === 'addresses') !== (c.kind === 'ADDRESS')) {
        warnings.push({ field: at, code: 'MISPLACED_FIELD', message: `${c.normalized} is a ${c.kind === 'ADDRESS' ? 'wallet address' : 'transaction hash'}; stored as such` });
      }
      entries.push({ raw: rawItem.trim(), value: c.normalized, kind: c.kind, family: c.family });
    });
  addList(toList(raw.addresses), 'addresses');
  addList(toList(raw.txHashes), 'txHashes');

  const entryErrors = errors.filter((e) => e.code === 'INVALID_ADDRESS' || e.code === 'INVALID_TX_HASH').length;
  if (entries.length === 0 && entryErrors === 0) err('addresses', 'NO_IDENTIFIERS', 'at least one wallet address or transaction hash is required');
  if (entries.length > MAX_ENTRIES) err('addresses', 'TOO_MANY', `at most ${MAX_ENTRIES} addresses/hashes per complaint`);

  const fir = clean(raw.firNumber);
  if (fir.length > 64) err('firNumber', 'TOO_LONG', 'FIR number is limited to 64 characters');
  const tokenContract = normalizeIdentifier(text(raw.tokenContract));

  if (errors.length) return { errors, warnings };
  return {
    errors,
    warnings,
    value: {
      ackNo,
      reportedAt: reportedAt!,
      category,
      amountInr: amountInr!,
      ...(net && net !== 'INVALID' ? { network: net } : {}),
      ...(fir ? { firNumber: fir } : {}),
      ...(tokenContract ? { tokenContract } : {}),
      entries,
    },
  };
}
