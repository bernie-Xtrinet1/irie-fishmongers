'use client';

import type { DeliveryZone } from '@iriefishmongers/types';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PaginationControls } from '@/components/pagination-controls';
import { formatCurrency } from '@/lib/format';
import { useFleetTrips } from '@/lib/hooks/use-fleet';

const PAGE_SIZE = 20;

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('en-JM') : 'In progress';
}

export function FleetTripsSection({ zones }: { zones: DeliveryZone[] }): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const page = Number(searchParams.get('tripPage') ?? '1') || 1;
  const query = useFleetTrips({ page, pageSize: PAGE_SIZE });

  const zoneName = (id: string): string => zones.find((zone) => zone.id === id)?.name ?? id;

  function goToPage(nextPage: number): void {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tripPage', String(nextPage));
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-gray-900">Fleet Trips</h2>

      <Card className="p-0">
        {query.isPending ? (
          <div className="flex flex-col gap-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-irie-red">Unable to load fleet trips.</p>
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
                  <TableHead>Fleet Asset</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Zone</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Ended</TableHead>
                  <TableHead>Fuel Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-gray-500">
                      No fleet trips recorded yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.items.map((trip) => (
                    <TableRow key={trip.id}>
                      <TableCell>
                        <span className="font-mono text-xs" title={trip.fleetAssetId}>
                          {shortId(trip.fleetAssetId)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs" title={trip.driverId}>
                          {shortId(trip.driverId)}
                        </span>
                      </TableCell>
                      <TableCell>{zoneName(trip.zoneId)}</TableCell>
                      <TableCell>{formatDateTime(trip.startedAt)}</TableCell>
                      <TableCell>{formatDateTime(trip.endedAt)}</TableCell>
                      <TableCell>{trip.fuelCost ? formatCurrency(trip.fuelCost, 'JMD') : '—'}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <PaginationControls
              page={query.data.page}
              pageSize={query.data.pageSize}
              total={query.data.total}
              onPageChange={goToPage}
            />
          </>
        ) : null}
      </Card>
    </section>
  );
}
