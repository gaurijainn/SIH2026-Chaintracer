import { Zap } from 'lucide-react';
import { StatusBadge } from '@/components/common/badges';
import { cn } from '@/lib/cn';

/** Small marker for a TRON row/address: the TRON fast path (format-detected, no probing, dedicated queue, USDT-TRC20 pre-selected). */
export function TronFastPathTag({ className }: { className?: string }) {
  return (
    <StatusBadge tone="info" icon={<Zap className="size-3" aria-hidden="true" />} className={className}>
      Fast path
    </StatusBadge>
  );
}

/** Explains what the fast path is, shown whenever TRON is selected or TRON addresses are present. `count` adds how many entries use it. */
export function TronFastPathNote({ count, className }: { count?: number; className?: string }) {
  return (
    <div role="note" className={cn('flex items-start gap-2 rounded-md border border-info/40 bg-info-soft px-3 py-2 text-sm text-info', className)}>
      <Zap className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        <strong className="font-semibold">TRON fast path{count !== undefined ? ` · ${count} ${count === 1 ? 'address' : 'addresses'}` : ''}.</strong> TRON addresses are recognised by format alone, skip chain probing and are queued on the dedicated TRON trace queue with the USDT-TRC20 contract pre-selected.
      </p>
    </div>
  );
}
