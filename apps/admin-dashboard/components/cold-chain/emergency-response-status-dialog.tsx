'use client';

import { EmergencyResponseStatus } from '@iriefishmongers/types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useUpdateEmergencyResponseStatus } from '@/lib/hooks/use-cold-chain';

const fieldClassName =
  'rounded-button border border-gray-300 px-4 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2';

const containSchema = z.object({
  actionsTaken: z.string().optional(),
});
type ContainFormValues = z.infer<typeof containSchema>;

// rootCause/correctiveAction are required (min 10 chars) when resolving -
// mirrors backend/src/modules/food-safety/services/emergency-responses.service.ts's
// ALLOWED_STATUS_TRANSITIONS + RESOLVED guard, so the form fails fast
// instead of round-tripping a 400 from the API.
const resolveSchema = z.object({
  rootCause: z.string().min(10, 'Root cause must be at least 10 characters'),
  correctiveAction: z.string().min(10, 'Corrective action must be at least 10 characters'),
  preventiveAction: z.string().optional(),
});
type ResolveFormValues = z.infer<typeof resolveSchema>;

export function ContainEmergencyResponseDialog({ responseId }: { responseId: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const updateStatus = useUpdateEmergencyResponseStatus();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<ContainFormValues>({ resolver: zodResolver(containSchema) });

  async function onSubmit(values: ContainFormValues): Promise<void> {
    await updateStatus.mutateAsync({
      id: responseId,
      input: { status: EmergencyResponseStatus.CONTAINED, actionsTaken: values.actionsTaken },
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
        <Button variant="secondary" size="sm">
          Mark contained
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark emergency response contained</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(onSubmit)(event)} noValidate>
          <div className="flex flex-col gap-1">
            <label htmlFor="contain-actions-taken" className="text-sm font-medium text-gray-700">
              Actions taken (optional)
            </label>
            <textarea
              id="contain-actions-taken"
              className={fieldClassName}
              rows={3}
              {...register('actionsTaken')}
            />
          </div>
          <DialogFooter>
            <Button type="submit" loading={isSubmitting}>
              Mark contained
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ResolveEmergencyResponseDialog({ responseId }: { responseId: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const updateStatus = useUpdateEmergencyResponseStatus();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ResolveFormValues>({ resolver: zodResolver(resolveSchema) });

  async function onSubmit(values: ResolveFormValues): Promise<void> {
    await updateStatus.mutateAsync({
      id: responseId,
      input: { status: EmergencyResponseStatus.RESOLVED, ...values },
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
        <Button size="sm">Resolve</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve emergency response</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(onSubmit)(event)} noValidate>
          <div className="flex flex-col gap-1">
            <label htmlFor="resolve-root-cause" className="text-sm font-medium text-gray-700">
              Root cause
            </label>
            <textarea id="resolve-root-cause" className={fieldClassName} rows={3} {...register('rootCause')} />
            {errors.rootCause ? <p className="text-sm text-irie-red">{errors.rootCause.message}</p> : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="resolve-corrective-action" className="text-sm font-medium text-gray-700">
              Corrective action
            </label>
            <textarea
              id="resolve-corrective-action"
              className={fieldClassName}
              rows={3}
              {...register('correctiveAction')}
            />
            {errors.correctiveAction ? (
              <p className="text-sm text-irie-red">{errors.correctiveAction.message}</p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="resolve-preventive-action" className="text-sm font-medium text-gray-700">
              Preventive action (optional)
            </label>
            <textarea
              id="resolve-preventive-action"
              className={fieldClassName}
              rows={3}
              {...register('preventiveAction')}
            />
          </div>
          <DialogFooter>
            <Button type="submit" loading={isSubmitting}>
              Resolve
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
