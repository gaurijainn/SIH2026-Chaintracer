import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogClose = DialogPrimitive.Close;

interface ContentProps {
  title: string;
  description?: string;
  /** 'center' = modal dialog, 'left' = navigation drawer, 'right' = detail sheet. */
  variant?: 'center' | 'left' | 'right';
  className?: string;
  children?: ReactNode;
}

export function DialogContent({ title, description, variant = 'center', className, children }: ContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60 print:hidden" />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 border bg-popover text-popover-foreground shadow-lg print:hidden',
          variant === 'center' && 'left-1/2 top-1/2 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg p-5',
          variant === 'left' && 'inset-y-0 left-0 w-72 max-w-[85vw] border-y-0 border-l-0 bg-sidebar',
          variant === 'right' && 'inset-y-0 right-0 w-full max-w-2xl overflow-y-auto border-y-0 border-r-0 bg-card',
          className,
        )}
      >
        <DialogPrimitive.Title className={variant === 'center' ? 'text-base font-semibold' : 'sr-only'}>{title}</DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className={variant === 'center' ? 'mt-1.5 text-sm text-muted-foreground' : 'sr-only'}>{description}</DialogPrimitive.Description>
        ) : (
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
        )}
        {children}
        {variant === 'center' && (
          <DialogPrimitive.Close aria-label="Close" className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
