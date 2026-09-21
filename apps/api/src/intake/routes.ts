import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { CsvHeaderError, readComplaintCsv } from './csv';
import type { IntakeService } from './service';

const scalar = z.union([z.string(), z.number()]).nullable().optional();
const list = z.union([z.string(), z.array(z.string())]).nullable().optional();
export const complaintBody = z
  .object({
    ackNo: scalar,
    reportedAt: scalar,
    category: scalar,
    amountInr: scalar,
    network: scalar,
    addresses: list,
    txHashes: list,
    tokenContract: scalar,
    firNumber: scalar,
  })
  .strict();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  ackNo: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  chain: z.enum(['TRON', 'ETH', 'BSC', 'POLYGON', 'BTC']).optional(),
  caseId: z.string().trim().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const MAX_CSV_BYTES = 25 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CSV_BYTES, files: 1 } });

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

/** Intake routes, mounted under /api/v1. (JWT + RBAC arrive with B10; these are not authenticated yet.) */
export function createIntakeRouter(service: IntakeService): Router {
  const r = Router();

  // POST /complaints: one complaint as JSON
  r.post(
    '/complaints',
    wrap(async (req, res) => {
      const parsed = complaintBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'INVALID_BODY', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
        return;
      }
      const { rows, summary } = await service.ingest([{ row: 1, raw: parsed.data }]);
      const row = rows[0];
      res.status(row.status === 'CREATED' ? 201 : row.status === 'DUPLICATE' ? 200 : 422).json({ complaint: row, summary });
    }),
  );

  // POST /complaints/import: CSV as multipart (field "file") or a raw text/csv body, streamed through csv-parse
  r.post(
    '/complaints/import',
    (req, res, next) => (req.is('multipart/form-data') ? upload.single('file')(req, res, next) : next()),
    wrap(async (req, res) => {
      let stream: Readable;
      if (req.is('multipart/form-data')) {
        if (!req.file) {
          res.status(400).json({ error: 'NO_FILE', message: 'send the CSV as multipart field "file"' });
          return;
        }
        stream = Readable.from(req.file.buffer);
      } else if (req.is(['text/csv', 'text/plain', 'application/csv'])) {
        stream = req;
      } else {
        res.status(415).json({ error: 'UNSUPPORTED_MEDIA_TYPE', message: 'send multipart/form-data (field "file") or text/csv' });
        return;
      }
      let inputs;
      try {
        inputs = await readComplaintCsv(stream);
      } catch (e) {
        if (e instanceof CsvHeaderError) {
          res.status(400).json({ error: 'INVALID_CSV', message: e.message });
          return;
        }
        throw e;
      }
      if (inputs.length === 0) {
        res.status(400).json({ error: 'EMPTY_CSV', message: 'no data rows found' });
        return;
      }
      const result = await service.ingest(inputs);
      const onlyErrors = req.query.report === 'errors';
      res.json({ summary: result.summary, rows: onlyErrors ? result.rows.filter((x) => x.status !== 'CREATED') : result.rows });
    }),
  );

  // GET /complaints: list and filter
  r.get(
    '/complaints',
    wrap(async (req, res) => {
      const q = listQuery.safeParse(req.query);
      if (!q.success) {
        res.status(400).json({ error: 'INVALID_QUERY', issues: q.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
        return;
      }
      res.json(await service.list(q.data));
    }),
  );

  return r;
}

export function intakeErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof SyntaxError && 'body' in (err as object)) {
    res.status(400).json({ error: 'INVALID_JSON', message: 'request body is not valid JSON' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'INTERNAL', message: 'unexpected error' });
}

