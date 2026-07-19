'use client';

import { RecallStatus } from '@iriefishmongers/types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { formatEnumLabel } from '@/lib/format';
import { useUpdateRecallStatus } from '@/lib/hooks/use-recalls';

const optionalReasonField = z.string().refine((value) => value.length === 0 || value.length >= 5, {
  message: 'Must be at least 5 characters if provided',
});

const schema = z.object({
  rootCause: optionalReasonField,
  resolutionNotes: optionalReasonField,
});
type FormValues = z.infer<typeof schema>;

const TARGET_COPY: Record<RecallStatus, { label: string; description: string }> = {
  [RecallStatus.DRAFT]: { label: 'Draft', description: '' },
  [RecallStatus.ACTIVE]: {
    label: 'Activate recall',
    description:
      'Activating this recall immediately marks every linked lot as RECALLED (removed from sale) and emails every affected customer. This cannot be reversed by lowering the status.',
  },
  [RecallStatus.INVESTIGATING]: {
    label: 'Begin investigation',
    description: 'Moves this recall into active investigation. No inventory or customer-facing changes occur at this step.',
  },
  [RecallStatus.RESOLVED]: {
    label: 'Resolve recall',
    description: 'Marks the recall as resolved. Record the root cause and resolution for the compliance record.',
  },
  [RecallStatus.CLOSED]: {
    label: 'Close recall',
    description: 'Closes this recall permanently. No further status changes are possible after this.',
  },
};

export function AdvanceRecallStatusDialog({
  recallId,
  targetStatus,
}: {
  recallId: string;
  targetStatus: RecallStatus;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const updateStatus = useUpdateRecallStatus();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { rootCause: '', resolutionNotes: '' } });
  const copy = TARGET_COPY[targetStatus];

  async function onSubmit(values: FormValues): Promise<void> {
    await updateStatus.mutateAsync({
      id: recallId,
      input: {
        status: targetStatus,
        rootCause: values.rootCause.length > 0 ? values.rootCause : undefined,
        resolutionNotes: values.resolutionNotes.length > 0 ? values.resolutionNotes : undefined,
      },
    });
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
        <Button variant={targetStatus === RecallStatus.ACTIVE ? 'primary' : 'secondary'} size="sm">
          {formatEnumLabel(targetStatus)}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.label}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(onSubmit)(event)} noValidate>
          <div className="flex flex-col gap-1">
            <label htmlFor={`recall-root-cause-${recallId}`} className="text-sm font-medium text-gray-700">
              Root cause (optional)
            </label>
            <textarea
              id={`recall-root-cause-${recallId}`}
              className="rounded-button border border-gray-300 px-4 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2"
              rows={2}
              {...register('rootCause')}
            />
            {errors.rootCause ? <p className="text-sm text-irie-red">{errors.rootCause.message}</p> : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`recall-resolution-notes-${recallId}`} className="text-sm font-medium text-gray-700">
              Resolution notes (optional)
            </label>
            <textarea
              id={`recall-resolution-notes-${recallId}`}
              className="rounded-button border border-gray-300 px-4 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2"
              rows={2}
              {...register('resolutionNotes')}
            />
            {errors.resolutionNotes ? <p className="text-sm text-irie-red">{errors.resolutionNotes.message}</p> : null}
          </div>
          <DialogFooter>
            <Button type="submit" variant={targetStatus === RecallStatus.ACTIVE ? 'danger' : 'primary'} loading={isSubmitting}>
              {copy.label}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
