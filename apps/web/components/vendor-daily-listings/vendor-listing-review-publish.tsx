'use client';

import { useState } from 'react';
import {
  ListingLifecycleStatus,
  type DailyListingResponse,
  type RegulatoryEvaluationResult,
} from '@iriefishmongers/types';
import { AlertCircle, CheckCircle2, ExternalLink, Fish, ShieldCheck, Trash2 } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatEnumLabel } from '@/lib/format';

import {
  formatDateTimeReadable,
  formatMoneyJmd,
  getApprovedActivePhotos,
  getDisplayPhoto,
  getPublishBlockers,
  getStatusBadgeMeta,
} from './vendor-daily-listings-helpers';

export interface VendorListingReviewPublishProps {
  listing: DailyListingResponse;
  regulatoryEval: RegulatoryEvaluationResult | null;
  regulatoryLoading: boolean;
  regulatoryError: string | null;
  canVendorSell: boolean;
  isSubmitting: boolean;
  onPublish: (listingId: string) => Promise<void>;
  onWithdraw: (listingId: string, reason: string) => Promise<void>;
  onGoToDraft: () => void;
  onGoToPhotos: () => void;
}

export function VendorListingReviewPublish({
  listing,
  regulatoryEval,
  regulatoryLoading,
  regulatoryError,
  canVendorSell,
  isSubmitting,
  onPublish,
  onWithdraw,
  onGoToDraft,
  onGoToPhotos,
}: VendorListingReviewPublishProps): React.ReactElement {
  const [publishError, setPublishError] = useState<string | null>(null);
  const [showWithdrawForm, setShowWithdrawForm] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  const primaryPhoto = getDisplayPhoto(listing);
  const approvedPhotos = getApprovedActivePhotos(listing);
  const badgeMeta = getStatusBadgeMeta(listing.derivedStatus || listing.status);
  const blockers = getPublishBlockers(listing, regulatoryEval, canVendorSell);
  const isPublished = listing.status === ListingLifecycleStatus.PUBLISHED;
  const isDraft = listing.status === ListingLifecycleStatus.DRAFT;
  const isWithdrawn = listing.status === ListingLifecycleStatus.WITHDRAWN;
  const isSuspended = listing.status === ListingLifecycleStatus.SUSPENDED;
  const canPublish = isDraft && blockers.length === 0 && !regulatoryLoading;

  async function handlePublish(): Promise<void> {
    setPublishError(null);
    try {
      await onPublish(listing.id);
    } catch (err) {
      // Preserve the DRAFT listing so the vendor can correct photos/expiry/compliance.
      setPublishError(
        err instanceof Error ? err.message : 'Publication failed. Your draft remains saved.',
      );
    }
  }

  async function handleConfirmWithdraw(): Promise<void> {
    const trimmed = withdrawReason.trim();
    if (trimmed.length < 5) {
      setWithdrawError('Please enter a withdrawal reason (minimum 5 characters).');
      return;
    }
    setWithdrawError(null);
    try {
      await onWithdraw(listing.id, trimmed);
      setShowWithdrawForm(false);
      setWithdrawReason('');
    } catch (err) {
      setWithdrawError(err instanceof Error ? err.message : 'Unable to withdraw listing.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>
            {isPublished
              ? 'Step 4 · Published to Available Today'
              : 'Step 3 · Review & publish'}
          </CardTitle>
          <Badge variant={badgeMeta.variant}>{badgeMeta.label}</Badge>
        </div>
        <p className="text-sm text-gray-600">
          {isPublished
            ? 'Your Catch of the Day listing is live for shoppers in Available Today.'
            : 'Review your listing summary, primary catch photograph, and compliance checks before publishing.'}
        </p>
      </CardHeader>

      <CardContent className="space-y-6">
        {isPublished ? (
          <div
            role="status"
            className="rounded-lg border border-irie-green/30 bg-irie-green/10 p-4 text-sm text-gray-900 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-irie-green" aria-hidden="true" />
              <div>
                <p className="font-semibold">Published and visible in Available Today</p>
                <p className="text-xs text-gray-700">
                  {listing.publishedAt
                    ? `Published ${formatDateTimeReadable(listing.publishedAt)}`
                    : 'Live now'}{' '}
                  · {listing.quantityAvailable} of {listing.quantityUploaded}{' '}
                  {formatEnumLabel(listing.unit).toLowerCase()} available
                </p>
              </div>
            </div>
            <Link
              href="/#available-today"
              className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-button bg-irie-green px-4 text-sm font-medium text-white hover:bg-irie-green/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-irie-green"
            >
              View on Available Today
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        ) : null}

        <div className="grid gap-5 sm:grid-cols-12">
          <div className="sm:col-span-5">
            <div className="relative h-56 w-full overflow-hidden rounded-card border border-gray-200 bg-gray-100">
              {primaryPhoto ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={primaryPhoto.url}
                  alt={primaryPhoto.caption || listing.listingTitle || 'Primary catch photo'}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-xs text-gray-500">
                  <Fish className="h-8 w-8 text-gray-400" aria-hidden="true" />
                  <span>No approved primary photo yet</span>
                </div>
              )}
            </div>
            {primaryPhoto ? (
              <p className="mt-1.5 text-xs text-gray-600">
                Primary image ({approvedPhotos.length} approved photo
                {approvedPhotos.length === 1 ? '' : 's'} attached)
              </p>
            ) : null}
          </div>

          <dl className="sm:col-span-7 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-gray-500">Listing title</dt>
              <dd className="mt-0.5 font-semibold text-gray-900">
                {listing.listingTitle?.trim() || listing.catalogueItem?.name || 'Daily Catch Listing'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500">Master catalogue item</dt>
              <dd className="mt-0.5 text-gray-900">
                {listing.catalogueItem?.name ?? listing.catalogueItemId}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500">Seafood lot</dt>
              <dd className="mt-0.5 text-gray-900">
                {listing.lot?.lotNumber ?? listing.lotId} ({listing.lot?.foodSafetyStatus ?? 'SAFE'})
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500">Price & quantity</dt>
              <dd className="mt-0.5 font-semibold text-irie-green">
                {formatMoneyJmd(listing.price, listing.currency)} /{' '}
                {formatEnumLabel(listing.unit).toLowerCase()} · {listing.quantityAvailable} /{' '}
                {listing.quantityUploaded}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500">Catch date</dt>
              <dd className="mt-0.5 text-gray-900">{formatDateTimeReadable(listing.catchDate)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500">Expires at</dt>
              <dd className="mt-0.5 text-gray-900">{formatDateTimeReadable(listing.expiresAt)}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium text-gray-500">Fulfillment</dt>
              <dd className="mt-0.5 text-gray-900">
                {[
                  listing.deliveryAvailable ? 'Delivery available' : null,
                  listing.pickupAvailable ? 'Pickup available' : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'None specified'}
              </dd>
            </div>
            {listing.description ? (
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium text-gray-500">Notes</dt>
                <dd className="mt-0.5 text-gray-700">{listing.description}</dd>
              </div>
            ) : null}
          </dl>
        </div>

        {isDraft ? (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <ShieldCheck className="h-4 w-4 text-irie-green" aria-hidden="true" />
              <span>Regulatory & publish readiness</span>
            </div>
            {regulatoryLoading ? (
              <p className="text-xs text-gray-600">Checking seasonal and regulatory eligibility…</p>
            ) : regulatoryError ? (
              <p className="text-xs text-amber-800">
                Pre-check unavailable ({regulatoryError}); server publish checks will still run on submit.
              </p>
            ) : blockers.length === 0 ? (
              <p className="text-xs text-irie-green">
                All pre-publish checks passed (approved vendor, SAFE lot, approved primary photo, and regulatory eligibility).
              </p>
            ) : (
              <ul className="list-disc pl-5 text-xs text-irie-red space-y-1">
                {blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {isWithdrawn || isSuspended ? (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
            This listing is <strong>{listing.status}</strong> and cannot be edited or published.
            {listing.withdrawnReason ? ` Reason: ${listing.withdrawnReason}` : ''}
            {listing.suspensionReason ? ` Reason: ${listing.suspensionReason}` : ''}
          </div>
        ) : null}

        {publishError ? (
          <div
            role="alert"
            className="rounded-lg border border-irie-red/40 bg-irie-red/10 p-3 text-sm text-irie-red flex items-start gap-2"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">Publication rejected — your draft was preserved</p>
              <p className="text-xs mt-0.5">{publishError}</p>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-4">
          <div className="flex flex-wrap gap-2">
            {!isWithdrawn && !isSuspended ? (
              <>
                <Button type="button" variant="ghost" disabled={isSubmitting} onClick={onGoToDraft}>
                  Edit details
                </Button>
                <Button type="button" variant="secondary" disabled={isSubmitting} onClick={onGoToPhotos}>
                  Manage photos
                </Button>
              </>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            {isDraft && canPublish ? (
              <Button
                type="button"
                variant="primary"
                loading={isSubmitting}
                onClick={() => void handlePublish()}
              >
                Publish to Available Today
              </Button>
            ) : null}

            {isDraft || isPublished ? (
              <Button
                type="button"
                variant="danger"
                disabled={isSubmitting}
                onClick={() => {
                  setShowWithdrawForm((prev) => !prev);
                  setWithdrawError(null);
                }}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Withdraw from sale
              </Button>
            ) : null}
          </div>
        </div>

        {showWithdrawForm ? (
          <div className="rounded-lg border border-irie-red/30 bg-irie-red/5 p-3.5 space-y-2">
            <label
              htmlFor="review-withdraw-reason"
              className="block text-xs font-medium text-gray-800"
            >
              Reason for withdrawal (minimum 5 characters)
            </label>
            <input
              id="review-withdraw-reason"
              type="text"
              value={withdrawReason}
              onChange={(e) => setWithdrawReason(e.target.value)}
              placeholder="e.g., Withdrawn after harbour sale"
              className="h-10 w-full rounded-button border border-gray-300 bg-white px-3 text-sm"
            />
            {withdrawError ? (
              <p role="alert" className="text-xs text-irie-red">
                {withdrawError}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="danger"
                loading={isSubmitting}
                onClick={() => void handleConfirmWithdraw()}
              >
                Confirm withdrawal
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={isSubmitting}
                onClick={() => setShowWithdrawForm(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
