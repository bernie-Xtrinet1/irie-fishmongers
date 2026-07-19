'use client';

import { DeviceStatus } from '@iriefishmongers/types';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatEnumLabel } from '@/lib/format';
import { useCalibrateTemperatureDevice, useTemperatureDevices } from '@/lib/hooks/use-cold-chain';

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('en-JM') : 'Never';
}

// GET /temperature-devices returns the full, unpaginated list (see the
// approved 12A plan's compatibility matrix) - device counts are
// operationally small, so no pagination control is rendered here.
export function TemperatureDevicesSection(): React.ReactElement {
  const query = useTemperatureDevices();
  const calibrate = useCalibrateTemperatureDevice();

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-gray-900">Temperature Devices</h2>

      <Card className="p-0">
        {query.isPending ? (
          <div className="flex flex-col gap-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-irie-red">Unable to load temperature devices.</p>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Device Code</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Seen</TableHead>
                <TableHead>Calibration Due</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-gray-500">
                    No temperature devices registered yet.
                  </TableCell>
                </TableRow>
              ) : (
                query.data.map((device) => (
                  <TableRow key={device.id}>
                    <TableCell className="font-medium">{device.deviceCode}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={device.status === DeviceStatus.ACTIVE ? 'success' : 'neutral'}>
                          {formatEnumLabel(device.status)}
                        </Badge>
                        {device.isOffline ? <Badge variant="danger">Offline</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell>{formatDateTime(device.lastSeenAt)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <span>{formatDateTime(device.calibrationDueAt)}</span>
                        {device.isCalibrationOverdue ? <Badge variant="danger">Overdue</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={calibrate.isPending}
                        onClick={() => calibrate.mutate(device.id)}
                      >
                        Calibrate
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        ) : null}
      </Card>
    </section>
  );
}
