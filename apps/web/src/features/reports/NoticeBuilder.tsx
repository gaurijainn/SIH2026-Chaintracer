import { Check, FileWarning, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusBadge } from '@/components/common/badges';
import { SectionCard } from '@/components/common/cards';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/skeleton';
import { useAlertRows } from '@/features/dashboard/api';
import { useVaspRegistry } from '@/features/attribution/api';
import { useCan } from '@/features/auth/access';
import { cn } from '@/lib/cn';
import { formatIst } from '@/lib/datetime';
import { NOTICE_STATUSES, noticeErrorMessage, useApproveNotice, useDraftNotice, useEditNotice, useSendNotice, useSessionNotices, useSubmitNotice, type FreezeNotice, type NoticeStatus } from './api';

const label = 'text-xs uppercase tracking-wide text-muted-foreground';
const field = 'h-9 rounded-md border border-input bg-background px-2 text-sm';
const STEP_LABEL: Record<NoticeStatus, string> = { DRAFT: 'Draft', PENDING_APPROVAL: 'Pending approval', APPROVED: 'Approved', SENT: 'Sent' };
const TONE: Record<NoticeStatus, 'neutral' | 'warning' | 'info' | 'success'> = { DRAFT: 'neutral', PENDING_APPROVAL: 'warning', APPROVED: 'info', SENT: 'success' };
const when = formatIst;

function Steps({ status }: { status: NoticeStatus }) {
  const { t } = useTranslation();
  const at = NOTICE_STATUSES.indexOf(status);
  return (
    <ol aria-label="Freeze notice workflow" className="flex flex-wrap items-center gap-2 text-xs">
      {NOTICE_STATUSES.map((s, i) => (
        <li key={s} aria-current={i === at ? 'step' : undefined} className={cn('flex items-center gap-1 rounded-full border px-2 py-1', i === at ? 'border-primary bg-primary/10 font-semibold text-foreground' : i < at ? 'text-foreground' : 'text-muted-foreground')}>
          {i < at && <Check className="size-3" aria-hidden="true" />}
          {t(STEP_LABEL[s])}
        </li>
      ))}
    </ol>
  );
}

