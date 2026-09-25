import { BellRing, Radio } from 'lucide-react';
import { Link } from 'react-router-dom';
import { StatusBadge, RiskBadge } from '@/components/common/badges';
import { EmptyState } from '@/components/common/states';
import { SectionCard } from '@/components/common/cards';
import { Boundary } from './Boundary';
import { useAlertRows, type AlertSeverity } from './api';
import { formatCount, formatTime, RULE_LABELS, shortAddress, shortId } from './metrics';
import { mergeFeed, useAlertFeed, type FeedAlert, type FeedStatus } from './useAlertFeed';

const STATUS: Record<FeedStatus, { tone: 'success' | 'warning' | 'neutral'; text: string }> = {
  connected: { tone: 'success', text: 'Live' },
  connecting: { tone: 'neutral', text: 'Connecting' },
  reconnecting: { tone: 'warning', text: 'Reconnecting' },
};

/** RiskBadge covers LOW–CRITICAL; INFO is an alert severity with no risk band, so it gets a neutral pill rather than a new category. */
function Severity({ severity }: { severity: AlertSeverity }) {
  return severity === 'INFO' ? <StatusBadge tone="info">Info</StatusBadge> : <RiskBadge band={severity} />;
}

function AlertItem({ alert }: { alert: FeedAlert }) {
  return (
    <li className="flex flex-col gap-1 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Severity severity={alert.severity} />
        <span className="text-sm font-medium">{RULE_LABELS[alert.rule]}</span>
        {alert.live && <StatusBadge tone="info">New</StatusBadge>}
        <time className="ml-auto text-xs text-muted-foreground tabular-nums" dateTime={new Date(alert.at).toISOString()}>
          {formatTime(alert.at)} IST
        </time>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono" title={alert.address}>
          {alert.chain ? `${alert.chain} · ` : ''}
          {shortAddress(alert.address)}
        </span>
        {alert.amount !== null && <span className="tabular-nums">Amount {formatCount(Number(alert.amount))}</span>}
        <Link to={`/cases/${encodeURIComponent(alert.caseId)}`} className="rounded font-medium text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Open case ${alert.caseId}`}>
          Case {shortId(alert.caseId)}
        </Link>
      </div>
    </li>
  );
}

/**
 * Live alert feed: alerts persisted in GET /alerts plus `alert.new` events as they arrive. New items are added
 * inside an aria-live="off" list so screen readers are not interrupted and focus never moves.
 */
export function AlertFeed({ caseIds }: { caseIds: string[] }) {
  const stored = useAlertRows();
  const { live, status } = useAlertFeed(caseIds);
  const s = STATUS[status];

  return (
    <SectionCard
      title="Live alerts"
      description="Newest first; new events appear without refreshing"
      actions={
        <StatusBadge tone={s.tone} icon={<Radio className="size-3.5" aria-hidden="true" />}>
          <span role="status">{s.text}</span>
        </StatusBadge>
      }
      bodyClassName="max-h-[26rem] overflow-y-auto"
    >
      <Boundary queries={[stored]}>
        {() => {
          const items = mergeFeed(live, stored.data!);
          if (items.length === 0) return <EmptyState icon={BellRing} title="No alerts yet" description="When a watched wallet moves funds, the alert appears here immediately." className="py-8" />;
          return (
            <ul aria-label="Alerts" aria-live="off" className="divide-y">
              {items.map((a) => (
                <AlertItem key={a.id} alert={a} />
              ))}
            </ul>
          );
        }}
      </Boundary>
    </SectionCard>
  );
}
