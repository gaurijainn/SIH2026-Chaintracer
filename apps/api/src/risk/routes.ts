import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { MlHttpError, MlResponseError, MlTimeoutError, MlUnavailableError, RiskPersistError, TraceNotFoundError, UnsupportedChainError } from './errors';
import type { RiskService } from './service';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

const chainParam = z.enum(['TRON', 'ETH', 'BSC', 'POLYGON', 'BTC']);
const addrParam = z.string().trim().min(1);
const riskQuery = z.object({ traceId: z.string().trim().min(1).optional() });

/** B7.6 route, mounted under /api/v1 (JWT + RBAC land in B10, same as intake/mule -- no auth yet). */
export function createRiskRouter(service: RiskService): Router {
  const r = Router();

  // GET /addresses/:chain/:addr/risk?traceId=<optional> — assembles B6 features, calls the B7.5 ML
  // service for score/band/SHAP factors + typology, persists an append-only RiskScore row.
  r.get(
    '/addresses/:chain/:addr/risk',
    wrap(async (req, res) => {
      const chain = chainParam.safeParse(req.params.chain);
      if (!chain.success) {
        res.status(400).json({ error: 'INVALID_CHAIN', message: 'chain must be one of TRON, ETH, BSC, POLYGON, BTC' });
        return;
      }
      const addr = addrParam.safeParse(req.params.addr);
      if (!addr.success) {
        res.status(400).json({ error: 'INVALID_ADDR', message: 'addr must be a non-empty string' });
        return;
      }
      const query = riskQuery.safeParse(req.query);
      if (!query.success) {
        res.status(400).json({ error: 'INVALID_QUERY', message: 'traceId must be a non-empty string when present' });
        return;
      }

      const result = await service.getAddressRisk(chain.data, addr.data, query.data.traceId);
      res.json({
        chain: result.chain,
        addr: result.addr,
        score: result.score,
        band: result.band,
        factors: result.factors,
        overrides: result.overrides,
        typology: result.typology,
        typologyConfidence: result.typologyConfidence,
        modelVersion: result.modelVersion,
        traceId: result.traceId,
        createdAt: result.createdAt,
      });
    }),
  );

  return r;
}

/**
 * Standard `{ error, message }` shape (matches intake/muleErrorHandler). Status choices:
 * - 400 INVALID_CHAIN / INVALID_ADDR / INVALID_QUERY / UNSUPPORTED_CHAIN: bad client input (the
 *   requested chain has no trained model at all -- a client error, not a server one).
 * - 404 TRACE_NOT_FOUND: `traceId` was supplied but does not exist (context the caller asked for
 *   is missing, distinct from "chain/addr malformed").
 * - 504 ML_TIMEOUT: the ML service didn't respond in time. Chosen over 503 because the Node
 *   service *did* reach it and the request *is* in flight upstream -- 504 (Gateway Timeout) is the
 *   more specific signal that this is a slow/stuck dependency, not an absent one.
 * - 503 ML_UNAVAILABLE: the ML service could not be reached at all (connection refused/DNS/etc) --
 *   the dependency itself is down.
 * - 502 ML_BAD_RESPONSE: the ML service replied with a non-2xx status, or 2xx with a body that
 *   fails our response-shape validation -- in both cases Node received a reply it cannot trust,
 *   which is exactly what 502 (Bad Gateway) means for a proxying service.
 * - 500 INTERNAL: RiskScore persistence failed, or anything unanticipated. Logged; generic message
 *   only, never leaking internals to the client.
 */
export function riskErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);

  if (err instanceof UnsupportedChainError) {
    res.status(400).json({ error: 'UNSUPPORTED_CHAIN', message: err.message });
    return;
  }
  if (err instanceof TraceNotFoundError) {
    res.status(404).json({ error: 'TRACE_NOT_FOUND', message: err.message });
    return;
  }
  if (err instanceof MlTimeoutError) {
    res.status(504).json({ error: 'ML_TIMEOUT', message: 'ML service did not respond in time' });
    return;
  }
  if (err instanceof MlUnavailableError) {
    res.status(503).json({ error: 'ML_UNAVAILABLE', message: 'ML service is unreachable' });
    return;
  }
  if (err instanceof MlHttpError || err instanceof MlResponseError) {
    res.status(502).json({ error: 'ML_BAD_RESPONSE', message: 'ML service returned an unexpected response' });
    return;
  }
  if (err instanceof RiskPersistError) {
    console.error(err);
    res.status(500).json({ error: 'PERSIST_FAILED', message: 'failed to save the risk score' });
    return;
  }

  console.error(err);
  res.status(500).json({ error: 'INTERNAL', message: 'unexpected error' });
}
