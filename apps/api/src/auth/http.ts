import cors from 'cors';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { SecurityConfig } from './config';
import { AuthError, PiiDecryptionError } from './errors';
import type { AuthService } from './service';
import type { TokenService } from './tokens';

/** Everything createApp needs to secure /api/v1. */
export interface AppSecurity {
  config: Pick<SecurityConfig, 'corsOrigins' | 'rateLimit'>;
  tokens: TokenService;
  auth: AuthService;
}

/** CORS allowlist: only configured origins get `Access-Control-Allow-Origin`; no wildcard, no credentials. */
export function corsAllowlist(origins: string[]): RequestHandler {
  const allowed = new Set(origins);
  return cors({
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
}

const tooMany = (_req: Request, res: Response) => void res.status(429).json({ error: 'RATE_LIMITED', message: 'too many requests; retry later' });

/** General per-IP limiter for the whole API. Set RATE_LIMIT_MAX high for load tests only. */
export function apiRateLimiter(c: SecurityConfig['rateLimit']): RequestHandler {
  return rateLimit({ windowMs: c.windowS * 1000, limit: c.max, standardHeaders: 'draft-7', legacyHeaders: false, handler: tooMany });
}

/** Tight limiter for credential endpoints; successful logins don't consume the budget, failures do. */
export function authRateLimiter(c: SecurityConfig['rateLimit']): RequestHandler {
  return rateLimit({ windowMs: c.windowS * 1000, limit: c.authMax, standardHeaders: 'draft-7', legacyHeaders: false, skipSuccessfulRequests: true, handler: tooMany });
}

/** Maps auth errors and low-level body-parsing failures to clean 4xx JSON. Registered before the module handlers. */
export function httpErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err instanceof AuthError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof PiiDecryptionError) {
    console.error(err);
    res.status(500).json({ error: 'INTERNAL', message: 'unexpected error' });
    return;
  }
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'request body is too large' });
    return;
  }
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'INVALID_JSON', message: 'request body is not valid JSON' });
    return;
  }
  if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500 && typeof e.type === 'string') {
    res.status(e.status).json({ error: 'BAD_REQUEST', message: 'request could not be processed' });
    return;
  }
  next(err);
}

/** JSON 404 for anything under /api/v1 that no router handled (after auth, so unauthenticated probes see 401 first). */
export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'NOT_FOUND', message: 'no such route' });
}
