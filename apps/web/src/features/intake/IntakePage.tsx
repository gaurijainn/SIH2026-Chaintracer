import { FileSpreadsheet, ListPlus, UserRoundPlus, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { StatusBadge } from '@/components/common/badges';
import { PageHeader } from '@/components/common/PageHeader';
import { cn } from '@/lib/cn';
import { ComplaintForm } from './ComplaintForm';
import { CsvImport } from './CsvImport';
import { TronFastPathNote } from './TronFastPath';

type Tab = 'single' | 'bulk' | 'paste';
const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'single', label: 'Single complaint', icon: UserRoundPlus },
  { id: 'bulk', label: 'Bulk CSV import', icon: FileSpreadsheet },
  { id: 'paste', label: 'Paste addresses', icon: ListPlus },
];

/** Complaint intake. Route access is gated by RequirePermission (complaint:create) in the router. */
export function IntakePage() {
  const [tab, setTab] = useState<Tab>('single');
  const move = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = TABS[(i + d + TABS.length) % TABS.length].id;
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };
  return (
    <>
      <PageHeader
        title="Complaint intake"
        description="Register NCRP complaints one at a time, in bulk from a CSV, or from a list of pasted wallet addresses. Every entry is checked before it is sent."
        meta={<StatusBadge tone="info">TRON fast path enabled</StatusBadge>}
      />
      <TronFastPathNote className="mb-4" />
      <div role="tablist" aria-label="Intake method" className="mb-4 flex flex-wrap gap-1 border-b">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => move(e, i)}
            className={cn('-mb-px inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm font-medium', tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            <t.icon className="size-4" aria-hidden="true" />
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'single' && <ComplaintForm mode="single" />}
        {tab === 'bulk' && <CsvImport />}
        {tab === 'paste' && <ComplaintForm mode="paste" />}
      </div>
    </>
  );
}
