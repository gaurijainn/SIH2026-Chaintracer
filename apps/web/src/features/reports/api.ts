import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useCan } from '@/features/auth/access';
import { api } from '@/lib/api';
import { ApiError, toApiError } from '@/lib/api/errors';

/**
 * Contracts of the B9 endpoints, read from apps/api/src/{reports,freeze-notices}/routes.ts:
 *   POST  /cases/:id/reports?format=pdf|json   -> pdf: application/pdf bytes + X-Report-Id / X-Report-Sha256 headers
 *                                                 json: { report, evidence, integrity }
 *   GET   /verify/:hash                        -> { match, report }   (public)
 *   POST  /cases/:id/freeze-notices            { vaspId, alertId? }        -> { freezeNotice }
 *   PATCH /freeze-notices/:id                  { legalProvision?, body? }  -> { freezeNotice }
 *   POST  /freeze-notices/:id/submit | approve | send  (empty body)        -> { freezeNotice }
 * There is no GET for freeze notices and no report list, so nothing here can be read back after a reload.
 */

const ID = (s: string) => encodeURIComponent(s);

export const reportRecordSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  version: z.string(),
  sha256: z.string(),
  pdfPath: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type ReportRecord = z.infer<typeof reportRecordSchema>;

const jsonReportSchema = z.object({ report: reportRecordSchema, evidence: z.record(z.string(), z.unknown()), integrity: z.object({ firNumberAsHashed: z.string().nullable() }) });

/** The evidence fields the summary shows; everything else stays in the downloaded file untouched. */
const evidenceSummarySchema = z.object({
  schemaVersion: z.string().optional(),
  generatedAt: z.string().optional(),
  hops: z.array(z.unknown()).optional(),
  attribution: z.array(z.unknown()).optional(),
  risk: z.array(z.unknown()).optional(),
  sources: z.array(z.unknown()).optional(),
  limitations: z.array(z.string()).optional(),
  case: z.object({ firNumber: z.string().nullable().optional(), ackNo: z.string().nullable().optional() }).optional(),
});

export interface PdfReport {
  blob: Blob;
  reportId: string | null;
  sha256: string | null;
  ms: number;
}
export interface JsonReport {
  /** The response body exactly as the server sent it; this is what "Download JSON" saves. */
  text: string;
  report: ReportRecord;
  evidence: z.infer<typeof evidenceSummarySchema>;
  firNumberAsHashed: string | null;
  ms: number;
}

const now = () => performance.now();

export function useGeneratePdf(caseId: string) {
  return useMutation({
    mutationFn: async (): Promise<PdfReport> => {
      const t0 = now();
      const res = await api.requestRaw(`/cases/${ID(caseId)}/reports`, { method: 'POST', query: { format: 'pdf' } });
      const blob = await res.blob();
      const ms = Math.round(now() - t0);
      if (!/application\/pdf/i.test(res.headers.get('Content-Type') ?? '') || blob.size === 0) throw new ApiError(502, 'INVALID_RESPONSE', 'The server did not return a PDF.');
      return { blob, reportId: res.headers.get('X-Report-Id'), sha256: res.headers.get('X-Report-Sha256'), ms };
    },
  });
}

export function useGenerateJson(caseId: string) {
  return useMutation({
    mutationFn: async (): Promise<JsonReport> => {
      const t0 = now();
      const res = await api.requestRaw(`/cases/${ID(caseId)}/reports`, { method: 'POST', query: { format: 'json' } });
      const text = await res.text();
      const ms = Math.round(now() - t0);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = undefined;
      }
      const parsed = jsonReportSchema.safeParse(raw);
      const summary = parsed.success ? evidenceSummarySchema.safeParse(parsed.data.evidence) : null;
      if (!parsed.success || !summary?.success) throw new ApiError(502, 'INVALID_RESPONSE', 'The server returned an unexpected report response.');
      return { text, report: parsed.data.report, evidence: summary.data, firNumberAsHashed: parsed.data.integrity.firNumberAsHashed, ms };
    },
  });
}

export const verifyResultSchema = z.object({ match: z.boolean(), report: reportRecordSchema.nullable() });
export type VerifyResult = z.infer<typeof verifyResultSchema>;

/** GET /verify/:hash is public by design, so no bearer token is sent. */
export function useVerifyHash() {
  return useMutation({
    mutationFn: async (hash: string): Promise<VerifyResult> => {
      const raw = await api.get<unknown>(`/verify/${ID(hash)}`, { auth: false });
      const parsed = verifyResultSchema.safeParse(raw);
      if (!parsed.success) throw new ApiError(502, 'INVALID_RESPONSE', 'The server returned an unexpected verification response.');
      return parsed.data;
    },
  });
}

