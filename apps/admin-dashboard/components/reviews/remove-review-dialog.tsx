'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useRemoveReview } from '@/lib/hooks/use-reviews';

// Reason is required and part of the audit trail (backend enforces 3-500
// chars); the removal and its audit record commit in one transaction.
const schema = z.object({
  reason: z.string().min(3, 'A reason of at least 3 characters is required').max(500),
});
type FormValues = z.infer<typeof schema>;

export function RemoveReviewDialog({ reviewId }: { reviewId: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const removeReview = useRemoveReview();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { reason: '' } });

  async function onSubmit(values: FormValues): Promise<void> {
    await removeReview.mutateAsync({ reviewId, reason: values.reason });
    reset();
    setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="danger" size="sm">
          Remove
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove review</DialogTitle>
          <DialogDescription>
            This hides the review from customers and records who removed it and why. The customer cannot restore an
            admin-removed review. This cannot be undone from here.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(onSubmit)(event)} noValidate>
          <div className="flex flex-col gap-1">
            <label htmlFor={`remove-review-reason-${reviewId}`} className="text-sm font-medium text-gray-700">
              Reason
            </label>
            <textarea
              id={`remove-review-reason-${reviewId}`}
              className="rounded-button border border-gray-300 px-4 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2"
              rows={3}
              {...register('reason')}
            />
            {errors.reason ? <p className="text-sm text-irie-red">{errors.reason.message}</p> : null}
            {removeReview.isError ? (
              <p className="text-sm text-irie-red">Could not remove the review. Please try again.</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" variant="danger" loading={isSubmitting}>
              Remove review
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
