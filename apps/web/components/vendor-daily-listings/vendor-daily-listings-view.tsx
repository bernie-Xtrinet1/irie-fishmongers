'use client';

import { useState } from 'react';
import {
  ListingLifecycleStatus,
  UserRole,
  VendorStatus,
  type AddListingPhotoInput,
  type CreateDailyListingInput,
  type DailyListingResponse,
  type UpdateDailyListingInput,
} from '@iriefishmongers/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  addDailyListingPhoto,
  createDailyListing,
  fetchMyDailyListing,
  fetchMyDailyListings,
  publishDailyListing,
  setPrimaryDailyListingPhoto,
  updateDailyListing,
  withdrawDailyListing,
  withdrawDailyListingPhoto,
} from '@/lib/api/daily-listings';
import {
  evaluateRegulatoryEligibility,
  fetchLandingSites,
  fetchManagedSpecies,
  fetchMySeafoodLots,
  fetchMyVendorCompliance,
  fetchMyVendorProfile,
  fetchPublishedCatalogue,
} from '@/lib/api/vendors';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth/auth-context';

import {
  getApprovedActivePhotos,
  getVendorSellingBlockers,
  WORKFLOW_STEPS,
  type WorkflowStep,
} from './vendor-daily-listings-helpers';
import { VendorListingDraftForm } from './vendor-listing-draft-form';
import { VendorListingPhotoStep } from './vendor-listing-photo-step';
import { VendorListingReviewPublish } from './vendor-listing-review-publish';
import { VendorListingsList } from './vendor-listings-list';

