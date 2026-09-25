import { FileText } from 'lucide-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/states';
import { Can } from '@/features/auth/access';
import { Boundary } from '@/features/dashboard/Boundary';
import { useAlertRows, useComplaintWindow } from '@/features/dashboard/api';
import { buildCaseRows } from '@/features/dashboard/metrics';
import { NoticeBuilder } from './NoticeBuilder';
import { ReportBuilder } from './ReportBuilder';

/**
 * F8 report and freeze-notice builder. The case comes from the same real source as the dashboard's recent cases (there is no
 * list-cases endpoint) or from ?caseId= (F6 links here with the VASP as ?vaspId=). Everything shown is a backend response.
 */
export function ReportsPage() {
  const [search, setSearch] = useSearchParams();
  const caseId = search.get('caseId');
  const vaspId = search.get('vaspId');
  const complaints = useComplaintWindow();
  const alerts = useAlertRows();
  const rows = useMemo(() => (complaints.data ? buildCaseRows(complaints.data.items, alerts.data ?? []) : []), [complaints.data, alerts.data]);
  const known = rows.find((r) => r.id === caseId);

  return (
    <>
      <PageHeader title="Reports" description="Evidence reports and freeze notices for a case." />
      <Boundary queries={[complaints]} loadingRows={2}>
        {() => (
          <div className="space-y-4">
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Case</span>
              <select
                className="h-9 max-w-full rounded-md border border-input bg-background px-2 text-sm"
                value={caseId ?? ''}
                onChange={(e) => setSearch(e.target.value ? { caseId: e.target.value } : {}, { replace: true })}
              >
                <option value="">Select a case</option>
                {caseId && !known && <option value={caseId}>{caseId}</option>}
                {rows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title} · {r.status}
                  </option>
                ))}
              </select>
            </label>
            {!caseId ? (
              <EmptyState icon={FileText} title="Choose a case" description={rows.length ? 'Select a case to generate its evidence report or draft a freeze notice.' : 'No cases exist yet. Cases are created when a complaint with a wallet address is registered at intake.'} className="py-10" />
            ) : (
              <div key={caseId} className="grid items-start gap-4 xl:grid-cols-2">
                <Can permission="report:generate" fallback={<ReportBuilder caseId={caseId} canGenerate={false} />}>
                  <ReportBuilder caseId={caseId} canGenerate />
                </Can>
                <NoticeBuilder caseId={caseId} presetVaspId={vaspId} />
              </div>
            )}
          </div>
        )}
      </Boundary>
    </>
  );
}
