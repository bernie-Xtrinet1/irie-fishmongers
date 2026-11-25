'use client';

import { AlertSeverity, TemperatureReadingOrigin } from '@iriefishmongers/types';

import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDeliveryTelemetryDetail } from '@/lib/hooks/use-telemetry';
import { formatEnumLabel } from '@/lib/format';
import {
  formatCoordinates,
  formatTelemetryDateTime,
  GPS_STATUS_META,
  SENSOR_STATUS_META,
} from '@/lib/telemetry-ui';

export interface DeliveryTelemetryDialogProps {
  deliveryId: string | null;
  onClose: () => void;
}

export function DeliveryTelemetryDialog({
  deliveryId,
  onClose,
}: DeliveryTelemetryDialogProps): React.ReactElement {
  const query = useDeliveryTelemetryDetail(deliveryId);

  return (
    <Dialog open={Boolean(deliveryId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Active Delivery Telemetry &amp; Custody</DialogTitle>
          <DialogDescription>
            Live vehicle GNSS fix, onboard compartment cargo-air telemetry, separate manual product handover checks, and coverage gaps.
          </DialogDescription>
        </DialogHeader>

        {query.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : query.isError ? (
          <p className="text-sm text-irie-red">Unable to load delivery telemetry details.</p>
        ) : query.data ? (
          <div className="flex flex-col gap-6 text-sm">
            {/* Vehicle & delivery metadata */}
            <div className="grid gap-4 rounded-md border border-gray-200 bg-gray-50 p-4 md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium uppercase text-gray-500">Delivery</span>
                <span className="font-semibold text-gray-900">
                  {query.data.delivery.vendorName} — {formatEnumLabel(query.data.delivery.status)}
                </span>
                <span className="text-xs text-gray-600">
                  Destination: {query.data.delivery.deliveryAddress ?? 'Address pending'}
                </span>
                <span className="text-xs text-gray-600">
                  Driver: {query.data.delivery.driverName ?? 'Unassigned'}
                </span>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium uppercase text-gray-500">Assigned Cold-Chain Vehicle</span>
                {query.data.vehicle ? (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900">
                        {query.data.vehicle.licensePlate} ({formatEnumLabel(query.data.vehicle.assetType)})
                      </span>
                      <Badge variant={GPS_STATUS_META[query.data.vehicle.gpsStatus].variant}>
                        {GPS_STATUS_META[query.data.vehicle.gpsStatus].label}
                      </Badge>
                    </div>
                    <span className="text-xs text-gray-600">
                      Position: {formatCoordinates(query.data.vehicle.lastLatitude, query.data.vehicle.lastLongitude)}
                    </span>
                    <span className="text-xs text-gray-600">
                      Position Time: {formatTelemetryDateTime(query.data.vehicle.lastGpsCapturedAt)}
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-gray-500">No compartment telemetry loaded yet.</span>
                )}
              </div>
            </div>

            {/* Compliance distinction banner */}
            <div className="rounded-md border border-ocean-blue/30 bg-ocean-blue/5 p-3 text-xs text-gray-800">
              <div className="flex flex-wrap items-center gap-2 font-medium">
                <span>Handover Compliance Status:</span>
                <Badge variant={query.data.complianceChecklist.pickupManualCheckRecorded ? 'success' : 'warning'}>
                  Manual Pickup Check:{' '}
                  {query.data.complianceChecklist.pickupManualCheckRecorded ? 'Recorded' : 'Required / Pending'}
                </Badge>
                <Badge variant={query.data.complianceChecklist.deliveryManualCheckRecorded ? 'success' : 'warning'}>
                  Manual Delivery Check:{' '}
                  {query.data.complianceChecklist.deliveryManualCheckRecorded ? 'Recorded' : 'Required / Pending'}
                </Badge>
              </div>
              <p className="mt-1 text-gray-600">
                {query.data.complianceChecklist.manualChecksDistinctNotice}
              </p>
            </div>

            {/* Compartment assignments / lots */}
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-gray-900">Compartment Cargo &amp; Lot Custody</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Lot</TableHead>
                    <TableHead>Compartment</TableHead>
                    <TableHead>Sensor</TableHead>
                    <TableHead>Qty Handed Over</TableHead>
                    <TableHead>Loaded / Closed</TableHead>
                    <TableHead>Lot Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.assignments.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-gray-500">
                        No compartment assignments recorded yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    query.data.assignments.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>
                          <div className="font-medium">{a.lotNumber}</div>
                          <div className="text-xs text-gray-500">
                            {a.species} ({formatEnumLabel(a.storageType)})
                          </div>
                        </TableCell>
                        <TableCell>
                          <div>{a.compartmentLabel}</div>
                          <div className="font-mono text-xs text-gray-500">{a.compartmentCode}</div>
                        </TableCell>
                        <TableCell>
                          {a.sensorDeviceCode ? (
                            <div className="flex flex-col gap-0.5">
                              <span className="font-mono text-xs">{a.sensorDeviceCode}</span>
                              {a.sensorReportingStatus ? (
                                <Badge variant={SENSOR_STATUS_META[a.sensorReportingStatus].variant}>
                                  {a.sensorLastTempC !== null ? `${a.sensorLastTempC.toFixed(2)} °C` : SENSOR_STATUS_META[a.sensorReportingStatus].label}
                                </Badge>
                              ) : null}
                            </div>
                          ) : (
                            'Unassigned'
                          )}
                        </TableCell>
                        <TableCell>
                          {a.handedOverQuantity} / {a.quantityUnits}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div>Loaded: {formatTelemetryDateTime(a.loadedAt)}</div>
                          <div>{a.unloadedAt ? `Closed: ${formatTelemetryDateTime(a.unloadedAt)}` : 'Onboard'}</div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              a.foodSafetyStatus === 'QUARANTINED' || a.foodSafetyStatus === 'RECALLED'
                                ? 'danger'
                                : a.foodSafetyStatus === 'UNDER_REVIEW'
                                  ? 'warning'
                                  : 'success'
                            }
                          >
                            {formatEnumLabel(a.foodSafetyStatus)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </section>

            {/* Separate Manual vs Automated Readings */}
            <div className="grid gap-4 md:grid-cols-2">
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-gray-900">
                  Manual Product-Temperature Checks ({query.data.manualProductChecks.length})
                </h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Lot / Checkpoint</TableHead>
                      <TableHead>Temp</TableHead>
                      <TableHead>Captured</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {query.data.manualProductChecks.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center text-xs text-gray-500">
                          No manual product checks logged yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      query.data.manualProductChecks.map((check) => (
                        <TableRow key={check.id}>
                          <TableCell className="text-xs">
                            <div className="font-medium">{check.lotNumber}</div>
                            <div className="text-gray-500">{formatEnumLabel(check.checkpoint)}</div>
                          </TableCell>
                          <TableCell className="font-medium">{check.temperatureC} °C</TableCell>
                          <TableCell className="text-xs text-gray-500">
                            {formatTelemetryDateTime(check.capturedAt)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-gray-900">
                  Cargo-Air Sensor &amp; CSV Readings ({query.data.cargoAirReadings.length})
                </h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Origin / Sensor</TableHead>
                      <TableHead>Temp</TableHead>
                      <TableHead>Captured</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {query.data.cargoAirReadings.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center text-xs text-gray-500">
                          No cargo-air telemetry attributed to this delivery yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      query.data.cargoAirReadings.slice(0, 12).map((reading) => (
                        <TableRow key={reading.id}>
                          <TableCell className="text-xs">
                            <div className="flex items-center gap-1">
                              <Badge
                                variant={
                                  reading.origin === TemperatureReadingOrigin.EYE_APP_RECOVERY_CSV
                                    ? 'info'
                                    : 'neutral'
                                }
                              >
                                {reading.origin === TemperatureReadingOrigin.EYE_APP_RECOVERY_CSV
                                  ? 'EYE CSV'
                                  : 'Cargo Air'}
                              </Badge>
                              {reading.isDelayed ? <Badge variant="warning">Delayed</Badge> : null}
                            </div>
                            <div className="mt-0.5 font-mono text-gray-500">
                              {reading.deviceCode ?? 'Sensor'}
                            </div>
                          </TableCell>
                          <TableCell className="font-medium">{reading.temperatureC} °C</TableCell>
                          <TableCell className="text-xs text-gray-500">
                            {formatTelemetryDateTime(reading.capturedAt)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </section>
            </div>

            {/* Alerts & Coverage Gaps */}
            <div className="grid gap-4 md:grid-cols-2">
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-gray-900">
                  Linked Alerts &amp; Emergency Responses ({query.data.alerts.length})
                </h3>
                {query.data.alerts.length === 0 ? (
                  <p className="text-xs text-gray-500">No temperature alerts triggered for this delivery.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {query.data.alerts.map((alert) => (
                      <div key={alert.id} className="rounded border border-gray-200 p-2.5 text-xs">
                        <div className="flex items-center justify-between">
                          <Badge variant={alert.severity === AlertSeverity.WARNING ? 'warning' : 'danger'}>
                            {alert.severity} ({alert.actualC} °C)
                          </Badge>
                          <span className="text-gray-500">
                            {alert.resolved ? 'Resolved' : 'Open'}
                          </span>
                        </div>
                        <div className="mt-1 text-gray-600">
                          Source: {formatEnumLabel(alert.readingOrigin)}
                          {alert.isDelayed ? ' (buffered late arrival)' : ''}
                        </div>
                        {alert.emergencyResponse ? (
                          <div className="mt-1 font-medium text-irie-red">
                            Emergency Response: {formatEnumLabel(alert.emergencyResponse.status)}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-gray-900">
                  Telemetry Coverage Gaps ({query.data.telemetryGaps.length})
                </h3>
                {query.data.telemetryGaps.length === 0 ? (
                  <p className="text-xs text-gray-500">No LTE buffer gaps or BLE sensor signal interruptions recorded.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {query.data.telemetryGaps.slice(0, 8).map((gap) => (
                      <div key={gap.frameId} className="rounded border border-gray-200 p-2.5 text-xs">
                        <div className="flex items-center justify-between">
                          <Badge variant="warning">{formatEnumLabel(gap.gapKind)}</Badge>
                          <span className="text-gray-500">+{gap.delaySeconds}s</span>
                        </div>
                        <div className="mt-1 text-gray-600">
                          Captured {formatTelemetryDateTime(gap.capturedAt)} → Received{' '}
                          {formatTelemetryDateTime(gap.receivedAt)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
