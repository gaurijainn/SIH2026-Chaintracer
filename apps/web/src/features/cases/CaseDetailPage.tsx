import { Briefcase } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { StatusBadge } from '@/components/common/badges';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { AttributionView } from '@/features/attribution/AttributionView';
import { RequirePermission } from '@/features/auth/access';
import { GraphExplorer } from '@/features/graph/GraphExplorer';
import { useCaseView } from '@/features/graph/api';
import { shortAddr } from '@/features/graph/model';

const TONE = { OPEN: 'info', TRACING: 'warning', ATTRIBUTED: 'success', CLOSED: 'neutral' } as const;

/**
 * Case detail. F4 puts the fund-flow graph here; the remaining case sections (wallet risk, attribution, notices) belong to
 * later steps and are not built. Opening the page is the audited case view (GET /cases/:id).
 */
export function CaseDetailPage() {
  const { id = '' } = useParams();
  const view = useCaseView(id);
  const [picked, setPicked] = useState<string | null>(null);
  // Alerts deep-link here with the alert's own chain + address (F7); the graph selects that node once it has loaded.
  const [search] = useSearchParams();
  const fc = search.get('focusChain');
  const fa = search.get('focusAddr');
  const focus = fc && fa ? { chain: fc, addr: fa } : null;

  const c = view.data;
  const trace = c ? (c.traces.find((t) => t.id === picked) ?? c.traces.find((t) => t.status === 'COMPLETED') ?? c.traces[0]) : undefined;

  return (
    <>
      <PageHeader
        title="Case"
        description={c?.title}
        meta={
          c && (
            <>
              <StatusBadge tone={TONE[c.status]}>{c.status}</StatusBadge>
              <span className="text-xs text-muted-foreground">{c.id}</span>
            </>
          )
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/cases">Back to cases</Link>
          </Button>
        }
      />
      {view.isPending && view.fetchStatus !== 'idle' ? (
        <LoadingState rows={6} label="Loading case" />
      ) : view.isError ? (
        <ErrorState error={view.error} title="Could not load this case" onRetry={() => void view.refetch()} />
      ) : !c ? null : !trace ? (
        <EmptyState icon={Briefcase} title="No traces for this case yet" description="A trace starts when the case's wallet addresses are queued after intake." />
      ) : (
        <div className="space-y-3">
          {c.traces.length > 1 && (
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Trace</span>
              <select className="h-9 max-w-full rounded-md border border-input bg-background px-2 text-sm" value={trace.id} onChange={(e) => setPicked(e.target.value)}>
                {c.traces.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.seedChain} {shortAddr(t.seedAddr)} · {t.status.toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
          )}
          <RequirePermission permission="graph:read">
            <GraphExplorer key={trace.id} caseId={c.id} trace={trace} focus={focus} />
            <AttributionView key={`attribution-${trace.id}`} caseId={c.id} trace={trace} />
          </RequirePermission>
        </div>
      )}
    </>
  );
}
