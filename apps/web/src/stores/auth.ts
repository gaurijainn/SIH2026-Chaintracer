import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** Mirrors the backend Role enum. */
export type Role = 'INVESTIGATOR' | 'SUPERVISOR' | 'ADMIN' | 'VIEWER';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

interface AuthState {
  user: SessionUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  /** F1's login form calls this with the POST /auth/login response. */
  setSession: (s: { user: SessionUser; accessToken: string; refreshToken: string }) => void;
  /** Token rotation from the API client's refresh interceptor; the user is unchanged. */
  setTokens: (t: { accessToken: string; refreshToken: string }) => void;
  clearSession: () => void;
}

/**
 * Session state only (who am I, which tokens). Kept in sessionStorage so it dies with the tab; F1 may revisit.
 * There is deliberately no login action here: F0 does not authenticate anyone.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      setSession: ({ user, accessToken, refreshToken }) => set({ user, accessToken, refreshToken }),
      setTokens: ({ accessToken, refreshToken }) => set({ accessToken, refreshToken }),
      clearSession: () => set({ user: null, accessToken: null, refreshToken: null }),
    }),
    { name: 'ps26183.session', storage: createJSONStorage(() => sessionStorage) },
  ),
);

export const isAuthenticated = () => useAuthStore.getState().user !== null;
