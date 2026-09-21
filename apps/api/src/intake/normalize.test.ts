import { describe, expect, it } from 'vitest';
import { normalizeComplaint, parseAmountInr, parseReportedAt, toList } from './normalize';
import { complaint, evmAddress, tronAddress, txHash } from './testutil';

const NOW = new Date('2026-09-20T00:00:00Z');
const codes = (r: ReturnType<typeof normalizeComplaint>) => r.errors.map((e) => `${e.field}:${e.code}`);

describe('normalizeComplaint: valid input', () => {
  it('normalises a full JSON complaint', () => {
    const t = tronAddress('a');
    const r = normalizeComplaint(
      { ackNo: ' ACK-001 ', reportedAt: '2026-09-01T08:30:00+05:30', category: ' Sextortion ', amountInr: '1,20,000', network: 'trc-20',
        addresses: [` ${t}\u200B`, evmAddress('e')], txHashes: [txHash('1')], tokenContract: ' 0Xabc ', firNumber: 'FIR-9' },
      NOW,
    );
    expect(r.errors).toEqual([]);
    expect(r.value).toMatchObject({
      ackNo: 'ACK-001', category: 'Sextortion', amountInr: '120000.00', network: 'TRC20', firNumber: 'FIR-9', tokenContract: '0xabc',
    });
    expect(r.value!.reportedAt.toISOString()).toBe('2026-09-01T03:00:00.000Z'); // IST -> UTC
    expect(r.value!.entries.map((e) => [e.kind, e.family])).toEqual([['ADDRESS', 'TRON'], ['ADDRESS', 'EVM'], ['TX_HASH', 'TRON_OR_BTC']]);
    expect(r.value!.entries[0].value).toBe(t);
    expect(r.value!.entries[1].value).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('accepts delimited address cells (CSV style) and keeps each address once', () => {
    const a = tronAddress('x');
    const b = tronAddress('y');
    const r = normalizeComplaint({ ...complaint('ACK-2'), addresses: `${a}; ${b} | ${a}\n` }, NOW);
    expect(r.value!.entries.map((e) => e.value)).toEqual([a, b]);
    expect(r.warnings.map((w) => w.code)).toEqual(['DUPLICATE_ENTRY']);
  });

  it('stores a hash placed in the address field as a hash, with a warning', () => {
    const r = normalizeComplaint({ ...complaint('ACK-3'), addresses: [tronAddress('q'), txHash('z')] }, NOW);
    expect(r.value!.entries[1].kind).toBe('TX_HASH');
    expect(r.warnings.map((w) => w.code)).toContain('MISPLACED_FIELD');
  });

  it('accepts a complaint with only a transaction hash', () => {
    const r = normalizeComplaint({ ...complaint('ACK-4'), addresses: [], txHashes: [txHash('only')] }, NOW);
    expect(r.errors).toEqual([]);
    expect(r.value!.entries).toHaveLength(1);
  });
});

describe('normalizeComplaint: missing and invalid input', () => {
  it('reports every missing required field', () => {
    expect(codes(normalizeComplaint({}, NOW))).toEqual(['ackNo:REQUIRED', 'reportedAt:REQUIRED', 'category:REQUIRED', 'amountInr:REQUIRED', 'addresses:NO_IDENTIFIERS']);
  });

  it('requires at least one address or hash', () => {
    expect(codes(normalizeComplaint({ ...complaint('ACK-5'), addresses: [] }, NOW))).toEqual(['addresses:NO_IDENTIFIERS']);
    expect(codes(normalizeComplaint({ ...complaint('ACK-5'), addresses: ' ; ' }, NOW))).toEqual(['addresses:NO_IDENTIFIERS']);
  });

  it('rejects an invalid address with the reason, and does not accept the row', () => {
    const bad = 'TQzQZGrZNw3Ni27hRyCj6pjrKm9u2jkZ0M'; // contains 0
    const r = normalizeComplaint({ ...complaint('ACK-6'), addresses: [tronAddress('ok'), bad] }, NOW);
    expect(r.value).toBeUndefined();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ field: 'addresses[1]', code: 'INVALID_ADDRESS' });
    expect(r.errors[0].message).toMatch(/Base58 alphabet/);
  });

  it('rejects a bad hash, network, ack number and category length', () => {
    const r = normalizeComplaint({ ...complaint('AC'), network: 'SOLANA', txHashes: ['0x12'], category: 'x'.repeat(101) }, NOW);
    expect(codes(r)).toEqual(expect.arrayContaining(['ackNo:INVALID_ACK_NO', 'network:INVALID_NETWORK', 'txHashes[0]:INVALID_TX_HASH', 'category:TOO_LONG']));
  });

  it('rejects unreasonable dates', () => {
    expect(codes(normalizeComplaint(complaint('ACK-7', { reportedAt: '2027-01-01T00:00:00Z' }), NOW))).toEqual(['reportedAt:DATE_IN_FUTURE']);
    expect(codes(normalizeComplaint(complaint('ACK-7', { reportedAt: '2001-01-01T00:00:00Z' }), NOW))).toEqual(['reportedAt:DATE_TOO_OLD']);
    expect(codes(normalizeComplaint(complaint('ACK-7', { reportedAt: 'yesterday' }), NOW))).toEqual(['reportedAt:INVALID_DATE']);
    expect(codes(normalizeComplaint(complaint('ACK-7', { reportedAt: '31/02/2026' }), NOW))).toEqual(['reportedAt:INVALID_DATE']);
  });

  it('caps the number of addresses per complaint', () => {
    const many = Array.from({ length: 51 }, (_, i) => tronAddress(`m${i}`));
    expect(codes(normalizeComplaint({ ...complaint('ACK-8'), addresses: many }, NOW))).toEqual(['addresses:TOO_MANY']);
  });
});

describe('field parsers', () => {
  it('parses amounts as exact decimal strings, never floats', () => {
    expect(parseAmountInr('5,00,000.5')).toBe('500000.50');
    expect(parseAmountInr('₹ 1,234')).toBe('1234.00');
    expect(parseAmountInr('Rs. 10')).toBe('10.00');
    expect(parseAmountInr(45000.5)).toBe('45000.50');
    expect(parseAmountInr('0.10')).toBe('0.10');
    for (const bad of ['0', '-5', '1.234', 'abc', '1e6', '', '9'.repeat(19)]) expect(parseAmountInr(bad), bad).toBeNull();
  });

  it('parses dates: ISO offset, naive ISO and DD/MM/YYYY are IST; Z is UTC', () => {
    expect(parseReportedAt('2026-09-01T08:30:00Z')!.toISOString()).toBe('2026-09-01T08:30:00.000Z');
    expect(parseReportedAt('2026-09-01T08:30:00')!.toISOString()).toBe('2026-09-01T03:00:00.000Z');
    expect(parseReportedAt('2026-09-01')!.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(parseReportedAt('01/09/2026 08:30')!.toISOString()).toBe('2026-09-01T03:00:00.000Z');
    expect(parseReportedAt('1-9-2026')!.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(parseReportedAt('2026-09-01 08:30:00+05:30')!.toISOString()).toBe('2026-09-01T03:00:00.000Z');
  });

  it('splits cells on ; , | and newlines and drops empties', () => {
    expect(toList('a;b, c|d\ne;;')).toEqual(['a', 'b', ' c', 'd', 'e']);
    expect(toList(['a', '', ' '])).toEqual(['a']);
    expect(toList(undefined)).toEqual([]);
  });
});
