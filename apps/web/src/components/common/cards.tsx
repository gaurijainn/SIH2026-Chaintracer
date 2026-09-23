import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Bordered panel with an optional header row. Flat: border only, no heavy shadow. */
export function SectionCard({ title, description, actions, children, className, bodyClassName }: { title?: string; description?: string; actions?: ReactNode; children?: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn('rounded-lg border bg-card text-card-foreground', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="truncate text-sm font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2 print:hidden">{actions}</div>}
        </div>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/** Single metric: label, value, optional hint/trailing slot. Values use tabular numerals for scanning. */
export function StatCard({ label, value, hint, icon: Icon, trailing, className }: { label: string; value: ReactNode; hint?: ReactNode; icon?: LucideIcon; trailing?: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-lg border bg-card p-4', className)}>
      <div className="flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {Icon && <Icon className="size-3.5" aria-hidden="true" />}
          {label}
        </span>
        {trailing}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
