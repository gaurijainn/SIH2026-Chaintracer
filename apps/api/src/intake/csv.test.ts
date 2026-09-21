import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CsvHeaderError, readComplaintCsv } from './csv';
import { normalizeComplaint } from './normalize';
import { createProbeRunner } from './probe';
import { resolveEntries } from './resolve';
import { evmAddress, tronAddress } from './testutil';

const read = (text: string) => readComplaintCsv(Readable.from([Buffer.from(text)]));
const HEADER = 'ack_no,reported_at,category,amount_inr,network,addresses,tx_hashes,token_contract,fir_number';

describe('CSV reader', () => {
  it('maps header aliases, handles a BOM, quoted multi-value cells and blank lines', async () => {
    const a = tronAddress('c1');
    const b = tronAddress('c2');
    const rows = await read(`\uFEFFAck No,Date,Complaint Category,Amount,Network,Wallet Addresses\n\nCSV-1,2026-09-01,Phishing,"1,00,000",TRC20,"${a};${b}"\n`);
    expect(rows).toHaveLength(1);
    expect(rows[0].raw).toMatchObject({ ackNo: 'CSV-1', reportedAt: '2026-09-01', category: 'Phishing', amountInr: '1,00,000', network: 'TRC20', addresses: `${a};${b}` });
    expect(rows[0].row).toBe(3);
  });

  it('reports the source line number of every record', async () => {
    const rows = await read(`${HEADER}\nA-1,2026-09-01,x,1,,${tronAddress('l1')},,,\nA-2,2026-09-01,x,1,,${tronAddress('l2')},,,\n`);
    expect(rows.map((r) => r.row)).toEqual([2, 3]);
  });

  it('fails the whole file when a required column is missing', async () => {
    await expect(read('ack_no,category\nA-1,x\n')).rejects.toThrow(CsvHeaderError);
    await expect(read('ack_no,category\nA-1,x\n')).rejects.toThrow(/reportedAt, amountInr/);
  });

  it('ignores unknown columns', async () => {
    const rows = await read(`${HEADER},victim_name\nA-1,2026-09-01,x,1,,${tronAddress('u')},,,,Someone\n`);
    expect(rows[0].raw).not.toHaveProperty('victim_name');
    expect(Object.keys(rows[0].raw!).some((k) => k.startsWith('_ignored'))).toBe(false);
  });

  it('keeps reading after a stray quote inside a field (validation decides), so no row is silently lost', async () => {
    const good = `A-9,2026-09-01,x,1,,${tronAddress('g')},,,`;
    const rows = await read(`${HEADER}\n${good}\nA-10,2026-09-01,"bad"quote,1,,${tronAddress('h')},,,\n${good.replace('A-9', 'A-11')}\n`);
    expect(rows.map((r) => r.raw?.ackNo)).toEqual(['A-9', 'A-10', 'A-11']);
  });

  it('reports an unclosed quote as a per-row error, keeps the rows before it, and says the rest was unreadable', async () => {
    const good = `A-9,2026-09-01,x,1,,${tronAddress('g')},,,`;
    const rows = await read(`${HEADER}\n${good}\nA-10,2026-09-01,"unclosed,1,,${tronAddress('h')},,,\n${good.replace('A-9', 'A-11')}\n`);
    expect(rows[0].raw?.ackNo).toBe('A-9');
    const err = rows.find((r) => r.error);
    expect(err?.error).toMatchObject({ code: 'MALFORMED_ROW' });
    expect(err?.error?.message).toMatch(/everything after it could not be read/);
    expect(err?.row).toBe(4);
  });

  it('returns nothing for a header-only file', async () => {
    expect(await read(`${HEADER}\n`)).toEqual([]);
  });
});

describe('1,000-row CSV', () => {
  it('validates in under 2 seconds with a per-row error report', async () => {
    const lines = [HEADER];
    const badRows = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const bad = i % 20 === 7; // 50 rows with a corrupt address
      const addr = bad ? `${tronAddress(`p${i}`).slice(0, 33)}0` : i % 10 === 3 ? evmAddress(`p${i}`) : tronAddress(`p${i}`);
      // a few rows carry a bad amount too
      lines.push(`PERF-${i},2026-09-01T10:00:00+05:30,Investment fraud,${i % 97 === 5 ? 'abc' : 100000 + i},${addr.startsWith('0x') ? 'ERC20' : 'TRC20'},${addr},,,`);
      if (bad || i % 97 === 5) badRows.add(i + 2);
    }
    const t0 = performance.now();
    const inputs = await read(lines.join('\n'));
    const runner = createProbeRunner(null);
    const results = await Promise.all(
      inputs.map(async (inp) => {
        const n = normalizeComplaint(inp.raw!, new Date('2026-09-20T00:00:00Z'));
        if (n.value) await resolveEntries(n.value, runner);
        return { row: inp.row, ok: !!n.value, errors: n.errors };
      }),
    );
    const ms = performance.now() - t0;

    expect(inputs).toHaveLength(1000);
    expect(ms).toBeLessThan(2000);
    const failed = results.filter((r) => !r.ok);
    expect(new Set(failed.map((r) => r.row))).toEqual(badRows); // every bad row reported, with its line number
    expect(failed.every((r) => r.errors.length > 0)).toBe(true);
    expect(results.filter((r) => r.ok)).toHaveLength(1000 - badRows.size);
    console.log(`1,000-row CSV parsed + validated + chain-tagged in ${ms.toFixed(0)} ms`);
  });
});
