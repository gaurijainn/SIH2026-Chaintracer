import { PlayCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDataMode } from '@/lib/api/health';
import { cn } from '@/lib/cn';

/** Visible only when the app is running on recorded data (DATA_MODE=replay). Subtle amber pill, always with text. */
export function DemoModeBadge({ className }: { className?: string }) {
  const mode = useDataMode();
  if (mode !== 'replay') return null;
  return (
    <span
      role="status"
      title="All provider data is replayed from recordings; nothing is fetched live."
      className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-risk-medium/40 bg-risk-medium-soft px-2.5 py-1 text-xs font-medium text-risk-medium', className)}
    >
      <PlayCircle className="size-3.5" aria-hidden="true" />
      <span>Demo mode · Replay</span>
    </span>
  );
}

/**
 * Full-width strip across the top of the app shell while the API reports DATA_MODE=replay (GET /health, or VITE_DATA_MODE).
 * Not dismissible: it is the standing indicator that no provider is being called live. Renders nothing in live or record mode.
 */
export function DemoBanner() {
  const mode = useDataMode();
  const { t } = useTranslation();
  if (mode !== 'replay') return null;
  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border-b border-risk-medium/40 bg-risk-medium-soft px-3 py-1 text-center text-xs text-risk-medium print:hidden">
      <PlayCircle className="size-3.5 shrink-0" aria-hidden="true" />
      <strong className="font-semibold">{t('Demo mode (replay)')}</strong>
      <span aria-hidden="true">—</span>
      <span>{t('Provider data is replayed from recordings; no external provider is called live.')}</span>
    </div>
  );
}
