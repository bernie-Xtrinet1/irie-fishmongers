'use client';

import { ASSIGNABLE_DRIVER_STATUSES, DriverStatus, type AssignableDriverStatus } from '@iriefishmongers/types';
import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmActionDialog } from '@/components/confirm-action-dialog';
import { PaginationControls } from '@/components/pagination-controls';
import { DriverPerformanceDialog } from '@/components/drivers/driver-performance-dialog';
import { formatEnumLabel } from '@/lib/format';
import { useDrivers, useUpdateDriverStatus } from '@/lib/hooks/use-drivers';

const PAGE_SIZE = 20;

const STATUS_BADGE_VARIANT: Record<DriverStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  [DriverStatus.PENDING]: 'warning',
  [DriverStatus.APPROVED]: 'success',
  [DriverStatus.SUSPENDED]: 'danger',
  [DriverStatus.REJECTED]: 'danger',
};

const ACTION_COPY: Record<
  AssignableDriverStatus,
  { label: string; title: string; description: string; variant: 'primary' | 'danger' }
> = {
  [DriverStatus.APPROVED]: {
    label: 'Approve',
    title: 'Approve this driver?',
    description: 'The driver will be able to go online and receive delivery assignments.',
    variant: 'primary',
  },
  [DriverStatus.SUSPENDED]: {
    label: 'Suspend',
    title: 'Suspend this driver?',
    description:
      'Suspending this driver prevents new delivery assignments. Any delivery already in progress is not affected and must be resolved operationally.',
    variant: 'danger',
  },
  [DriverStatus.REJECTED]: {
    label: 'Reject',
    title: 'Reject this driver?',
    description:
      'Rejecting this driver marks their application REJECTED and prevents them from receiving deliveries. This can be reversed later by approving them again.',
    variant: 'danger',
  },
};

export function DriversView(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [performanceDriverId, setPerformanceDriverId] = useState<string | null>(null);

  const page = Number(searchParams.get('page') ?? '1') || 1;
  const status = (searchParams.get('status') as DriverStatus | null) ?? undefined;

  const query = useDrivers({ page, pageSize: PAGE_SIZE, status });
  const updateStatus = useUpdateDriverStatus();

  function updateSearchParams(next: { status?: string; page?: number }): void {
    const params = new URLSearchParams(searchParams.toString());

    if ('status' in next) {
      if (next.status && next.status !== 'ALL') params.set('status', next.status);
      else params.delete('status');
      params.delete('page');
    }
    if ('page' in next && next.page) {
      params.set('page', String(next.page));
    }

    const queryString = params.toString();
    router.push(queryString ? `${pathname}?${queryString}` : pathname);
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-gray-900">Drivers</h1>

      <div className="flex flex-col gap-1">
        <label htmlFor="status-filter" className="text-xs font-medium uppercase tracking-wide text-gray-500">
          Status
        </label>
        <Select value={status ?? 'ALL'} onValueChange={(value) => updateSearchParams({ status: value })}>
          <SelectTrigger id="status-filter" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All statuses</SelectItem>
            {Object.values(DriverStatus).map((value) => (
              <SelectItem key={value} value={value}>
                {formatEnumLabel(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="p-0">
        {query.isPending ? (
          <div className="flex flex-col gap-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-irie-red">Unable to load drivers.</p>
            <Button
              variant="secondary"
              size="sm"
              className="w-fit"
              onClick={() => {
                void query.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : query.data ? (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>License Plate</TableHead>
                  <TableHead>Vehicle</TableHead>
                  <TableHead>Cold Chain</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Availability</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-gray-500">
                      No drivers match these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.items.map((driver) => (
                    <TableRow key={driver.id}>
                      <TableCell className="font-medium">{driver.licensePlate}</TableCell>
                      <TableCell>
                        {formatEnumLabel(driver.vehicleType)} · {formatEnumLabel(driver.vehicleOwnership)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={driver.coldChainCapable ? 'success' : 'neutral'}>
                          {driver.coldChainCapable ? 'Capable' : 'Not capable'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_BADGE_VARIANT[driver.status]}>{formatEnumLabel(driver.status)}</Badge>
                      </TableCell>
                      <TableCell>{formatEnumLabel(driver.availabilityStatus)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="secondary" size="sm" onClick={() => setPerformanceDriverId(driver.id)}>
                            Performance
                          </Button>
                          {ASSIGNABLE_DRIVER_STATUSES.filter((target) => target !== driver.status).map((target) => {
                            const copy = ACTION_COPY[target];

                            if (target === DriverStatus.APPROVED) {
                              return (
                                <Button
                                  key={target}
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => updateStatus.mutate({ id: driver.id, status: target })}
                                >
                                  {copy.label}
                                </Button>
                              );
                            }

                            return (
                              <ConfirmActionDialog
                                key={target}
                                trigger={
                                  <Button variant="secondary" size="sm">
                                    {copy.label}
                                  </Button>
                                }
                                title={copy.title}
                                description={copy.description}
                                actionLabel={copy.label}
                                actionVariant={copy.variant}
                                isPending={updateStatus.isPending}
                                onConfirm={() => updateStatus.mutate({ id: driver.id, status: target })}
                              />
                            );
                          })}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <PaginationControls
              page={query.data.page}
              pageSize={query.data.pageSize}
              total={query.data.total}
              onPageChange={(nextPage) => updateSearchParams({ page: nextPage })}
            />
          </>
        ) : null}
      </Card>

      <DriverPerformanceDialog
        driverId={performanceDriverId}
        onOpenChange={(open) => {
          if (!open) setPerformanceDriverId(null);
        }}
      />
    </div>
  );
}
