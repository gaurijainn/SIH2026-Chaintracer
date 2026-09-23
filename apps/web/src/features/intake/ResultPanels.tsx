import { CircleAlert, CircleCheck, CopyMinus, Link2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ChainBadge, StatusBadge } from '@/components/common/badges';
import { SectionCard, StatCard } from '@/components/common/cards';
import { Can } from '@/features/auth/access';
import type { CreateComplaintResponse, ImportResponse, IngestSummary, RowResult } from './api';
import { TronFastPathTag } from './TronFastPath';

const short = (id: string) => `${id.slice(0, 8)}…`;

function CaseLink({ id }: { id: string }) {
  return (
    <Can permission="case:read" fallback={<span className="font-mono text-xs">{short(id)}</span>}>
      <Link to={`/cases/${id}`} className="font-mono text-xs text-primary underline-offset-2 hover:underline" aria-label={`Open case ${id}`}>
        {short(id)}
      </Link>
    </Can>
  );
}

const STATUS = {
  CREATED: { tone: 'success', label: 'Imported' },
  DUPLICATE: { tone: 'warning', label: 'Duplicate' },
  INVALID: { tone: 'danger', label: 'Rejected' },
} as const;

function LinkedCases({ row }: { row: RowResult }) {
  if (!row.linkedCaseIds?.length) return null;
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs">
      <StatusBadge tone="info" icon={<Link2 className="size-3" aria-hidden="true" />}>
        Linked case
      </StatusBadge>
      shares a wallet with {row.linkedAckNos?.length ? `complaint ${row.linkedAckNos.join(', ')}` : 'an existing complaint'}; joined case
      {row.caseId && <CaseLink id={row.caseId} />}
    </p>
  );
}

