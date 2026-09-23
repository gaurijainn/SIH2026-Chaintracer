import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { AuthService } from './service';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

const loginBody = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(256) }).strict();
const refreshBody = z.object({ refreshToken: z.string().trim().min(1).max(4096) }).strict();

const invalid = (res: Response, error: z.ZodError) =>
  res.status(400).json({ error: 'INVALID_BODY', issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });

/** Public auth routes (mounted before `authenticate`). `limiter` throttles credential guessing. */
export function createAuthRouter(service: AuthService, limiter: RequestHandler): Router {
  const r = Router();

  r.post(
    '/auth/login',
    limiter,
    wrap(async (req, res) => {
      const body = loginBody.safeParse(req.body);
      if (!body.success) return void invalid(res, body.error);
      res.json(await service.login(body.data.email, body.data.password));
    }),
  );

  r.post(
    '/auth/refresh',
    limiter,
    wrap(async (req, res) => {
      const body = refreshBody.safeParse(req.body);
      if (!body.success) return void invalid(res, body.error);
      res.json(await service.refresh(body.data.refreshToken));
    }),
  );

  r.post(
    '/auth/logout',
    limiter,
    wrap(async (req, res) => {
      const body = refreshBody.safeParse(req.body);
      if (!body.success) return void invalid(res, body.error);
      await service.logout(body.data.refreshToken);
      res.status(204).end();
    }),
  );

  return r;
}
