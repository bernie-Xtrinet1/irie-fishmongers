'use client';

import { useState } from 'react';
import {
  DriverAvailabilityStatus,
  DriverStatus,
  UserRole,
  type DriverAvailabilityTarget,
  type DriverProfile,
  type UpdateDeliveryScheduleInput,
  type UpdateDeliveryStatusInput,
} from '@iriefishmongers/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';

import {
  claimAvailableDelivery,
  fetchAvailableDeliveries,
  fetchMyDeliveries,
  fetchMyDriverProfile,
  updateDeliverySchedule,
  updateDeliveryStatus,
  updateMyDriverAvailability,
} from '@/lib/api/drivers';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth/auth-context';

import { AvailablePickupsSection } from './available-pickups-section';
import { DriverStatusCard } from './driver-status-card';
import { MyDeliveriesSection } from './my-deliveries-section';

function formatQueryError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return fallback;
}

export function DriverDeliveriesView(): React.ReactElement {
  const { status, user, refreshSession } = useAuth();
  const queryClient = useQueryClient();

  const isDriver =
    status === 'authenticated' && user?.roles.includes(UserRole.DRIVER) === true;

  const [isMutating, setIsMutating] = useState(false);
  const [claimingVendorOrderId, setClaimingVendorOrderId] = useState<string | null>(null);
  const [claimBannerError, setClaimBannerError] = useState<string | null>(null);
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [accessRevokedMidSession, setAccessRevokedMidSession] = useState(false);

  const driverProfileQuery = useQuery({
    queryKey: ['driver-me-profile'],
    queryFn: fetchMyDriverProfile,
    enabled: isDriver,
    retry: false,
  });

  const profileNotFound =
    driverProfileQuery.error instanceof ApiError && driverProfileQuery.error.status === 404;

  const profileForbidden =
    driverProfileQuery.error instanceof ApiError && driverProfileQuery.error.status === 403;

  const driverProfile = driverProfileQuery.data ?? null;
  const hasProfile = Boolean(driverProfile);
  const isApproved = driverProfile?.status === DriverStatus.APPROVED;
  const isBusy = driverProfile?.availabilityStatus === DriverAvailabilityStatus.BUSY;
  const canBrowsePickups =
    isApproved && driverProfile?.availabilityStatus === DriverAvailabilityStatus.ONLINE;

  const availablePickupsQuery = useQuery({
    queryKey: ['delivery-available'],
    queryFn: () => fetchAvailableDeliveries(1, 20),
    enabled: isDriver && canBrowsePickups && !profileForbidden,
    retry: false,
  });

  const myDeliveriesQuery = useQuery({
    queryKey: ['delivery-mine'],
    queryFn: () => fetchMyDeliveries(1, 50),
    enabled: isDriver && hasProfile && !profileForbidden,
    retry: false,
  });

  async function refreshAllDriverQueries(): Promise<void> {
    await queryClient.cancelQueries({ queryKey: ['delivery-available'] });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['driver-me-profile'] }),
      queryClient.invalidateQueries({ queryKey: ['delivery-mine'] }),
    ]);
    const latestProfile = queryClient.getQueryData<DriverProfile>(['driver-me-profile']);
    if (
      latestProfile?.status === DriverStatus.APPROVED &&
      latestProfile.availabilityStatus === DriverAvailabilityStatus.ONLINE
    ) {
      await queryClient.invalidateQueries({ queryKey: ['delivery-available'] });
    }
  }

  async function handleMidSessionAccessError(err: unknown): Promise<void> {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      const refreshed = refreshSession ? await refreshSession() : null;
      if (!refreshed || !refreshed.roles.includes(UserRole.DRIVER)) {
        setAccessRevokedMidSession(true);
      }
      await refreshAllDriverQueries();
    }
  }

  async function handleToggleAvailability(nextStatus: DriverAvailabilityTarget): Promise<void> {
    if (isMutating) return;
    setIsMutating(true);
    setActionErrorMessage(null);
    setClaimBannerError(null);
    try {
      await updateMyDriverAvailability(nextStatus);
      await refreshAllDriverQueries();
    } catch (err) {
      await handleMidSessionAccessError(err);
      setActionErrorMessage(formatQueryError(err, 'Unable to update driver availability.'));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleClaimPickup(vendorOrderId: string): Promise<void> {
    if (isMutating || claimingVendorOrderId) return;
    setIsMutating(true);
    setClaimingVendorOrderId(vendorOrderId);
    setClaimBannerError(null);
    setActionErrorMessage(null);
    try {
      await claimAvailableDelivery(vendorOrderId);
      await refreshAllDriverQueries();
    } catch (err) {
      await handleMidSessionAccessError(err);
      if (err instanceof ApiError && err.status === 409) {
        setClaimBannerError(
          err.message.toLowerCase().includes('already been claimed')
            ? `${err.message}. We refreshed the pickup list.`
            : err.message,
        );
      } else {
        setClaimBannerError(formatQueryError(err, 'Unable to claim this pickup job.'));
      }
      await refreshAllDriverQueries();
    } finally {
      setIsMutating(false);
      setClaimingVendorOrderId(null);
    }
  }

  async function handleUpdateSchedule(
    deliveryId: string,
    input: UpdateDeliveryScheduleInput,
  ): Promise<void> {
    if (isMutating) return;
    setIsMutating(true);
    setActionErrorMessage(null);
    try {
      await updateDeliverySchedule(deliveryId, input);
      await refreshAllDriverQueries();
    } catch (err) {
      await handleMidSessionAccessError(err);
      throw err;
    } finally {
      setIsMutating(false);
    }
  }

  async function handleUpdateStatus(
    deliveryId: string,
    input: UpdateDeliveryStatusInput,
  ): Promise<void> {
    if (isMutating) return;
    setIsMutating(true);
    setActionErrorMessage(null);
    try {
      await updateDeliveryStatus(deliveryId, input);
      await refreshAllDriverQueries();
    } catch (err) {
      await handleMidSessionAccessError(err);
      const message = formatQueryError(err, 'Unable to update delivery status.');
      setActionErrorMessage(message);
      throw err;
    } finally {
      setIsMutating(false);
    }
  }

  if (status === 'loading') {
    return (
      <main className="mx-auto max-w-4xl px-4 py-10">
        <p className="text-gray-600">Loading your driver workspace…</p>
      </main>
    );
  }

  if (status === 'unauthenticated') {
    return (
      <main className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">Driver Deliveries</h1>
        <div className="mt-6 rounded-card border border-gray-200 bg-white p-6 space-y-3">
          <p className="text-gray-700">
            Sign in with your driver account to manage delivery availability, pickups, and drop-offs.
          </p>
          <Link
            href="/login?returnUrl=%2Fdriver%2Fdeliveries"
            className="inline-flex h-11 items-center justify-center rounded-button bg-ocean-blue px-5 text-sm font-medium text-white hover:bg-ocean-blue/90"
          >
            Sign in
          </Link>
        </div>
      </main>
    );
  }

  if (!isDriver || accessRevokedMidSession || profileForbidden) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">Driver Deliveries</h1>
        <div className="mt-6 rounded-card border border-irie-red/30 bg-white p-6 space-y-3">
          <p className="font-medium text-gray-900">
            {accessRevokedMidSession || profileForbidden
              ? 'Driver access is unavailable for this session.'
              : 'This page is available only to signed-in driver accounts.'}
          </p>
          <div className="flex flex-wrap gap-4 text-sm">
            <Link href="/account" className="font-medium text-ocean-blue hover:underline">
              Back to account
            </Link>
            <Link href="/" className="font-medium text-irie-green hover:underline">
              Return to marketplace
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const profileLoadError =
    driverProfileQuery.error && !profileNotFound
      ? formatQueryError(driverProfileQuery.error, 'Unable to load driver status.')
      : null;

  const availableLoadError = availablePickupsQuery.error
    ? formatQueryError(availablePickupsQuery.error, 'Unable to load available pickups.')
    : null;

  const myDeliveriesLoadError = myDeliveriesQuery.error
    ? formatQueryError(myDeliveriesQuery.error, 'Unable to load your deliveries.')
    : null;

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 sm:py-8 space-y-6">
      <div className="border-b border-gray-200 pb-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-ocean-blue">
          Driver Operations
        </p>
        <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">My Deliveries</h1>
        <p className="mt-1 text-sm text-gray-600">
          Manage your driver status, claim ready pickups, set Jamaica-time delivery windows, and complete drop-offs.
        </p>
      </div>

      <DriverStatusCard
        profile={driverProfile}
        profileMissing={profileNotFound}
        isLoading={driverProfileQuery.isPending}
        errorMessage={profileLoadError}
        isMutating={isMutating}
        onRetry={() => {
          void driverProfileQuery.refetch();
        }}
        onToggleAvailability={handleToggleAvailability}
      />

      <AvailablePickupsSection
        canBrowsePickups={canBrowsePickups}
        isBusy={isBusy}
        isApproved={isApproved}
        items={availablePickupsQuery.data?.items ?? []}
        isLoading={availablePickupsQuery.isPending}
        isFetching={availablePickupsQuery.isFetching}
        errorMessage={availableLoadError}
        claimBannerError={claimBannerError}
        claimingVendorOrderId={claimingVendorOrderId}
        onRefresh={() => {
          void availablePickupsQuery.refetch();
        }}
        onClaim={handleClaimPickup}
      />

      {hasProfile ? (
        <MyDeliveriesSection
          deliveries={myDeliveriesQuery.data?.items ?? []}
          isLoading={myDeliveriesQuery.isPending}
          errorMessage={myDeliveriesLoadError}
          actionErrorMessage={actionErrorMessage}
          isApproved={isApproved}
          isMutating={isMutating}
          onRetry={() => {
            void myDeliveriesQuery.refetch();
          }}
          onUpdateSchedule={handleUpdateSchedule}
          onUpdateStatus={handleUpdateStatus}
        />
      ) : null}
    </main>
  );
}
