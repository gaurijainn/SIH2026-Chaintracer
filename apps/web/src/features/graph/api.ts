import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useCan } from '@/features/auth/access';
import { api } from '@/lib/api';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Chain } from '@/lib/tokens';
import { graphResponseSchema, vaspKey, type GraphResponse, type VaspIndex } from './model';

export interface GraphFilters {
  chain: Chain | '';
  /** Minimum edge value in USD, as typed (empty = no minimum). */
  minUsd: string;
  /** yyyy-mm-dd (IST calendar day) bounds, empty = open. */
  from: string;
  to: string;
}
export const NO_FILTERS: GraphFilters = { chain: '', minUsd: '', from: '', to: '' };
export const filtersActive = (f: GraphFilters) => !!(f.chain || f.minUsd || f.from || f.to);

/** yyyy-mm-dd read as an IST calendar day (the app's convention) -> UTC ISO instant for the backend's `from` / `to`. */
const istDay = (day: string, endOfDay: boolean) => new Date(`${day}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+05:30`).toISOString();

export function graphQuery(f: GraphFilters) {
  const min = Number(f.minUsd);
  return {
    chain: f.chain || undefined,
    minValueUsd: f.minUsd.trim() !== '' && Number.isFinite(min) && min >= 0 ? min : undefined,
    from: f.from ? istDay(f.from, false) : undefined,
    to: f.to ? istDay(f.to, true) : undefined,
  };
}

export const graphKeys = {
  caseView: (caseId: string) => ['graph', 'case', caseId] as const,
  graph: (traceId: string, q: ReturnType<typeof graphQuery>) => ['graph', 'trace', traceId, q] as const,
  vasps: ['graph', 'vasps'] as const,
  watchlist: (caseId: string) => ['graph', 'watchlist', caseId] as const,
};

const caseViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['OPEN', 'TRACING', 'ATTRIBUTED', 'CLOSED']),
  createdAt: z.string().optional(),
  owner: z.object({ name: z.string() }).nullable().optional(),
  traces: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']),
      seedChain: z.string(),
      seedAddr: z.string(),
      createdAt: z.string(),
      finishedAt: z.string().nullable().optional(),
    }),
  ),
});
export type CaseView = z.infer<typeof caseViewSchema>;

/**
 * GET /cases/:id. The backend records an audit entry for every call (chain of custody), and opening a case is exactly the
 * view that entry is meant for. The AbortSignal is deliberately not passed so a StrictMode remount cannot double-log it.
 */
export function useCaseView(caseId: string) {
  const can = useCan();
  return useQuery({
    queryKey: graphKeys.caseView(caseId),
    queryFn: async () => {
      const raw = await api.get<{ case: unknown }>(`/cases/${encodeURIComponent(caseId)}`);
      const parsed = caseViewSchema.safeParse(raw.case);
      if (!parsed.success) throw new ApiError(502, 'INVALID_RESPONSE', 'The server returned an unexpected case response.');
      return parsed.data;
    },
    enabled: can('case:read'),
    staleTime: 5 * 60_000,
  });
}

/** GET /traces/:id/graph with server-side chain / min-value / time filters. Previous data stays on screen while a filter change loads. */
export function useTraceGraph(traceId: string | null, filters: GraphFilters) {
  const can = useCan();
  const q = graphQuery(filters);
  return useQuery({
    queryKey: graphKeys.graph(traceId ?? '', q),
    queryFn: async ({ signal }): Promise<GraphResponse> => {
      const raw = await api.get<unknown>(`/traces/${encodeURIComponent(traceId!)}/graph`, { query: q, signal });
      const parsed = graphResponseSchema.safeParse(raw);
      if (!parsed.success) throw new ApiError(502, 'INVALID_RESPONSE', 'The server returned an unexpected graph response. Try again shortly.');
      return parsed.data;
    },
    enabled: !!traceId && can('graph:read'),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

/** GET /vasps hot wallets, indexed by CHAIN:address. Real VASP identity for nodes; skipped without vasp:read. */
export function useVaspIndex() {
  const can = useCan();
  return useQuery({
    queryKey: graphKeys.vasps,
    queryFn: async ({ signal }): Promise<VaspIndex> => {
      const { vasps } = await api.get<{ vasps: { name: string; addresses?: { chain: string; addr: string }[] }[] }>('/vasps', { signal });
      const idx: VaspIndex = new Map();
      for (const v of vasps) for (const a of v.addresses ?? []) idx.set(vaspKey(a.chain, a.addr), { name: v.name });
      return idx;
    },
    enabled: can('vasp:read'),
    staleTime: 5 * 60_000,
  });
}

export interface WatchItem {
  id: string;
  chain: string;
  addr: string;
}
export function useCaseWatchlist(caseId: string) {
  const can = useCan();
  return useQuery({
    queryKey: graphKeys.watchlist(caseId),
    queryFn: async ({ signal }) => (await api.get<{ items: WatchItem[] }>('/watchlist', { query: { caseId }, signal })).items,
    enabled: can('watchlist:read'),
    staleTime: 30_000,
  });
}

export interface AddResult {
  added: string[];
  alreadyWatched: string[];
  failed: { id: string; message: string }[];
}

/**
 * POST /watchlist once per address (the API takes one). Already-watched addresses are skipped up front using the case's
 * watchlist, so the officer is told rather than silently re-posting; failures are reported per address.
 */
export function useAddToWatchlist(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (targets: { id: string; chain: Chain; addr: string }[]): Promise<AddResult> => {
      const existing = qc.getQueryData<WatchItem[]>(graphKeys.watchlist(caseId)) ?? [];
      const have = new Set(existing.map((w) => vaspKey(w.chain, w.addr)));
      const result: AddResult = { added: [], alreadyWatched: [], failed: [] };
      for (const t of targets) {
        if (have.has(vaspKey(t.chain, t.addr))) {
          result.alreadyWatched.push(t.id);
          continue;
        }
        try {
          await api.post('/watchlist', { caseId, chain: t.chain, addr: t.addr, reason: 'manual' });
          result.added.push(t.id);
        } catch (e) {
          result.failed.push({ id: t.id, message: errorMessage(e) });
        }
      }
      return result;
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: graphKeys.watchlist(caseId) }),
  });
}
