import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { CHAINS, RISK_BANDS, STATUS_TONES, type Chain, type RiskBand, type StatusTone } from '@/lib/tokens';

const pill = 'inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-xs font-medium leading-none';

/** Risk band with icon + text, so meaning never depends on colour alone. Optional score is shown as `72`. */
export function RiskBadge({ band, score, className }: { band: RiskBand; score?: number; className?: string }) {
  const b = RISK_BANDS[band];
  const Icon = b.icon;
  return (
    <span className={cn(pill, 'uppercase tracking-wide', b.classes, className)} title={b.meaning}>
      <Icon className="size-3.5" aria-hidden="true" />
      <span>{b.label}</span>
      {score !== undefined && <span className="font-mono tabular-nums opacity-80">{score}</span>}
      <span className="sr-only">{b.meaning}</span>
    </span>
  );
}

/** Chain identity: coloured dot + ticker text. */
export function ChainBadge({ chain, className }: { chain: Chain; className?: string }) {
  const c = CHAINS[chain];
  return (
    <span className={cn(pill, 'border-border bg-muted font-mono uppercase', className)}>
      <span className={cn('size-2 rounded-full', c.dot)} aria-hidden="true" />
      <span className="text-foreground">{c.label}</span>
    </span>
  );
}

/** Generic state pill (case status, alert state, connection state…). */
export function StatusBadge({ tone = 'neutral', icon, children, className }: { tone?: StatusTone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cn(pill, STATUS_TONES[tone], className)}>
      {icon}
      {children}
    </span>
  );
}
