import { createHash } from 'node:crypto';

/**
 * Deterministic canonical-JSON serialisation used everywhere B9 needs a stable, reproducible hash:
 * `Report.sha256`, the PDF footer/QR payload, `/verify`, and the `AuditLog` hash chain. There is
 * exactly one implementation so none of those call sites can silently drift from each other.
 *
 * Rules (all deliberate, not incidental):
 *  - Object keys are sorted lexicographically (by UTF-16 code unit) at every level, recursively.
 *    JSON.stringify preserves insertion order for string keys; sorting first removes that
 *    dependency so the same logical object always serialises identically regardless of how it was
 *    built.
 *  - Arrays keep their original order (order is semantically meaningful for e.g. a hop list) but
 *    every element is canonicalised recursively.
 *  - `undefined` values (on an object) are dropped entirely, the same way `JSON.stringify` already
 *    treats them -- they never appear as `"key":undefined`. Use explicit `null` for "field
 *    considered, no data": this canonicalizer preserves `null` exactly (`"key":null`) so
 *    "no data" and "field never computed" cannot be confused in the hash.
 *  - Numbers are serialised via `JSON.stringify`'s own number formatting (no trailing zeros, no
 *    locale formatting). `NaN`/`Infinity` are rejected (they are not valid JSON and must never
 *    silently become `null`).
 *  - `Date` instances are rejected -- callers must convert to an explicit ISO-8601 UTC string
 *    (e.g. via `date.toISOString()` or this package's `toIst().iso`) before canonicalizing, so the
 *    canonical form never depends on an implicit `Date -> string` rule that could change.
 *  - Strings are passed through `JSON.stringify`'s own escaping.
 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null'; // only reachable at the top level; see serializeObject for nested handling
  const t = typeof value;

  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError(`canonicalize: non-finite number (${String(value)}) is not valid JSON`);
    }
    return JSON.stringify(value);
  }
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);

  if (value instanceof Date) {
    throw new TypeError('canonicalize: Date instances are not allowed -- pass an explicit ISO-8601 UTC string instead');
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : serialize(v))).join(',')}]`;
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`).join(',')}}`;
  }

  throw new TypeError(`canonicalize: unsupported value type (${t})`);
}

/** SHA-256 of a canonical string, hex-encoded. */
export function sha256Hex(canonicalString: string): string {
  return createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}
