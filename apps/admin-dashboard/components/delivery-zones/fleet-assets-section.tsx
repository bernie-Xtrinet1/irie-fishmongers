'use client';

import {
  FleetAssetStatus,
  FleetAssetType,
  FleetOwnership,
  TrackerHardwareModel,
  type DeliveryZone,
} from '@iriefishmongers/types';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
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
import { ConfirmActionDialog } from '@/components/confirm-action-dialog';
import { PaginationControls } from '@/components/pagination-controls';
import { formatEnumLabel } from '@/lib/format';
import { useCreateFleetAsset, useFleetAssets, useUpdateFleetAssetStatus } from '@/lib/hooks/use-fleet';
import { useRegisterVehicleTracker } from '@/lib/hooks/use-telemetry';

const PAGE_SIZE = 20;

const STATUS_BADGE_VARIANT: Record<FleetAssetStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  [FleetAssetStatus.ACTIVE]: 'success',
  [FleetAssetStatus.MAINTENANCE]: 'warning',
  [FleetAssetStatus.RETIRED]: 'danger',
};

const ACTION_COPY: Record<
  FleetAssetStatus,
  { label: string; title: string; description: string; variant: 'primary' | 'danger'; gated: boolean }
> = {
  [FleetAssetStatus.ACTIVE]: {
    label: 'Activate',
    title: 'Reactivate this asset?',
    description: 'The asset will be marked ACTIVE and become available for delivery scheduling again.',
    variant: 'primary',
    gated: false,
  },
  [FleetAssetStatus.MAINTENANCE]: {
    label: 'Maintenance',
    title: 'Mark this asset under maintenance?',
    description: 'Marking this asset MAINTENANCE removes it from delivery scheduling until it is reactivated.',
    variant: 'danger',
    gated: true,
  },
  [FleetAssetStatus.RETIRED]: {
    label: 'Retire',
    title: 'Retire this asset?',
    description:
      'Retiring this asset permanently removes it from delivery scheduling. This is typically not reversed operationally.',
    variant: 'danger',
    gated: true,
  },
};

const inputClassName =
  'h-10 rounded-button border border-gray-300 bg-white px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2';

