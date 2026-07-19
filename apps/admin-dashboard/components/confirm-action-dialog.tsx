'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

interface ConfirmActionDialogProps {
  trigger: React.ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  actionVariant?: 'primary' | 'danger';
  onConfirm: () => void;
  isPending?: boolean;
}

// Shared confirmation dialog for every high-impact admin action (suspend/
// reject a vendor, suspend a driver, activate a recall, etc.) - copy is
// always consequence-specific (passed in by the caller), never a bare "Are
// you sure?".
export function ConfirmActionDialog({
  trigger,
  title,
  description,
  actionLabel,
  actionVariant = 'danger',
  onConfirm,
  isPending,
}: ConfirmActionDialogProps): React.ReactElement {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={actionVariant} disabled={isPending} onClick={onConfirm}>
            {isPending ? 'Working…' : actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
