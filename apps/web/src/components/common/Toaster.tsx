import { CheckCircle2, Info, TriangleAlert, XCircle, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { STATUS_TONES } from '@/lib/tokens';
import { useToastStore, type ToastKind } from '@/stores/toast';

const KIND = {
  success: { icon: CheckCircle2, tone: STATUS_TONES.success, label: 'Success' },
  info: { icon: Info, tone: STATUS_TONES.info, label: 'Information' },
  warning: { icon: TriangleAlert, tone: STATUS_TONES.warning, label: 'Warning' },
  error: { icon: XCircle, tone: STATUS_TONES.danger, label: 'Error' },
} satisfies Record<ToastKind, unknown>;

/** Mount once at the root (outside the router, so in-app links go through `onNavigate`). Errors are announced assertively, everything else politely. */
export function Toaster({ onNavigate }: { onNavigate?: (to: string) => void }) {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2 print:hidden">
      {toasts.map((t) => {
        const k = KIND[t.kind];
        const Icon = k.icon;
        return (
          <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} className={cn('pointer-events-auto flex animate-toast-in items-start gap-2.5 rounded-lg border p-3 text-sm shadow-lg motion-reduce:animate-none', k.tone)}>
            <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                <span className="sr-only">{k.label}: </span>
                {t.title}
              </p>
              {t.description && <p className="mt-0.5 opacity-90">{t.description}</p>}
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    dismiss(t.id);
                    onNavigate?.(t.action!.to);
                  }}
                  className="mt-1.5 inline-block rounded font-medium underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(t.id)} className="rounded p-0.5 opacity-70 hover:opacity-100">
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
