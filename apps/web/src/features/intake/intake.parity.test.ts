import { describe, expect, it } from 'vitest';
// The backend's own validators (pure functions; no DB or network is touched).
import { readComplaintCsv } from '../../../../api/src/intake/csv';
import { parseAmountInr as apiAmount, parseNetwork as apiNetwork, parseReportedAt as apiDate } from '../../../../api/src/intake/normalize';
import { Readable } from 'node:stream';
import { canonicalHeader, ALIASES } from './csvCore';
import { parseAmountInr, parseNetwork, parseReportedAt } from './rules';

describe('frontend intake rules stay identical to the API', () => {
  it('parses dates the same way', () => {
    for (const v of ['2026-09-01', '2026-09-01T08:30:00+05:30', '2026-09-01 08:30', '01/09/2026 08:30', '31/02/2026', '2026-13-01', 'yesterday', '', '2026-09-01T08:30Z']) {
      expect(parseReportedAt(v)?.toISOString() ?? null, v).toBe(apiDate(v)?.toISOString() ?? null);
    }
  });
  it('parses amounts the same way', () => {
    for (const v of ['1000', '₹1,25,000.50', 'Rs. 500', 'INR 12', '0', '-5', '12.345', 'abc', '', '99999999999999999999']) expect(parseAmountInr(v), v).toBe(apiAmount(v));
  });
  it('parses networks the same way', () => {
    for (const v of ['TRC20', 'trc-20', 'ERC20', 'BEP20', 'POLYGON', 'TRON', '', ' ']) expect(parseNetwork(v), v).toBe(apiNetwork(v));
  });
  it('maps every header alias to the same field as the API', async () => {
    for (const [alias, field] of Object.entries(ALIASES)) {
      const [row] = await readComplaintCsv(Readable.from([`ackNo,reportedAt,category,amountInr,${alias}\nA-1,2026-09-01,x,10,v\n`]));
      const key = Object.keys(row.raw ?? {}).find((k) => !['ackNo', 'reportedAt', 'category', 'amountInr'].includes(k)) ?? field;
      // when the alias is one of the required columns the API keeps the first; otherwise it must land on `field`
      expect(canonicalHeader(alias), alias).toBe(field);
      expect(['ackNo', 'reportedAt', 'category', 'amountInr'].includes(field) || key === field, alias).toBe(true);
    }
  });
});
