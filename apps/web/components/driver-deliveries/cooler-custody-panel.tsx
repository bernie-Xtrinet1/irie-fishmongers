'use client';

import type { DriverDelivery, DriverDeliveryLoadingContext } from '@iriefishmongers/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, ChevronDown, ChevronUp, PackageCheck, Thermometer } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  fetchDriverLoadingContext,
  recordCargoHandover,
  recordCargoPickup,
  recordCargoTransfer,
  recordManualTemperatureCheck,
} from '@/lib/api/drivers';
import { formatEnumLabel } from '@/lib/format';

import { formatJamaicaDateTime } from './driver-deliveries-helpers';

export interface CoolerCustodyPanelProps {
  delivery: DriverDelivery;
  isApproved: boolean;
}

export function CoolerCustodyPanel({
  delivery,
  isApproved,
}: CoolerCustodyPanelProps): React.ReactElement | null {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = React.useState(false);

  const [selectedVehicleId, setSelectedVehicleId] = React.useState('');
  const [selectedCompartmentId, setSelectedCompartmentId] = React.useState('');
  const [lotQuantities, setLotQuantities] = React.useState<Record<string, number>>({});
  const [handoverLotId, setHandoverLotId] = React.useState('');
  const [handoverQty, setHandoverQty] = React.useState('1');
  const [transferToVehicleId, setTransferToVehicleId] = React.useState('');
  const [transferToCompartmentId, setTransferToCompartmentId] = React.useState('');
  const [moveCoolerWithCargo, setMoveCoolerWithCargo] = React.useState(false);

  const [manualLotId, setManualLotId] = React.useState('');
  const [manualCheckpoint, setManualCheckpoint] = React.useState<'DRIVER_PICKUP' | 'DELIVERY'>('DRIVER_PICKUP');
  const [manualTempC, setManualTempC] = React.useState('');
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const canAct = isApproved && (delivery.stage === 'ASSIGNED' || delivery.stage === 'PICKED_UP');

  const contextQuery = useQuery<DriverDeliveryLoadingContext | null>({
    queryKey: ['driver-loading-context', delivery.id],
    queryFn: () =>
      typeof fetchDriverLoadingContext === 'function'
        ? fetchDriverLoadingContext(delivery.id)
        : Promise.resolve(null),
    enabled: expanded && canAct,
  });

  const ctx = contextQuery.data ?? null;
  const lotItems = (ctx?.items ?? []).filter((item) => Boolean(item.lotId));
  const selectedVehicle = ctx?.fleetAssets.find((a) => a.id === selectedVehicleId) ?? ctx?.fleetAssets[0];
  const compartments = selectedVehicle?.compartments ?? [];

  React.useEffect(() => {
    if (!ctx) return;
    if (!selectedVehicleId && ctx.fleetAssets[0]) {
      setSelectedVehicleId(ctx.fleetAssets[0].id);
      if (ctx.fleetAssets[0].compartments[0]) {
        setSelectedCompartmentId(ctx.fleetAssets[0].compartments[0].id);
      }
    }
    const defaults: Record<string, number> = {};
    for (const item of ctx.items) {
      if (item.lotId) {
        defaults[item.lotId] = item.quantity;
      }
    }
    setLotQuantities((prev) => (Object.keys(prev).length > 0 ? prev : defaults));

    if (!manualLotId && ctx.items.find((i) => i.lotId)?.lotId) {
      setManualLotId(ctx.items.find((i) => i.lotId)!.lotId!);
    }
    if (ctx.openAssignments[0] && !handoverLotId) {
      setHandoverLotId(ctx.openAssignments[0].lotId);
      setHandoverQty(
        String(Math.max(1, ctx.openAssignments[0].quantityUnits - ctx.openAssignments[0].handedOverQuantity)),
      );
    }
  }, [ctx, selectedVehicleId, manualLotId, handoverLotId]);

  React.useEffect(() => {
    if (!selectedVehicle) return;
    if (!selectedVehicle.compartments.some((c) => c.id === selectedCompartmentId)) {
      setSelectedCompartmentId(selectedVehicle.compartments[0]?.id ?? '');
    }
  }, [selectedVehicle, selectedCompartmentId]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['driver-loading-context', delivery.id] });
    void queryClient.invalidateQueries({ queryKey: ['driver', 'deliveries'] });
  };

  const pickupMutation = useMutation({
    mutationFn: () => {
      const targetComp = compartments.find((c) => c.id === selectedCompartmentId);
      return recordCargoPickup({
        deliveryId: delivery.id,
        fleetAssetId: selectedVehicle!.id,
        compartmentId: selectedCompartmentId,
        trackerId: selectedVehicle?.trackers[0]?.id,
        sensorDeviceId: targetComp?.sensors[0]?.id,
        notes: `Driver confirmed cooler ${targetComp?.coolerCode ?? targetComp?.compartmentCode ?? ''} at pickup`,
        lots: lotItems.map((item) => ({
          lotId: item.lotId!,
          quantityUnits: lotQuantities[item.lotId!] || item.quantity,
        })),
      });
    },
    onSuccess: () => {
      setError(null);
      setFeedback('Cooler & lot custody recorded at pickup.');
      invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Unable to record cooler pickup.'),
  });

  const handoverMutation = useMutation({
    mutationFn: () => {
      const activeAssignment = ctx?.openAssignments.find((a) => a.lotId === handoverLotId) ?? ctx?.openAssignments[0];
      return recordCargoHandover({
        deliveryId: delivery.id,
        compartmentId: activeAssignment?.compartmentId,
        items: [{ lotId: activeAssignment!.lotId, handedOverQuantity: Number(handoverQty) || 1 }],
      });
    },
    onSuccess: () => {
      setError(null);
      setFeedback('Handover quantity closed in cooler custody log.');
      invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Unable to record handover.'),
  });

  const transferMutation = useMutation({
    mutationFn: () => {
      const openA = ctx?.openAssignments[0];
      return recordCargoTransfer({
        deliveryId: delivery.id,
        fromCompartmentId: openA?.compartmentId,
        toFleetAssetId: transferToVehicleId,
        toCompartmentId: moveCoolerWithCargo && openA ? openA.compartmentId : transferToCompartmentId,
        notes: moveCoolerWithCargo
          ? `Portable cooler transferred directly to replacement vehicle`
          : 'Cargo transferred to destination cooler/compartment',
      });
    },
    onSuccess: () => {
      setError(null);
      setFeedback('Vehicle / cooler transfer recorded; prior and active readings remain split by timestamp.');
      invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Unable to record transfer.'),
  });

  const manualCheckMutation = useMutation({
    mutationFn: () =>
      recordManualTemperatureCheck({
        lotId: manualLotId,
        checkpoint: manualCheckpoint,
        temperatureC: Number(manualTempC),
        notes: `Manual product core check logged by driver on delivery ${delivery.vendorOrderId}`,
      }),
    onSuccess: () => {
      setError(null);
      setManualTempC('');
      setFeedback('Manual product temperature check saved (distinct from continuous cooler-air telemetry).');
      invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Unable to record product check.'),
  });

  if (!canAct) {
    return null;
  }

  const destVehicle = ctx?.fleetAssets.find((a) => a.id === transferToVehicleId);

  return (
    <div className="rounded-lg border border-ocean-blue/25 bg-ocean-blue/5 p-3">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 text-left text-sm font-semibold text-deep-navy"
      >
        <span className="flex items-center gap-2">
          <PackageCheck className="h-4 w-4 text-ocean-blue" aria-hidden="true" />
          Cooler &amp; Lot Cold-Chain Custody
        </span>
        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>

      {expanded ? (
        <div className="mt-3 space-y-4 text-xs">
          {contextQuery.isPending ? (
            <p className="text-gray-600">Loading assigned vehicles, coolers, and lot details...</p>
          ) : !ctx ? (
            <p className="text-gray-600">Unable to load cooler context.</p>
          ) : (
            <>
              {feedback ? (
                <p className="rounded border border-sea-green/30 bg-sea-green/10 p-2 font-medium text-sea-green">
                  {feedback}
                </p>
              ) : null}
              {error ? (
                <p className="rounded border border-irie-red/30 bg-irie-red/10 p-2 font-medium text-irie-red">
                  {error}
                </p>
              ) : null}

              {/* Active onboard cooler assignments */}
              {ctx.openAssignments.length > 0 ? (
                <div className="space-y-2 rounded border border-gray-200 bg-white p-2.5">
                  <div className="font-semibold text-gray-900">Active Onboard Custody</div>
                  {ctx.openAssignments.map((a) => {
                    const remaining = Math.max(0, a.quantityUnits - a.handedOverQuantity);
                    return (
                      <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-1.5">
                        <div>
                          <span className="font-medium text-gray-900">
                            {a.lotNumber} ({a.species})
                          </span>{' '}
                          · {remaining} / {a.quantityUnits} onboard in{' '}
                          <span className="font-mono font-semibold">{a.compartmentCode}</span>
                          <div className="text-[11px] text-gray-500">
                            Loaded {formatJamaicaDateTime(a.loadedAt)}
                          </div>
                        </div>
                        <Badge variant="info">
                          {a.sensorLastTempC !== null ? `${a.sensorLastTempC.toFixed(1)} °C air` : 'Pending air temp'}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {/* Confirm Pickup Load into Cooler */}
              {lotItems.length > 0 ? (
                <div className="space-y-2 rounded border border-gray-200 bg-white p-2.5">
                  <div className="font-semibold text-gray-900">1. Confirm Pickup &amp; Cooler Loading</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] font-medium text-gray-600">Vehicle (Bike / Van)</span>
                      <select
                        value={selectedVehicle?.id ?? ''}
                        onChange={(e) => setSelectedVehicleId(e.target.value)}
                        className="h-9 rounded border border-gray-300 bg-white px-2 text-xs"
                      >
                        {ctx.fleetAssets.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.licensePlate} · {formatEnumLabel(a.assetType)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] font-medium text-gray-600">Cooler / Compartment ID</span>
                      <select
                        value={selectedCompartmentId}
                        onChange={(e) => setSelectedCompartmentId(e.target.value)}
                        className="h-9 rounded border border-gray-300 bg-white px-2 text-xs"
                      >
                        {compartments.length === 0 ? (
                          <option value="">No cooler assigned to this vehicle</option>
                        ) : (
                          compartments.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.coolerCode ?? c.compartmentCode} ({c.label})
                            </option>
                          ))
                        )}
                      </select>
                    </label>
                  </div>
                  <div className="space-y-1.5">
                    {lotItems.map((item) => (
                      <div key={item.orderItemId} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          <span className="font-medium">{item.productName}</span> · Lot{' '}
                          <span className="font-mono">{item.lotNumber}</span>
                        </span>
                        <label className="flex items-center gap-1.5">
                          <span className="text-[11px] text-gray-600">Qty:</span>
                          <input
                            type="number"
                            min={1}
                            max={item.quantity}
                            value={lotQuantities[item.lotId!] ?? item.quantity}
                            onChange={(e) =>
                              setLotQuantities((prev) => ({
                                ...prev,
                                [item.lotId!]: Number(e.target.value) || 1,
                              }))
                            }
                            className="h-8 w-16 rounded border border-gray-300 px-2 text-xs"
                          />
                        </label>
                      </div>
                    ))}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!selectedVehicle || !selectedCompartmentId || pickupMutation.isPending}
                    onClick={() => pickupMutation.mutate()}
                  >
                    {pickupMutation.isPending ? 'Recording pickup...' : 'Confirm Pickup & Cooler ID'}
                  </Button>
                </div>
              ) : (
                <p className="rounded border border-gray-200 bg-white p-2.5 text-gray-600">
                  No tracked seafood lot IDs are linked to this order’s items.
                </p>
              )}

              {/* Partial Handover & Transfer controls when onboard */}
              {ctx.openAssignments.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2 rounded border border-gray-200 bg-white p-2.5">
                    <div className="font-semibold text-gray-900">2. Partial / Full Handover</div>
                    <select
                      value={handoverLotId}
                      onChange={(e) => setHandoverLotId(e.target.value)}
                      className="h-9 w-full rounded border border-gray-300 bg-white px-2 text-xs"
                    >
                      {ctx.openAssignments.map((a) => (
                        <option key={a.id} value={a.lotId}>
                          {a.lotNumber} ({a.quantityUnits - a.handedOverQuantity} remaining)
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={1}
                      value={handoverQty}
                      onChange={(e) => setHandoverQty(e.target.value)}
                      className="h-9 w-full rounded border border-gray-300 px-2 text-xs"
                      aria-label="Handover quantity"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={handoverMutation.isPending}
                      onClick={() => handoverMutation.mutate()}
                    >
                      {handoverMutation.isPending ? 'Saving...' : 'Close Handover Qty'}
                    </Button>
                  </div>

                  <div className="space-y-2 rounded border border-gray-200 bg-white p-2.5">
                    <div className="flex items-center gap-1 font-semibold text-gray-900">
                      <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
                      3. Transfer Cooler / Load
                    </div>
                    <select
                      value={transferToVehicleId}
                      onChange={(e) => {
                        setTransferToVehicleId(e.target.value);
                        setTransferToCompartmentId('');
                      }}
                      className="h-9 w-full rounded border border-gray-300 bg-white px-2 text-xs"
                    >
                      <option value="">Select destination vehicle...</option>
                      {ctx.fleetAssets.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.licensePlate} · {formatEnumLabel(a.assetType)}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1.5 text-[11px] text-gray-700">
                      <input
                        type="checkbox"
                        checked={moveCoolerWithCargo}
                        onChange={(e) => setMoveCoolerWithCargo(e.target.checked)}
                      />
                      Transfer sealed portable cooler as-is
                    </label>
                    {!moveCoolerWithCargo ? (
                      <select
                        value={transferToCompartmentId}
                        onChange={(e) => setTransferToCompartmentId(e.target.value)}
                        className="h-9 w-full rounded border border-gray-300 bg-white px-2 text-xs"
                      >
                        <option value="">Destination cooler / compartment...</option>
                        {(destVehicle?.compartments ?? []).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.coolerCode ?? c.compartmentCode} ({c.label})
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={
                        !transferToVehicleId ||
                        (!moveCoolerWithCargo && !transferToCompartmentId) ||
                        transferMutation.isPending
                      }
                      onClick={() => transferMutation.mutate()}
                    >
                      {transferMutation.isPending ? 'Transferring...' : 'Record Vehicle Transfer'}
                    </Button>
                  </div>
                </div>
              ) : null}

              {/* Manual Core Product Temperature Check */}
              {lotItems.length > 0 ? (
                <div className="space-y-2 rounded border border-amber-200 bg-amber-50/70 p-2.5">
                  <div className="flex items-center gap-1.5 font-semibold text-amber-950">
                    <Thermometer className="h-3.5 w-3.5" aria-hidden="true" />
                    Manual Product Core Temperature Check (Separate from Cooler Air Telemetry)
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <select
                      value={manualLotId}
                      onChange={(e) => setManualLotId(e.target.value)}
                      className="h-9 rounded border border-gray-300 bg-white px-2 text-xs"
                    >
                      {lotItems.map((item) => (
                        <option key={item.orderItemId} value={item.lotId!}>
                          {item.lotNumber} ({item.species})
                        </option>
                      ))}
                    </select>
                    <select
                      value={manualCheckpoint}
                      onChange={(e) => setManualCheckpoint(e.target.value as 'DRIVER_PICKUP' | 'DELIVERY')}
                      className="h-9 rounded border border-gray-300 bg-white px-2 text-xs"
                    >
                      <option value="DRIVER_PICKUP">Pickup Core Check</option>
                      <option value="DELIVERY">Handover / Delivery Core Check</option>
                    </select>
                    <input
                      type="number"
                      step="0.1"
                      placeholder="Core °C (e.g. 2.1)"
                      value={manualTempC}
                      onChange={(e) => setManualTempC(e.target.value)}
                      className="h-9 rounded border border-gray-300 bg-white px-2 text-xs"
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={!manualLotId || !manualTempC.trim() || manualCheckMutation.isPending}
                    onClick={() => manualCheckMutation.mutate()}
                  >
                    {manualCheckMutation.isPending ? 'Saving...' : 'Save Manual Product Check'}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
