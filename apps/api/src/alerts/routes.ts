import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { AlertNotFoundError, InvalidAlertTransitionError } from './errors';
import type { AlertService } from './service';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

const listQuery = z.object({
  caseId: z.string().trim().min(1).optional(),
  severity: z.enum(['INFO', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  status: z.enum(['NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'SNOOZED']).optional(),
});
const patchBody = z.object({
  action: z.enum(['acknowledge', 'assign', 'snooze']),
  assigneeId: z.string().trim().min(1).optional(),
  snoozedUntil: z.string().trim().min(1).optional(),
});

/** B8/F7 routes, mounted under /api/v1 (JWT + RBAC land in B10 -- no auth yet, same as the other B8 routes). */
export function createAlertRouter(service: AlertService): Router {
  const r = Router();

  // GET /alerts?caseId=&severity=&status= -- list, filterable.
  r.get(
    '/alerts',
    wrap(async (req, res) => {
      const query = listQuery.safeParse(req.query);
      if (!query.success) {
        res.status(400).json({ error: 'INVALID_QUERY', message: query.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      res.json({ alerts: await service.list(query.data) });
    }),
  );

  // PATCH /alerts/:id -- acknowledge, assign, or snooze.
  r.patch(
    '/alerts/:id',
    wrap(async (req, res) => {
      const body = patchBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'INVALID_BODY', message: body.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const alert = await service.update(req.params.id, body.data);
      res.json({ alert });
    }),
  );

  return r;
}

// Same "recognise or pass on" convention as watchlistErrorHandler -- see its comment.
export function alertErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err instanceof AlertNotFoundError) {
    res.status(404).json({ error: 'ALERT_NOT_FOUND', message: err.message });
    return;
  }
  if (err instanceof InvalidAlertTransitionError) {
    res.status(400).json({ error: 'INVALID_TRANSITION', message: err.message });
    return;
  }
  next(err);
}
