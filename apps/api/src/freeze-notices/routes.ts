import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { AlertNotFoundError, CaseNotFoundError, FreezeNoticeNotFoundError, InvalidNoticeTransitionError, VaspNotFoundError } from './errors';
import type { FreezeNoticeService } from './service';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

const draftBody = z.object({
  vaspId: z.string().trim().min(1),
  alertId: z.string().trim().min(1).optional(),
  actorId: z.string().trim().min(1).optional(),
});
const editBody = z.object({
  legalProvision: z.string().optional(),
  body: z.record(z.unknown()).optional(),
  actorId: z.string().trim().min(1).optional(),
});
const approveBody = z.object({
  approvedById: z.string().trim().min(1).optional(),
  actorId: z.string().trim().min(1).optional(),
});
const sendBody = z.object({
  actorId: z.string().trim().min(1).optional(),
});

/** B9 freeze-notice routes, mounted under /api/v1 (no auth yet -- same convention as other B8/B9 routes). */
export function createFreezeNoticeRouter(service: FreezeNoticeService): Router {
  const r = Router();

  r.post(
    '/cases/:id/freeze-notices',
    wrap(async (req, res) => {
      const body = draftBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'INVALID_BODY', message: body.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const notice = await service.draft(req.params.id, body.data);
      res.status(201).json({ freezeNotice: notice });
    }),
  );

  r.patch(
    '/freeze-notices/:id',
    wrap(async (req, res) => {
      const body = editBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'INVALID_BODY', message: body.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const notice = await service.edit(req.params.id, { legalProvision: body.data.legalProvision, body: body.data.body }, body.data.actorId);
      res.json({ freezeNotice: notice });
    }),
  );

  r.post(
    '/freeze-notices/:id/submit',
    wrap(async (req, res) => {
      const notice = await service.submitForApproval(req.params.id);
      res.json({ freezeNotice: notice });
    }),
  );

  r.post(
    '/freeze-notices/:id/approve',
    wrap(async (req, res) => {
      const body = approveBody.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: 'INVALID_BODY', message: body.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const notice = await service.approve(req.params.id, { approvedById: body.data.approvedById }, body.data.actorId);
      res.json({ freezeNotice: notice });
    }),
  );

  r.post(
    '/freeze-notices/:id/send',
    wrap(async (req, res) => {
      const body = sendBody.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: 'INVALID_BODY', message: body.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const notice = await service.send(req.params.id, body.data.actorId);
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
