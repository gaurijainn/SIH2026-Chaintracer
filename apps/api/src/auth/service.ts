import type { Role } from '@prisma/client';
import type { AuditService } from '../audit/service';
import { AuthError } from './errors';
import { verifyPassword } from './password';
import { hashJti, type RefreshStore } from './refreshStore';
import type { TokenService } from './tokens';

/** The subset of PrismaClient the auth service needs. */
export interface AuthPrisma {
  user: {
    findUnique(args: { where: { email: string } | { id: string } }): Promise<{ id: string; email: string; name: string; role: Role; passwordHash: string } | null>;
  };
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: { id: string; email: string; name: string; role: Role };
}

export interface AuthServiceDeps {
  prisma: AuthPrisma;
  tokens: TokenService;
  store: RefreshStore;
  audit?: AuditService;
}

/**
 * Login / refresh (with rotation) / logout. Refresh tokens are single-use: every refresh revokes the
 * presented token and issues a new pair, and replaying an already-rotated token revokes the user's
 * whole refresh-token family. The user row is re-read on refresh, so a role change or deleted user
 * takes effect at the next rotation (access tokens are short-lived by design).
 */
export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.deps.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    // verifyPassword runs a full scrypt even when the user is unknown (no user-enumeration timing gap)
    const ok = verifyPassword(password, user?.passwordHash);
    if (!user || !ok) {
      // no email in the audit meta: the log is append-only and hash-chained, so it must not accumulate typed identifiers
      await this.deps.audit?.record({ action: 'login failed', entity: 'User', meta: { reason: 'invalid credentials' } });
      throw new AuthError('INVALID_CREDENTIALS', 'invalid email or password');
    }
    const pair = await this.issue(user);
    await this.deps.audit?.record({ actorId: user.id, action: 'login', entity: 'User', entityId: user.id, meta: { role: user.role } });
    return pair;
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const { userId, jti } = this.deps.tokens.verifyRefresh(refreshToken);
    const result = await this.deps.store.consume(hashJti(jti));
    if (result.status === 'reused') {
      await this.deps.store.revokeUser(result.userId);
      await this.deps.audit?.record({ actorId: result.userId, action: 'refresh token reuse detected; sessions revoked', entity: 'User', entityId: result.userId });
      throw new AuthError('REFRESH_REVOKED', 'refresh token has already been used; sign in again');
    }
    if (result.status !== 'ok' || result.userId !== userId) throw new AuthError('REFRESH_REVOKED', 'refresh token has been revoked or expired');
    const user = await this.deps.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AuthError('REFRESH_REVOKED', 'user no longer exists');
    return this.issue(user);
  }

  /** Idempotent: revokes the presented refresh token if it is valid, and never reveals whether it was. */
  async logout(refreshToken: string): Promise<void> {
    try {
      const { userId, jti } = this.deps.tokens.verifyRefresh(refreshToken);
      const r = await this.deps.store.consume(hashJti(jti));
      if (r.status === 'ok') await this.deps.audit?.record({ actorId: userId, action: 'logout', entity: 'User', entityId: userId });
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
    }
  }

  private async issue(user: { id: string; email: string; name: string; role: Role }): Promise<TokenPair> {
    const access = this.deps.tokens.signAccess({ id: user.id, email: user.email, role: user.role });
    const refresh = this.deps.tokens.signRefresh(user.id);
    await this.deps.store.save(hashJti(refresh.jti), user.id, refresh.ttlS);
    return { accessToken: access, refreshToken: refresh.token, tokenType: 'Bearer', expiresIn: this.deps.tokens.accessTtlS, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  }
}
