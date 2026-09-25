import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCan } from '@/features/auth/access';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { alertResponseSchema, alertsResponseSchema, type AlertFilters } from './model';

export const alertKeys = {
  all: ['alerts'] as const,
  list: (f: AlertFilters) => ['alerts', 'list', f] as const,
};

/** GET /alerts with the backend's own caseId / severity / status filters. The endpoint has no pagination: it returns every match. */
export function useAlerts(filters: AlertFilters) {
  const can = useCan();
  return useQuery({
    queryKey: alertKeys.list(filters),
    queryFn: async ({ signal }) => {
      const raw = await api.get<unknown>('/alerts', {
        query: { caseId: filters.caseId.trim() || undefined, severity: filters.severity || undefined, status: filters.status || undefined },
        signal,
      });
      const parsed = alertsResponseSchema.safeParse(raw);
      if (!parsed.success) throw new ApiError(502, 'INVALID_RESPONSE', 'The server returned an unexpected alerts response. Try again shortly.');
      return parsed.data.alerts;
    },
    enabled: can('alert:read'),
    staleTime: 15_000,
  });
}

export type AlertPatch =
  | { id: string; action: 'acknowledge' }
  | { id: string; action: 'assign'; assigneeId: string }
  | { id: string; action: 'snooze'; snoozedUntil: string };

/** PATCH /alerts/:id. Nothing is shown as changed until the server answers; the list is refetched afterwards. */
export function useUpdateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: AlertPatch) => {
      const raw = await api.patch<unknown>(`/alerts/${encodeURIComponent(id)}`, body);
      const parsed = alertResponseSchema.safeParse(raw);
      if (!parsed.success) throw new ApiError(502, 'INVALID_RESPONSE', 'The server returned an unexpected alert response.');
      return parsed.data.alert;
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: alertKeys.all }),
  });
}
