import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** Mirrors the backend Role enum. */
export type Role = 'INVESTIGATOR' | 'SUPERVISOR' | 'ADMIN' | 'VIEWER';

const ROLES: readonly string[] = ['INVESTIGATOR', 'SUPERVISOR', 'ADMIN', 'VIEWER'];
export const isRole = (v: unknown): v is Role => typeof v === 'string' && ROLES.includes(v);

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/** Why the last session ended (not persisted); drives the login screen's message and the return-to-page behaviour. */
export type SessionEnd = 'signed_out' | 'expired' | null;

interface AuthState {
  user: SessionUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  endReason: SessionEnd;
  /** Called with the POST /auth/login response. */
  setSession: (s: { user: SessionUser; accessToken: string; refreshToken: string }) => void;
  /** Token rotation from the API client's refresh interceptor; the user is unchanged. */
  setTokens: (t: { accessToken: string; refreshToken: string }) => void;
  /** User chose to sign out. */
  signOut: () => void;
  /** The server rejected our tokens and refresh failed. */
  expireSession: () => void;
  clearSession: () => void;
}

const EMPTY = { user: null, accessToken: null, refreshToken: null } as const;

const isValidUser = (u: unknown): u is SessionUser => {
  const x = u as Partial<SessionUser> | null;
  return !!x && typeof x.id === 'string' && typeof x.email === 'string' && typeof x.name === 'string' && isRole(x.role);
};

/**
 * The single source of session state (who am I, which tokens). Kept in sessionStorage so it dies with the tab.
 * A stored session that is malformed or has an unknown role is discarded on load instead of trusted.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      ...EMPTY,
      endReason: null,
      setSession: ({ user, accessToken, refreshToken }) => set({ user, accessToken, refreshToken, endReason: null }),
      setTokens: ({ accessToken, refreshToken }) => set({ accessToken, refreshToken }),
      signOut: () => set({ ...EMPTY, endReason: 'signed_out' }),
      expireSession: () => set((s) => (s.user ? { ...EMPTY, endReason: 'expired' } : s)),
      clearSession: () => set({ ...EMPTY, endReason: null }),
    }),
    {
      name: 'ps26183.session',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ user: s.user, accessToken: s.accessToken, refreshToken: s.refreshToken }),
      merge: (persisted, current) => {
        const p = persisted as Partial<AuthState> | undefined;
        if (p && isValidUser(p.user) && typeof p.accessToken === 'string' && typeof p.refreshToken === 'string') {
          return { ...current, user: p.user, accessToken: p.accessToken, refreshToken: p.refreshToken };
        }
        return current;
      },
    },
  ),
);

export const isAuthenticated = () => useAuthStore.getState().user !== null;
