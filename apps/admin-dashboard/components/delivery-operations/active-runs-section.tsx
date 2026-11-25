'use client';

import { DeliveryRunStatus } from '@iriefishmongers/types';
import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { DeliveryTelemetryDialog } from '@/components/delivery-operations/delivery-telemetry-dialog';
import { LiveFleetMap } from '@/components/delivery-operations/live-fleet-map';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PaginationControls } from '@/components/pagination-controls';
import { formatEnumLabel } from '@/lib/format';
import { useDeliveryRuns } from '@/lib/hooks/use-delivery-operations';
import { useActiveRunsLiveOverview } from '@/lib/hooks/use-telemetry';
import { useDeliveryZones } from '@/lib/hooks/use-delivery-zones';
import { formatTelemetryDateTime, GPS_STATUS_META } from '@/lib/telemetry-ui';

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
  const liveQuery = useActiveRunsLiveOverview();
  const zonesQuery = useDeliveryZones();
  const [selectedDeliveryId, setSelectedDeliveryId] = React.useState<string | null>(null);
  const [selectedFleetAssetId, setSelectedFleetAssetId] = React.useState<string | null>(null);

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

      {liveQuery?.data ? (
        <>
          <LiveFleetMap
            vehicles={liveQuery.data.vehicles}
            selectedFleetAssetId={selectedFleetAssetId}
            onSelectVehicle={(fleetAssetId) => setSelectedFleetAssetId(fleetAssetId)}
          />

          <Card className="p-0">
            <div className="border-b border-gray-200 px-4 py-3">
              <h3 className="text-sm font-semibold text-gray-900">
                Active Deliveries &amp; Live Vehicle Telemetry
              </h3>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Delivery</TableHead>
                  <TableHead>Vehicle / Driver</TableHead>
                  <TableHead>GPS Status &amp; Position Time</TableHead>
                  <TableHead>Onboard Cargo</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {liveQuery.data.activeDeliveries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-gray-500">
                      No active deliveries require live telemetry tracking right now.
                    </TableCell>
                  </TableRow>
                ) : (
                  liveQuery.data.activeDeliveries.map((item) => {
                    const gpsMeta = GPS_STATUS_META[item.gpsStatus];
                    return (
                      <TableRow key={item.deliveryId}>
                        <TableCell>
                          <div className="font-medium text-gray-900">{item.vendorName}</div>
                          <div className="text-xs text-gray-500">
                            {item.deliveryAddress ?? 'Destination pending'}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="font-medium">{item.licensePlate ?? 'Unassigned vehicle'}</div>
                          <div className="text-gray-500">{item.driverName ?? 'No driver'}</div>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="flex items-center gap-1.5">
                            <Badge variant={gpsMeta.variant}>{gpsMeta.label}</Badge>
                            {item.lastTelemetryDelayed ? (
                              <Badge variant="warning">Buffered</Badge>
                            ) : null}
                          </div>
                          <div className="mt-1 text-gray-500">
                            {formatTelemetryDateTime(item.lastGpsCapturedAt)}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div>{item.onboardLotCount} onboard lot(s)</div>
                          <div className="text-gray-600">
                            {item.latestCargoTempC !== null
                              ? `${item.latestCargoTempC.toFixed(2)} °C`
                              : 'No temp'}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="info">{formatEnumLabel(item.status)}</Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setSelectedDeliveryId(item.deliveryId)}
                          >
                            Inspect Telemetry
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Card>
        </>
      ) : null}

      <DeliveryTelemetryDialog
        deliveryId={selectedDeliveryId}
        onClose={() => setSelectedDeliveryId(null)}
      />
    </section>
  );
}
