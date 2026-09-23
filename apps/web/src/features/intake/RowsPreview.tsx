import { CircleAlert, CircleCheck, CopyMinus, Link2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ChainBadge, StatusBadge } from '@/components/common/badges';
import { EmptyState } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { PreviewRow, RowStatus } from './csvCore';
import { TronFastPathTag } from './TronFastPath';

export type RowFilter = 'all' | RowStatus | 'linked' | 'tron';
export const PAGE_SIZE = 100;

const FILTERS: { value: RowFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'valid', label: 'Valid' },
  { value: 'invalid', label: 'Invalid' },
  { value: 'duplicate', label: 'Duplicates' },
  { value: 'linked', label: 'Linked' },
  { value: 'tron', label: 'TRON' },
];

const matches = (r: PreviewRow, f: RowFilter) => (f === 'all' ? true : f === 'linked' ? r.linkedRows.length > 0 : f === 'tron' ? r.tron : r.status === f);

const short = (v: string) => (v.length > 20 ? `${v.slice(0, 10)}…${v.slice(-6)}` : v);

/** Paged preview of the parsed CSV. Rendering is capped at PAGE_SIZE rows so a 20,000-row file never bloats the DOM. */
export function RowsPreview({ rows }: { rows: PreviewRow[] }) {
  const [filter, setFilter] = useState<RowFilter>('all');
  const [tronFirst, setTronFirst] = useState(true);
  const [page, setPage] = useState(0);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.value, rows.filter((r) => matches(r, f.value)).length])) as Record<RowFilter, number>, [rows]);
  const view = useMemo(() => {
    const list = rows.filter((r) => matches(r, filter));
    return tronFirst ? [...list].sort((a, b) => Number(b.tron) - Number(a.tron) || a.index - b.index) : list;
  }, [rows, filter, tronFirst]);
  const pages = Math.max(1, Math.ceil(view.length / PAGE_SIZE));
  useEffect(() => setPage(0), [filter, tronFirst, rows]);
  const slice = view.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Filter preview rows" className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn('inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium', filter === f.value ? 'border-primary bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {f.label}
              <span className="tabular-nums opacity-80">{counts[f.value]}</span>
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={tronFirst} onChange={(e) => setTronFirst(e.target.checked)} className="size-4" />
          TRON rows first
        </label>
      </div>

      {slice.length === 0 ? (
        <EmptyState title="No rows match this filter" description="Choose another filter to see the other rows." className="py-8" />
      ) : (
        <div className="table-scroll" data-testid="preview-table">
          <table className="w-full min-w-max border-collapse text-sm">
            <caption className="sr-only">Parsed CSV rows with validation status</caption>
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {['Row', 'Address', 'Chain', 'Date', 'Amount (INR)', 'Category', 'NCRP ack', 'Status', 'Markers'].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {slice.map((r) => {
                const first = r.entries.find((e) => e.kind === 'ADDRESS') ?? r.entries[0];
                const extra = r.entries.length - 1;
                return (
                  <tr key={r.index} data-status={r.status} className={cn('align-top', r.tron && r.status === 'valid' && 'border-l-2 border-l-chain-tron', r.status === 'invalid' && 'bg-risk-critical-soft/40')}>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.index}</td>
                    <td className="px-3 py-2 font-mono text-xs" title={first?.value}>
                      {first ? short(first.value) : <span className="text-muted-foreground">{r.fields.addresses || '—'}</span>}
                      {extra > 0 && <span className="ml-1 text-muted-foreground">+{extra}</span>}
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {r.chains.length === 0 && <span className="text-muted-foreground">—</span>}
                        {r.chains.map((c) => (
                          <ChainBadge key={c} chain={c} className={r.entries.some((e) => e.chain === c) ? '' : 'opacity-60'} />
                        ))}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">{r.fields.reportedAt || '—'}</td>
                    <td className="px-3 py-2 tabular-nums">{r.fields.amountInr || '—'}</td>
                    <td className="px-3 py-2">{r.fields.category || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.fields.ackNo || '—'}</td>
                    <td className="min-w-56 px-3 py-2">
                      {r.status === 'valid' && (
                        <StatusBadge tone="success" icon={<CircleCheck className="size-3" aria-hidden="true" />}>
                          Valid
                        </StatusBadge>
                      )}
                      {r.status === 'invalid' && (
                        <>
                          <StatusBadge tone="danger" icon={<CircleAlert className="size-3" aria-hidden="true" />}>
                            Invalid
                          </StatusBadge>
                          <ul className="mt-1 space-y-0.5">
                            {r.errors.map((e, i) => (
                              <li key={i} className="text-xs text-risk-critical">
                                {e.message}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {r.status === 'duplicate' && (
                        <StatusBadge tone="warning" icon={<CopyMinus className="size-3" aria-hidden="true" />}>
                          Duplicate
                        </StatusBadge>
                      )}
                      {r.warnings.length > 0 && r.status !== 'invalid' && <p className="mt-1 text-xs text-risk-medium">{r.warnings[0].message}</p>}
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {r.tron && r.status === 'valid' && <TronFastPathTag />}
                        {r.status === 'duplicate' && r.duplicate && (
                          <StatusBadge tone="warning">
                            {r.duplicate.identical ? 'Duplicate row' : 'Duplicate ack no.'} of row {r.duplicate.ofRow}
                          </StatusBadge>
                        )}
                        {r.linkedRows.length > 0 && (
                          <StatusBadge tone="info" icon={<Link2 className="size-3" aria-hidden="true" />}>
                            Linked to row{r.linkedRows.length > 1 ? 's' : ''} {r.linkedRows.slice(0, 3).join(', ')}
                            {r.linkedRows.length > 3 ? '…' : ''}
                          </StatusBadge>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav aria-label="Preview pages" className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            Rows {page * PAGE_SIZE + 1}–{Math.min(view.length, (page + 1) * PAGE_SIZE)} of {view.length}
          </span>
          <span className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </span>
        </nav>
      )}
    </div>
  );
}
