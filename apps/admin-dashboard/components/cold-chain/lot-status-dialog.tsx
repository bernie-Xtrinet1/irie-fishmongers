'use client';

import { ASSIGNABLE_LOT_STATUSES, type AssignableLotStatus, type FoodSafetyStatus } from '@iriefishmongers/types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatEnumLabel } from '@/lib/format';
import { useUpdateLotStatus } from '@/lib/hooks/use-cold-chain';

const schema = z.object({
  status: z.string().min(1, 'Select a status'),
  // Backend requires >= 5 characters when a reason is supplied at all
  // (backend/src/modules/food-safety/dto/update-lot-status.dto.ts) - an
  // empty string is sent as "no reason", not "a reason of length zero".
  reason: z.string().refine((value) => value.length === 0 || value.length >= 5, {
    message: 'Reason must be at least 5 characters if provided',
  }),
});
type FormValues = z.infer<typeof schema>;

export function LotStatusDialog({ lotId, currentStatus }: { lotId: string; currentStatus: FoodSafetyStatus }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const updateStatus = useUpdateLotStatus();
  const targets = ASSIGNABLE_LOT_STATUSES.filter((target) => target !== currentStatus);
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { status: targets[0] ?? '', reason: '' },
  });

  async function onSubmit(values: FormValues): Promise<void> {
    await updateStatus.mutateAsync({
      id: lotId,
      input: {
        status: values.status as AssignableLotStatus,
        reason: values.reason.length > 0 ? values.reason : undefined,
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
        <Button variant="secondary" size="sm">
          Update status
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update lot status</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(onSubmit)(event)} noValidate>
          <div className="flex flex-col gap-1">
            <label htmlFor={`lot-status-${lotId}`} className="text-sm font-medium text-gray-700">
              New status
            </label>
            <Select value={watch('status')} onValueChange={(value) => setValue('status', value)}>
              <SelectTrigger id={`lot-status-${lotId}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targets.map((target) => (
                  <SelectItem key={target} value={target}>
                    {formatEnumLabel(target)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.status ? <p className="text-sm text-irie-red">{errors.status.message}</p> : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`lot-reason-${lotId}`} className="text-sm font-medium text-gray-700">
              Reason (optional)
            </label>
            <textarea
              id={`lot-reason-${lotId}`}
              className="rounded-button border border-gray-300 px-4 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2"
              rows={3}
              {...register('reason')}
            />
            {errors.reason ? <p className="text-sm text-irie-red">{errors.reason.message}</p> : null}
          </div>
          <DialogFooter>
            <Button type="submit" loading={isSubmitting}>
              Update status
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
