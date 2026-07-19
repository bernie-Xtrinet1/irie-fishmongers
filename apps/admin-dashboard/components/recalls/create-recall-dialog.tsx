'use client';

import { RecallSeverityClass } from '@iriefishmongers/types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatEnumLabel } from '@/lib/format';
import { useCreateRecall } from '@/lib/hooks/use-recalls';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const schema = z.object({
  severityClass: z.string().min(1, 'Select a severity class'),
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
  // The backend has no lot-search endpoint suited to a picker widget, so
  // affected lots are entered as their ids directly - lot ids are already
  // visible on the Cold Chain screen's Quarantined Lots section and in
  // seafood-lot detail views.
  lotIds: z.string().refine(
    (value) => {
      const ids = value.split(',').map((id) => id.trim()).filter(Boolean);
      return ids.length > 0 && ids.every((id) => UUID_PATTERN.test(id));
    },
    { message: 'Enter one or more valid lot ids, separated by commas' },
  ),
});
type FormValues = z.infer<typeof schema>;

export function CreateRecallDialog(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const createRecall = useCreateRecall();
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { severityClass: '', reason: '', lotIds: '' },
  });

  async function onSubmit(values: FormValues): Promise<void> {
    const lotIds = values.lotIds.split(',').map((id) => id.trim()).filter(Boolean);
    await createRecall.mutateAsync({
      severityClass: values.severityClass as RecallSeverityClass,
      reason: values.reason,
      lotIds,
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
        <Button size="sm">New recall</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create recall</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(onSubmit)(event)} noValidate>
          <div className="flex flex-col gap-1">
            <label htmlFor="recall-severity" className="text-sm font-medium text-gray-700">
              Severity class
            </label>
            <Select value={watch('severityClass') ?? ''} onValueChange={(value) => setValue('severityClass', value)}>
              <SelectTrigger id="recall-severity">
                <SelectValue placeholder="Select severity" />
              </SelectTrigger>
              <SelectContent>
                {Object.values(RecallSeverityClass).map((value) => (
                  <SelectItem key={value} value={value}>
                    {formatEnumLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.severityClass ? <p className="text-sm text-irie-red">{errors.severityClass.message}</p> : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="recall-reason" className="text-sm font-medium text-gray-700">
              Reason
            </label>
            <textarea
              id="recall-reason"
              className="rounded-button border border-gray-300 px-4 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2"
              rows={3}
              {...register('reason')}
            />
            {errors.reason ? <p className="text-sm text-irie-red">{errors.reason.message}</p> : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="recall-lot-ids" className="text-sm font-medium text-gray-700">
              Affected lot ids (comma-separated)
            </label>
            <textarea
              id="recall-lot-ids"
              className="rounded-button border border-gray-300 px-4 py-2 text-sm font-mono focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2"
              rows={2}
              {...register('lotIds')}
            />
            {errors.lotIds ? <p className="text-sm text-irie-red">{errors.lotIds.message}</p> : null}
          </div>
          <DialogFooter>
            <Button type="submit" loading={isSubmitting}>
              Create recall
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
