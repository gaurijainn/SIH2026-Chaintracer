import type { Role } from '@prisma/client';
import type { AppSecurity } from './http';
import { InMemoryRefreshStore } from './refreshStore';
import { AuthService } from './service';
import { TokenService } from './tokens';

/** Shared by the API test suites: a real TokenService/AuthService over in-memory state, no I/O. */
export const TEST_JWT_SECRET = 'test-secret-test-secret-test-secret-0123';
export const TEST_ORIGIN = 'http://localhost:5173';

export const testTokens = () => new TokenService({ secret: TEST_JWT_SECRET, accessTtlS: 900, refreshTtlS: 3600 });

export interface TestUserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  passwordHash: string;
}

export function testSecurity(opts: { users?: TestUserRow[]; rateLimit?: { windowS: number; max: number; authMax: number }; corsOrigins?: string[] } = {}): AppSecurity & { store: InMemoryRefreshStore } {
  const tokens = testTokens();
  const store = new InMemoryRefreshStore();
  const users = opts.users ?? [];
  const auth = new AuthService({
    prisma: {
      user: {
        findUnique: async ({ where }) => users.find((u) => ('email' in where ? u.email === where.email : u.id === where.id)) ?? null,
      },
    },
    tokens,
    store,
  });
  return {
    config: { corsOrigins: opts.corsOrigins ?? [TEST_ORIGIN], rateLimit: opts.rateLimit ?? { windowS: 60, max: 100000, authMax: 100000 } },
    tokens,
    auth,
    store,
  };
}

export const bearer = (role: Role, userId = 'test-user'): string => `Bearer ${testTokens().signAccess({ id: userId, email: `${userId}@test.local`, role })}`;

/** fetch() with an Authorization header for `role` (default SUPERVISOR, which holds every permission the pre-B10 route tests exercise). */
export function authFetch(role: Role = 'SUPERVISOR', userId = 'test-user') {
  return (url: string | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('authorization')) headers.set('authorization', bearer(role, userId));
    return fetch(url, { ...init, headers });
  };
}

export const TEST_PASSWORD = 'Test-Pass-1!';

/**
 * Integration tests: one fixed user per role (idempotent upsert). They are never deleted -- audit rows reference
 * their ids, and the hash-chained log must not be rewritten (a deleted user would null actorId and break the chain).
 */
export async function ensureTestUsers(prisma: {
  user: { upsert(args: { where: { email: string }; update: object; create: { email: string; name: string; role: Role; passwordHash: string } }): Promise<{ id: string }> };
}): Promise<Record<Role, string>> {
  const { hashPassword } = await import('./password');
  const ids = {} as Record<Role, string>;
  for (const role of ['VIEWER', 'INVESTIGATOR', 'SUPERVISOR', 'ADMIN'] as Role[]) {
    const email = `b10-${role.toLowerCase()}@test.local`;
    const row = await prisma.user.upsert({ where: { email }, update: { role }, create: { email, name: `B10 test ${role}`, role, passwordHash: hashPassword(TEST_PASSWORD) } });
    ids[role] = row.id;
  }
  return ids;
}