/** GET /cases/:id fields F8 shows read-only: the case FIR number and each complaint's NCRP acknowledgement. */
const caseInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  firNumber: z.string().nullable().optional(),
  complaints: z.array(z.object({ id: z.string(), ackNo: z.string() })).default([]),
});
export type CaseInfo = z.infer<typeof caseInfoSchema>;

export function useCaseInfo(caseId: string | null) {
  const can = useCan();
  return useQuery({
    queryKey: ['reports', 'case', caseId] as const,
    queryFn: async (): Promise<CaseInfo> => {
      const raw = await api.get<{ case: unknown }>(`/cases/${ID(caseId!)}`);
      const parsed = caseInfoSchema.safeParse(raw.case);
      if (!parsed.success) throw new ApiError(502, 'INVALID_RESPONSE', 'The server returned an unexpected case response.');
      return parsed.data;
    },
    enabled: !!caseId && can('case:read'),
    staleTime: 5 * 60_000,
  });
}

export const NOTICE_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

/** `body` is built by the backend from real VASP, hop and alert data; it is displayed, never composed here. */
const noticeBodySchema = z
  .object({
    vasp: z.object({ id: z.string(), name: z.string(), jurisdiction: z.string().nullish(), contactEmail: z.string().nullish(), contactPortal: z.string().nullish() }).partial().optional(),
    depositAddresses: z.array(z.string()).optional(),
    txHashes: z.array(z.string()).optional(),
    amounts: z.array(z.object({ chain: z.string(), token: z.string(), amount: z.string(), usd: z.string().nullable() }).passthrough()).optional(),
    alertId: z.string().nullable().optional(),
    requestedAt: z.object({ utc: z.string(), ist: z.object({ iso: z.string(), display: z.string() }) }).partial().optional(),
    requests: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export const freezeNoticeSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  vaspId: z.string(),
  status: z.enum(NOTICE_STATUSES),
  legalProvision: z.string().nullable(),
  legalCellReviewed: z.boolean(),
  body: noticeBodySchema,
  submissionId: z.string().nullable(),
  approvedById: z.string().nullable(),
  approvedAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
});
export type FreezeNotice = z.infer<typeof freezeNoticeSchema>;

const noticeEnvelope = z.object({ freezeNotice: freezeNoticeSchema });
const noticesKey = (caseId: string) => ['reports', 'notices', caseId] as const;

async function parseNotice(raw: unknown): Promise<FreezeNotice> {
  const parsed = noticeEnvelope.safeParse(raw);
  if (!parsed.success) throw new ApiError(502, 'INVALID_RESPONSE', 'The server returned an unexpected freeze notice response.');
  return parsed.data.freezeNotice;
}

/**
 * The API cannot list or fetch freeze notices, so the only source of truth is each mutation's own response. Those responses are
 * kept in the query cache (per case) for the browser session; a reload starts empty and the notice cannot be re-read.
 */
export function useSessionNotices(caseId: string) {
  return useQuery({ queryKey: noticesKey(caseId), queryFn: async () => [] as FreezeNotice[], staleTime: Infinity, gcTime: Infinity });
}

function useNoticeMutation<V>(caseId: string, call: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: V) => parseNotice(await call(v)),
    onSuccess: (notice) => {
      qc.setQueryData<FreezeNotice[]>(noticesKey(caseId), (old = []) => (old.some((n) => n.id === notice.id) ? old.map((n) => (n.id === notice.id ? notice : n)) : [notice, ...old]));
    },
  });
}

export const useDraftNotice = (caseId: string) => useNoticeMutation(caseId, (v: { vaspId: string; alertId?: string }) => api.post(`/cases/${ID(caseId)}/freeze-notices`, v));
export const useEditNotice = (caseId: string) => useNoticeMutation(caseId, (v: { id: string; legalProvision: string }) => api.patch(`/freeze-notices/${ID(v.id)}`, { legalProvision: v.legalProvision }));
export const useSubmitNotice = (caseId: string) => useNoticeMutation(caseId, (id: string) => api.post(`/freeze-notices/${ID(id)}/submit`));
export const useApproveNotice = (caseId: string) => useNoticeMutation(caseId, (id: string) => api.post(`/freeze-notices/${ID(id)}/approve`));
export const useSendNotice = (caseId: string) => useNoticeMutation(caseId, (id: string) => api.post(`/freeze-notices/${ID(id)}/send`));

/** INVALID_TRANSITION carries the backend's own explanation ("must be APPROVED to send (currently DRAFT)"); everything else uses the shared message. */
export function noticeErrorMessage(err: unknown): string {
  const e = toApiError(err);
  const body = e.body as { message?: unknown } | undefined;
  if (e.code === 'INVALID_TRANSITION' && typeof body?.message === 'string') return body.message;
  return e.message;
}
