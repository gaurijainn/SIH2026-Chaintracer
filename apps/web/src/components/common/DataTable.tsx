import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
}

/**
 * Thin presentational table. The wrapper scrolls horizontally on narrow screens, so wide tables never
 * stretch the page. Loading / empty / error handling stays with the caller (use the state components).
 */
export function DataTable<T>({ columns, rows, rowKey, caption, className }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; caption?: string; className?: string }) {
  return (
    <div className={cn('table-scroll bg-card', className)}>
      <table className="w-full min-w-max border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn('px-3 py-2 font-medium', c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={rowKey(r)} className="hover:bg-accent/40">
              {columns.map((c) => (
                <td key={c.key} className={cn('px-3 py-2 align-middle', c.className)}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
