import { createHmac } from 'node:crypto';

/** Must match apps/api/src/auth/tokens.ts (which imports this constant). */
export const JWT_ISSUER = 'ps26183-api';

const b64 = (o: object | Buffer) => Buffer.from(o instanceof Buffer ? o : JSON.stringify(o)).toString('base64url');

/**
 * B10 compatibility helper: a short-lived, least-privilege (VIEWER) HS256 access token for in-cluster callers such
 * as the B8 worker's A5 risk-recompute call into the API, which is now behind JWT auth. Uses only node:crypto, so the
 * workers package needs no JWT dependency. It is a normal access token -- the API verifies it exactly like a user's.
 */
export function signServiceToken(secret: string, name = 'workers', ttlS = 60, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({ sub: `system:${name}`, email: `${name}@system.local`, role: 'VIEWER', iss: JWT_ISSUER, aud: 'access', iat, exp: iat + ttlS });
  const sig = b64(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}
