import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AuthError } from './errors';
import { can, type Permission } from './permissions';
import type { AuthContext, TokenService } from './tokens';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** Requires `Authorization: Bearer <access token>`; attaches `req.auth`. Anything else is a 401 with a stable code. */
export function authenticate(tokens: TokenService): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const m = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!m) return next(new AuthError('TOKEN_MISSING', 'a Bearer access token is required'));
    try {
      req.auth = tokens.verifyAccess(m[1]);
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Route-level RBAC gate: 403 unless the authenticated role holds `permission`. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(new AuthError('TOKEN_MISSING', 'authentication required'));
    if (!can(req.auth.role, permission)) return next(new AuthError('FORBIDDEN', `role ${req.auth.role} is not permitted to perform ${permission}`));
    next();
  };
}

/** The authenticated user for handlers behind `authenticate` (the actor recorded in every audit entry). */
export function actor(req: Request): AuthContext {
  if (!req.auth) throw new AuthError('TOKEN_MISSING', 'authentication required');
  return req.auth;
}
