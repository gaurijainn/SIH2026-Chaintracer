import { Bell, Briefcase, Eye, FileText, Landmark, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '@/components/common/badges';
import { Can, ReadOnlyNotice } from '@/features/auth/access';
import { INTAKE_ACCESS } from '@/layouts/nav';
import type { Permission } from '@/lib/permissions';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/states';
import { Button } from '@/components/ui/button';

interface PlaceholderProps {
  title: string;
  description: string;
  icon: LucideIcon;
  phase: string;
  emptyTitle: string;
  emptyText: string;
  /** Suggested next step; `anyOf` hides it from roles that could not open the target. */
  next?: { to: string; label: string; anyOf?: readonly Permission[] };
  /** If set, roles without this permission see a "Read-only access" pill. */
  writePermission?: Permission;
}

/** Intentional stand-in for a screen a later phase builds. No fake data. */
function Placeholder({ title, description, icon, phase, emptyTitle, emptyText, next, writePermission }: PlaceholderProps) {
  return (
    <>
      <PageHeader title={title} description={description} meta={
          <>
            <StatusBadge tone="neutral">Planned · {phase}</StatusBadge>
            {writePermission && <ReadOnlyNotice writePermission={writePermission} />}
          </>
        } />
      <EmptyState
        icon={icon}
        title={emptyTitle}
        description={emptyText}
        action={
          next && (
            <Can anyOf={next.anyOf ?? ['case:read']} fallback={null}>
              <Button asChild variant="outline" size="sm">
                <Link to={next.to}>{next.label}</Link>
              </Button>
            </Can>
          )
        }
      />
    </>
  );
}

export const CasesPage = () => (
  <Placeholder writePermission="notice:draft" title="Cases" description="All investigations you can access." icon={Briefcase} phase="F2" emptyTitle="The case workspace will appear here" emptyText="Cases created from complaints are listed here with their risk and status." next={{ to: '/intake', label: 'Start from intake', anyOf: INTAKE_ACCESS }} />
);

export const AlertsPage = () => (
  <Placeholder writePermission="alert:update" title="Alerts" description="Real-time movements on watched wallets, including freeze-window openings." icon={Bell} phase="F7" emptyTitle="No alert feed yet" emptyText="When a watched wallet moves funds, the alert is shown here immediately." next={{ to: '/watchlist', label: 'View watchlist' }} />
);

export const WatchlistPage = () => (
  <Placeholder writePermission="watchlist:write" title="Watchlist" description="Mule and frontier addresses under live monitoring." icon={Eye} phase="F7" emptyTitle="The watchlist will appear here" emptyText="Addresses flagged during a trace are added here and monitored across chains." next={{ to: '/cases', label: 'View cases' }} />
);

export const VaspsPage = () => (
  <Placeholder writePermission="vasp:write" title="VASP registry" description="Exchanges and service providers, with attribution confidence." icon={Landmark} phase="F6" emptyTitle="The VASP registry will appear here" emptyText="Look up an exchange, its jurisdiction and the freeze contact for a notice." />
);

export const ReportsPage = () => (
  <Placeholder title="Reports" description="Evidence reports and freeze notices." icon={FileText} phase="F8" emptyTitle="Generated reports will appear here" emptyText="Evidence PDFs and freeze notices for each case are listed with their verification hash." next={{ to: '/cases', label: 'View cases' }} />
);
