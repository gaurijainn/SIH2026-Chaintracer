import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { InvalidAddressError, WatchlistNotFoundError } from './errors';
import type { WatchlistService } from './service';
import { actor, requirePermission } from '../auth/middleware';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

const chainEnum = z.enum(['TRON', 'ETH', 'BSC', 'POLYGON', 'BTC']);
const createBody = z.object({
  caseId: z.string().trim().min(1),
  chain: chainEnum,
  addr: z.string().trim().min(1),
  reason: z.string().trim().min(1).optional(),
  tier: z.enum(['HOT', 'WARM', 'COLD']).optional(),
}).strict();
const listQuery = z.object({ caseId: z.string().trim().min(1).optional() });

/** B8/F4 routes, mounted under /api/v1 (behind authenticate + per-route RBAC, B10; the actor is the authenticated user). */
export function createWatchlistRouter(service: WatchlistService): Router {
  const r = Router();

  // GET /watchlist?caseId=<optional> -- every monitored address, optionally scoped to one case.
  r.get(
    '/watchlist',
    requirePermission('watchlist:read'),
    wrap(async (req, res) => {
      const query = listQuery.safeParse(req.query);
      if (!query.success) {
        res.status(400).json({ error: 'INVALID_QUERY', message: 'caseId must be a non-empty string when present' });
        return;
      }
      res.json({ items: await service.list(query.data.caseId) });
    }),
  );

  // POST /watchlist -- add an address to a case's watchlist (idempotent; manual add, distinct from
  // the automatic B4 'frontier' / B6 'mule' population).
  r.post(
    '/watchlist',
    requirePermission('watchlist:write'),
    wrap(async (req, res) => {
      const body = createBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'INVALID_BODY', message: body.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const item = await service.create({ ...body.data, addedById: actor(req).userId });
      res.status(201).json({ item });
    }),
  );

  // DELETE /watchlist/:id -- stop monitoring one address for one case.
  r.delete(
    '/watchlist/:id',
    requirePermission('watchlist:write'),
    wrap(async (req, res) => {
      await service.remove(req.params.id);
      res.status(204).end();
    }),
  );

  return r;
}

// Only handles the error types it recognises; anything else is passed on with next(err) so it still
// reaches a later, more general handler (riskErrorHandler / intake / muleErrorHandler in app.ts) --
// unlike those unconditional-500 handlers, this one must not swallow errors it doesn't own, since it
// is registered ahead of them.
export function watchlistErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err instanceof InvalidAddressError) {
    res.status(400).json({ error: 'INVALID_ADDRESS', message: err.message, reasons: err.reasons });
    return;
  }
  if (err instanceof WatchlistNotFoundError) {
    res.status(404).json({ error: 'WATCHLIST_ITEM_NOT_FOUND', message: err.message });
    return;
  }
  next(err);
}
