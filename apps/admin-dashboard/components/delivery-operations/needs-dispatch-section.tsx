'use client';

import { DeliveryRunStatus } from '@iriefishmongers/types';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmActionDialog } from '@/components/confirm-action-dialog';
import { PaginationControls } from '@/components/pagination-controls';
import { useDeliveryZones } from '@/lib/hooks/use-delivery-zones';
import { useDeliveryRuns, useDispatchDeliveryRun } from '@/lib/hooks/use-delivery-operations';

const PAGE_SIZE = 20;

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('en-JM');
}

// Feeds the 10A Fleet Dispatch Engine: dispatching runs the scoring
// algorithm and assigns the best-fit eligible driver/fleet asset in one
// call (POST /delivery-runs/:id/dispatch), rather than requiring the
// dispatcher to manually pick one. A 409 (no eligible candidate) leaves the
// run PLANNED and visible here for the dispatcher to resolve manually via
// driver/fleet status changes elsewhere in the dashboard.
export function NeedsDispatchSection(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const page = Number(searchParams.get('dispatchPage') ?? '1') || 1;

  const query = useDeliveryRuns({ page, pageSize: PAGE_SIZE, status: DeliveryRunStatus.PLANNED });
  const zonesQuery = useDeliveryZones();
  const dispatch = useDispatchDeliveryRun();

  function zoneName(zoneId: string): string {
    return zonesQuery.data?.find((zone) => zone.id === zoneId)?.name ?? zoneId;
  }

  function updateSearchParams(nextPage: number): void {
    const params = new URLSearchParams(searchParams.toString());
    params.set('dispatchPage', String(nextPage));
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-gray-900">Needs Dispatch</h2>
      <p className="text-sm text-gray-500">
        Planned delivery runs with no driver or fleet asset assigned yet.
      </p>

      <Card className="p-0">
        {query.isPending ? (
          <div className="flex flex-col gap-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-irie-red">Unable to load delivery runs.</p>
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
                  <TableHead>Zone</TableHead>
                  <TableHead>Stops</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-gray-500">
                      No delivery runs are waiting for dispatch.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.items.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell className="font-medium">{zoneName(run.zoneId)}</TableCell>
                      <TableCell>{run.stops.length}</TableCell>
                      <TableCell>{formatDateTime(run.createdAt)}</TableCell>
                      <TableCell>
                        <ConfirmActionDialog
                          trigger={
                            <Button variant="secondary" size="sm">
                              Dispatch
                            </Button>
                          }
                          title="Dispatch this delivery run?"
                          description="Automatically assigns the best-fit eligible driver and fleet asset based on zone, cold-chain requirements, and capacity. If no eligible driver or asset is found, the run stays here for manual assignment."
                          actionLabel="Dispatch"
                          actionVariant="primary"
                          isPending={dispatch.isPending}
                          onConfirm={() => dispatch.mutate(run.id)}
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
