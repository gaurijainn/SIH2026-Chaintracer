import { describe, expect, it, vi } from 'vitest';
import { parseCsvSource, toImportCsv } from './csvCore';
import { parseCsvFile, type WorkerLike } from './parseCsv';
import { parsePastedAddresses } from './paste';
import { BTC_A, csvFile, ETH_A, HEADER, TRON_A, TRON_B } from './testData';

const NOW = new Date('2026-09-24T00:00:00Z');
const parse = (text: string) => parseCsvSource(text, undefined, NOW);
const row = (ack: string, addr: string, extra: Partial<Record<'date' | 'cat' | 'amt' | 'net', string>> = {}) =>
  `${ack},${extra.date ?? '2026-09-01'},${extra.cat ?? 'Investment fraud'},${extra.amt ?? '5000'},${extra.net ?? ''},${addr}`;

describe('CSV parsing and validation', () => {
  it('parses a valid CSV with chain detection and the TRON fast path', async () => {
    const r = await parse([HEADER, row('A-001', TRON_A), row('A-002', ETH_A, { net: 'ERC20' }), row('A-003', BTC_A)].join('\n'));
    expect(r.fileErrors).toEqual([]);
    expect(r.rows.map((x) => x.status)).toEqual(['valid', 'valid', 'valid']);
    expect(r.rows.map((x) => x.chains)).toEqual([['TRON'], ['ETH'], ['BTC']]);
    expect(r.rows.map((x) => x.tron)).toEqual([true, false, false]);
  });

  it('accepts backend header aliases and reports ignored columns', async () => {
    const r = await parse(`Acknowledgement Number,Date,Complaint Category,Amount,Wallet,Notes\nA-9,01/09/2026,Phishing,"1,500",${TRON_A},hello`);
    expect(r.rows[0].status).toBe('valid');
    expect(r.ignoredColumns).toEqual(['Notes']);
  });

  it('flags an ambiguous EVM address without a network (server would probe) but keeps it valid', async () => {
    const r = await parse([HEADER, row('A-1', ETH_A)].join('\n'));
    expect(r.rows[0].status).toBe('valid');
    expect(r.rows[0].chains).toEqual(['ETH', 'BSC', 'POLYGON']);
    expect(r.rows[0].warnings[0].code).toBe('AMBIGUOUS_CHAIN');
  });

  it('rejects the whole file when a required column is missing', async () => {
    const r = await parse('ackNo,category,amountInr,addresses\nA-1,x,10,' + TRON_A);
    expect(r.fileErrors[0]).toMatch(/Missing required column\(s\): reportedAt/);
    expect(r.rows).toEqual([]);
  });

  it('marks missing required fields per row', async () => {
    const r = await parse([HEADER, `A-1,,,,,${TRON_A}`].join('\n'));
    expect(r.rows[0].status).toBe('invalid');
    expect(r.rows[0].errors.map((e) => e.field)).toEqual(expect.arrayContaining(['reportedAt', 'category', 'amountInr']));
  });

  it('marks malformed addresses, unsupported chains, invalid dates and amounts', async () => {
    const r = await parse(
      [HEADER, row('A-1', 'TXnotanaddress'), row('A-2', TRON_A, { net: 'SOLANA' }), row('A-3', TRON_A, { date: '31/02/2026' }), row('A-4', TRON_A, { amt: '-5' }), row('A-5', TRON_A, { date: '2030-01-01' })].join('\n'),
    );
    const codes = r.rows.map((x) => x.errors.map((e) => e.code));
    expect(codes[0]).toContain('INVALID_ADDRESS');
    expect(codes[1]).toContain('INVALID_NETWORK');
    expect(codes[2]).toContain('INVALID_DATE');
    expect(codes[3]).toContain('INVALID_AMOUNT');
    expect(codes[4]).toContain('DATE_IN_FUTURE');
    expect(r.rows.every((x) => x.status === 'invalid')).toBe(true);
  });

  it('flags malformed rows (unquoted comma shifts the cells)', async () => {
    const r = await parse([HEADER, `A-1,2026-09-01,Fraud, crypto,5000,,${TRON_A}`].join('\n'));
    expect(r.rows[0].status).toBe('invalid');
    expect(r.rows[0].errors[0].code).toBe('MALFORMED_ROW');
  });

  it('reports an unclosed quote as a file-level error', async () => {
    const r = await parse([HEADER, row('A-1', TRON_A), `A-2,2026-09-01,"Fraud,5000,,${TRON_A}`, row('A-3', TRON_B)].join('\n'));
    expect(r.fileErrors.join(' ')).toMatch(/quoted value is not closed/);
  });

  it('detects duplicate rows and duplicate acknowledgement numbers, keeping the first', async () => {
    const same = row('A-1', TRON_A);
    const r = await parse([HEADER, same, same, row('A-1', TRON_B)].join('\n'));
    expect(r.rows.map((x) => x.status)).toEqual(['valid', 'duplicate', 'duplicate']);
    expect(r.rows[1].duplicate).toEqual({ ofRow: 1, identical: true });
    expect(r.rows[2].duplicate).toEqual({ ofRow: 1, identical: false });
    expect(r.rows.every((x) => x.linkedRows.length === 0)).toBe(true); // a duplicate is not a second complaint, so it links nothing
  });

  it('marks complaints sharing a wallet as linked, on both rows', async () => {
    const r = await parse([HEADER, row('A-1', TRON_A), row('A-2', TRON_A), row('A-3', TRON_B)].join('\n'));
    expect(r.rows[0].linkedRows).toEqual([2]);
    expect(r.rows[1].linkedRows).toEqual([1]);
    expect(r.rows[2].linkedRows).toEqual([]);
  });

  it('handles mixed valid and invalid rows and only re-serialises the valid ones', async () => {
    const r = await parse([HEADER, row('A-1', TRON_A), row('A-2', 'bad'), row('A-3', BTC_A)].join('\n'));
    expect(r.rows.map((x) => x.status)).toEqual(['valid', 'invalid', 'valid']);
    const csv = toImportCsv(r.rows.filter((x) => x.status === 'valid'));
    expect(csv.split('\n')).toHaveLength(3);
    expect(csv).toContain('A-1');
    expect(csv).not.toContain('A-2');
    expect(csv.split('\n')[0]).toBe('ackNo,reportedAt,category,amountInr,network,addresses,txHashes,tokenContract,firNumber');
  });

  it('reports an empty file and a header-only file', async () => {
    expect((await parse('')).fileErrors[0]).toMatch(/no data rows|no header/);
    expect((await parse(HEADER)).fileErrors[0]).toMatch(/no data rows/);
  });

  it('rejects files over the 25 MB API limit without reading them', async () => {
    const big = { size: 26 * 1048576, name: 'big.csv' } as File;
    expect((await parseCsvSource(big)).fileErrors[0]).toMatch(/25 MB/);
  });

  it('stops at the API row limit', async () => {
    const lines = [HEADER];
    for (let i = 0; i < 20_005; i++) lines.push(row(`A-${i}`, TRON_A));
    const r = await parse(lines.join('\n'));
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(20_000);
    // every row shares one wallet: linking stays capped (and fast) rather than quadratic
    expect(r.rows[19_999].linkedRows.length).toBeLessThanOrEqual(5);
    expect(r.rows[0].linkedRows.length).toBeGreaterThan(0);
  }, 15_000);
});

