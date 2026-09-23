import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { actor, requirePermission } from '../auth/middleware';
import type { VaspService } from './service';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

const vaspBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    type: z.enum(['CENTRALISED_EXCHANGE', 'INSTANT_SWAP', 'OTC', 'P2P']),
    jurisdiction: z.string().trim().min(1).max(100),
    fiuStatus: z.string().trim().min(1).max(64),
    fiuStatusDate: z.string().datetime().optional(),
    fiuSource: z.string().trim().min(1).max(500).optional(),
    contactEmail: z.string().trim().email().max(254).optional(),
    contactPortal: z.string().trim().url().max(500).optional(),
    hotWallets: z
      .array(
        z.object({
          chain: z.enum(['TRON', 'ETH', 'BSC', 'POLYGON', 'BTC']),
          addr: z.string().trim().min(1).max(128),
          source: z.string().trim().min(1).max(200),
          confidence: z.number().min(0).max(1),
        }),
      )
      .max(200)
      .optional(),
  })
  .strict();

/** VASP registry, mounted under /api/v1: any role reads, only Admin writes (audited by VaspService). */
export function createVaspRouter(service: VaspService): Router {
  const r = Router();

  r.get(
    '/vasps',
    requirePermission('vasp:read'),
    wrap(async (_req, res) => {
      res.json({ vasps: await service.list() });
    }),
  );

  r.post(
    '/vasps',
    requirePermission('vasp:write'),
    wrap(async (req, res) => {
      const body = vaspBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'INVALID_BODY', issues: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
        return;
      }
      res.status(201).json({ vasp: await service.upsert(body.data, actor(req).userId) });
    }),
  );

  return r;
}
