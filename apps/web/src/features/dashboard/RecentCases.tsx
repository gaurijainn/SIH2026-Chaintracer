import { flexRender, getCoreRowModel, getFilteredRowModel, getPaginationRowModel, getSortedRowModel, useReactTable, type ColumnDef, type FilterFn, type SortingState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, Briefcase } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChainBadge, RiskBadge, StatusBadge } from '@/components/common/badges';
import { SectionCard } from '@/components/common/cards';
import { EmptyState } from '@/components/common/states';
import { SearchInput } from '@/components/common/SearchInput';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { Boundary } from './Boundary';
import { useAlertRows, useComplaintWindow, type CaseStatus } from './api';
import { buildCaseRows, formatCount, formatDate, formatInr, severityRank, type CaseRow } from './metrics';

const STATUS_TONE: Record<CaseStatus, 'info' | 'warning' | 'success' | 'neutral'> = { OPEN: 'info', TRACING: 'warning', ATTRIBUTED: 'success', CLOSED: 'neutral' };
const STATUSES: CaseStatus[] = ['OPEN', 'TRACING', 'ATTRIBUTED', 'CLOSED'];
const PAGE_SIZES = [5, 10, 20];

const textFilter: FilterFn<CaseRow> = (row, _id, value: string) => {
  const q = value.trim().toLowerCase();
  if (!q) return true;
  const c = row.original;
  return [c.title, c.id, c.status, ...c.chains].some((s) => s.toLowerCase().includes(q));
};

const columns: ColumnDef<CaseRow>[] = [
  {
    id: 'title',
    header: 'Case',
    accessorFn: (r) => r.title,
    cell: ({ row }) => (
      <Link to={`/cases/${encodeURIComponent(row.original.id)}`} className="block max-w-[22rem] truncate rounded font-medium text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" title={row.original.title}>
        {row.original.title}
        <span className="sr-only"> (case {row.original.id})</span>
      </Link>
    ),
  },
  { id: 'status', header: 'Status', accessorKey: 'status', filterFn: 'equalsString', cell: ({ row }) => <StatusBadge tone={STATUS_TONE[row.original.status]}>{row.original.status}</StatusBadge> },
  { id: 'chains', header: 'Chains', accessorFn: (r) => r.chains.join(','), enableSorting: false, cell: ({ row }) => (row.original.chains.length ? <span className="flex flex-wrap gap-1">{row.original.chains.map((c) => <ChainBadge key={c} chain={c} />)}</span> : <span className="text-muted-foreground">—</span>) },
  { id: 'amountInr', header: 'Reported (INR)', accessorKey: 'amountInr', meta: { align: 'right' }, cell: ({ getValue }) => <span className="tabular-nums">{formatInr(getValue<number>())}</span> },
  { id: 'complaints', header: 'Complaints', accessorKey: 'complaints', meta: { align: 'right' }, cell: ({ getValue }) => <span className="tabular-nums">{formatCount(getValue<number>())}</span> },
  {
    id: 'alerts',
    header: 'Alerts',
    accessorFn: (r) => severityRank(r.topSeverity) * 1_000_000 + r.alerts,
    cell: ({ row }) => {
      const { alerts, topSeverity } = row.original;
      if (!alerts) return <span className="text-muted-foreground">None</span>;
      return (
        <span className="flex items-center gap-1.5">
          <span className="tabular-nums">{alerts}</span>
          {topSeverity === 'INFO' ? <StatusBadge tone="info">Info</StatusBadge> : topSeverity && <RiskBadge band={topSeverity} />}
        </span>
      );
    },
  },
  { id: 'lastReportedAt', header: 'Last reported', accessorKey: 'lastReportedAt', cell: ({ getValue }) => <span className="whitespace-nowrap">{formatDate(getValue<string>())}</span> },
];

function SortIcon({ dir }: { dir: false | 'asc' | 'desc' }) {
  const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown;
  return <Icon className={cn('size-3.5', !dir && 'opacity-40')} aria-hidden="true" />;
}

