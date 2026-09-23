import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { IntegrationAdapter } from './types';
import type { SahyogSubmitResult } from './sahyogAdapter';
import type { NcrpSyncResult } from './ncrpNoticeAdapter';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

const submitBody = z.object({
  notice: z.record(z.unknown()),
});

export interface IntegrationServices {
  sahyog: IntegrationAdapter<Record<string, unknown>, SahyogSubmitResult>;
  ncrpNotice: IntegrationAdapter<Record<string, unknown>, NcrpSyncResult>;
}

/**
 * Direct adapter-invocation routes (distinct from freeze-notices' own `/send`, which calls the
 * SAHYOG adapter internally as part of the state machine). These exist for the plan's standalone
 * "POST /integrations/sahyog/submit" / "POST /integrations/ncrp/sync" contract, e.g. manual
 * resubmission/testing against the mock server without going through a FreezeNotice row.
 */
export function createIntegrationsRouter(services: IntegrationServices): Router {
  const r = Router();

  r.post(
    '/integrations/sahyog/submit',
    wrap(async (req, res) => {
      const body = submitBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'INVALID_BODY', message: body.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const result = await services.sahyog.submit(body.data.notice);
      res.status(201).json(result);
    }),
  );

  r.post(
    '/integrations/ncrp/sync',
    wrap(async (req, res) => {
      const body = submitBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'INVALID_BODY', message: body.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const result = await services.ncrpNotice.submit(body.data.notice);
      res.status(201).json(result);
    }),
  );

  return r;
}

export function integrationsErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  // Adapter failures (network/timeout/server error) are surfaced as a uniform 502 -- there is no
  // typed error hierarchy here (unlike reports/freeze-notices) because these are thin passthroughs
  // to createHttp, whose errors are plain axios errors.
  const message = err instanceof Error ? err.message : String(err);
  if (/ETIMEDOUT|timeout of \d+ms exceeded/i.test(message)) {
    res.status(504).json({ error: 'INTEGRATION_TIMEOUT', message });
    return;
  }
  if (/unexpected response shape/i.test(message)) {
    res.status(502).json({ error: 'INTEGRATION_BAD_RESPONSE', message });
    return;
  }
  next(err);
}
