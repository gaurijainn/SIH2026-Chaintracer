import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { CaseNotFoundError, EvidenceNotFoundError, ReportGenerationError } from './errors';
import type { ReportService } from './service';
import { actor, requirePermission } from '../auth/middleware';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

const generateQuery = z.object({
  format: z.enum(['pdf', 'json']).default('json'),
});
// The actor is always the authenticated user; a client-supplied actor is never trusted, so the body carries nothing.
const generateBody = z.object({}).strict();

/** B9 report routes, mounted under /api/v1 behind authenticate + RBAC (B10). */
export function createReportRouter(service: ReportService): Router {
  const r = Router();

  // POST /cases/:id/reports?format=pdf|json
  r.post(
    '/cases/:id/reports',
    requirePermission('report:generate'),
    wrap(async (req, res) => {
      const query = generateQuery.safeParse(req.query);
      const body = generateBody.safeParse(req.body ?? {});
      if (!query.success || !body.success) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: [...(query.success ? [] : query.error.issues), ...(body.success ? [] : body.error.issues)].map((i) => i.message).join('; ') });
        return;
      }
      const result = await service.generate(req.params.id, { format: query.data.format, actorId: actor(req).userId });
      if (query.data.format === 'pdf' && result.pdfBuffer) {
        res.status(201).setHeader('Content-Type', 'application/pdf').setHeader('X-Report-Id', result.report.id).setHeader('X-Report-Sha256', result.report.sha256);
        res.send(result.pdfBuffer);
        return;
      }
      res.status(201).json({ report: result.report, evidence: result.json, integrity: result.integrity });
    }),
  );

  return r;
}

/**
 * GET /verify/:hash is deliberately PUBLIC (mounted before `authenticate`): the QR code on a PDF lets a court
 * or a VASP check that a report is authentic without an account. It only ever answers match/no-match plus the
 * report's own metadata, and it sits behind the API rate limiter.
 */
export function createVerifyRouter(service: ReportService): Router {
  const r = Router();
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
