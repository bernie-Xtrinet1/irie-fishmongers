'use client';

import { FleetAssetStatus, type DeliveryZone } from '@iriefishmongers/types';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmActionDialog } from '@/components/confirm-action-dialog';
import { PaginationControls } from '@/components/pagination-controls';
import { formatEnumLabel } from '@/lib/format';
import { useFleetAssets, useUpdateFleetAssetStatus } from '@/lib/hooks/use-fleet';

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
      <h2 className="text-lg font-semibold text-gray-900">Fleet Assets</h2>

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
