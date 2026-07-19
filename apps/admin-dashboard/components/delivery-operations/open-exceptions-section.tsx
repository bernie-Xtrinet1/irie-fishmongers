'use client';

import { DeliveryExceptionType } from '@iriefishmongers/types';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmActionDialog } from '@/components/confirm-action-dialog';
import { PaginationControls } from '@/components/pagination-controls';
import { formatEnumLabel } from '@/lib/format';
import { useDeliveryExceptions, useResolveDeliveryException } from '@/lib/hooks/use-delivery-operations';

const PAGE_SIZE = 20;

const TYPE_BADGE_VARIANT: Record<DeliveryExceptionType, 'neutral' | 'warning' | 'danger'> = {
  [DeliveryExceptionType.CUSTOMER_UNAVAILABLE]: 'warning',
  [DeliveryExceptionType.ADDRESS_ISSUE]: 'warning',
  [DeliveryExceptionType.VEHICLE_BREAKDOWN]: 'danger',
  [DeliveryExceptionType.TRAFFIC_DELAY]: 'neutral',
  [DeliveryExceptionType.WEATHER_DELAY]: 'neutral',
  [DeliveryExceptionType.PRODUCT_DAMAGE]: 'danger',
  [DeliveryExceptionType.OTHER]: 'neutral',
};

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('en-JM');
}

export function OpenExceptionsSection(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const page = Number(searchParams.get('exceptionsPage') ?? '1') || 1;

  const query = useDeliveryExceptions({ page, pageSize: PAGE_SIZE, resolved: false });
  const resolveException = useResolveDeliveryException();

  function updateSearchParams(nextPage: number): void {
    const params = new URLSearchParams(searchParams.toString());
    params.set('exceptionsPage', String(nextPage));
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-gray-900">Open Exceptions</h2>
      <p className="text-sm text-gray-500">
        Unresolved delivery exceptions reported by drivers, with the vendor/customer/driver context
        needed to act on them without a second lookup.
      </p>

      <Card className="p-0">
        {query.isPending ? (
          <div className="flex flex-col gap-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-irie-red">Unable to load delivery exceptions.</p>
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
                  <TableHead>Vendor</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Reported</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-gray-500">
                      No open delivery exceptions.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.items.map((exception) => (
                    <TableRow key={exception.id}>
                      <TableCell className="font-medium">{exception.vendorBusinessName}</TableCell>
                      <TableCell>{exception.customerName}</TableCell>
                      <TableCell>{exception.driverName}</TableCell>
                      <TableCell>
                        <Badge variant={TYPE_BADGE_VARIANT[exception.type]}>{formatEnumLabel(exception.type)}</Badge>
                      </TableCell>
                      <TableCell className="max-w-xs truncate" title={exception.reason}>
                        {exception.reason}
                      </TableCell>
                      <TableCell>{formatDateTime(exception.createdAt)}</TableCell>
                      <TableCell>
                        <ConfirmActionDialog
                          trigger={
                            <Button variant="secondary" size="sm">
                              Resolve
                            </Button>
                          }
                          title="Resolve this delivery exception?"
                          description="Marks this exception as resolved. It does not change the underlying delivery's status - use the delivery/driver record if the delivery itself still needs action."
                          actionLabel="Resolve"
                          actionVariant="primary"
                          isPending={resolveException.isPending}
                          onConfirm={() => resolveException.mutate(exception.id)}
                        />
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
              onPageChange={updateSearchParams}
            />
          </>
        ) : null}
      </Card>
    </section>
  );
}
