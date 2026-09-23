import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import type { Chain } from '@/lib/tokens';
import { toComplaintPayload, type ComplaintFormValues } from './complaintSchema';
import type { Issue } from './rules';

/** Response shapes of POST /complaints and POST /complaints/import (RowResult / IngestSummary in apps/api/src/intake/service.ts). */
export interface PreparedTrace {
  id: string;
  chain: Chain;
  seed: string;
  queue: string;
  reused: boolean;
}
export interface RowResult {
  row: number;
  ackNo: string | null;
  status: 'CREATED' | 'DUPLICATE' | 'INVALID';
  errors: Issue[];
  warnings: Issue[];
  duplicateOf?: 'existing' | 'file';
  complaintId?: string;
  caseId?: string;
  caseCreated?: boolean;
  linkedCaseIds?: string[];
  linkedAckNos?: string[];
  entries?: { raw: string; value: string; kind: 'ADDRESS' | 'TX_HASH'; chain: Chain | null; candidateChains: Chain[]; flags: string[] }[];
  traceJobs?: PreparedTrace[];
}
export interface IngestSummary {
  total: number;
  created: number;
  duplicates: number;
  invalid: number;
  linked: number;
  casesCreated: number;
  traceJobsPrepared: number;
  tronTraceJobs: number;
  queued: number;
  queueError?: string;
  timings: { validationMs: number; persistMs: number; totalMs: number };
}
export interface CreateComplaintResponse {
  complaint: RowResult;
  summary: IngestSummary;
}
export interface ImportResponse {
  summary: IngestSummary;
  rows: RowResult[];
}

/** 201 created, 200 duplicate, 422 invalid: the 422 carries the row's issues, which the form maps onto fields. */
export async function createComplaint(values: ComplaintFormValues, addresses: string[]): Promise<CreateComplaintResponse> {
  return api.post<CreateComplaintResponse>('/complaints', toComplaintPayload(values, addresses));
}

export function useCreateComplaint() {
  return useMutation({ mutationFn: (a: { values: ComplaintFormValues; addresses: string[] }) => createComplaint(a.values, a.addresses) });
}

/** Rejected 422 complaint -> the API's per-field issues, or null when the error is something else. */
export function rowIssuesOf(err: unknown): Issue[] | null {
  if (!(err instanceof ApiError) || err.status !== 422) return null;
  const c = (err.body as { complaint?: { errors?: Issue[] } } | undefined)?.complaint;
  return Array.isArray(c?.errors) ? c.errors : null;
}

/** Sends the validated rows as text/csv (a format the endpoint accepts) through the shared API client. */
export function useImportComplaints() {
  return useMutation({
    mutationFn: (csv: string) => api.post<ImportResponse>('/complaints/import', undefined, { rawBody: csv, contentType: 'text/csv' }),
  });
}
