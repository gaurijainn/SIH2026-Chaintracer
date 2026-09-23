import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { CaseNotFoundError, EvidenceNotFoundError, ReportGenerationError } from './errors';
import type { ReportService } from './service';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

const generateQuery = z.object({
  format: z.enum(['pdf', 'json']).default('json'),
});
const generateBody = z.object({
  actorId: z.string().trim().min(1).optional(),
});

/** B9 routes, mounted under /api/v1 (no auth yet -- see other B8/B9 modules' routes.ts). */
export function createReportRouter(service: ReportService): Router {
  const r = Router();

  // POST /cases/:id/reports?format=pdf|json
  r.post(
    '/cases/:id/reports',
    wrap(async (req, res) => {
      const query = generateQuery.safeParse(req.query);
      const body = generateBody.safeParse(req.body ?? {});
      if (!query.success || !body.success) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: [...(query.success ? [] : query.error.issues), ...(body.success ? [] : body.error.issues)].map((i) => i.message).join('; ') });
        return;
      }
      const result = await service.generate(req.params.id, { format: query.data.format, actorId: body.data.actorId });
      if (query.data.format === 'pdf' && result.pdfBuffer) {
        res.status(201).setHeader('Content-Type', 'application/pdf').setHeader('X-Report-Id', result.report.id).setHeader('X-Report-Sha256', result.report.sha256);
        res.send(result.pdfBuffer);
        return;
      }
      res.status(201).json({ report: result.report, evidence: result.json });
    }),
  );

  // GET /verify/:hash
  r.get(
    '/verify/:hash',
    wrap(async (req, res) => {
      const result = await service.verify(req.params.hash);
      res.json(result);
    }),
  );

  return r;
}

export function reportErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err instanceof CaseNotFoundError) {
    res.status(404).json({ error: 'CASE_NOT_FOUND', message: err.message });
    return;
  }
  if (err instanceof EvidenceNotFoundError) {
    res.status(404).json({ error: 'EVIDENCE_NOT_FOUND', message: err.message });
    return;
  }
  if (err instanceof ReportGenerationError) {
    res.status(500).json({ error: 'REPORT_GENERATION_FAILED', message: err.message });
    return;
  }
  next(err);
}
