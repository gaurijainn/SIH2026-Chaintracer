import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { AlertNotFoundError, CaseNotFoundError, FreezeNoticeNotFoundError, InvalidNoticeTransitionError, VaspNotFoundError } from './errors';
import type { FreezeNoticeService } from './service';
import { actor, requirePermission } from '../auth/middleware';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

const draftBody = z
  .object({
    vaspId: z.string().trim().min(1),
    alertId: z.string().trim().min(1).optional(),
  })
  .strict();
const editBody = z
  .object({
    legalProvision: z.string().max(5000).optional(),
    body: z.record(z.unknown()).optional(),
  })
  .strict();
// Approver/actor identity always comes from the authenticated user, never from the body.
const emptyBody = z.object({}).strict();

/** B9 freeze-notice routes, mounted under /api/v1 behind authenticate + RBAC (B10): drafting = Investigator+, approve/send = Supervisor. */
export function createFreezeNoticeRouter(service: FreezeNoticeService): Router {
  const r = Router();

  r.post(
    '/cases/:id/freeze-notices',
    requirePermission('notice:draft'),
    wrap(async (req, res) => {
      const body = draftBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'INVALID_BODY', message: body.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const notice = await service.draft(req.params.id, { ...body.data, actorId: actor(req).userId });
      res.status(201).json({ freezeNotice: notice });
    }),
  );

  r.patch(
    '/freeze-notices/:id',
    requirePermission('notice:draft'),
    wrap(async (req, res) => {
      const body = editBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'INVALID_BODY', message: body.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const notice = await service.edit(req.params.id, { legalProvision: body.data.legalProvision, body: body.data.body }, actor(req).userId);
      res.json({ freezeNotice: notice });
    }),
  );

  r.post(
    '/freeze-notices/:id/submit',
    requirePermission('notice:draft'),
    wrap(async (req, res) => {
      if (!emptyBody.safeParse(req.body ?? {}).success) {
        res.status(400).json({ error: 'INVALID_BODY', message: 'this endpoint takes no request body' });
        return;
      }
      const notice = await service.submitForApproval(req.params.id, actor(req).userId);
      res.json({ freezeNotice: notice });
    }),
  );

  r.post(
    '/freeze-notices/:id/approve',
    requirePermission('notice:approve'),
    wrap(async (req, res) => {
      const body = emptyBody.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: 'INVALID_BODY', message: body.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const notice = await service.approve(req.params.id, { approvedById: actor(req).userId }, actor(req).userId);
      res.json({ freezeNotice: notice });
    }),
  );

  r.post(
    '/freeze-notices/:id/send',
    requirePermission('notice:send'),
    wrap(async (req, res) => {
      const body = emptyBody.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: 'INVALID_BODY', message: body.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const notice = await service.send(req.params.id, actor(req).userId);
      res.json({ freezeNotice: notice });
    }),
  );

  return r;
}

export function freezeNoticeErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err instanceof FreezeNoticeNotFoundError || err instanceof CaseNotFoundError || err instanceof VaspNotFoundError || err instanceof AlertNotFoundError) {
    res.status(404).json({ error: 'NOT_FOUND', message: err.message });
    return;
  }
  if (err instanceof InvalidNoticeTransitionError) {
    res.status(400).json({ error: 'INVALID_TRANSITION', message: err.message });
    return;
  }
  next(err);
}
