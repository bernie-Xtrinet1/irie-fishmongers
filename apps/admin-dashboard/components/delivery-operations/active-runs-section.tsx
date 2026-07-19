'use client';

import { DeliveryRunStatus } from '@iriefishmongers/types';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PaginationControls } from '@/components/pagination-controls';
import { useDeliveryZones } from '@/lib/hooks/use-delivery-zones';
import { useDeliveryRuns } from '@/lib/hooks/use-delivery-operations';

const PAGE_SIZE = 20;

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function ActiveRunsSection(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const page = Number(searchParams.get('activePage') ?? '1') || 1;

  const query = useDeliveryRuns({ page, pageSize: PAGE_SIZE, status: DeliveryRunStatus.IN_PROGRESS });
  const zonesQuery = useDeliveryZones();

  function zoneName(zoneId: string): string {
    return zonesQuery.data?.find((zone) => zone.id === zoneId)?.name ?? zoneId;
  }

  function updateSearchParams(nextPage: number): void {
    const params = new URLSearchParams(searchParams.toString());
    params.set('activePage', String(nextPage));
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-gray-900">Active Runs</h2>
      <p className="text-sm text-gray-500">Delivery runs currently in progress, informational only.</p>

      <Card className="p-0">
        {query.isPending ? (
          <div className="flex flex-col gap-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-irie-red">Unable to load active delivery runs.</p>
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
                  <TableHead>Driver</TableHead>
                  <TableHead>Fleet Asset</TableHead>
                  <TableHead>Stops</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-gray-500">
                      No delivery runs are currently active.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.items.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell className="font-medium">{zoneName(run.zoneId)}</TableCell>
                      <TableCell>
                        {run.driverId ? (
                          <span className="font-mono text-xs" title={run.driverId}>
                            {shortId(run.driverId)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        {run.fleetAssetId ? (
                          <span className="font-mono text-xs" title={run.fleetAssetId}>
                            {shortId(run.fleetAssetId)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>{run.stops.length}</TableCell>
                      <TableCell>
                        <Badge variant="success">In Progress</Badge>
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
