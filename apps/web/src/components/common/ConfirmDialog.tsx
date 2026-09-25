import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';

/** Confirmation for consequential actions (F8 freeze notices, deletions). `destructive` styles the confirm button red. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive,
  busy,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t(title)} description={description ? t(description) : undefined}>
        {children && <div className="mt-3 text-sm">{children}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>
              {t(cancelLabel)}
            </Button>
          </DialogClose>
          <Button variant={destructive ? 'destructive' : 'default'} disabled={busy} onClick={onConfirm}>
            {t(confirmLabel)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
