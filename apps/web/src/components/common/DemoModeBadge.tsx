import { PlayCircle } from 'lucide-react';
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
