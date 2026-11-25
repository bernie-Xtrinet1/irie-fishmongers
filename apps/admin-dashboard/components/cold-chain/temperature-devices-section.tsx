'use client';

import { DeviceStatus } from '@iriefishmongers/types';
import * as React from 'react';

import { SensorTelemetryDialog } from '@/components/cold-chain/sensor-telemetry-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatEnumLabel } from '@/lib/format';
import { useCalibrateTemperatureDevice, useTemperatureDevices } from '@/lib/hooks/use-cold-chain';
import { useTelemetryDevicesOverview } from '@/lib/hooks/use-telemetry';
import {
  formatDelayDuration,
  formatTelemetryDateTime,
  GPS_STATUS_META,
  SENSOR_STATUS_META,
} from '@/lib/telemetry-ui';

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('en-JM') : 'Never';
}

// GET /temperature-devices returns the full, unpaginated list (see the
// approved 12A plan's compatibility matrix) - device counts are
// operationally small, so no pagination control is rendered here.
export function TemperatureDevicesSection(): React.ReactElement {
  const query = useTemperatureDevices();
  const telemetryOverview = useTelemetryDevicesOverview();
  const calibrate = useCalibrateTemperatureDevice();
  const [selectedSensorId, setSelectedSensorId] = React.useState<string | null>(null);

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

      {telemetryOverview?.data ? (
        <div className="flex flex-col gap-4">
          <Card className="p-0">
            <div className="border-b border-gray-200 px-4 py-3">
              <h3 className="text-sm font-semibold text-gray-900">
                Vehicle Cargo-Air Temperature Sensors (Teltonika EYE BTSMP1)
              </h3>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sensor</TableHead>
                  <TableHead>Vehicle / Compartment</TableHead>
                  <TableHead>Latest Cargo Air (°C)</TableHead>
                  <TableHead>Capture Time / Delay</TableHead>
                  <TableHead>Reporting Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {telemetryOverview.data.sensors.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-gray-500">
                      No vehicle cargo-air sensors enrolled yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  telemetryOverview.data.sensors.map((sensor) => {
                    const statusMeta = SENSOR_STATUS_META[sensor.reportingStatus];
                    const delayBadge = formatDelayDuration(sensor.lastDelaySeconds);
                    return (
                      <TableRow key={sensor.id}>
                        <TableCell>
                          <div className="font-mono font-medium">{sensor.deviceCode}</div>
                          <div className="text-xs text-gray-500">
                            {sensor.bleMacAddress ?? formatEnumLabel(sensor.hardwareModel)}
                            {sensor.sensorSlot ? ` · Slot #${sensor.sensorSlot}` : ''}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="font-medium">{sensor.licensePlate ?? sensor.vendorName ?? 'Unassigned'}</div>
                          <div className="text-gray-500">
                            {sensor.compartmentLabel
                              ? `${sensor.compartmentLabel} (${sensor.compartmentCode})`
                              : 'Vendor Probe'}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="font-semibold text-gray-900">
                            {sensor.lastTemperatureC !== null
                              ? `${sensor.lastTemperatureC.toFixed(2)} °C`
                              : 'No reading'}
                          </div>
                          {sensor.lastHumidityPct !== null ? (
                            <div className="text-xs text-gray-500">{sensor.lastHumidityPct}% RH</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div>{formatTelemetryDateTime(sensor.lastCapturedAt)}</div>
                          {delayBadge ? (
                            <Badge variant="warning" className="mt-1">
                              {delayBadge}
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setSelectedSensorId(sensor.id)}
                          >
                            History &amp; EYE CSV
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Card>

          <Card className="p-0">
            <div className="border-b border-gray-200 px-4 py-3">
              <h3 className="text-sm font-semibold text-gray-900">
                Vehicle LTE/GNSS Trackers (Teltonika FMC130)
              </h3>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>IMEI</TableHead>
                  <TableHead>Vehicle</TableHead>
                  <TableHead>Protocol / SIM Carrier</TableHead>
                  <TableHead>Last Capture</TableHead>
                  <TableHead>GPS Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {telemetryOverview.data.trackers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-gray-500">
                      No vehicle trackers enrolled yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  telemetryOverview.data.trackers.map((tracker) => {
                    const gpsMeta = GPS_STATUS_META[tracker.gpsStatus];
                    return (
                      <TableRow key={tracker.id}>
                        <TableCell className="font-mono text-xs font-medium">{tracker.imei}</TableCell>
                        <TableCell className="text-xs font-medium">{tracker.licensePlate}</TableCell>
                        <TableCell className="text-xs text-gray-600">
                          <div>{formatEnumLabel(tracker.protocol)}</div>
                          <div>{tracker.simCarrier ?? 'Carrier unassigned'}</div>
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatTelemetryDateTime(tracker.lastCapturedAt)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={gpsMeta.variant}>{gpsMeta.label}</Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Card>
        </div>
      ) : null}

      <SensorTelemetryDialog
        sensorId={selectedSensorId}
        onClose={() => setSelectedSensorId(null)}
      />
    </section>
  );
}
