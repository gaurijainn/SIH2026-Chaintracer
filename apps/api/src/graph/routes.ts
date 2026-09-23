import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { requirePermission } from '../auth/middleware';
import { TraceNotFoundError, type TraceGraphService } from './service';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

const graphQuery = z.object({
  chain: z.enum(['TRON', 'ETH', 'BSC', 'POLYGON', 'BTC']).optional(),
  minValueUsd: z.coerce.number().min(0).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export function createGraphRouter(service: TraceGraphService): Router {
  const r = Router();

  r.get(
    '/traces/:id/graph',
    requirePermission('graph:read'),
    wrap(async (req, res) => {
      const q = graphQuery.safeParse(req.query);
      if (!q.success) {
        res.status(400).json({ error: 'INVALID_QUERY', issues: q.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
        return;
      }
      res.json(await service.graph(req.params.id, q.data));
    }),
  );

  return r;
}

export function graphErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err instanceof TraceNotFoundError) {
    res.status(404).json({ error: 'TRACE_NOT_FOUND', message: err.message });
    return;
  }
  next(err);
}
