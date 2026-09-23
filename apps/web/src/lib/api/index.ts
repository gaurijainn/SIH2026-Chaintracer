import { useAuthStore } from '@/stores/auth';
import { apiBaseUrl } from '../env';
import { createApiClient } from './client';

/** App-wide API client wired to the session store. Feature hooks (F2+) import `api` from here. */
export const api = createApiClient({
  baseUrl: apiBaseUrl,
  getTokens: () => {
    const { accessToken, refreshToken } = useAuthStore.getState();
    return accessToken && refreshToken ? { accessToken, refreshToken } : null;
  },
  onTokens: (t) => useAuthStore.getState().setTokens(t),
  onAuthFailure: () => useAuthStore.getState().clearSession(),
});

export { ApiError, errorMessage, toApiError } from './errors';
export { createApiClient } from './client';
export type { ApiClient } from './client';
