'use client';

import { useQuery } from '@tanstack/react-query';
import { MapPin, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  getOrderDeliveryTracking,
  type CustomerDeliveryTrackingStage,
  type CustomerTrackedDeliveryPart,
} from '@/lib/api/orders';
import { CustomerDeliveryMap } from './customer-delivery-map';

const POLL_INTERVAL_MS = 10_000;

function formatCapturedTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('en-JM', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatCoordinatePair(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

function getStageBadgeVariant(
  stage: CustomerDeliveryTrackingStage,
): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  switch (stage) {
    case 'IN_TRANSIT':
      return 'info';
    case 'HANDED_OVER':
    case 'DELIVERED':
      return 'success';
    case 'RETURNED':
    case 'FAILED':
    case 'CANCELLED':
      return 'danger';
    default:
      return 'neutral';
  }
}

export interface DeliveryTrackingSectionProps {
  orderId: string;
  isSplitOrder: boolean;
  hasInTransitHint: boolean;
  isOpen: boolean;
  selectedVendorOrderId: string | null;
  onToggleOpen: (nextOpen: boolean) => void;
  onSelectVendorOrderId: (vendorOrderId: string) => void;
}

/**
 * Customer-facing delivery tracking card on Orders -> Order Details.
 */
export function DeliveryTrackingSection({
  orderId,
  isSplitOrder,
  hasInTransitHint,
  isOpen,
  selectedVendorOrderId,
  onToggleOpen,
  onSelectVendorOrderId,
}: DeliveryTrackingSectionProps): React.ReactElement {
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(
    selectedVendorOrderId,
  );

  useEffect(() => {
    if (selectedVendorOrderId) {
      setInternalSelectedId(selectedVendorOrderId);
    }
  }, [selectedVendorOrderId]);

  const trackingQuery = useQuery({
    queryKey: ['orders', orderId, 'tracking'],
    queryFn: () => getOrderDeliveryTracking(orderId),
    enabled: isOpen,
    refetchInterval: (query) =>
      isOpen && query.state.data?.hasActiveTracking ? POLL_INTERVAL_MS : false,
  });

  const handleSelectPart = (vendorOrderId: string): void => {
    setInternalSelectedId(vendorOrderId);
    onSelectVendorOrderId(vendorOrderId);
  };

  const deliveries = trackingQuery.data?.deliveries ?? [];
  const defaultPart =
    deliveries.find((part) => part.stage === 'IN_TRANSIT') ?? deliveries[0] ?? null;
  const activePart: CustomerTrackedDeliveryPart | null =
    deliveries.find((part) => part.vendorOrderId === internalSelectedId) ?? defaultPart;

  return (
    <section
      aria-label="Track delivery"
      className="mt-6 rounded-card border border-gray-200 bg-white p-5 sm:p-6"
    >
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-gray-900">Delivery tracking</h2>
            {isSplitOrder ? (
              <Badge variant="info">Split order</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-gray-600">
            {hasInTransitHint
              ? 'An active delivery is picked up and in transit. Check its live position and status.'
              : 'View your delivery status and live vehicle location once your order is picked up.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isOpen ? (
            <Button
              type="button"
              variant="primary"
              className="min-h-[44px]"
              onClick={() => onToggleOpen(true)}
            >
              <MapPin className="h-4 w-4" aria-hidden="true" />
              Track delivery
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="secondary"
                className="min-h-[44px]"
                disabled={trackingQuery.isFetching}
                onClick={() => {
                  void trackingQuery.refetch();
                }}
              >
                <RefreshCw
                  className={`h-4 w-4 ${trackingQuery.isFetching ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                Refresh location
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="min-h-[44px]"
                onClick={() => onToggleOpen(false)}
              >
                Hide tracking
              </Button>
            </>
          )}
        </div>
      </div>

      {isOpen ? (
        <div className="mt-5 border-t border-gray-100 pt-5">
          {trackingQuery.isPending ? (
            <p className="text-sm text-gray-600">Loading delivery tracking…</p>
          ) : trackingQuery.isError ? (
            <div className="rounded-lg border border-irie-red/20 bg-irie-red/5 p-4 text-sm text-gray-700">
              <p>We could not load delivery tracking right now.</p>
              <Button
                type="button"
                variant="secondary"
                className="mt-3 min-h-[44px]"
                onClick={() => {
                  void trackingQuery.refetch();
                }}
              >
                Try again
              </Button>
            </div>
          ) : !activePart ? (
            <p className="text-sm text-gray-600">No deliveries were found for this order.</p>
          ) : (
            <div className="space-y-4">
              {deliveries.length > 1 ? (
                <div role="tablist" aria-label="Order deliveries" className="grid gap-2 sm:grid-cols-2">
                  {deliveries.map((part) => {
                    const selected = part.vendorOrderId === activePart.vendorOrderId;
                    return (
                      <button
                        key={part.vendorOrderId}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        onClick={() => handleSelectPart(part.vendorOrderId)}
                        className={`min-h-[44px] rounded-lg border p-3 text-left transition ${
                          selected
                            ? 'border-irie-green bg-irie-green/5 ring-1 ring-irie-green'
                            : 'border-gray-200 bg-white hover:border-gray-300'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-gray-900">
                            {part.deliveryLabel}
                          </span>
                          <Badge variant={getStageBadgeVariant(part.stage)}>
                            {part.statusLabel}
                          </Badge>
                        </div>
                        <p className="mt-1 truncate text-xs text-gray-600">
                          {part.itemsSummary}
                        </p>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">
                      {activePart.deliveryLabel}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-600">
                      {activePart.itemsSummary}
                    </p>
                  </div>
                  <Badge variant={getStageBadgeVariant(activePart.stage)}>
                    {activePart.statusLabel}
                  </Badge>
                </div>

                {activePart.location ? (
                  <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
                        Position status
                      </dt>
                      <dd className="mt-1 flex items-center gap-2 font-medium text-gray-900">
                        <Badge variant={activePart.location.stale ? 'warning' : 'success'}>
                          {activePart.location.label}
                        </Badge>
                      </dd>
                    </div>

                    <div>
                      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
                        {activePart.location.stale
                          ? 'Last reported location'
                          : 'Vehicle coordinates'}
                      </dt>
                      <dd className="mt-1 font-mono text-xs text-gray-900 sm:text-sm">
                        {formatCoordinatePair(
                          activePart.location.latitude,
                          activePart.location.longitude,
                        )}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
                        Captured
                      </dt>
                      <dd className="mt-1 text-gray-900">
                        {formatCapturedTimestamp(activePart.location.capturedAt)}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="mt-3 text-sm text-gray-700">
                    {activePart.locationMessage}
                  </p>
                )}
              </div>

              <CustomerDeliveryMap
                deliveries={deliveries}
                selectedVendorOrderId={activePart.vendorOrderId}
                onSelectDelivery={handleSelectPart}
              />

              {trackingQuery.data?.hasActiveTracking ? (
                <p className="text-xs text-gray-500">
                  Live tracking refreshes automatically while an active delivery is in transit.
                </p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
