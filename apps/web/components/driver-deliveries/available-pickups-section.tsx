'use client';

import type { AvailableDelivery } from '@iriefishmongers/types';
import { AlertCircle, MapPin, PackageCheck, RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatEnumLabel } from '@/lib/format';

import { formatJamaicaDateTime } from './driver-deliveries-helpers';

export interface AvailablePickupsSectionProps {
  canBrowsePickups: boolean;
  isBusy: boolean;
  isApproved: boolean;
  items: AvailableDelivery[];
  isLoading: boolean;
  isFetching: boolean;
  errorMessage: string | null;
  claimBannerError: string | null;
  claimingVendorOrderId: string | null;
  onRefresh: () => void;
  onClaim: (vendorOrderId: string) => Promise<void>;
}

export function AvailablePickupsSection({
  canBrowsePickups,
  isBusy,
  isApproved,
  items,
  isLoading,
  isFetching,
  errorMessage,
  claimBannerError,
  claimingVendorOrderId,
  onRefresh,
  onClaim,
}: AvailablePickupsSectionProps): React.ReactElement {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>Available pickups</CardTitle>
          <p className="text-sm text-gray-600">
            Vendor orders marked ready for pickup. Claiming a job sets your availability to Busy until it closes.
          </p>
        </div>

        {canBrowsePickups ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-10 w-full sm:w-auto"
            disabled={isFetching}
            onClick={onRefresh}
          >
            <RefreshCw
              className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            Refresh pickups
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-4">
        {claimBannerError ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-irie-red/40 bg-irie-red/10 p-3.5 text-sm text-irie-red"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{claimBannerError}</span>
          </div>
        ) : null}

        {!isApproved ? (
          <p className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
            Available pickup jobs appear here once your driver profile is approved and you are online.
          </p>
        ) : isBusy ? (
          <p className="rounded-lg border border-ocean-blue/25 bg-ocean-blue/5 p-4 text-sm text-gray-700">
            Finish or record failure on your active delivery before claiming another pickup job.
          </p>
        ) : !canBrowsePickups ? (
          <p className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
            Go online in the Driver status card above to browse and claim available pickup jobs.
          </p>
        ) : isLoading ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading available pickups">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : errorMessage ? (
          <div className="space-y-3">
            <div
              role="alert"
              className="rounded-lg border border-irie-red/40 bg-irie-red/10 p-3.5 text-sm text-irie-red"
            >
              {errorMessage}
            </div>
            <Button type="button" variant="secondary" onClick={onRefresh}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Retry available pickups
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-600">
            No ready vendor pickups right now. Tap Refresh pickups to check again.
          </div>
        ) : (
          <ul className="space-y-3">
            {items.map((job) => {
              const isClaimingThis = claimingVendorOrderId === job.vendorOrderId;
              return (
                <li
                  key={job.vendorOrderId}
                  className="rounded-lg border border-gray-200 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-semibold text-gray-900">{job.pickupVendorName}</h4>
                      <Badge variant="info">
                        <MapPin className="h-3 w-3" aria-hidden="true" />
                        {formatEnumLabel(job.pickupParish)}
                      </Badge>
                    </div>
                    <ul className="text-sm text-gray-700 space-y-0.5">
                      {job.items.map((item, idx) => (
                        <li key={`${job.vendorOrderId}-item-${idx}`}>
                          {item.quantity} × {item.productName} ({formatEnumLabel(item.unit).toLowerCase()})
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-gray-500">
                      Ready since {formatJamaicaDateTime(job.readyForPickupAt)}
                    </p>
                  </div>

                  <Button
                    type="button"
                    variant="primary"
                    className="h-11 w-full shrink-0 sm:w-auto"
                    loading={isClaimingThis}
                    disabled={Boolean(claimingVendorOrderId)}
                    onClick={() => {
                      void onClaim(job.vendorOrderId);
                    }}
                  >
                    <PackageCheck className="h-4 w-4" aria-hidden="true" />
                    Claim pickup
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
