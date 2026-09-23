import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Title row for a page: heading, one-line context, and an action area that wraps on narrow screens. */
export function PageHeader({ title, description, actions, meta, className }: { title: string; description?: ReactNode; actions?: ReactNode; meta?: ReactNode; className?: string }) {
  return (
    <header className={cn('mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3', className)}>
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {meta && <div className="mt-1 flex flex-wrap items-center gap-2">{meta}</div>}
        {description && <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 print:hidden">{actions}</div>}
    </header>
  );
}
