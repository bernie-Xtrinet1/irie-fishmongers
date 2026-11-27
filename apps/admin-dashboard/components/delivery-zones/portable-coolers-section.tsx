'use client';

import {
  CompartmentKind,
  FleetAssetStatus,
  FleetAssetType,
  type DeliveryZone,
  type FleetAsset,
  type PortableCoolerSummary,
} from '@iriefishmongers/types';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatEnumLabel } from '@/lib/format';
import { useFleetAssets } from '@/lib/hooks/use-fleet';
import {
  useAssignCoolerVehicle,
  useCompartments,
  useCreateCompartment,
  useRegisterCargoSensor,
  useUnassignCoolerVehicle,
} from '@/lib/hooks/use-telemetry';
import { formatTelemetryDateTime, SENSOR_STATUS_META } from '@/lib/telemetry-ui';

const fieldClassName =
  'h-10 rounded-button border border-gray-300 bg-white px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2';

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatRange(cooler: PortableCoolerSummary): string {
  if (cooler.targetMinC !== null && cooler.targetMaxC !== null) {
    return `${cooler.targetMinC}°C to ${cooler.targetMaxC}°C`;
  }
  return cooler.storageType === 'FROZEN' ? '-100°C to -18°C' : '0°C to 4°C';
}

function RegisterCoolerDialog({ vehicles }: { vehicles: FleetAsset[] }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [coolerCode, setCoolerCode] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [storageType, setStorageType] = React.useState<'FRESH' | 'FROZEN'>('FRESH');
  const [fleetAssetId, setFleetAssetId] = React.useState<string>('NONE');
  const [sensorSlot, setSensorSlot] = React.useState<string>('1');
  const [notes, setNotes] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const createCompartment = useCreateCompartment();

  function reset(): void {
    setCoolerCode('');
    setLabel('');
    setStorageType('FRESH');
    setFleetAssetId('NONE');
    setSensorSlot('1');
    setNotes('');
    setError(null);
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    if (!coolerCode.trim() || !label.trim()) {
      setError('Cooler ID and label are required.');
      return;
    }

    try {
      await createCompartment.mutateAsync({
        compartmentKind: CompartmentKind.PORTABLE_COOLER,
        coolerCode: coolerCode.trim().toUpperCase(),
        compartmentCode: coolerCode.trim().toUpperCase(),
        label: label.trim(),
        storageType,
        targetMinC: storageType === 'FRESH' ? 0 : -22,
        targetMaxC: storageType === 'FRESH' ? 4 : -18,
        ...(fleetAssetId !== 'NONE' ? { fleetAssetId, sensorSlot: Number(sensorSlot) || 1 } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      reset();
      setOpen(false);
    } catch (err) {
      setError(getErrorMessage(err, 'Unable to register portable cooler.'));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">Register portable cooler</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register Reusable Portable Cooler</DialogTitle>
          <DialogDescription>
            Register an insulated cooler ID (for example IGLOO-MOTO-01) so staff can pair its Teltonika EYE
            BTSMP1 EN12830 sensor and assign it to motorbikes or vans.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
          <div className="flex flex-col gap-1">
            <label htmlFor="cooler-code-input" className="text-xs font-medium text-gray-700">
              Reusable Cooler ID
            </label>
            <input
              id="cooler-code-input"
              className={fieldClassName}
              placeholder="IGLOO-MOTO-01"
              value={coolerCode}
              onChange={(e) => setCoolerCode(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="cooler-label-input" className="text-xs font-medium text-gray-700">
              Description / Size
            </label>
            <input
              id="cooler-label-input"
              className={fieldClassName}
              placeholder="Igloo Marine 48qt Insulated Cooler"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="cooler-storage-select" className="text-xs font-medium text-gray-700">
                Storage Profile
              </label>
              <Select value={storageType} onValueChange={(v) => setStorageType(v as 'FRESH' | 'FROZEN')}>
                <SelectTrigger id="cooler-storage-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FRESH">Fresh Chilled (0°C to 4°C)</SelectItem>
                  <SelectItem value="FROZEN">Frozen (-22°C to -18°C)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="cooler-vehicle-select" className="text-xs font-medium text-gray-700">
                Initial Vehicle Assignment (Optional)
              </label>
              <Select value={fleetAssetId} onValueChange={setFleetAssetId}>
                <SelectTrigger id="cooler-vehicle-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">Keep unassigned (Depot)</SelectItem>
                  {vehicles
                    .filter((v) => v.status !== FleetAssetStatus.RETIRED)
                    .map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.licensePlate} ({formatEnumLabel(v.assetType)})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {fleetAssetId !== 'NONE' ? (
            <div className="flex flex-col gap-1">
              <label htmlFor="cooler-slot-select" className="text-xs font-medium text-gray-700">
                Tracker BLE Sensor Slot (1-4)
              </label>
              <Select value={sensorSlot} onValueChange={setSensorSlot}>
                <SelectTrigger id="cooler-slot-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Slot #1 (AVL 10800)</SelectItem>
                  <SelectItem value="2">Slot #2 (AVL 10801)</SelectItem>
                  <SelectItem value="3">Slot #3 (AVL 10802)</SelectItem>
                  <SelectItem value="4">Slot #4 (AVL 10803)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <label htmlFor="cooler-notes-input" className="text-xs font-medium text-gray-700">
              Mounting Notes
            </label>
            <input
              id="cooler-notes-input"
              className={fieldClassName}
              placeholder="Upper liner bracket away from ice packs and meltwater"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {error ? <p className="text-xs font-medium text-irie-red">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createCompartment?.isPending}>
              {createCompartment?.isPending ? 'Saving...' : 'Save portable cooler'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PairEyeSensorDialog({
  cooler,
  onClose,
}: {
  cooler: PortableCoolerSummary | null;
  onClose: () => void;
}): React.ReactElement {
  const [deviceCode, setDeviceCode] = React.useState('');
  const [bleMacAddress, setBleMacAddress] = React.useState('');
  const [sensorSlot, setSensorSlot] = React.useState('1');
  const [firmwareVersion, setFirmwareVersion] = React.useState('1.12.5');
  const [error, setError] = React.useState<string | null>(null);
  const registerSensor = useRegisterCargoSensor();

  React.useEffect(() => {
    if (cooler) {
      setDeviceCode(`${cooler.coolerCode ?? cooler.compartmentCode}-EYE`);
      setBleMacAddress('');
      setSensorSlot('1');
      setError(null);
    }
  }, [cooler]);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!cooler) return;
    setError(null);
    if (!deviceCode.trim()) {
      setError('Sensor device code is required.');
      return;
    }
    try {
      await registerSensor.mutateAsync({
        compartmentId: cooler.id,
        deviceCode: deviceCode.trim(),
        ...(bleMacAddress.trim() ? { bleMacAddress: bleMacAddress.trim() } : {}),
        sensorSlot: Number(sensorSlot) || 1,
        ...(firmwareVersion.trim() ? { firmwareVersion: firmwareVersion.trim() } : {}),
      });
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Unable to pair EYE sensor.'));
    }
  }

  return (
    <Dialog open={Boolean(cooler)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pair Teltonika EYE BTSMP1 EN12830 Sensor</DialogTitle>
          <DialogDescription>
            Pair a BLE probe mounted inside cooler{' '}
            <span className="font-mono font-semibold">{cooler?.coolerCode ?? cooler?.compartmentCode}</span> clear of
            direct ice/fish contact.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
          <div className="flex flex-col gap-1">
            <label htmlFor="eye-device-code" className="text-xs font-medium text-gray-700">
              Sensor Device Code
            </label>
            <input
              id="eye-device-code"
              className={fieldClassName}
              value={deviceCode}
              onChange={(e) => setDeviceCode(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="eye-ble-mac" className="text-xs font-medium text-gray-700">
                BLE MAC Address
              </label>
              <input
                id="eye-ble-mac"
                className={fieldClassName}
                placeholder="7C:D9:F4:11:22:33"
                value={bleMacAddress}
                onChange={(e) => setBleMacAddress(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="eye-slot-select" className="text-xs font-medium text-gray-700">
                Tracker BLE Preset Slot
              </label>
              <Select value={sensorSlot} onValueChange={setSensorSlot}>
                <SelectTrigger id="eye-slot-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Slot #1 (AVL 10800)</SelectItem>
                  <SelectItem value="2">Slot #2 (AVL 10801)</SelectItem>
                  <SelectItem value="3">Slot #3 (AVL 10802)</SelectItem>
                  <SelectItem value="4">Slot #4 (AVL 10803)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="eye-fw" className="text-xs font-medium text-gray-700">
              Firmware Version (Optional)
            </label>
            <input
              id="eye-fw"
              className={fieldClassName}
              value={firmwareVersion}
              onChange={(e) => setFirmwareVersion(e.target.value)}
            />
          </div>
          {error ? <p className="text-xs font-medium text-irie-red">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={registerSensor?.isPending}>
              {registerSensor?.isPending ? 'Pairing...' : 'Save sensor pairing'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssignCoolerDialog({
  cooler,
  vehicles,
  onClose,
}: {
  cooler: PortableCoolerSummary | null;
  vehicles: FleetAsset[];
  onClose: () => void;
}): React.ReactElement {
  const [fleetAssetId, setFleetAssetId] = React.useState('');
  const [sensorSlot, setSensorSlot] = React.useState('1');
  const [notes, setNotes] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const assignCooler = useAssignCoolerVehicle();

  React.useEffect(() => {
    if (cooler) {
      const candidate =
        vehicles.find((v) => v.status !== FleetAssetStatus.RETIRED && v.id !== cooler.fleetAssetId) ??
        vehicles[0];
      setFleetAssetId(candidate?.id ?? '');
      setSensorSlot(String(cooler.sensors[0]?.sensorSlot ?? 1));
      setNotes('');
      setError(null);
    }
  }, [cooler, vehicles]);

  const selectedVehicle = vehicles.find((v) => v.id === fleetAssetId);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!cooler || !fleetAssetId) return;
    setError(null);
    try {
      await assignCooler.mutateAsync({
        compartmentId: cooler.id,
        fleetAssetId,
        sensorSlot: Number(sensorSlot) || 1,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Unable to assign cooler to vehicle.'));
    }
  }

  return (
    <Dialog open={Boolean(cooler)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign / Transfer Portable Cooler</DialogTitle>
          <DialogDescription>
            Move cooler <span className="font-mono font-semibold">{cooler?.coolerCode ?? cooler?.compartmentCode}</span>{' '}
            to a motorbike (max 1 active cooler) or small van (supports multiple coolers). Full assignment history is
            preserved.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
          <div className="flex flex-col gap-1">
            <label htmlFor="assign-vehicle-select" className="text-xs font-medium text-gray-700">
              Destination Vehicle
            </label>
            <Select value={fleetAssetId} onValueChange={setFleetAssetId}>
              <SelectTrigger id="assign-vehicle-select">
                <SelectValue placeholder="Choose bike or van" />
              </SelectTrigger>
              <SelectContent>
                {vehicles
                  .filter((v) => v.status !== FleetAssetStatus.RETIRED)
                  .map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.licensePlate} · {formatEnumLabel(v.assetType)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {selectedVehicle?.assetType === FleetAssetType.MOTORBIKE ? (
              <p className="text-xs text-gray-600">
                Motorbike rule: supports 1 mounted cooler and uses Teltonika FMC234 BLE telemetry.
              </p>
            ) : selectedVehicle ? (
              <p className="text-xs text-gray-600">
                Van / truck rule: supports up to 4 separately monitored coolers across BLE slots #1-#4.
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="assign-slot-select" className="text-xs font-medium text-gray-700">
              Vehicle Tracker BLE Slot
            </label>
            <Select value={sensorSlot} onValueChange={setSensorSlot}>
              <SelectTrigger id="assign-slot-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Slot #1 (AVL 10800)</SelectItem>
                <SelectItem value="2">Slot #2 (AVL 10801)</SelectItem>
                <SelectItem value="3">Slot #3 (AVL 10802)</SelectItem>
                <SelectItem value="4">Slot #4 (AVL 10803)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="assign-notes-input" className="text-xs font-medium text-gray-700">
              Handover / Assignment Notes
            </label>
            <input
              id="assign-notes-input"
              className={fieldClassName}
              placeholder="Morning Kingston pilot run"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {error ? <p className="text-xs font-medium text-irie-red">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={assignCooler?.isPending || !fleetAssetId}>
              {assignCooler?.isPending ? 'Assigning...' : 'Confirm assignment'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CoolerHistoryDialog({
  cooler,
  onClose,
}: {
  cooler: PortableCoolerSummary | null;
  onClose: () => void;
}): React.ReactElement {
  return (
    <Dialog open={Boolean(cooler)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Cooler Assignment History ({cooler?.coolerCode ?? cooler?.compartmentCode})
          </DialogTitle>
          <DialogDescription>
            Chronological log of every motorbike or van that carried this cooler and its BLE sensor slot.
          </DialogDescription>
        </DialogHeader>
        {cooler?.assignmentHistory.length === 0 ? (
          <p className="text-sm text-gray-500">No vehicle assignments recorded yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vehicle</TableHead>
                <TableHead>BLE Slot</TableHead>
                <TableHead>Assigned</TableHead>
                <TableHead>Unassigned</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cooler?.assignmentHistory.map((h) => (
                <TableRow key={h.id}>
                  <TableCell className="text-xs font-medium">
                    {h.licensePlate} ({formatEnumLabel(h.assetType)})
                  </TableCell>
                  <TableCell className="text-xs">{h.sensorSlot ? `#${h.sensorSlot}` : '—'}</TableCell>
                  <TableCell className="text-xs">{formatTelemetryDateTime(h.assignedAt)}</TableCell>
                  <TableCell className="text-xs">
                    {h.unassignedAt ? (
                      formatTelemetryDateTime(h.unassignedAt)
                    ) : (
                      <Badge variant="success">Active</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-gray-600">{h.notes ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function PortableCoolersSection({ zones: _zones }: { zones: DeliveryZone[] }): React.ReactElement {
  const compartmentsQuery = useCompartments?.();
  const fleetQuery = useFleetAssets({ page: 1, pageSize: 100 });
  const unassignCooler = useUnassignCoolerVehicle?.();

  const [pairTarget, setPairTarget] = React.useState<PortableCoolerSummary | null>(null);
  const [assignTarget, setAssignTarget] = React.useState<PortableCoolerSummary | null>(null);
  const [historyTarget, setHistoryTarget] = React.useState<PortableCoolerSummary | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const vehicles = fleetQuery?.data?.items ?? [];
  const coolers = compartmentsQuery?.data ?? [];

  async function handleDetach(coolerId: string): Promise<void> {
    if (!unassignCooler) return;
    setActionError(null);
    try {
      await unassignCooler.mutateAsync({ compartmentId: coolerId, notes: 'Detached to depot storage' });
    } catch (err) {
      setActionError(getErrorMessage(err, 'Unable to detach cooler.'));
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Portable Coolers &amp; Cargo Compartments</h2>
          <p className="text-xs text-gray-600">
            Register reusable Igloo/insulated coolers, pair EYE BTSMP1 EN12830 sensors, and assign 1 cooler per
            motorbike or multiple coolers per small van with preserved assignment history.
          </p>
        </div>
        <RegisterCoolerDialog vehicles={vehicles} />
      </div>

      {actionError ? <p className="text-sm font-medium text-irie-red">{actionError}</p> : null}

      <Card className="p-0">
        {compartmentsQuery?.isPending ? (
          <div className="flex flex-col gap-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : compartmentsQuery?.isError ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-irie-red">Unable to load portable coolers and vehicle compartments.</p>
            <Button variant="secondary" size="sm" className="w-fit" onClick={() => void compartmentsQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cooler / Code</TableHead>
                <TableHead>Kind / Target</TableHead>
                <TableHead>Current Vehicle</TableHead>
                <TableHead>Paired EYE Sensor (BTSMP1)</TableHead>
                <TableHead>Assignment History</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {coolers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-gray-500">
                    No portable coolers or compartments registered yet.
                  </TableCell>
                </TableRow>
              ) : (
                coolers.map((cooler) => {
                  const primarySensor = cooler.sensors[0] ?? null;
                  const statusMeta = primarySensor
                    ? SENSOR_STATUS_META[primarySensor.reportingStatus]
                    : null;
                  return (
                    <TableRow key={cooler.id}>
                      <TableCell>
                        <div className="font-mono text-xs font-semibold text-gray-900">
                          {cooler.coolerCode ?? cooler.compartmentCode}
                        </div>
                        <div className="text-xs text-gray-500">{cooler.label}</div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <Badge
                          variant={
                            cooler.compartmentKind === CompartmentKind.PORTABLE_COOLER ? 'info' : 'neutral'
                          }
                        >
                          {cooler.compartmentKind === CompartmentKind.PORTABLE_COOLER
                            ? 'Portable Cooler'
                            : 'Fixed Compartment'}
                        </Badge>
                        <div className="mt-1 text-gray-500">{formatRange(cooler)}</div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {cooler.licensePlate ? (
                          <div>
                            <div className="font-medium text-gray-900">{cooler.licensePlate}</div>
                            <div className="text-gray-500">
                              {cooler.assetType ? formatEnumLabel(cooler.assetType) : ''}
                            </div>
                          </div>
                        ) : (
                          <span className="text-gray-500">Depot (Unassigned)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {primarySensor ? (
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono font-medium">{primarySensor.deviceCode}</span>
                              {statusMeta ? (
                                <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
                              ) : null}
                            </div>
                            <div className="text-gray-500">
                              {primarySensor.bleMacAddress ?? 'No BLE MAC'}
                              {primarySensor.sensorSlot ? ` · Slot #${primarySensor.sensorSlot}` : ''}
                              {primarySensor.lastTemperatureC !== null
                                ? ` · ${primarySensor.lastTemperatureC.toFixed(1)} °C`
                                : ''}
                            </div>
                          </div>
                        ) : (
                          <span className="text-gray-500">No sensor paired</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setHistoryTarget(cooler)}
                        >
                          History ({cooler.assignmentHistory.length})
                        </Button>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1.5">
                          <Button variant="secondary" size="sm" onClick={() => setPairTarget(cooler)}>
                            Pair sensor
                          </Button>
                          {cooler.compartmentKind === CompartmentKind.PORTABLE_COOLER ? (
                            <>
                              <Button variant="secondary" size="sm" onClick={() => setAssignTarget(cooler)}>
                                {cooler.fleetAssetId ? 'Reassign vehicle' : 'Assign vehicle'}
                              </Button>
                              {cooler.fleetAssetId ? (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  disabled={unassignCooler?.isPending}
                                  onClick={() => void handleDetach(cooler.id)}
                                >
                                  Detach
                                </Button>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        )}
      </Card>

      <PairEyeSensorDialog cooler={pairTarget} onClose={() => setPairTarget(null)} />
      <AssignCoolerDialog cooler={assignTarget} vehicles={vehicles} onClose={() => setAssignTarget(null)} />
      <CoolerHistoryDialog cooler={historyTarget} onClose={() => setHistoryTarget(null)} />
    </section>
  );
}