export function VendorDailyListingsView(): React.ReactElement {
  const { status, user } = useAuth();
  const queryClient = useQueryClient();

  const isVendor =
    status === 'authenticated' &&
    user?.roles.includes(UserRole.VENDOR) === true;

  const [workflowMode, setWorkflowMode] = useState<'none' | 'create' | 'manage'>('none');
  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>('draft');
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  const [selectedListingFallback, setSelectedListingFallback] =
    useState<DailyListingResponse | null>(null);
  const [isMutating, setIsMutating] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const vendorProfileQuery = useQuery({
    queryKey: ['vendor-me-profile'],
    queryFn: fetchMyVendorProfile,
    enabled: isVendor,
  });

  const hasVendorProfile = Boolean(vendorProfileQuery.data);

  const complianceQuery = useQuery({
    queryKey: ['vendor-me-compliance'],
    queryFn: fetchMyVendorCompliance,
    enabled: isVendor && hasVendorProfile,
  });

  const lotsQuery = useQuery({
    queryKey: ['vendor-my-seafood-lots'],
    queryFn: () => fetchMySeafoodLots(1, 100),
    enabled: isVendor && hasVendorProfile,
  });

  const catalogueQuery = useQuery({
    queryKey: ['published-catalogue-items'],
    queryFn: () => fetchPublishedCatalogue(100),
    enabled: isVendor && hasVendorProfile,
  });

  const landingSitesQuery = useQuery({
    queryKey: ['landing-sites'],
    queryFn: fetchLandingSites,
    enabled: isVendor && hasVendorProfile,
  });

  const speciesQuery = useQuery({
    queryKey: ['managed-species'],
    queryFn: fetchManagedSpecies,
    enabled: isVendor && hasVendorProfile,
  });

  const myListingsQuery = useQuery({
    queryKey: ['vendor-daily-listings'],
    queryFn: () => fetchMyDailyListings({ page: 1, pageSize: 100 }),
    enabled: isVendor && hasVendorProfile,
  });

  const activeDetailQuery = useQuery({
    queryKey: ['vendor-daily-listing', selectedListingId],
    queryFn: () => fetchMyDailyListing(selectedListingId!),
    enabled: isVendor && workflowMode === 'manage' && Boolean(selectedListingId),
    retry: false,
  });

  const activeListing = activeDetailQuery.data ?? selectedListingFallback;

  const regulatoryEvalQuery = useQuery({
    queryKey: [
      'regulatory-eligibility',
      activeListing?.id,
      activeListing?.catalogueItemId,
      activeListing?.lotId,
    ],
    queryFn: () =>
      evaluateRegulatoryEligibility({
        catalogueItemId: activeListing!.catalogueItemId,
        vendorDailyListingId: activeListing!.id,
        seafoodLotId: activeListing!.lotId,
      }),
    enabled:
      isVendor &&
      workflowMode === 'manage' &&
      workflowStep === 'review' &&
      Boolean(activeListing),
  });

  async function refreshMarketplaceAndVendorQueries(listingId?: string): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['vendor-daily-listings'] }),
      queryClient.invalidateQueries({ queryKey: ['available-today'] }),
      queryClient.invalidateQueries({ queryKey: ['catalogue-item-listings'] }),
      ...(listingId
        ? [queryClient.invalidateQueries({ queryKey: ['vendor-daily-listing', listingId] })]
        : []),
    ]);
  }

  function handleSelectionError(err: unknown): void {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      setWorkflowMode('none');
      setSelectedListingId(null);
      setSelectedListingFallback(null);
      setBannerError(
        'That listing is unavailable or no longer belongs to your vendor account.',
      );
      void refreshMarketplaceAndVendorQueries();
      return;
    }
    throw err;
  }

  function handleStartNewListing(): void {
    setBannerError(null);
    setSelectedListingId(null);
    setSelectedListingFallback(null);
    setWorkflowMode('create');
    setWorkflowStep('draft');
  }

  function handleSelectListing(listing: DailyListingResponse, step: WorkflowStep): void {
    setBannerError(null);
    setSelectedListingId(listing.id);
    setSelectedListingFallback(listing);
    setWorkflowMode('manage');
    setWorkflowStep(
      listing.status === ListingLifecycleStatus.PUBLISHED && step === 'review'
        ? 'publish'
        : step,
    );
  }

  async function handleCreateDraft(input: CreateDailyListingInput): Promise<void> {
    if (isMutating) return;
    setIsMutating(true);
    setBannerError(null);
    try {
      const created = await createDailyListing(input);
      setSelectedListingId(created.id);
      setSelectedListingFallback(created);
      setWorkflowMode('manage');
      setWorkflowStep('photo');
      await refreshMarketplaceAndVendorQueries(created.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        void queryClient.invalidateQueries({ queryKey: ['vendor-my-seafood-lots'] });
      }
      throw err;
    } finally {
      setIsMutating(false);
    }
  }

  async function handleUpdateListing(
    listingId: string,
    input: UpdateDailyListingInput,
  ): Promise<void> {
    if (isMutating) return;
    setIsMutating(true);
    setBannerError(null);
    try {
      const updated = await updateDailyListing(listingId, input);
      setSelectedListingFallback(updated);
      await refreshMarketplaceAndVendorQueries(listingId);
      setWorkflowStep(
        updated.status === ListingLifecycleStatus.PUBLISHED ? 'publish' : 'photo',
      );
    } catch (err) {
      handleSelectionError(err);
    } finally {
      setIsMutating(false);
    }
  }

  async function handleAddPhoto(
    listingId: string,
    input: AddListingPhotoInput,
  ): Promise<void> {
    if (isMutating) return;
    setIsMutating(true);
    try {
      await addDailyListingPhoto(listingId, input);
      const refreshed = await fetchMyDailyListing(listingId);
      setSelectedListingFallback(refreshed);
      await refreshMarketplaceAndVendorQueries(listingId);
    } catch (err) {
      handleSelectionError(err);
    } finally {
      setIsMutating(false);
    }
  }

  async function handleSetPrimaryPhoto(listingId: string, photoId: string): Promise<void> {
    if (isMutating) return;
    setIsMutating(true);
    try {
      await setPrimaryDailyListingPhoto(listingId, photoId);
      const refreshed = await fetchMyDailyListing(listingId);
      setSelectedListingFallback(refreshed);
      await refreshMarketplaceAndVendorQueries(listingId);
    } catch (err) {
      handleSelectionError(err);
    } finally {
      setIsMutating(false);
    }
  }

  async function handleWithdrawPhoto(
    listingId: string,
    photoId: string,
    reason: string,
  ): Promise<void> {
    if (isMutating) return;
    setIsMutating(true);
    try {
      await withdrawDailyListingPhoto(listingId, photoId, reason);
      const refreshed = await fetchMyDailyListing(listingId);
      setSelectedListingFallback(refreshed);
      await refreshMarketplaceAndVendorQueries(listingId);
    } catch (err) {
      handleSelectionError(err);
    } finally {
      setIsMutating(false);
    }
  }

  async function handlePublishListing(listingId: string): Promise<void> {
    if (isMutating) return;
    setIsMutating(true);
    try {
      const published = await publishDailyListing(listingId);
      setSelectedListingFallback(published);
      setWorkflowStep('publish');
      await refreshMarketplaceAndVendorQueries(listingId);
    } catch (err) {
      handleSelectionError(err);
    } finally {
      setIsMutating(false);
    }
  }

  async function handleWithdrawListing(listingId: string, reason: string): Promise<void> {
    if (isMutating) return;
    setIsMutating(true);
    try {
      const withdrawn = await withdrawDailyListing(listingId, reason);
      if (selectedListingId === listingId) {
        setSelectedListingFallback(withdrawn);
      }
      await refreshMarketplaceAndVendorQueries(listingId);
    } catch (err) {
      handleSelectionError(err);
    } finally {
      setIsMutating(false);
    }
  }

  if (status === 'loading') {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <p className="text-gray-600">Loading your vendor workspace…</p>
      </main>
    );
  }

  if (status === 'unauthenticated') {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">Catch of the Day</h1>
        <div className="mt-6 rounded-card border border-gray-200 bg-white p-6 space-y-3">
          <p className="text-gray-700">
            Sign in with your vendor account to manage your Catch of the Day listings.
          </p>
          <Link
            href="/login?returnUrl=%2Fvendor%2Fdaily-listings"
            className="inline-flex h-10 items-center justify-center rounded-button bg-irie-green px-5 text-sm font-medium text-white hover:bg-irie-green/90"
          >
            Sign in
          </Link>
        </div>
      </main>
    );
  }

  if (!isVendor) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">Catch of the Day</h1>
        <div className="mt-6 rounded-card border border-irie-red/30 bg-white p-6 space-y-3">
          <p className="text-gray-800 font-medium">
            This page is available only to signed-in vendor accounts.
          </p>
          <Link href="/" className="inline-block text-sm font-medium text-irie-green hover:underline">
            Return to marketplace
          </Link>
        </div>
      </main>
    );
  }

  const vendor = vendorProfileQuery.data ?? null;
  const compliance = complianceQuery.data ?? null;
  const sellingBlockers = vendorProfileQuery.isPending
    ? []
    : getVendorSellingBlockers(vendor, compliance);
  const canVendorSell =
    Boolean(vendor) &&
    vendor?.status === VendorStatus.APPROVED &&
    (compliance ? compliance.canSell : true);

  const isInitialLoading =
    vendorProfileQuery.isPending ||
    (hasVendorProfile &&
      (lotsQuery.isPending || catalogueQuery.isPending || myListingsQuery.isPending));

  const nonNotFoundProfileError =
    vendorProfileQuery.error instanceof ApiError && vendorProfileQuery.error.status === 404
      ? null
      : vendorProfileQuery.error;

  const loadError =
    nonNotFoundProfileError ??
    (hasVendorProfile
      ? lotsQuery.error ?? catalogueQuery.error ?? myListingsQuery.error
      : null) ??
    null;

  const listings = myListingsQuery.data?.items ?? [];
  const lots = lotsQuery.data?.items ?? [];
  const catalogueItems = catalogueQuery.data?.data ?? [];
  const landingSites = landingSitesQuery.data ?? [];
  const speciesList = speciesQuery.data ?? [];

  const activePhotoCount = activeListing ? getApprovedActivePhotos(activeListing).length : 0;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 space-y-8">
      <div className="flex flex-col gap-4 border-b border-gray-200 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-ocean-blue">
            {vendor?.businessName ?? 'Vendor Portal'}
          </p>
          <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">Catch of the Day</h1>
          <p className="mt-1 text-sm text-gray-600">
            Create daily catch drafts from SAFE seafood lots, attach catch photos, and publish to Available Today.
          </p>
        </div>

        <Button
          type="button"
          variant="primary"
          disabled={isInitialLoading || isMutating || !hasVendorProfile}
          onClick={handleStartNewListing}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          New catch listing
        </Button>
      </div>

      {bannerError ? (
        <div
          role="alert"
          className="rounded-lg border border-irie-red/40 bg-irie-red/10 p-4 text-sm text-irie-red"
        >
          {bannerError}
        </div>
      ) : null}

      {sellingBlockers.length > 0 ? (
        <div
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 space-y-1.5"
        >
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Vendor onboarding / compliance prerequisites incomplete</span>
          </div>
          <ul className="list-disc pl-5 text-xs space-y-1">
            {sellingBlockers.map((msg) => (
              <li key={msg}>{msg}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {isInitialLoading ? (
        <Card>
          <CardContent className="p-6 text-sm text-gray-600">
            Loading your vendor lots, catalogue items, and daily catch listings…
          </CardContent>
        </Card>
      ) : loadError ? (
        <Card>
          <CardContent className="p-6 text-sm text-irie-red">
            Failed to load vendor daily listing data:{' '}
            {loadError instanceof Error ? loadError.message : 'Unexpected error'}
          </CardContent>
        </Card>
      ) : !hasVendorProfile ? (
        <Card>
          <CardContent className="p-6 text-sm text-gray-700">
            Complete vendor onboarding before creating Catch of the Day listings.
          </CardContent>
        </Card>
      ) : (
        <>
          {workflowMode !== 'none' ? (
            <section aria-label="Daily listing workflow" className="space-y-4">
              <nav aria-label="Workflow steps" className="grid grid-cols-4 gap-2">
                {WORKFLOW_STEPS.map((stepMeta) => {
                  const hasSavedListing = Boolean(activeListing);
                  const isAccessible =
                    stepMeta.id === 'draft' ||
                    (hasSavedListing &&
                      (stepMeta.id !== 'publish' ||
                        activeListing?.status === ListingLifecycleStatus.PUBLISHED));
                  const isCurrent = workflowStep === stepMeta.id;

                  return (
                    <button
                      key={stepMeta.id}
                      type="button"
                      disabled={!isAccessible || isMutating}
                      onClick={() => setWorkflowStep(stepMeta.id)}
                      aria-current={isCurrent ? 'step' : undefined}
                      className={`rounded-button border px-2 py-2 text-center text-xs font-medium transition-colors sm:text-sm ${
                        isCurrent
                          ? 'border-irie-green bg-irie-green text-white'
                          : isAccessible
                            ? 'border-gray-200 bg-white text-gray-800 hover:bg-gray-50'
                            : 'border-gray-100 bg-gray-100 text-gray-400 cursor-not-allowed'
                      }`}
                    >
                      {stepMeta.number}. {stepMeta.label}
                    </button>
                  );
                })}
              </nav>

              {activeDetailQuery.isError ? (
                <div
                  role="alert"
                  className="rounded-lg border border-irie-red/40 bg-irie-red/10 p-4 text-sm text-irie-red"
                >
                  {activeDetailQuery.error instanceof ApiError &&
                  (activeDetailQuery.error.status === 403 ||
                    activeDetailQuery.error.status === 404)
                    ? 'That listing could not be loaded because it does not exist or does not belong to your vendor account.'
                    : 'Unable to refresh the selected listing.'}
                </div>
              ) : null}

              {workflowStep === 'draft' && (workflowMode === 'create' || !activeDetailQuery.isError) ? (
                <VendorListingDraftForm
                  editingListing={workflowMode === 'manage' ? activeListing : null}
                  lots={lots}
                  catalogueItems={catalogueItems}
                  landingSites={landingSites}
                  speciesList={speciesList}
                  canVendorSell={canVendorSell}
                  isSubmitting={isMutating}
                  onCreateDraft={handleCreateDraft}
                  onUpdateListing={handleUpdateListing}
                  onCancel={() => {
                    setWorkflowMode('none');
                    setSelectedListingId(null);
                    setSelectedListingFallback(null);
                  }}
                />
              ) : null}

              {workflowStep === 'photo' && activeListing && !activeDetailQuery.isError ? (
                <VendorListingPhotoStep
                  listing={activeListing}
                  isSubmitting={isMutating}
                  onAddPhoto={handleAddPhoto}
                  onSetPrimaryPhoto={handleSetPrimaryPhoto}
                  onWithdrawPhoto={handleWithdrawPhoto}
                  onBackToDraft={() => setWorkflowStep('draft')}
                  onContinueToReview={() =>
                    setWorkflowStep(
                      activeListing.status === ListingLifecycleStatus.PUBLISHED &&
                        activePhotoCount > 0
                        ? 'publish'
                        : 'review',
                    )
                  }
                />
              ) : null}

              {(workflowStep === 'review' || workflowStep === 'publish') &&
              activeListing &&
              !activeDetailQuery.isError ? (
                <VendorListingReviewPublish
                  listing={activeListing}
                  regulatoryEval={regulatoryEvalQuery.data ?? null}
                  regulatoryLoading={regulatoryEvalQuery.isFetching}
                  regulatoryError={
                    regulatoryEvalQuery.error instanceof Error
                      ? regulatoryEvalQuery.error.message
                      : null
                  }
                  canVendorSell={canVendorSell}
                  isSubmitting={isMutating}
                  onPublish={handlePublishListing}
                  onWithdraw={handleWithdrawListing}
                  onGoToDraft={() => setWorkflowStep('draft')}
                  onGoToPhotos={() => setWorkflowStep('photo')}
                />
              ) : null}
            </section>
          ) : null}

          <VendorListingsList
            listings={listings}
            activeListingId={selectedListingId}
            isMutating={isMutating}
            onSelectForWorkflow={handleSelectListing}
            onWithdrawListing={handleWithdrawListing}
          />
        </>
      )}
    </main>
  );
}
