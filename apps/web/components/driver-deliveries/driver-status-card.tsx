'use client';

import {
  DriverAvailabilityStatus,
  DriverStatus,
  type DriverAvailabilityTarget,
  type DriverProfile,
} from '@iriefishmongers/types';
import { RefreshCw, ShieldCheck, Snowflake, Truck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatEnumLabel } from '@/lib/format';

import { getDriverEligibilityBanner } from './driver-deliveries-helpers';

export interface DriverStatusCardProps {
  profile: DriverProfile | null;
  profileMissing: boolean;
  isLoading: boolean;
  errorMessage: string | null;
  isMutating: boolean;
  onRetry: () => void;
  onToggleAvailability: (nextStatus: DriverAvailabilityTarget) => Promise<void>;
}

export function DriverStatusCard({
  profile,
  profileMissing,
  isLoading,
  errorMessage,
  isMutating,
  onRetry,
  onToggleAvailability,
}: DriverStatusCardProps): React.ReactElement {
  if (isLoading) {
    return (
      <Card aria-busy="true" aria-label="Loading driver status">
        <CardHeader>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-11 w-40" />
        </CardContent>
      </Card>
    );
  }

  if (errorMessage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Driver status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            role="alert"
            className="rounded-lg border border-irie-red/40 bg-irie-red/10 p-4 text-sm text-irie-red"
          >
            {errorMessage}
          </div>
          <Button type="button" variant="secondary" onClick={onRetry}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Retry loading status
          </Button>
        </CardContent>
      </Card>
    );
  }

  const banner = getDriverEligibilityBanner(profile, profileMissing);
  const nextTarget: DriverAvailabilityTarget =
    profile?.availabilityStatus === DriverAvailabilityStatus.ONLINE ? 'OFFLINE' : 'ONLINE';
  const toggleLabel =
    profile?.availabilityStatus === DriverAvailabilityStatus.ONLINE ? 'Go offline' : 'Go online';

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Driver status</CardTitle>
            <Badge variant={banner.badgeVariant}>{banner.badgeLabel}</Badge>
            {profile?.status === DriverStatus.APPROVED ? (
              <Badge variant="success">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                Approved driver
              </Badge>
            ) : null}
          </div>
          <p className="text-sm font-medium text-gray-900">{banner.title}</p>
        </div>

        {banner.canToggleAvailability ? (
          <Button
            type="button"
            variant={nextTarget === 'ONLINE' ? 'primary' : 'secondary'}
            className="h-11 w-full sm:w-auto"
            loading={isMutating}
            onClick={() => {
              void onToggleAvailability(nextTarget);
            }}
          >
            {toggleLabel}
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-4">
        <p className="text-sm text-gray-600">{banner.description}</p>

        {profile ? (
          <div className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3.5 text-sm sm:grid-cols-3">
            <div className="flex items-center gap-2 text-gray-800">
              <Truck className="h-4 w-4 shrink-0 text-ocean-blue" aria-hidden="true" />
              <div>
                <p className="text-xs text-gray-500">Vehicle</p>
                <p className="font-medium">
                  {formatEnumLabel(profile.vehicleType)} · {profile.licensePlate}
                </p>
              </div>
            </div>
            <div>
              <p className="text-xs text-gray-500">Approval status</p>
              <p className="font-medium text-gray-900">{formatEnumLabel(profile.status)}</p>
            </div>
            <div className="flex items-center gap-2">
              <Snowflake className="h-4 w-4 shrink-0 text-ocean-blue" aria-hidden="true" />
              <div>
                <p className="text-xs text-gray-500">Cold-chain handling</p>
                <p className="font-medium text-gray-900">
                  {profile.coldChainCapable ? 'Cold-chain capable' : 'Standard ambient only'}
                </p>
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
