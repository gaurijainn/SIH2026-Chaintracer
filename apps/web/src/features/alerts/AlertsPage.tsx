import { useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, Bell, BellOff, BellRing, CircleAlert, GitBranch, Info, Radio, RefreshCw, RotateCcw, UserCheck, Check, type LucideIcon } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChainBadge, StatusBadge } from '@/components/common/badges';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { useComplaintWindow } from '@/features/dashboard/api';
import { buildCaseRows } from '@/features/dashboard/metrics';
import { MAX_ROOMS } from '@/features/dashboard/useAlertFeed';
import { ReadOnlyNotice, useCan } from '@/features/auth/access';
import { CHAIN_LIST, formatWhen, shortAddr } from '@/features/graph/model';
import { cn } from '@/lib/cn';
import type { Chain, StatusTone } from '@/lib/tokens';
import { RISK_BANDS } from '@/lib/tokens';
import { useAuthStore } from '@/stores/auth';
import { toast, useToastStore } from '@/stores/toast';
import { useUiStore } from '@/stores/ui';
import { alertKeys, useAlerts, useUpdateAlert } from './api';
import {
  ALERT_SEVERITIES, ALERT_STATUSES, alertFiltersActive, formatAmount, NO_ALERT_FILTERS, RULE_LABELS, SEVERITY_LABELS, SNOOZE_OPTIONS, STATUS_LABELS,
  type Alert, type AlertFilters, type AlertNewEvent, type AlertSeverity, type AlertStatus,
} from './model';
import { playAlertSound, primeAlertSound } from './sound';
import { useAlertSocket, type AlertLiveStatus } from './useAlertSocket';

const field = 'h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring';
const labelCls = 'flex flex-col gap-1 text-xs text-muted-foreground';

const SEVERITY_LOOK: Record<AlertSeverity, { icon: LucideIcon; classes: string }> = {
  INFO: { icon: Info, classes: 'border-info/40 bg-info-soft text-info' },
  MEDIUM: { icon: CircleAlert, classes: RISK_BANDS.MEDIUM.classes },
  HIGH: { icon: AlertTriangle, classes: RISK_BANDS.HIGH.classes },
  CRITICAL: { icon: AlertOctagon, classes: `${RISK_BANDS.CRITICAL.classes} border-2` },
};

/** Severity is icon + upper-case text + border weight, never colour alone. */
function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  const look = SEVERITY_LOOK[severity];
  const Icon = look.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-xs font-semibold uppercase leading-none tracking-wide', look.classes)}>
      <Icon className="size-3.5" aria-hidden="true" />
      {severity}
      <span className="sr-only"> severity</span>
    </span>
  );
}

const STATUS_TONE: Record<AlertStatus, StatusTone> = { NEW: 'info', ACKNOWLEDGED: 'success', ASSIGNED: 'neutral', SNOOZED: 'warning' };

const LIVE_TEXT: Record<AlertLiveStatus, string> = {
  off: 'Live updates off: no cases to listen to yet',
  connecting: 'Live: connecting',
  connected: 'Live: listening for new alerts',
  reconnecting: 'Live: reconnecting',
};

