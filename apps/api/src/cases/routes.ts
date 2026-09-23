import { Router, type NextFunction, type Request, type Response } from 'express';
import { actor, requirePermission } from '../auth/middleware';
import { CaseNotFoundError } from './errors';
import type { CaseService } from './service';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

/** B10 case-detail route (the audited "case view"), mounted under /api/v1. */
export function createCaseRouter(service: CaseService): Router {
  const r = Router();

  r.get(
    '/cases/:id',
    requirePermission('case:read'),
    wrap(async (req, res) => {
      res.json({ case: await service.view(req.params.id, actor(req).userId) });
    }),
  );

  return r;
}

export function caseErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err instanceof CaseNotFoundError) {
    res.status(404).json({ error: 'CASE_NOT_FOUND', message: err.message });
    return;
  }
  next(err);
}
