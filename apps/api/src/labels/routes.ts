import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { actor, requirePermission } from '../auth/middleware';
import { InvalidLabelAddressError, LabelNotFoundError, LabelNotManualError, VaspNotFoundError, type LabelAdminService } from './service';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

const labelBody = z
  .object({
    chain: z.enum(['TRON', 'ETH', 'BSC', 'POLYGON', 'BTC']),
    addr: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(200),
    category: z.string().trim().min(1).max(64),
    confidence: z.number().min(0).max(1).optional(),
    evidence: z.record(z.unknown()).optional(),
    vaspId: z.string().trim().min(1).optional(),
  })
  .strict();

/** Manual label management, mounted under /api/v1. Every change is audited by LabelAdminService. */
export function createLabelRouter(service: LabelAdminService): Router {
  const r = Router();

  r.post(
    '/labels',
    requirePermission('label:write'),
    wrap(async (req, res) => {
      const body = labelBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'INVALID_BODY', issues: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
        return;
      }
      res.status(201).json({ label: await service.upsertManual(body.data, actor(req).userId) });
    }),
  );

  r.delete(
    '/labels/:id',
    requirePermission('label:write'),
    wrap(async (req, res) => {
      await service.remove(req.params.id, actor(req).userId);
      res.status(204).end();
    }),
  );

  return r;
}

export function labelErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err instanceof InvalidLabelAddressError) {
    res.status(400).json({ error: 'INVALID_ADDRESS', message: err.message, reasons: err.reasons });
    return;
  }
  if (err instanceof LabelNotFoundError) {
    res.status(404).json({ error: 'LABEL_NOT_FOUND', message: err.message });
    return;
  }
  if (err instanceof VaspNotFoundError) {
    res.status(404).json({ error: 'VASP_NOT_FOUND', message: err.message });
    return;
  }
  if (err instanceof LabelNotManualError) {
    res.status(409).json({ error: 'LABEL_NOT_MANUAL', message: err.message });
    return;
  }
  next(err);
}