export function AlertsPage() {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user);
  const soundOn = useUiStore((s) => s.alertSoundEnabled);
  const setSoundOn = useUiStore((s) => s.setAlertSoundEnabled);
  const [filters, setFilters] = useState<AlertFilters>(NO_ALERT_FILTERS);
  const alerts = useAlerts(filters);
  const update = useUpdateAlert();
  const canUpdate = can('alert:update');
  const canOpenCase = can('case:read');

  // Only alert.new events received while this page is open are "new"; ids already handled are ignored (a repeated event).
  const seen = useRef<Set<string>>(new Set());
  const onNew = useCallback(
    (ev: AlertNewEvent) => {
      if (seen.current.has(ev.id)) return;
      seen.current.add(ev.id);
      void qc.invalidateQueries({ queryKey: alertKeys.all });
      if (ev.severity !== 'CRITICAL') return;
      const amount = formatAmount(ev.amount);
      useToastStore.getState().push(
        {
          kind: 'error',
          title: `CRITICAL alert: ${RULE_LABELS[ev.rule]}`,
          description: `${ev.chain} ${shortAddr(ev.address)}${amount ? ` · amount ${amount}` : ''}`,
          action: can('case:read') ? { label: 'Open case', to: focusLink(ev) } : undefined,
        },
        12_000,
      );
      if (soundOn) playAlertSound();
    },
    [qc, soundOn, can],
  );
  // Cases come from the same source as the dashboard (GET /complaints): the API has no case-list endpoint.
  const complaints = useComplaintWindow();
  const cases = useMemo(() => buildCaseRows(complaints.data?.items ?? []), [complaints.data]);
  const rooms = useMemo(() => (filters.caseId ? [filters.caseId] : cases.filter((c) => c.status !== 'CLOSED').slice(0, MAX_ROOMS).map((c) => c.id)), [cases, filters.caseId]);
  const live = useAlertSocket(rooms, onNew);

  const reset = () => setFilters(NO_ALERT_FILTERS);
  const toggleSound = () => {
    if (soundOn) return setSoundOn(false);
    if (primeAlertSound()) {
      setSoundOn(true);
      playAlertSound();
    } else toast.warning('Sound is not available', 'This browser did not allow audio. The on-screen toast still appears for CRITICAL alerts.');
  };

  const run = (patch: Parameters<typeof update.mutate>[0], done: string) =>
    update.mutate(patch, { onSuccess: () => toast.success(done), onError: (err) => toast.error('Could not update the alert', err) });

  const pendingId = update.isPending ? update.variables?.id : undefined;
  const rows = alerts.data ?? [];

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Movements on watched wallets, including freeze-window openings, newest first."
        meta={<ReadOnlyNotice writePermission="alert:update" />}
        actions={
          <>
            <Button type="button" variant={soundOn ? 'default' : 'outline'} size="sm" aria-pressed={soundOn} onClick={toggleSound}>
              {soundOn ? <BellRing className="size-4" aria-hidden="true" /> : <BellOff className="size-4" aria-hidden="true" />}
              {soundOn ? 'Alert sound on' : 'Enable alert sound'}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void alerts.refetch()} disabled={alerts.isFetching}>
              <RefreshCw className={cn('size-4', alerts.isFetching && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" /> Refresh
            </Button>
          </>
        }
      />

      <form className="mb-3 flex flex-wrap items-end gap-2" aria-label="Alert filters" onSubmit={(e) => e.preventDefault()}>
        <label className={labelCls}>
          Severity
          <select className={field} value={filters.severity} onChange={(e) => setFilters({ ...filters, severity: e.target.value as AlertSeverity | '' })}>
            <option value="">All severities</option>
            {ALERT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          Status
          <select className={field} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as AlertStatus | '' })}>
            <option value="">All statuses</option>
            {ALERT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          Case
          <select className={cn(field, 'max-w-[18rem]')} value={filters.caseId} onChange={(e) => setFilters({ ...filters, caseId: e.target.value })}>
            <option value="">All cases</option>
            {cases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} · {shortAddr(c.id)}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" size="sm" variant="ghost" onClick={reset} disabled={!alertFiltersActive(filters)}>
          <RotateCcw className="size-4" aria-hidden="true" /> Reset filters
        </Button>
      </form>

      <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <StatusBadge tone={live.status === 'connected' ? 'success' : 'neutral'} icon={<Radio className="size-3.5" aria-hidden="true" />}>
          <span role="status" data-testid="live-status">
            {LIVE_TEXT[live.status]}
          </span>
        </StatusBadge>
      </p>

      {alerts.isPending && alerts.fetchStatus !== 'idle' ? (
        <LoadingState rows={6} label="Loading alerts" />
      ) : alerts.isError && !alerts.data ? (
        <ErrorState error={alerts.error} title="Could not load alerts" onRetry={() => void alerts.refetch()} />
      ) : !alerts.data ? (
        <EmptyState icon={Bell} title="Not available for your role" description="Your role does not include alert access." />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Bell}
          title={alertFiltersActive(filters) ? 'No alerts match these filters' : 'No alerts yet'}
          description={alertFiltersActive(filters) ? 'Loosen the severity, status or case filter.' : 'When a watched wallet moves funds, the alert is listed here.'}
          action={alertFiltersActive(filters) ? <Button variant="outline" size="sm" onClick={reset}>Reset filters</Button> : undefined}
        />
      ) : (
        <div className={cn('overflow-x-auto rounded-lg border bg-card', alerts.isFetching && 'opacity-90')} aria-busy={alerts.isFetching}>
          <table className="w-full min-w-[60rem] border-collapse text-left text-sm">
            <caption className="sr-only">
              {rows.length} {rows.length === 1 ? 'alert' : 'alerts'}, newest first
            </caption>
            <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {['Severity', 'Alert', 'Case', 'Address', 'Status', 'Created (IST)', 'Actions'].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {t(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((a) => (
                <AlertRow
                  key={a.id}
                  alert={a}
                  meId={me?.id}
                  busy={pendingId === a.id}
                  canUpdate={canUpdate}
                  canOpenCase={canOpenCase}
                  onAcknowledge={() => run({ id: a.id, action: 'acknowledge' }, 'Alert acknowledged')}
                  onAssignMe={() => me && run({ id: a.id, action: 'assign', assigneeId: me.id }, 'Alert assigned to you')}
                  onSnooze={(ms) => run({ id: a.id, action: 'snooze', snoozedUntil: new Date(Date.now() + ms).toISOString() }, 'Alert snoozed')}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {alerts.data && (
        <p className="mt-2 text-xs text-muted-foreground">
          Assigning is limited to yourself: the API has no endpoint that lists users to choose from.
        </p>
      )}
    </>
  );
}

/** The alert's own chain and address are the most specific graph location the API returns (the list has no hop details). */
const focusLink = (a: { caseId: string; chain: string; address: string }) =>
  `/cases/${encodeURIComponent(a.caseId)}?focusChain=${encodeURIComponent(a.chain)}&focusAddr=${encodeURIComponent(a.address)}`;

function AlertRow({ alert: a, meId, busy, canUpdate, canOpenCase, onAcknowledge, onAssignMe, onSnooze }: {
  alert: Alert; meId: string | undefined; busy: boolean; canUpdate: boolean; canOpenCase: boolean;
  onAcknowledge: () => void; onAssignMe: () => void; onSnooze: (ms: number) => void;
}) {
  const amount = formatAmount(a.amount);
  const known = (CHAIN_LIST as string[]).includes(a.chain);
  const mine = !!meId && a.assigneeId === meId;
  return (
    <tr className={cn('align-top', a.severity === 'CRITICAL' && 'bg-risk-critical-soft/30')} data-testid={`alert-${a.id}`}>
      <td className="px-3 py-2.5">
        <SeverityBadge severity={a.severity} />
      </td>
      <td className="max-w-[20rem] px-3 py-2.5">
        <div className="font-medium">{RULE_LABELS[a.rule]}</div>
        <div className="text-xs text-muted-foreground">{a.rule}</div>
        <p className="mt-1 text-xs">{a.message}</p>
        {amount && <p className="mt-0.5 text-xs text-muted-foreground">Amount {amount}</p>}
      </td>
      <td className="px-3 py-2.5">
        {canOpenCase ? (
          <Link to={`/cases/${encodeURIComponent(a.caseId)}`} className="font-mono text-xs underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" title={a.caseId}>
            {shortAddr(a.caseId)}
          </Link>
        ) : (
          <span className="font-mono text-xs" title={a.caseId}>
            {shortAddr(a.caseId)}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5">
        {known ? <ChainBadge chain={a.chain as Chain} /> : <StatusBadge>{a.chain}</StatusBadge>}
        <div className="mt-1 font-mono text-xs" title={a.address}>
          {shortAddr(a.address)}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <StatusBadge tone={STATUS_TONE[a.status]}>{STATUS_LABELS[a.status]}</StatusBadge>
        {a.status === 'ASSIGNED' && <div className="mt-1 text-xs text-muted-foreground">{mine ? 'Assigned to you' : 'Assigned to another user'}</div>}
        {a.status === 'SNOOZED' && a.snoozedUntil && <div className="mt-1 text-xs text-muted-foreground">Until {formatWhen(Date.parse(a.snoozedUntil))}</div>}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-xs tabular-nums">
        <time dateTime={a.createdAt}>{formatWhen(Date.parse(a.createdAt))}</time>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {canOpenCase && (
            <Button asChild size="sm" variant="outline">
              <Link to={focusLink(a)} aria-label={`View ${a.chain} ${shortAddr(a.address)} in the case graph`}>
                <GitBranch className="size-4" aria-hidden="true" /> View in graph
              </Link>
            </Button>
          )}
          {canUpdate && (
            <>
              <Button type="button" size="sm" variant="outline" disabled={busy || a.status === 'ACKNOWLEDGED'} onClick={onAcknowledge} aria-label={`Acknowledge ${a.severity} alert on ${shortAddr(a.address)}`}>
                <Check className="size-4" aria-hidden="true" /> Acknowledge
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={busy || mine} onClick={onAssignMe} aria-label={`Assign alert on ${shortAddr(a.address)} to me`}>
                <UserCheck className="size-4" aria-hidden="true" /> Assign to me
              </Button>
              <select
                className={cn(field, 'h-8 text-xs')}
                aria-label={`Snooze alert on ${shortAddr(a.address)}`}
                value=""
                disabled={busy}
                onChange={(e) => e.target.value && onSnooze(Number(e.target.value))}
              >
                <option value="">Snooze…</option>
                {SNOOZE_OPTIONS.map((o) => (
                  <option key={o.ms} value={o.ms}>
                    {o.label}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