function TraceJobs({ row }: { row: RowResult }) {
  if (!row.traceJobs?.length) return null;
  return (
    <ul className="space-y-1 text-xs" aria-label="Trace jobs prepared by the server">
      {row.traceJobs.map((t) => (
        <li key={t.id} className="flex flex-wrap items-center gap-1.5">
          <ChainBadge chain={t.chain} />
          {t.chain === 'TRON' && <TronFastPathTag />}
          <span className="font-mono">{t.seed.slice(0, 10)}…</span>
          <span className="text-muted-foreground">
            queue <span className="font-mono">{t.queue}</span>
            {t.reused ? ' (existing job reused)' : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Outcome of POST /complaints, exactly as the API reported it. */
export function ComplaintResult({ result }: { result: CreateComplaintResponse }) {
  const c = result.complaint;
  const s = STATUS[c.status];
  return (
    <SectionCard title="Result" bodyClassName="space-y-3">
      <div role="status" className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={s.tone} icon={c.status === 'CREATED' ? <CircleCheck className="size-3" aria-hidden="true" /> : <CopyMinus className="size-3" aria-hidden="true" />}>
          {c.status === 'CREATED' ? 'Complaint registered' : c.status === 'DUPLICATE' ? 'Already registered' : 'Rejected'}
        </StatusBadge>
        <span className="text-sm">
          NCRP <span className="font-mono">{c.ackNo}</span>
        </span>
        {c.caseId && (
          <span className="text-sm text-muted-foreground">
            {c.caseCreated ? 'New case ' : 'Case '}
            <CaseLink id={c.caseId} />
          </span>
        )}
      </div>
      {c.status === 'DUPLICATE' && <p className="text-sm text-muted-foreground">This acknowledgement number was already registered{c.duplicateOf === 'existing' ? ' earlier' : ''}. Nothing new was created.</p>}
      <LinkedCases row={c} />
      <TraceJobs row={c} />
      {c.warnings.length > 0 && (
        <ul className="space-y-1 text-xs text-risk-medium">
          {c.warnings.map((w, i) => (
            <li key={i}>{w.message}</li>
          ))}
        </ul>
      )}
      {result.summary.queueError && <p className="text-xs text-risk-medium">Saved, but the trace could not be queued right now. It stays queued and is retried when the complaint is re-submitted.</p>}
    </SectionCard>
  );
}

function SummaryCards({ summary, skippedLocally }: { summary: IngestSummary; skippedLocally: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="Imported" value={summary.created} hint={`${summary.casesCreated} new case${summary.casesCreated === 1 ? '' : 's'}`} icon={CircleCheck} />
      <StatCard label="Rejected by server" value={summary.invalid} icon={CircleAlert} />
      <StatCard label="Duplicates" value={summary.duplicates} hint="already registered or repeated in file" icon={CopyMinus} />
      <StatCard label="Linked cases" value={summary.linked} hint="shared a wallet with an existing case" icon={Link2} />
      <StatCard label="TRON fast-path jobs" value={summary.tronTraceJobs} hint={`${summary.traceJobsPrepared} trace jobs prepared, ${summary.queued} queued`} className="col-span-2 lg:col-span-2" />
      {skippedLocally > 0 && <StatCard label="Not sent" value={skippedLocally} hint="invalid or duplicate rows excluded in preview" className="col-span-2 lg:col-span-2" />}
    </div>
  );
}

const MAX_RESULT_ROWS = 200;

/** Outcome of POST /complaints/import. Counts and row statuses come only from the API response. */
export function ImportResult({ result, skippedLocally }: { result: ImportResponse; skippedLocally: number }) {
  const rows = [...result.rows].sort((a, b) => Number(a.status === 'CREATED') - Number(b.status === 'CREATED') || a.row - b.row);
  return (
    <SectionCard title="Import result" description={`Server processed ${result.summary.total} row${result.summary.total === 1 ? '' : 's'} in ${result.summary.timings.totalMs} ms.`} bodyClassName="space-y-4">
      <div role="status" className="sr-only">
        {result.summary.created} imported, {result.summary.invalid} rejected, {result.summary.duplicates} duplicates.
      </div>
      <SummaryCards summary={result.summary} skippedLocally={skippedLocally} />
      {result.summary.queueError && <p className="text-sm text-risk-medium">Rows were saved, but the trace queue was unavailable. Jobs stay queued and are re-enqueued when the file is re-imported.</p>}
      <div className="table-scroll max-h-96 overflow-y-auto">
        <table className="w-full min-w-max border-collapse text-sm">
          <caption className="sr-only">Per-row import outcome</caption>
          <thead className="sticky top-0 bg-muted text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Line</th>
              <th scope="col" className="px-3 py-2 font-medium">Ack no.</th>
              <th scope="col" className="px-3 py-2 font-medium">Outcome</th>
              <th scope="col" className="px-3 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.slice(0, MAX_RESULT_ROWS).map((r) => (
              <tr key={`${r.row}-${r.ackNo}`} className="align-top">
                <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.row}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.ackNo ?? '—'}</td>
                <td className="px-3 py-2">
                  <StatusBadge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusBadge>
                </td>
                <td className="space-y-1 px-3 py-2">
                  {r.errors.map((e, i) => (
                    <p key={i} className="text-xs text-risk-critical">
                      {e.message}
                    </p>
                  ))}
                  {r.status === 'DUPLICATE' && <p className="text-xs text-muted-foreground">{r.duplicateOf === 'file' ? 'Repeated acknowledgement number in this file' : 'Already registered'}</p>}
                  {r.caseId && r.status !== 'INVALID' && (
                    <p className="text-xs text-muted-foreground">
                      Case <CaseLink id={r.caseId} />
                    </p>
                  )}
                  <LinkedCases row={r} />
                  {r.status === 'CREATED' && <TraceJobs row={r} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > MAX_RESULT_ROWS && <p className="text-xs text-muted-foreground">Showing the first {MAX_RESULT_ROWS} of {rows.length} rows (problems first).</p>}
    </SectionCard>
  );
}
