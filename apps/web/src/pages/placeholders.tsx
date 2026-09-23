import { Bell, Briefcase, Eye, FileText, LayoutDashboard, Landmark, Upload, type LucideIcon } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { StatusBadge } from '@/components/common/badges';
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
  next?: { to: string; label: string };
}

/** Intentional stand-in for a screen a later phase builds. No fake data. */
function Placeholder({ title, description, icon, phase, emptyTitle, emptyText, next }: PlaceholderProps) {
  return (
    <>
      <PageHeader title={title} description={description} meta={<StatusBadge tone="neutral">Planned · {phase}</StatusBadge>} />
      <EmptyState
        icon={icon}
        title={emptyTitle}
        description={emptyText}
        action={
          next && (
            <Button asChild variant="outline" size="sm">
              <Link to={next.to}>{next.label}</Link>
            </Button>
          )
        }
      />
    </>
  );
}

export const DashboardPage = () => (
  <Placeholder title="Dashboard" description="Live overview of open cases, alerts and freeze windows." icon={LayoutDashboard} phase="F3" emptyTitle="Operations overview will appear here" emptyText="Key figures, the live alert feed and case activity are added in a later step." next={{ to: '/intake', label: 'Go to intake' }} />
);

export const IntakePage = () => (
  <Placeholder title="Complaint intake" description="Register a complaint and start a trace from a victim's transaction." icon={Upload} phase="F2" emptyTitle="The intake form will appear here" emptyText="Enter a wallet address or transaction hash, and the trace will start from there." next={{ to: '/cases', label: 'View cases' }} />
);

export const CasesPage = () => (
  <Placeholder title="Cases" description="All investigations you can access." icon={Briefcase} phase="F2" emptyTitle="The case workspace will appear here" emptyText="Cases created from complaints are listed here with their risk and status." next={{ to: '/intake', label: 'Start from intake' }} />
);

export function CaseDetailPage() {
  const { id } = useParams();
  return (
    <Placeholder title="Case" description={`Case ${id ?? ''}`.trim()} icon={Briefcase} phase="F4–F6" emptyTitle="Case details will appear here" emptyText="The fund-flow graph, wallet risk explanations and VASP attribution for this case are added in later steps." next={{ to: '/cases', label: 'Back to cases' }} />
  );
}

export const AlertsPage = () => (
  <Placeholder title="Alerts" description="Real-time movements on watched wallets, including freeze-window openings." icon={Bell} phase="F7" emptyTitle="No alert feed yet" emptyText="When a watched wallet moves funds, the alert is shown here immediately." next={{ to: '/watchlist', label: 'View watchlist' }} />
);

export const WatchlistPage = () => (
  <Placeholder title="Watchlist" description="Mule and frontier addresses under live monitoring." icon={Eye} phase="F7" emptyTitle="The watchlist will appear here" emptyText="Addresses flagged during a trace are added here and monitored across chains." next={{ to: '/cases', label: 'View cases' }} />
);

export const VaspsPage = () => (
  <Placeholder title="VASP registry" description="Exchanges and service providers, with attribution confidence." icon={Landmark} phase="F6" emptyTitle="The VASP registry will appear here" emptyText="Look up an exchange, its jurisdiction and the freeze contact for a notice." />
);

export const ReportsPage = () => (
  <Placeholder title="Reports" description="Evidence reports and freeze notices." icon={FileText} phase="F8" emptyTitle="Generated reports will appear here" emptyText="Evidence PDFs and freeze notices for each case are listed with their verification hash." next={{ to: '/cases', label: 'View cases' }} />
);
