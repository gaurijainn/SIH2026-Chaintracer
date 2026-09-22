import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { MuleService } from './service';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

const chainParam = z.enum(['TRON', 'ETH', 'BSC', 'POLYGON', 'BTC']);

/** B6 routes, mounted under /api/v1 (JWT + RBAC arrive with B10, same as intake). */
export function createMuleRouter(service: MuleService): Router {
  const r = Router();

  // POST /cases/:id/mule/analyze — runs B6 detection + GDS + cross-case linkage for one case (idempotent rerun).
  r.post(
    '/cases/:id/mule/analyze',
    wrap(async (req, res) => {
      const result = await service.analyzeCase(req.params.id);
      res.json({
        caseId: req.params.id,
        addresses: result.addresses,
        flags: result.flags,
        features: result.features,
        communities: result.communities,
        sharedMules: result.sharedMules,
      });
    }),
  );

  // GET /cases/:id/mule/flags — every fired rule (with evidence) for addresses touched by this case.
  r.get(
    '/cases/:id/mule/flags',
    wrap(async (req, res) => {
      res.json({ caseId: req.params.id, flags: await service.listFlagsForCase(req.params.id) });
    }),
  );

  // GET /cases/:id/mule/communities — WCC/Louvain membership and collector-wallet metrics for this case.
  r.get(
    '/cases/:id/mule/communities',
    wrap(async (req, res) => {
      res.json({ caseId: req.params.id, communities: await service.listCommunitiesForCase(req.params.id) });
    }),
  );

  // GET /addresses/:chain/:addr/shared-mule — cross-case (shared-mule candidate) linkage for one wallet.
  r.get(
    '/addresses/:chain/:addr/shared-mule',
    wrap(async (req, res) => {
      const chain = chainParam.safeParse(req.params.chain);
      if (!chain.success) {
        res.status(400).json({ error: 'INVALID_CHAIN', message: 'chain must be one of TRON, ETH, BSC, POLYGON, BTC' });
        return;
      }
      const flag = await service.getSharedMule(chain.data, req.params.addr);
      res.json({ chain: chain.data, addr: req.params.addr, sharedMule: flag ? { caseCount: flag.caseCount, caseIds: flag.caseIds } : null });
    }),
  );

  return r;
}

export function muleErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  console.error(err);
  res.status(500).json({ error: 'INTERNAL', message: 'unexpected error' });
}
