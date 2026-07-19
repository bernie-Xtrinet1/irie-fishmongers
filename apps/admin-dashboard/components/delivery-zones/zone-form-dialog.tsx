'use client';

import type { DeliveryZone } from '@iriefishmongers/types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useCreateDeliveryZone, useUpdateDeliveryZone } from '@/lib/hooks/use-delivery-zones';

const createSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  code: z.string().min(2, 'Code must be at least 2 characters'),
  description: z.string().optional(),
});
type CreateFormValues = z.infer<typeof createSchema>;

const editSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  description: z.string().optional(),
  active: z.boolean(),
});
type EditFormValues = z.infer<typeof editSchema>;

const fieldClassName =
  'h-11 rounded-button border border-gray-300 px-4 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2';

export function CreateZoneDialog(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const createZone = useCreateDeliveryZone();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateFormValues>({ resolver: zodResolver(createSchema) });

  async function onSubmit(values: CreateFormValues): Promise<void> {
    await createZone.mutateAsync(values);
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
        <Button size="sm">New zone</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create delivery zone</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => void handleSubmit(onSubmit)(event)}
          noValidate
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="zone-name" className="text-sm font-medium text-gray-700">
              Name
            </label>
            <input id="zone-name" className={fieldClassName} {...register('name')} />
            {errors.name ? <p className="text-sm text-irie-red">{errors.name.message}</p> : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="zone-code" className="text-sm font-medium text-gray-700">
              Code
            </label>
            <input id="zone-code" className={fieldClassName} {...register('code')} />
            {errors.code ? <p className="text-sm text-irie-red">{errors.code.message}</p> : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="zone-description" className="text-sm font-medium text-gray-700">
              Description (optional)
            </label>
            <input id="zone-description" className={fieldClassName} {...register('description')} />
          </div>
          <DialogFooter>
            <Button type="submit" loading={isSubmitting}>
              Create zone
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EditZoneDialog({ zone }: { zone: DeliveryZone }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const updateZone = useUpdateDeliveryZone();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EditFormValues>({
    resolver: zodResolver(editSchema),
    defaultValues: { name: zone.name, description: zone.description ?? '', active: zone.active },
  });

  useEffect(() => {
    reset({ name: zone.name, description: zone.description ?? '', active: zone.active });
  }, [zone, reset]);

  async function onSubmit(values: EditFormValues): Promise<void> {
    await updateZone.mutateAsync({ id: zone.id, input: values });
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {zone.name}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => void handleSubmit(onSubmit)(event)}
          noValidate
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={`zone-name-${zone.id}`} className="text-sm font-medium text-gray-700">
              Name
            </label>
            <input id={`zone-name-${zone.id}`} className={fieldClassName} {...register('name')} />
            {errors.name ? <p className="text-sm text-irie-red">{errors.name.message}</p> : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`zone-description-${zone.id}`} className="text-sm font-medium text-gray-700">
              Description
            </label>
            <input id={`zone-description-${zone.id}`} className={fieldClassName} {...register('description')} />
          </div>
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input type="checkbox" className="h-4 w-4" {...register('active')} />
            Active
          </label>
          <DialogFooter>
            <Button type="submit" loading={isSubmitting}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
