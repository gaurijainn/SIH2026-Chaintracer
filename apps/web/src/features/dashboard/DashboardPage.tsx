import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Can } from '@/features/auth/access';
import { INTAKE_ACCESS } from '@/layouts/nav';
import { AlertFeed } from './AlertFeed';
import { ChainSplitPanel, TopVaspsPanel, TracesPerDayPanel, TypologyMixPanel } from './ChartPanels';
import { KpiRow } from './KpiRow';
import { RecentCases } from './RecentCases';
import { useComplaintWindow } from './api';
import { buildCaseRows } from './metrics';
import { MAX_ROOMS } from './useAlertFeed';

/**
 * F3 Command dashboard. Open to every signed-in role (the F1 matrix gives all four roles the reads it uses);
 * each data source is skipped and its panel says so if a role ever loses that read permission.
 */
export function DashboardPage() {
  const complaints = useComplaintWindow();
  // The relay delivers alert.new per case room, so join the newest non-closed cases from the window already loaded.
  const caseIds = useMemo(
    () =>
      buildCaseRows(complaints.data?.items ?? [])
        .filter((c) => c.status !== 'CLOSED')
        .slice(0, MAX_ROOMS)
        .map((c) => c.id),
    [complaints.data],
  );

  return (
    <>
      <PageHeader title="Dashboard" description="Command dashboard: open cases, exchange landings and live alerts at a glance."
        actions={
          <Can anyOf={INTAKE_ACCESS}>
            <Button asChild variant="outline" size="sm">
              <Link to="/intake">Go to intake</Link>
            </Button>
          </Can>
        }
      />
      <div className="space-y-4">
        <KpiRow />
        <div className="grid gap-4 lg:grid-cols-2">
          <TracesPerDayPanel />
          <TypologyMixPanel />
          <TopVaspsPanel />
          <ChainSplitPanel />
        </div>
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="min-w-0 lg:col-span-2">
            <AlertFeed caseIds={caseIds} />
          </div>
          <div className="min-w-0 lg:col-span-3">
            <RecentCases />
          </div>
        </div>
      </div>
    </>
  );
}