/** Stand-in for the real Worker: runs the same parse core, but strictly through the postMessage protocol. */
class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  terminated = false;
  postMessage(msg: unknown) {
    const { file } = msg as { file: File };
    void parseCsvSource(file, (progress) => this.onmessage?.({ data: { type: 'progress', progress } } as never), NOW).then((result) => this.onmessage?.({ data: { type: 'done', result } } as never));
  }
  terminate() {
    this.terminated = true;
  }
}

describe('Web Worker path', () => {
  it('parses a 5,000-row file through the worker protocol with progress', async () => {
    const lines = [HEADER];
    for (let i = 0; i < 5000; i++) lines.push(row(`A-${i}`, i % 2 ? TRON_A : ETH_A, { net: i % 2 ? '' : 'ERC20' }));
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const onProgress = vi.fn();
    const r = await parseCsvFile(csvFile(lines.join('\n')), onProgress, factory).promise;
    expect(factory).toHaveBeenCalledOnce();
    expect(r.rows).toHaveLength(5000);
    expect(r.rows.filter((x) => x.tron)).toHaveLength(2500);
    expect(onProgress).toHaveBeenCalled();
    expect(worker.terminated).toBe(true);
  });

  it('falls back to the main thread only when a Worker cannot be created', async () => {
    const r = await parseCsvFile(csvFile([HEADER, row('A-1', TRON_A)].join('\n')), undefined, () => null).promise;
    expect(r.rows).toHaveLength(1);
  });

  it('cancel terminates the worker', () => {
    const worker = new FakeWorker();
    parseCsvFile(csvFile(HEADER), undefined, () => worker).cancel();
    expect(worker.terminated).toBe(true);
  });
});

describe('pasted addresses', () => {
  it('reads one address per line, trims whitespace and ignores empty lines', () => {
    const { rows, summary } = parsePastedAddresses(`  ${TRON_A}  \n\n\t${BTC_A}\r\n   \n`, null);
    expect(rows.map((r) => r.raw)).toEqual([TRON_A, BTC_A]);
    expect(rows.map((r) => r.line)).toEqual([1, 3]);
    expect(summary).toMatchObject({ total: 2, valid: 2, invalid: 0, duplicate: 0, tron: 1 });
  });

  it('flags duplicates (EVM case-insensitively) and invalid entries without discarding them', () => {
    const { rows, summary } = parsePastedAddresses([TRON_A, TRON_A, ETH_A, ETH_A.toLowerCase(), 'nonsense', 'T123'].join('\n'), 'ERC20');
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.status)).toEqual(['valid', 'duplicate', 'valid', 'duplicate', 'invalid', 'invalid']);
    expect(rows[1].duplicateOfLine).toBe(1);
    expect(rows[4].error).toBeTruthy();
    expect(summary).toMatchObject({ total: 6, valid: 2, invalid: 2, duplicate: 2 });
  });

  it('does not guess the chain of an EVM address: asks for a network, or accepts server probing', () => {
    expect(parsePastedAddresses(ETH_A, null).rows[0].status).toBe('needs-chain');
    expect(parsePastedAddresses(ETH_A, 'BEP20').rows[0]).toMatchObject({ status: 'valid', chain: 'BSC' });
    expect(parsePastedAddresses(ETH_A, null, true).rows[0].status).toBe('valid');
  });

  it('handles an empty paste', () => {
    expect(parsePastedAddresses('  \n\n', null).summary.total).toBe(0);
  });
});
