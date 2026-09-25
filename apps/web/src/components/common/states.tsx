import { Inbox, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Skeleton, Spinner } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';

const frame = 'flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center';

/** Nothing here yet: says what this area is for and offers the next step. */
export function EmptyState({ icon: Icon = Inbox, title, description, action, className }: { icon?: LucideIcon; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={cn(frame, className)}>
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <h2 className="text-sm font-semibold">{t(title)}</h2>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{typeof description === 'string' ? t(description) : description}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** Skeleton rows by default; `spinner` for blocking actions. Announces itself to screen readers. */
export function LoadingState({ rows = 4, label = 'Loading', spinner, className }: { rows?: number; label?: string; spinner?: boolean; className?: string }) {
  const { t } = useTranslation();
  label = t(label);
  if (spinner) {
    return (
      <div className={cn('flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground', className)}>
        <Spinner label={label} /> {label}…
      </div>
    );
  }
  return (
    <div role="status" aria-label={label} className={cn('space-y-3', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn('h-9', i % 3 === 2 && 'w-2/3')} />
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

/** Failure with a readable message and an optional retry. Pass the thrown value; internals are never shown. */
export function ErrorState({ error, title = 'Something went wrong', onRetry, className }: { error?: unknown; title?: string; onRetry?: () => void; className?: string }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className={cn(frame, 'border-risk-critical/40', className)}>
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-risk-critical-soft text-risk-critical">
        <TriangleAlert className="size-5" aria-hidden="true" />
      </div>
      <h2 className="text-sm font-semibold">{t(title)}</h2>
      {error !== undefined && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{errorMessage(error)}</p>}
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          {t('Try again')}
        </Button>
      )}
    </div>
  );
}