function NoticeCard({ notice, caseId }: { notice: FreezeNotice; caseId: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const edit = useEditNotice(caseId);
  const submit = useSubmitNotice(caseId);
  const approve = useApproveNotice(caseId);
  const send = useSendNotice(caseId);
  const [legal, setLegal] = useState(notice.legalProvision ?? '');
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'approve' | 'send' | null>(null);
  useEffect(() => setLegal(notice.legalProvision ?? ''), [notice.legalProvision]);

  const busy = edit.isPending || submit.isPending || approve.isPending || send.isPending;
  const editable = notice.status === 'DRAFT' || notice.status === 'PENDING_APPROVAL';
  const mayEdit = editable && can('notice:draft');
  const run = <V,>(m: { mutate: (v: V, o: { onSuccess: () => void; onError: (e: unknown) => void }) => void }, v: V, then?: () => void) => {
    setError(null);
    m.mutate(v, { onSuccess: () => then?.(), onError: (e) => { setError(noticeErrorMessage(e)); setConfirm(null); } });
  };

  const b = notice.body;
  return (
    <SectionCard
      title={`Freeze notice to ${b.vasp?.name ?? notice.vaspId}`}
      description={`Notice ${notice.id} · created ${when(notice.createdAt)}`}
      actions={<StatusBadge tone={TONE[notice.status]}>{STEP_LABEL[notice.status]}</StatusBadge>}
      bodyClassName="space-y-4"
    >
      <Steps status={notice.status} />

      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className={label}>VASP</dt>
          <dd className="text-sm">
            {b.vasp?.name ?? notice.vaspId}
            {b.vasp?.jurisdiction ? ` · ${b.vasp.jurisdiction}` : ''}
          </dd>
        </div>
        <div>
          <dt className={label}>VASP contact on file</dt>
          <dd className="break-all text-sm">{b.vasp?.contactEmail || b.vasp?.contactPortal || 'None on file'}</dd>
        </div>
        <div>
          <dt className={label}>{t('Requested')}</dt>
          <dd className="text-sm">{formatIst(b.requestedAt?.utc)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className={label}>{t('Deposit addresses')}</dt>
          <dd className="break-all font-mono text-xs">{b.depositAddresses?.length ? b.depositAddresses.join(', ') : 'None found'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className={label}>{t('Transaction hashes')}</dt>
          <dd className="space-y-0.5 break-all font-mono text-xs">{b.txHashes?.length ? b.txHashes.map((h) => <div key={h}>{h}</div>) : 'None found in this case’s traces for these addresses'}</dd>
        </div>
        {b.amounts && b.amounts.length > 0 && (
          <div className="sm:col-span-2">
            <dt className={label}>{t('Amounts')}</dt>
            <dd className="text-xs">
              {b.amounts.map((a, i) => (
                <div key={i}>
                  {a.amount} {a.token} on {a.chain}
                  {a.usd ? ` (USD ${a.usd})` : ''}
                </div>
              ))}
            </dd>
          </div>
        )}
        {b.requests && (
          <div className="sm:col-span-2">
            <dt className={label}>Requests in the notice</dt>
            <dd>
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                {Object.entries(b.requests).map(([k, v]) => (
                  <li key={k}>{v}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>

      <div className="space-y-1.5">
        <label htmlFor={`legal-${notice.id}`} className="text-sm font-medium">
          {t('Legal provision')}
        </label>
        <textarea
          id={`legal-${notice.id}`}
          className="min-h-20 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm disabled:opacity-60"
          value={legal}
          maxLength={5000}
          disabled={!mayEdit || busy}
          onChange={(e) => setLegal(e.target.value)}
          placeholder={mayEdit ? 'Entered by the investigating officer' : undefined}
        />
        <div className="flex flex-wrap items-center gap-2">
          {mayEdit && (
            <Button type="button" variant="outline" size="sm" disabled={busy || legal === (notice.legalProvision ?? '')} onClick={() => run(edit, { id: notice.id, legalProvision: legal })}>
              {edit.isPending && <Spinner label="Saving" />} {t('Save legal provision')}
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            {notice.legalProvision === null ? 'Not filled in yet. The system never supplies statutory wording.' : editable ? 'Editable until approval.' : 'Locked: the notice is no longer editable.'} Legal cell reviewed: {notice.legalCellReviewed ? 'yes' : 'no'}.
          </span>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-risk-critical/40 bg-risk-critical-soft px-3 py-2 text-sm text-risk-critical">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button type="button" variant="outline" disabled={busy || notice.status !== 'DRAFT' || !can('notice:draft')} onClick={() => run(submit, notice.id)}>
          {submit.isPending && <Spinner label="Submitting" />} {t('Submit for approval')}
        </Button>
        <Button type="button" variant="outline" disabled={busy || notice.status !== 'PENDING_APPROVAL' || !can('notice:approve')} onClick={() => setConfirm('approve')}>
          {t('Approve')}
        </Button>
        <Button type="button" disabled={busy || notice.status !== 'APPROVED' || !can('notice:send')} onClick={() => setConfirm('send')}>
          <Send className="size-4" aria-hidden="true" /> {t('Submit to SAHYOG (sandbox)')}
        </Button>
        {!can('notice:approve') && <span className="text-xs text-muted-foreground">{t('Approving and sending require the Supervisor role.')}</span>}
      </div>

      {notice.approvedAt && (
        <p className="text-xs text-muted-foreground">
          Approved {when(notice.approvedAt)}
          {notice.approvedById ? ` by ${notice.approvedById}` : ''}.
        </p>
      )}
      {notice.status === 'SENT' && (
        <div role="status" className="rounded-md border bg-muted px-3 py-2 text-sm">
          <div className="font-medium">Submitted to the SAHYOG sandbox</div>
          <div className="text-xs text-muted-foreground">
            Submission ID <span className="font-mono">{notice.submissionId ?? 'not returned'}</span> · sent {when(notice.sentAt)}. The server only submits to the SAHYOG sandbox mock; nothing reaches a real government system.
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'approve'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Approve this freeze notice?"
        description="Approval makes the notice final: it can no longer be edited."
        confirmLabel="Approve"
        busy={approve.isPending}
        onConfirm={() => run(approve, notice.id, () => setConfirm(null))}
      />
      <ConfirmDialog
        open={confirm === 'send'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Submit to SAHYOG (sandbox)?"
        description="The server sends this approved notice to the SAHYOG sandbox and records the submission."
        confirmLabel="Submit"
        busy={send.isPending}
        onConfirm={() => run(send, notice.id, () => setConfirm(null))}
      />
    </SectionCard>
  );
}

/** Freeze-notice workflow for one case. Drafting reads real VASPs and alerts; the notice body is built by the backend. */
export function NoticeBuilder({ caseId, presetVaspId }: { caseId: string; presetVaspId?: string | null }) {
  const { t } = useTranslation();
  const can = useCan();
  const notices = useSessionNotices(caseId);
  const vasps = useVaspRegistry();
  const alerts = useAlertRows();
  const draft = useDraftNotice(caseId);
  const [vaspId, setVaspId] = useState(presetVaspId ?? '');
  const [alertId, setAlertId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const caseAlerts = useMemo(() => (alerts.data ?? []).filter((a) => a.caseId === caseId), [alerts.data, caseId]);
  const list = notices.data ?? [];

  return (
    <div className="space-y-4">
      <SectionCard title="Freeze notice" description="Draft a notice to a VASP. The backend fills in the VASP contact, deposit addresses, transaction hashes and amounts from real data." bodyClassName="space-y-3">
        {can('notice:draft') ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              draft.mutate({ vaspId, ...(alertId ? { alertId } : {}) }, { onError: (err) => setError(noticeErrorMessage(err)) });
            }}
          >
            <label className="grid gap-1 text-xs text-muted-foreground">
              VASP
              <select className={cn(field, 'min-w-56 text-foreground')} value={vaspId} onChange={(e) => setVaspId(e.target.value)} required>
                <option value="">{vasps.isPending ? 'Loading VASPs…' : 'Select a VASP'}</option>
                {(vasps.data ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · {v.jurisdiction}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t('Alert (optional)')}
              <select className={cn(field, 'min-w-56 text-foreground')} value={alertId} onChange={(e) => setAlertId(e.target.value)}>
                <option value="">No alert: use the VASP&apos;s known addresses</option>
                {caseAlerts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.rule} · {a.severity} · {a.message.slice(0, 60)}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" disabled={!vaspId || draft.isPending}>
              {draft.isPending && <Spinner label="Drafting" />} {t('Draft freeze notice')}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">{t('Your role cannot draft or change freeze notices.')}</p>
        )}
        {vasps.isError && <p role="alert" className="text-sm text-risk-critical">{`Could not load the VASP registry: ${noticeErrorMessage(vasps.error)}`}</p>}
        {error && (
          <p role="alert" className="rounded-md border border-risk-critical/40 bg-risk-critical-soft px-3 py-2 text-sm text-risk-critical">
            {`Could not draft the notice: ${error}`}
          </p>
        )}
        <p className="text-xs text-muted-foreground">The API cannot list or re-fetch freeze notices, so only notices drafted or changed in this browser session appear below. After a reload they cannot be shown again.</p>
      </SectionCard>

      {list.length === 0 ? (
        <EmptyState icon={FileWarning} title="No freeze notice in this session" description="Draft one above to start the Draft, Pending approval, Approved, Sent workflow." className="py-8" />
      ) : (
        list.map((n) => <NoticeCard key={n.id} notice={n} caseId={caseId} />)
      )}
    </div>
  );
}
