import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { JWT_ISSUER } from '@ps26183/shared';
import jwt from 'jsonwebtoken';
import { AuthError } from './errors';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

/** What `authenticate` attaches to `req.auth`. */
export interface AuthContext {
  userId: string;
  email: string;
  role: Role;
}

const ISSUER = JWT_ISSUER;
const ROLES: readonly string[] = ['INVESTIGATOR', 'SUPERVISOR', 'ADMIN', 'VIEWER'];

export interface TokenServiceOptions {
  secret: string;
  accessTtlS: number;
  refreshTtlS: number;
}

/**
 * Signs/verifies the two JWT kinds. Both are HS256 (algorithm pinned on verify -- no `alg: none` /
 * key-confusion), carry an issuer, and are told apart by audience so a refresh token can never be used
 * as an access token or vice versa. Refresh tokens carry a `jti`; only its SHA-256 is ever stored.
 */
export class TokenService {
  constructor(private readonly opts: TokenServiceOptions) {}

  get accessTtlS(): number {
    return this.opts.accessTtlS;
  }

  signAccess(user: AuthUser): string {
    return jwt.sign({ email: user.email, role: user.role }, this.opts.secret, {
      algorithm: 'HS256',
      issuer: ISSUER,
      audience: 'access',
      subject: user.id,
      expiresIn: this.opts.accessTtlS,
    });
  }

  signRefresh(userId: string): { token: string; jti: string; ttlS: number } {
    const jti = randomUUID();
    const token = jwt.sign({}, this.opts.secret, { algorithm: 'HS256', issuer: ISSUER, audience: 'refresh', subject: userId, jwtid: jti, expiresIn: this.opts.refreshTtlS });
    return { token, jti, ttlS: this.opts.refreshTtlS };
  }

  verifyAccess(token: string): AuthContext {
    const p = this.verify(token, 'access');
    if (typeof p.sub !== 'string' || typeof p.email !== 'string' || typeof p.role !== 'string' || !ROLES.includes(p.role)) {
      throw new AuthError('TOKEN_INVALID', 'access token is invalid');
    }
    return { userId: p.sub, email: p.email, role: p.role as Role };
  }

  verifyRefresh(token: string): { userId: string; jti: string } {
    const p = this.verify(token, 'refresh');
    if (typeof p.sub !== 'string' || typeof p.jti !== 'string') throw new AuthError('TOKEN_INVALID', 'refresh token is invalid');
    return { userId: p.sub, jti: p.jti };
  }

  private verify(token: string, audience: 'access' | 'refresh'): jwt.JwtPayload {
    try {
      const p = jwt.verify(token, this.opts.secret, { algorithms: ['HS256'], issuer: ISSUER, audience });
      if (typeof p === 'string') throw new AuthError('TOKEN_INVALID', 'token is invalid');
      return p;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      if (e instanceof jwt.TokenExpiredError) throw new AuthError('TOKEN_EXPIRED', `${audience} token has expired`);
      throw new AuthError('TOKEN_INVALID', `${audience} token is invalid`);
    }
  }
}
