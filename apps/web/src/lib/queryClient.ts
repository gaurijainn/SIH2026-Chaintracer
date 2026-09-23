import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/errors';

/** Retry transient failures only; 4xx (auth, validation, not-found) will not improve by retrying. */
export const shouldRetry = (failureCount: number, error: unknown) => {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
};

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: shouldRetry, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