function RegisterFleetVehicleForm({
  zones,
  onClose,
}: {
  zones: DeliveryZone[];
  onClose: () => void;
}): React.ReactElement {
  const [zoneId, setZoneId] = React.useState(zones[0]?.id ?? '');
  const [assetType, setAssetType] = React.useState<FleetAssetType>(FleetAssetType.MOTORBIKE);
  const [ownership, setOwnership] = React.useState<FleetOwnership>(FleetOwnership.COMPANY_OWNED);
  const [licensePlate, setLicensePlate] = React.useState('');
  const [capacityLbs, setCapacityLbs] = React.useState('120');
  const [coldChainCapable, setColdChainCapable] = React.useState(true);
  const [enrollTracker, setEnrollTracker] = React.useState(false);
  const [imei, setImei] = React.useState('');
  const [simCarrier, setSimCarrier] = React.useState('Digicel Jamaica LTE');
  const [firmwareVersion, setFirmwareVersion] = React.useState('03.29.00.Rev.18');
  const [error, setError] = React.useState<string | null>(null);

  const createAsset = useCreateFleetAsset?.();
  const registerTracker = useRegisterVehicleTracker?.();

  React.useEffect(() => {
    if (!zoneId && zones[0]?.id) {
      setZoneId(zones[0].id);
    }
  }, [zones, zoneId]);

  const trackerModel =
    assetType === FleetAssetType.MOTORBIKE
      ? TrackerHardwareModel.TELTONIKA_FMC234
      : TrackerHardwareModel.TELTONIKA_FMC130;

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!createAsset) return;
    setError(null);
    if (!zoneId || !licensePlate.trim()) {
      setError('Zone and license plate are required.');
      return;
    }
    const parsedCapacity = Number(capacityLbs);
    if (!Number.isFinite(parsedCapacity) || parsedCapacity <= 0) {
      setError('Capacity must be positive.');
      return;
    }
    if (enrollTracker && !/^\d{15,20}$/.test(imei.trim())) {
      setError('Tracker IMEI must be 15 to 20 digits.');
      return;
    }

    try {
      const created = await createAsset.mutateAsync({
        zoneId,
        assetType,
        ownership,
        licensePlate: licensePlate.trim().toUpperCase(),
        capacityLbs: parsedCapacity,
        coldChainCapable,
      });

      if (enrollTracker && registerTracker) {
        await registerTracker.mutateAsync({
          fleetAssetId: created.id,
          imei: imei.trim(),
          hardwareModel: trackerModel,
          simCarrier: simCarrier.trim() || undefined,
          firmwareVersion: firmwareVersion.trim() || undefined,
        });
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Unable to register vehicle.');
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="fleet-zone-input" className="text-xs font-medium text-gray-700">
            Delivery Zone
          </label>
          <Select value={zoneId} onValueChange={setZoneId}>
            <SelectTrigger id="fleet-zone-input">
              <SelectValue placeholder="Select zone" />
            </SelectTrigger>
            <SelectContent>
              {zones.map((z) => (
                <SelectItem key={z.id} value={z.id}>
                  {z.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="fleet-type-input" className="text-xs font-medium text-gray-700">
            Vehicle Type
          </label>
          <Select
            value={assetType}
            onValueChange={(value) => {
              const nextType = value as FleetAssetType;
              setAssetType(nextType);
              setCapacityLbs(nextType === FleetAssetType.MOTORBIKE ? '120' : '1500');
            }}
          >
            <SelectTrigger id="fleet-type-input">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.values(FleetAssetType).map((value) => (
                <SelectItem key={value} value={value}>
                  {formatEnumLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="fleet-plate-input" className="text-xs font-medium text-gray-700">
            License Plate
          </label>
          <input
            id="fleet-plate-input"
            className={inputClassName}
            placeholder="MB 4021"
            value={licensePlate}
            onChange={(e) => setLicensePlate(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="fleet-capacity-input" className="text-xs font-medium text-gray-700">
            Capacity (lbs)
          </label>
          <input
            id="fleet-capacity-input"
            type="number"
            min="1"
            step="1"
            className={inputClassName}
            value={capacityLbs}
            onChange={(e) => setCapacityLbs(e.target.value)}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="fleet-ownership-input" className="text-xs font-medium text-gray-700">
            Ownership
          </label>
          <Select value={ownership} onValueChange={(v) => setOwnership(v as FleetOwnership)}>
            <SelectTrigger id="fleet-ownership-input">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.values(FleetOwnership).map((value) => (
                <SelectItem key={value} value={value}>
                  {formatEnumLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 pt-5 text-xs font-medium text-gray-700">
          <input
            type="checkbox"
            checked={coldChainCapable}
            onChange={(e) => setColdChainCapable(e.target.checked)}
          />
          Cold-chain capable (cooler / chiller)
        </label>
      </div>

      <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
        <label className="flex items-center gap-2 text-xs font-semibold text-gray-800">
          <input
            type="checkbox"
            checked={enrollTracker}
            onChange={(e) => setEnrollTracker(e.target.checked)}
          />
          Also enroll Teltonika LTE tracker ({formatEnumLabel(trackerModel)})
        </label>
        {enrollTracker ? (
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="tracker-imei-input" className="text-xs font-medium text-gray-700">
                15-digit IMEI
              </label>
              <input
                id="tracker-imei-input"
                className={inputClassName}
                placeholder="356307042449901"
                value={imei}
                onChange={(e) => setImei(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="tracker-sim-input" className="text-xs font-medium text-gray-700">
                Jamaican SIM Carrier
              </label>
              <input
                id="tracker-sim-input"
                className={inputClassName}
                value={simCarrier}
                onChange={(e) => setSimCarrier(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label htmlFor="tracker-fw-input" className="text-xs font-medium text-gray-700">
                Verified Firmware
              </label>
              <input
                id="tracker-fw-input"
                className={inputClassName}
                value={firmwareVersion}
                onChange={(e) => setFirmwareVersion(e.target.value)}
              />
            </div>
          </div>
        ) : null}
      </div>
      {error ? <p className="text-xs font-medium text-irie-red">{error}</p> : null}
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={createAsset?.isPending || registerTracker?.isPending}>
          {createAsset?.isPending ? 'Saving...' : 'Save fleet vehicle'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RegisterFleetVehicleDialog({ zones }: { zones: DeliveryZone[] }): React.ReactElement {
  const [open, setOpen] = React.useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Register bike / vehicle</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register Fleet Vehicle &amp; Optional Tracker</DialogTitle>
          <DialogDescription>
            Enroll a motorbike (Teltonika FMC234 pilot) or delivery van/truck (Teltonika FMC130) for same-parish
            cold-chain runs.
          </DialogDescription>
        </DialogHeader>
        {open ? <RegisterFleetVehicleForm zones={zones} onClose={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

export function FleetAssetsSection({ zones }: { zones: DeliveryZone[] }): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const page = Number(searchParams.get('assetPage') ?? '1') || 1;
  const zoneId = searchParams.get('assetZone') ?? undefined;
  const status = (searchParams.get('assetStatus') as FleetAssetStatus | null) ?? undefined;

  const query = useFleetAssets({ page, pageSize: PAGE_SIZE, zoneId, status });
  const updateStatus = useUpdateFleetAssetStatus();

  const zoneName = (id: string): string => zones.find((zone) => zone.id === id)?.name ?? id;

  function updateSearchParams(next: { zone?: string; status?: string; page?: number }): void {
    const params = new URLSearchParams(searchParams.toString());

    if ('zone' in next) {
      if (next.zone && next.zone !== 'ALL') params.set('assetZone', next.zone);
      else params.delete('assetZone');
      params.delete('assetPage');
    }
    if ('status' in next) {
      if (next.status && next.status !== 'ALL') params.set('assetStatus', next.status);
      else params.delete('assetStatus');
      params.delete('assetPage');
    }
    if ('page' in next && next.page) {
      params.set('assetPage', String(next.page));
    }

    const queryString = params.toString();
    router.push(queryString ? `${pathname}?${queryString}` : pathname);
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900">Fleet Assets</h2>
        {zones.length > 0 ? <RegisterFleetVehicleDialog zones={zones} /> : null}
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="asset-zone-filter" className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Zone
          </label>
          <Select value={zoneId ?? 'ALL'} onValueChange={(value) => updateSearchParams({ zone: value })}>
            <SelectTrigger id="asset-zone-filter" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All zones</SelectItem>
              {zones.map((zone) => (
                <SelectItem key={zone.id} value={zone.id}>
                  {zone.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="asset-status-filter" className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Status
          </label>
          <Select value={status ?? 'ALL'} onValueChange={(value) => updateSearchParams({ status: value })}>
            <SelectTrigger id="asset-status-filter" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {Object.values(FleetAssetStatus).map((value) => (
                <SelectItem key={value} value={value}>
                  {formatEnumLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="p-0">
        {query.isPending ? (
          <div className="flex flex-col gap-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-irie-red">Unable to load fleet assets.</p>
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
                  <TableHead>License Plate</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Zone</TableHead>
                  <TableHead>Capacity (lbs)</TableHead>
                  <TableHead>Cold Chain</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-gray-500">
                      No fleet assets match these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.items.map((asset) => (
                    <TableRow key={asset.id}>
                      <TableCell className="font-medium">{asset.licensePlate}</TableCell>
                      <TableCell>{formatEnumLabel(asset.assetType)}</TableCell>
                      <TableCell>{zoneName(asset.zoneId)}</TableCell>
                      <TableCell>{asset.capacityLbs}</TableCell>
                      <TableCell>
                        <Badge variant={asset.coldChainCapable ? 'success' : 'neutral'}>
                          {asset.coldChainCapable ? 'Capable' : 'Not capable'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_BADGE_VARIANT[asset.status]}>{formatEnumLabel(asset.status)}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          {Object.values(FleetAssetStatus)
                            .filter((target) => target !== asset.status)
                            .map((target) => {
                              const copy = ACTION_COPY[target];

                              if (!copy.gated) {
                                return (
                                  <Button
                                    key={target}
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => updateStatus.mutate({ id: asset.id, status: target })}
                                  >
                                    {copy.label}
                                  </Button>
                                );
                              }

                              return (
                                <ConfirmActionDialog
                                  key={target}
                                  trigger={
                                    <Button variant="secondary" size="sm">
                                      {copy.label}
                                    </Button>
                                  }
                                  title={copy.title}
                                  description={copy.description}
                                  actionLabel={copy.label}
                                  actionVariant={copy.variant}
                                  isPending={updateStatus.isPending}
                                  onConfirm={() => updateStatus.mutate({ id: asset.id, status: target })}
                                />
                              );
                            })}
                        </div>
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
              onPageChange={(nextPage) => updateSearchParams({ page: nextPage })}
            />
          </>
        ) : null}
      </Card>
    </section>
  );
}
