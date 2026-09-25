import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import type { Chain } from '@/lib/tokens';
import { useCan } from '@/features/auth/access';

/** Shapes of the existing read endpoints the dashboard composes (no dashboard-specific endpoint exists). */
export type CaseStatus = 'OPEN' | 'TRACING' | 'ATTRIBUTED' | 'CLOSED';
export type AlertRule = 'A1_MOVEMENT' | 'A2_VASP_LANDING' | 'A3_OBFUSCATION' | 'A4_LINKAGE' | 'A5_BLACKLIST';
export type AlertSeverity = 'INFO' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AlertStatus = 'NEW' | 'ACKNOWLEDGED' | 'ASSIGNED' | 'SNOOZED';

/** GET /complaints item (IntakeService.list): complaint + addresses + its case summary. */
export interface ComplaintItem {
  id: string;
  ackNo: string;
  reportedAt: string;
  category: string;
  amountInr: string;
  network: string | null;
  caseId: string | null;
  case: { id: string; title: string; status: CaseStatus } | null;
  addresses: { address: string; chain: Chain | null; kind: 'ADDRESS' | 'TX_HASH' }[];
}
export interface ComplaintsPage {
  total: number;
  page: number;
  pageSize: number;
  items: ComplaintItem[];
}

/** GET /alerts row (AlertService.list, a Prisma Alert). `metadata` is rule-specific; A2 carries vaspName + freezeWindowOpen. */
export interface AlertRow {
  id: string;
  caseId: string;
  rule: AlertRule;
  severity: AlertSeverity;
  status: AlertStatus;
  chain: string;
  address: string;
  amount: string | null;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** GET /vasps row: only the fields the dashboard reads. */
export interface VaspRow {
  id: string;
  name: string;
  addresses?: unknown[];
}

const PAGE_SIZE = 200; // the API's maximum
/** The complaints list is paged and has no aggregate endpoint, so the dashboard reads a bounded, newest-first window. */
export const MAX_COMPLAINT_PAGES = 5;
export const MAX_COMPLAINTS = PAGE_SIZE * MAX_COMPLAINT_PAGES;

export interface ComplaintWindow {
  items: ComplaintItem[];
  /** Total complaints on the server. */
  total: number;
  /** True when total exceeds the window, so every figure derived from it covers only the newest `items.length`. */
  truncated: boolean;
}

export async function fetchComplaintWindow(signal?: AbortSignal): Promise<ComplaintWindow> {
  const first = await api.get<ComplaintsPage>('/complaints', { query: { page: 1, pageSize: PAGE_SIZE }, signal });
  const items = [...first.items];
  const pages = Math.min(MAX_COMPLAINT_PAGES, Math.ceil(first.total / PAGE_SIZE));
  for (let page = 2; page <= pages; page++) {
    const next = await api.get<ComplaintsPage>('/complaints', { query: { page, pageSize: PAGE_SIZE }, signal });
    items.push(...next.items);
  }
  return { items, total: first.total, truncated: first.total > items.length };
}

/** Stable keys: one cache entry per source, shared by every panel that derives from it. */
export const dashboardKeys = {
  complaints: ['dashboard', 'complaints'] as const,
  alerts: ['dashboard', 'alerts'] as const,
  vasps: ['dashboard', 'vasps'] as const,
  summary: ['dashboard', 'summary'] as const,
};

/** Each source is skipped (not fetched) when the role lacks its read permission, using the existing F1 matrix. */
export function useComplaintWindow() {
  const can = useCan();
  return useQuery({ queryKey: dashboardKeys.complaints, queryFn: ({ signal }) => fetchComplaintWindow(signal), enabled: can('complaint:read') });
}

export function useAlertRows() {
  const can = useCan();
  return useQuery({ queryKey: dashboardKeys.alerts, queryFn: async ({ signal }) => (await api.get<{ alerts: AlertRow[] }>('/alerts', { signal })).alerts, enabled: can('alert:read') });
}

export function useVaspRows() {
  const can = useCan();
  return useQuery({ queryKey: dashboardKeys.vasps, queryFn: async ({ signal }) => (await api.get<{ vasps: VaspRow[] }>('/vasps', { signal })).vasps, enabled: can('vasp:read') });
}

const count = z.number().int().nonnegative();

/**
 * GET /api/v1/dashboard/summary (apps/api/src/dashboard/service.ts). Parsed at the boundary so a malformed body becomes a
 * clear error state instead of NaN or a crash. `tracedValueUsd` is USD by contract (no INR conversion exists), and
 * `timeToAttributionMedianSeconds` is deliberately null until the backend defines it.
 */
export const dashboardSummarySchema = z.object({
  openCases: count,
  tracesPerDay: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count })),
  tracedValueUsd: z.number().finite().nonnegative(),
  vaspsIdentified: count,
  typologyMix: z.array(z.object({ typology: z.string().min(1), count })),
  timeToAttributionMedianSeconds: z.number().finite().nonnegative().nullable(),
  chainSplit: z.array(z.object({ chain: z.string().min(1), count })),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

export async function fetchDashboardSummary(signal?: AbortSignal): Promise<DashboardSummary> {
  const raw = await api.get<unknown>('/dashboard/summary', { signal });
  const parsed = dashboardSummarySchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(502, 'INVALID_RESPONSE', 'The server returned an unexpected dashboard response. Try again shortly.');
  return parsed.data;
}

/** One shared cache entry for the KPI cards and the three summary charts; case:read gates it like the F1 matrix. */
export function useDashboardSummary() {
  const can = useCan();
  return useQuery({ queryKey: dashboardKeys.summary, queryFn: ({ signal }) => fetchDashboardSummary(signal), enabled: can('case:read') });
}
