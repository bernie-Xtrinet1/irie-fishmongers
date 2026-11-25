'use client';

import { TelemetryGapKind } from '@iriefishmongers/types';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  useSensorTelemetryHistory,
  useUploadEyeAppCsvRecovery,
} from '@/lib/hooks/use-telemetry';
import { formatEnumLabel } from '@/lib/format';
import {
  formatCoordinates,
  formatDelayDuration,
  formatTelemetryDateTime,
  SENSOR_STATUS_META,
} from '@/lib/telemetry-ui';

export interface SensorTelemetryDialogProps {
  sensorId: string | null;
  onClose: () => void;
}

export function SensorTelemetryDialog({
  sensorId,
  onClose,
}: SensorTelemetryDialogProps): React.ReactElement {
  const historyQuery = useSensorTelemetryHistory(sensorId);
  const uploadCsv = useUploadEyeAppCsvRecovery();
  const [csvContent, setCsvContent] = React.useState('');
  const [notes, setNotes] = React.useState('');

  async function handleImport(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!sensorId || !csvContent.trim()) return;
    await uploadCsv.mutateAsync({
      sensorId,
      csvContent,
      notes: notes.trim() || undefined,
    });
    setCsvContent('');
    setNotes('');
  }

  return (
    <Dialog open={Boolean(sensorId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Sensor History &amp; EYE App Recovery</DialogTitle>
          <DialogDescription>
            Recent cargo-air readings, delayed buffer recoveries, signal gaps, and manual Teltonika EYE App EN12830 CSV log upload.
          </DialogDescription>
        </DialogHeader>

        {historyQuery.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : historyQuery.isError ? (
          <p className="text-sm text-irie-red">Unable to load sensor telemetry history.</p>
        ) : historyQuery.data ? (
          <div className="flex flex-col gap-6 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-gray-200 bg-gray-50 p-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-gray-900">
                    {historyQuery.data.sensor.deviceCode}
                  </span>
                  <Badge
                    variant={
                      SENSOR_STATUS_META[historyQuery.data.sensor.reportingStatus].variant
                    }
                  >
                    {SENSOR_STATUS_META[historyQuery.data.sensor.reportingStatus].label}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-gray-600">
                  Vehicle: {historyQuery.data.sensor.licensePlate ?? 'Unassigned'} · Compartment:{' '}
                  {historyQuery.data.sensor.compartmentLabel ?? 'None'} · BLE MAC:{' '}
                  {historyQuery.data.sensor.bleMacAddress ?? 'N/A'}
                </p>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold text-gray-900">
                  {historyQuery.data.sensor.lastTemperatureC !== null
                    ? `${historyQuery.data.sensor.lastTemperatureC.toFixed(2)} °C`
                    : 'No temp reading'}
                </div>
                <div className="text-xs text-gray-500">
                  Last captured: {formatTelemetryDateTime(historyQuery.data.sensor.lastCapturedAt)}
                </div>
              </div>
            </div>

            <form
              onSubmit={(e) => {
                void handleImport(e);
              }}
              className="flex flex-col gap-2 rounded-md border border-gray-200 p-4"
            >
              <div className="flex items-center justify-between">
                <label htmlFor="eye-csv-input" className="text-xs font-semibold uppercase text-gray-700">
                  Import Teltonika EYE App EN12830 Recovery CSV
                </label>
                <span className="text-xs text-gray-500">
                  Stored separately as EYE_APP_RECOVERY_CSV
                </span>
              </div>
              <textarea
                id="eye-csv-input"
                value={csvContent}
                onChange={(e) => setCsvContent(e.target.value)}
                rows={4}
                placeholder={'Timestamp,Temperature,Humidity\n2026-11-25T10:00:00Z,2.30,78'}
                className="w-full rounded-md border border-gray-300 p-2 font-mono text-xs"
              />
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional recovery reason (e.g. LTE outage in Portland parish)"
                  className="min-w-[240px] flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-xs"
                />
                <Button type="submit" size="sm" disabled={uploadCsv.isPending || !csvContent.trim()}>
                  {uploadCsv.isPending ? 'Importing CSV...' : 'Import Recovery CSV'}
                </Button>
              </div>
              {uploadCsv.data ? (
                <p className="text-xs font-medium text-irie-green">
                  Imported {uploadCsv.data.importedFrames} frames ({uploadCsv.data.deduplicatedFrames}{' '}
                  deduplicated), attributed {uploadCsv.data.lotReadingsCreated} lot readings, raised{' '}
                  {uploadCsv.data.alertsCreated} alerts.
                </p>
              ) : null}
              {uploadCsv.isError ? (
                <p className="text-xs text-irie-red">
                  {uploadCsv.error instanceof Error ? uploadCsv.error.message : 'CSV import failed'}
                </p>
              ) : null}
            </form>

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-gray-900">
                Recent Temperature History ({historyQuery.data.frames.length})
              </h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Captured At</TableHead>
                    <TableHead>Temp (°C)</TableHead>
                    <TableHead>Origin / Protocol</TableHead>
                    <TableHead>Delay / Gap</TableHead>
                    <TableHead>GPS</TableHead>
                    <TableHead>Lots / Alerts</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {historyQuery.data.frames.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-gray-500">
                        No telemetry frames recorded in the selected window.
                      </TableCell>
                    </TableRow>
                  ) : (
                    historyQuery.data.frames.map((frame) => {
                      const delayText = formatDelayDuration(frame.delaySeconds);
                      return (
                        <TableRow key={frame.id}>
                          <TableCell className="text-xs">
                            {formatTelemetryDateTime(frame.capturedAt)}
                          </TableCell>
                          <TableCell className="font-semibold">
                            {frame.cargoTempC !== null ? `${frame.cargoTempC.toFixed(2)} °C` : 'Missing'}
                          </TableCell>
                          <TableCell className="text-xs">
                            <div>{formatEnumLabel(frame.origin)}</div>
                            <div className="text-gray-500">{formatEnumLabel(frame.protocol)}</div>
                          </TableCell>
                          <TableCell className="text-xs">
                            <div className="flex flex-wrap gap-1">
                              {delayText ? <Badge variant="warning">{delayText}</Badge> : null}
                              {frame.gapKind ? (
                                <Badge variant={frame.gapKind === TelemetryGapKind.SENSOR_SIGNAL_MISSING ? 'danger' : 'warning'}>
                                  {formatEnumLabel(frame.gapKind)}
                                </Badge>
                              ) : (
                                !delayText && <span className="text-gray-500">On time</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-gray-600">
                            {formatCoordinates(frame.latitude, frame.longitude)}
                          </TableCell>
                          <TableCell className="text-xs">
                            {frame.linkedLotsCount} lot(s) · {frame.alertsCount} alert(s)
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
