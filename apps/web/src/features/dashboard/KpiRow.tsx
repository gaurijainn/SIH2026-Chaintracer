import { Banknote, Briefcase, Landmark, Snowflake, Timer, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { StatCard } from '@/components/common/cards';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api/errors';
import { isSkipped } from './Boundary';
import { useAlertRows, useComplaintWindow, useDashboardSummary, useVaspRows } from './api';
import { computeAlertKpis, formatCount, formatUsd } from './metrics';

interface Q {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  fetchStatus: 'fetching' | 'paused' | 'idle';
}

/** One KPI card whose value is a function of its source queries: skeleton while loading, message on error, dash when skipped. */
function Kpi({ label, icon, queries, value, hint }: { label: string; icon: LucideIcon; queries: Q[]; value: () => ReactNode; hint: () => ReactNode }) {
  const failed = queries.find((q) => q.isError);
  const skipped = queries.some(isSkipped);
  const loading = !failed && !skipped && queries.some((q) => q.isPending);
  let body: ReactNode;
  let note: ReactNode;
  if (failed) {
    body = <span className="text-risk-critical">Error</span>;
    note = <span role="alert">{errorMessage(failed.error)}</span>;
  } else if (skipped) {
    body = <span className="text-muted-foreground">—</span>;
    note = 'Not available for your role';
  } else if (loading) {
    body = <Skeleton className="h-8 w-24" />;
    note = <span className="sr-only">Loading</span>;
  } else {
    body = value();
    note = hint();
  }
  return <StatCard label={label} icon={icon} value={body} hint={note} />;
}

const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

/** 95 -> "1m 35s". Only shown once the backend defines the median; until then it is null and the card says N/A. */
const formatDuration = (seconds: number) => {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/**
 * The five KPI cards. Four come from GET /dashboard/summary; freeze windows have no summary field and stay derived from
 * alerts. Nothing is computed for the median: the backend returns null and the card shows N/A.
 */
export function KpiRow() {
  const summary = useDashboardSummary();
  const alerts = useAlertRows();
  const vasps = useVaspRows();
  const complaints = useComplaintWindow();

  const alertKpis = alerts.data ? computeAlertKpis(alerts.data, complaints.data?.items) : null;

  return (
    <section aria-label="Key figures" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Kpi label="Open cases" icon={Briefcase} queries={[summary]} value={() => formatCount(summary.data!.openCases)} hint={() => 'Cases not yet closed.'} />
      <Kpi
        label="Value traced (USD)"
        icon={Banknote}
        queries={[summary]}
        value={() => formatUsd(summary.data!.tracedValueUsd)}
        hint={() => 'From stored trace hops, each transfer counted once. Not converted to INR.'}
      />
      <Kpi
        label="VASPs identified"
        icon={Landmark}
        queries={[summary]}
        value={() => formatCount(summary.data!.vaspsIdentified)}
        hint={() => `Distinct exchanges with attributed addresses${vasps.data ? `; registry holds ${formatCount(vasps.data.length)}` : ''}.`}
      />
      <Kpi
        label="Freeze windows open"
        icon={Snowflake}
        queries={[alerts]}
        value={() => formatCount(alertKpis!.freezeWindowsOpen)}
        hint={() => `Landing alerts not snoozed, across ${plural(alertKpis!.freezeWindowCases, 'case')}.`}
      />
      <Kpi
        label="Median time-to-attribution"
        icon={Timer}
        queries={[summary]}
        value={() => {
          const m = summary.data!.timeToAttributionMedianSeconds;
          return m === null ? <span className="text-muted-foreground">N/A</span> : formatDuration(m);
        }}
        hint={() => (summary.data!.timeToAttributionMedianSeconds === null ? 'Not defined by the backend yet, so it is not estimated here.' : 'Median across attributed cases.')}
      />
    </section>
  );
}
