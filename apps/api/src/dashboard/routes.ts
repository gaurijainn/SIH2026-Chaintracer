import { Router, type NextFunction, type Request, type Response } from 'express';
import { requirePermission } from '../auth/middleware';
import type { DashboardService } from './service';

/**
 * GET /api/v1/dashboard/summary, mounted behind `authenticate`. Reuses `case:read` (every role holds it, per the B10
 * matrix): the numbers are aggregates over cases. Unlike GET /cases/:id this records no audit entry, since it names no case.
 */
export function createDashboardRouter(service: DashboardService): Router {
  const r = Router();
  r.get(
    '/dashboard/summary',
    requirePermission('case:read'),
    (_req: Request, res: Response, next: NextFunction) => {
      service.summary().then((summary) => res.json(summary), next);
    },
  );
  return r;
}
