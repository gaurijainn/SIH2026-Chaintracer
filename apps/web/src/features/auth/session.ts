import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { useAuthStore } from '@/stores/auth';
import { loginResponseSchema, type LoginValues } from './loginSchema';

/** Only same-app paths are honoured as a post-login destination (no open redirects, never back to /login). */
export function safeReturnPath(from: unknown): string {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\') || from.startsWith('/login')) return '/dashboard';
  return from;
}

/** POST /auth/login -> session store. The response is validated before it is trusted. */
export function useLogin() {
  const setSession = useAuthStore((s) => s.setSession);
  return useMutation({
    mutationFn: async (values: LoginValues) => {
      const raw = await api.post<unknown>('/auth/login', values, { auth: false });
      const parsed = loginResponseSchema.safeParse(raw);
      if (!parsed.success) throw new ApiError(502, 'BAD_RESPONSE', 'The server returned an unexpected response. Try again shortly.');
      return parsed.data;
    },
    onSuccess: (data) => setSession({ user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken }),
  });
}

/** Ends the session locally at once, and revokes the refresh token server-side on a best-effort basis. */
export function signOut() {
  const { refreshToken, signOut: clear } = useAuthStore.getState();
  clear();
  if (refreshToken) void api.post('/auth/logout', { refreshToken }, { auth: false }).catch(() => undefined);
}
