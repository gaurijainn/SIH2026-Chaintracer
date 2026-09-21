import { parse } from 'csv-parse';
import type { Readable } from 'node:stream';
import type { IngestInput } from './service';
import type { Issue, RawComplaint } from './types';

/** header aliases (matched after lower-casing and stripping non-alphanumerics) -> canonical field */
const ALIASES: Record<string, keyof RawComplaint> = {
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
export const REQUIRED_COLUMNS: (keyof RawComplaint)[] = ['ackNo', 'reportedAt', 'category', 'amountInr'];

export class CsvHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvHeaderError';
  }
}

const canonical = (h: string): string => {
  const key = h.replace(/[\u200B-\u200F\uFEFF]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ALIASES[key] ?? `_ignored_${key}`;
};

/**
 * Streams a CSV through csv-parse one record at a time (no full-file buffering in the parser) and maps it to
 * ingest inputs. Malformed records become per-row errors instead of aborting the file.
 * A missing required column fails the whole file with CsvHeaderError.
 */
export async function readComplaintCsv(stream: Readable, maxRows = 20_000): Promise<IngestInput[]> {
  const rows: IngestInput[] = [];
  let headerChecked = false;
  const parser = parse({
    columns: (header: string[]) => {
      const cols = header.map(canonical);
      const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c));
      if (missing.length) throw new CsvHeaderError(`missing required column(s): ${missing.join(', ')}`);
      headerChecked = true;
      return cols;
    },
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_records_with_error: true,
    info: true,
    on_skip: (err?: { message?: string; lines?: number }) => {
      const msg = err?.message ?? 'malformed CSV record';
      const issue: Issue = {
        field: 'row',
        code: 'MALFORMED_ROW',
        message: /Quote Not Closed/i.test(msg)
          ? `${msg}; this record and everything after it could not be read, fix the quote and re-import (rows already imported are skipped as duplicates)`
          : msg,
      };
      rows.push({ row: err?.lines ?? rows.length + 2, error: issue });
    },
  });
  stream.pipe(parser);
  try {
    for await (const { record, info } of parser as AsyncIterable<{ record: Record<string, string>; info: { lines: number } }>) {
      if (rows.length >= maxRows) throw new CsvHeaderError(`file exceeds ${maxRows} rows; split it into smaller files`);
      const raw: RawComplaint = {};
      for (const [k, v] of Object.entries(record)) if (!k.startsWith('_ignored_')) (raw as Record<string, unknown>)[k] = v;
      rows.push({ row: info.lines, raw });
    }
  } catch (e) {
    if (e instanceof CsvHeaderError) throw e;
    if (!headerChecked) throw new CsvHeaderError(e instanceof Error ? e.message : 'unreadable CSV');
    throw e;
  }
  return rows.sort((a, b) => a.row - b.row);
}