function CasesTable({ data }: { data: CaseRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'lastReportedAt', desc: true }]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 5 });

  // A fresh array every render would defeat TanStack's memoised row models and loop the auto page reset.
  const columnFilters = useMemo(() => (status ? [{ id: 'status', value: status }] : []), [status]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, pagination, globalFilter: query, columnFilters },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    globalFilterFn: textFilter,
    autoResetPageIndex: true,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: (r) => r.id,
  });

  const filtered = table.getFilteredRowModel().rows.length;
  const rows = table.getRowModel().rows;
  const { pageIndex, pageSize } = table.getState().pagination;
  const first = filtered ? pageIndex * pageSize + 1 : 0;
  const last = Math.min(filtered, (pageIndex + 1) * pageSize);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput label="Filter cases" placeholder="Filter by title, ID or chain" value={query} onChange={(e) => setQuery(e.target.value)} wrapperClassName="min-w-0 flex-1 basis-56" />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground">
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Briefcase} title="No cases match" description="Clear the filter to see every recent case." className="py-8" />
      ) : (
        <div className="table-scroll relative bg-card">
          <table className="w-full min-w-max border-collapse text-sm">
            <caption className="sr-only">Recent cases, sortable by column</caption>
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => {
                    const dir = h.column.getIsSorted();
                    const right = (h.column.columnDef.meta as { align?: string } | undefined)?.align === 'right';
                    return (
                      <th key={h.id} scope="col" aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : h.column.getCanSort() ? 'none' : undefined} className={cn('px-3 py-2 font-medium', right && 'text-right')}>
                        {h.column.getCanSort() ? (
                          <button type="button" onClick={h.column.getToggleSortingHandler()} className={cn('inline-flex items-center gap-1 rounded uppercase tracking-wide hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring', right && 'flex-row-reverse')}>
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            <SortIcon dir={dir} />
                            <span className="sr-only">{dir === 'asc' ? ', sorted ascending' : dir === 'desc' ? ', sorted descending' : ', click to sort'}</span>
                          </button>
                        ) : (
                          flexRender(h.column.columnDef.header, h.getContext())
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-accent/40">
                  {r.getVisibleCells().map((c) => (
                    <td key={c.id} className={cn('px-3 py-2 align-middle', (c.column.columnDef.meta as { align?: string } | undefined)?.align === 'right' && 'text-right')}>
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span aria-live="polite">
          {filtered === 0 ? 'No cases' : `${first}–${last} of ${formatCount(filtered)} ${filtered === 1 ? 'case' : 'cases'}`}
          {filtered !== data.length && ` (filtered from ${formatCount(data.length)})`}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5">
            Rows
            <select value={pageSize} onChange={(e) => table.setPageSize(Number(e.target.value))} className="h-8 rounded-md border border-input bg-background px-1.5 text-sm text-foreground">
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <span className="tabular-nums">
            Page {table.getPageCount() ? pageIndex + 1 : 0} of {table.getPageCount()}
          </span>
          <Button variant="outline" size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="Previous page">
            Previous
          </Button>
          <Button variant="outline" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="Next page">
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Recent cases, rolled up client-side from the bounded complaint window (there is no list-cases endpoint). */
export function RecentCases() {
  const complaints = useComplaintWindow();
  const alerts = useAlertRows();
  const data = useMemo(() => (complaints.data ? buildCaseRows(complaints.data.items, alerts.data ?? []) : []), [complaints.data, alerts.data]);
  const note = complaints.data?.truncated ? `Built from the newest ${formatCount(complaints.data.items.length)} of ${formatCount(complaints.data.total)} complaints.` : 'Rolled up from registered complaints';

  return (
    <SectionCard title="Recent cases" description={note} className="min-w-0">
      {/* alerts are optional enrichment: a failed or forbidden /alerts read must not hide the cases */}
      <Boundary queries={[complaints]} loadingRows={5}>
        {() =>
          data.length === 0 ? (
            <EmptyState icon={Briefcase} title="No cases yet" description="Cases are created when a complaint with a wallet address is registered at intake." className="py-8" />
          ) : (
            <CasesTable data={data} />
          )
        }
      </Boundary>
    </SectionCard>
  );
}
