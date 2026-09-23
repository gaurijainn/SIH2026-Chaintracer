import { useQuery } from '@tanstack/react-query';
import { apiBaseUrl, envDataMode, isDataMode, type DataMode } from '../env';

/** GET /health is unauthenticated and lives outside /api/v1. Only the fields F0 needs are typed. */
export async function fetchHealth(signal?: AbortSignal): Promise<{ mode?: unknown }> {
  const res = await fetch(`${apiBaseUrl}/health`, { signal, headers: { Accept: 'application/json' } });
  // 503 still carries a body with `mode`, so don't throw on non-2xx.
  return (await res.json()) as { mode?: unknown };
}

/** Current data mode: build-time override first, otherwise whatever the API reports. undefined until known. */
export function useDataMode(): DataMode | undefined {
  const { data } = useQuery({
    queryKey: ['health', 'mode'],
    queryFn: ({ signal }) => fetchHealth(signal),
    enabled: !envDataMode,
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  return envDataMode ?? (isDataMode(data?.mode) ? data.mode : undefined);
}
