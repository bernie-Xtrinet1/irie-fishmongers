'use client';

import { useState } from 'react';
import { ListingLifecycleStatus, type DailyListingResponse } from '@iriefishmongers/types';
import { Camera, ExternalLink, Fish, Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatEnumLabel } from '@/lib/format';

import {
  formatDateTimeReadable,
  formatMoneyJmd,
  getApprovedActivePhotos,
  getDisplayPhoto,
  getStatusBadgeMeta,
} from './vendor-daily-listings-helpers';

export interface VendorListingsListProps {
  listings: DailyListingResponse[];
  activeListingId: string | null;
  isMutating: boolean;
  onSelectForWorkflow: (listing: DailyListingResponse, step: 'draft' | 'photo' | 'review' | 'publish') => void;
  onWithdrawListing: (listingId: string, reason: string) => Promise<void>;
}

const FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: ListingLifecycleStatus.DRAFT, label: 'Drafts' },
  { value: ListingLifecycleStatus.PUBLISHED, label: 'Published' },
  { value: ListingLifecycleStatus.WITHDRAWN, label: 'Withdrawn' },
  { value: ListingLifecycleStatus.SUSPENDED, label: 'Suspended' },
];

export function VendorListingsList({
  listings,
  activeListingId,
  isMutating,
  onSelectForWorkflow,
  onWithdrawListing,
}: VendorListingsListProps): React.ReactElement {
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [withdrawTargetId, setWithdrawTargetId] = useState<string | null>(null);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  const filtered =
    statusFilter === 'ALL'
      ? listings
      : listings.filter(
          (item) => String(item.status) === statusFilter || item.derivedStatus === statusFilter,
        );

  async function handleConfirmWithdraw(listingId: string): Promise<void> {
    const trimmed = withdrawReason.trim();
    if (trimmed.length < 5) {
      setWithdrawError('Please provide a withdrawal reason (at least 5 characters).');
      return;
    }
    setWithdrawError(null);
    try {
      await onWithdrawListing(listingId, trimmed);
      setWithdrawTargetId(null);
      setWithdrawReason('');
    } catch (err) {
      setWithdrawError(err instanceof Error ? err.message : 'Unable to withdraw listing.');
    }
  }

  return (
    <section aria-labelledby="vendor-listings-heading" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 id="vendor-listings-heading" className="text-xl font-semibold text-gray-900">
          Your daily catch listings ({listings.length})
        </h2>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter listings by status">
          {FILTER_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setStatusFilter(option.value)}
              className={`rounded-button px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-irie-green ${
                statusFilter === option.value
                  ? 'bg-irie-green text-white'
                  : 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-gray-600">
            {listings.length === 0
              ? 'You have not created any daily catch listings yet. Select “New catch listing” above to publish today’s catch.'
              : 'No listings match the selected status filter.'}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((listing) => {
            const badgeMeta = getStatusBadgeMeta(listing.derivedStatus || listing.status);
            const displayPhoto = getDisplayPhoto(listing);
            const photoCount = getApprovedActivePhotos(listing).length;
            const title = listing.listingTitle?.trim() || listing.catalogueItem?.name || 'Daily Catch Listing';
            const canEdit =
              listing.status === ListingLifecycleStatus.DRAFT ||
              listing.status === ListingLifecycleStatus.PUBLISHED;
            const canWithdraw =
              listing.status === ListingLifecycleStatus.DRAFT ||
              listing.status === ListingLifecycleStatus.PUBLISHED;
            const isSelected = listing.id === activeListingId;

            return (
              <Card
                key={listing.id}
                className={isSelected ? 'ring-2 ring-irie-green' : undefined}
              >
                <CardContent className="p-4 sm:p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                    <div className="relative h-24 w-full shrink-0 overflow-hidden rounded-lg bg-gray-100 sm:h-24 sm:w-28">
                      {displayPhoto ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={displayPhoto.url}
                          alt={title}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center text-xs text-gray-400">
                          <Fish className="h-6 w-6" aria-hidden="true" />
                          <span>No photo</span>
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="truncate text-base font-semibold text-gray-900">
                            {title}
                          </h3>
                          {listing.catalogueItem ? (
                            <p className="text-xs text-gray-500">
                              Catalogue: {listing.catalogueItem.name} · Lot{' '}
                              {listing.lot?.lotNumber ?? listing.lotId}
                            </p>
                          ) : null}
                        </div>

                        <Badge variant={badgeMeta.variant}>{badgeMeta.label}</Badge>
                      </div>

                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600 sm:flex sm:flex-wrap sm:gap-x-5">
                        <span>
                          <strong className="text-gray-900">
                            {formatMoneyJmd(listing.price, listing.currency)}
                          </strong>{' '}
                          / {formatEnumLabel(listing.unit).toLowerCase()}
                        </span>
                        <span>
                          Stock: {listing.quantityAvailable} / {listing.quantityUploaded}
                        </span>
                        <span>Photos: {photoCount}</span>
                        <span>Expires: {formatDateTimeReadable(listing.expiresAt)}</span>
                      </div>

                      {listing.withdrawnReason ? (
                        <p className="text-xs text-gray-600">
                          Withdrawal reason: {listing.withdrawnReason}
                        </p>
                      ) : null}

                      {listing.suspensionReason ? (
                        <p className="text-xs text-irie-red">
                          Suspension reason: {listing.suspensionReason}
                        </p>
                      ) : null}

                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {listing.status === ListingLifecycleStatus.DRAFT ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="primary"
                            disabled={isMutating}
                            onClick={() =>
                              onSelectForWorkflow(
                                listing,
                                photoCount > 0 ? 'review' : 'photo',
                              )
                            }
                          >
                            {photoCount > 0 ? 'Review & publish' : 'Continue draft'}
                          </Button>
                        ) : null}

                        {canEdit ? (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={isMutating}
                              onClick={() => onSelectForWorkflow(listing, 'draft')}
                            >
                              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                              Edit details
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={isMutating}
                              onClick={() => onSelectForWorkflow(listing, 'photo')}
                            >
                              <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                              Photos ({photoCount})
                            </Button>
                          </>
                        ) : null}

                        {listing.status === ListingLifecycleStatus.PUBLISHED ? (
                          <Link
                            href="/#available-today"
                            className="inline-flex h-9 items-center gap-1 rounded-button border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-irie-green"
                          >
                            View in Available Today
                            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                          </Link>
                        ) : null}

                        {canWithdraw ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="danger"
                            disabled={isMutating}
                            onClick={() => {
                              setWithdrawTargetId(
                                withdrawTargetId === listing.id ? null : listing.id,
                              );
                              setWithdrawReason('');
                              setWithdrawError(null);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            Withdraw
                          </Button>
                        ) : null}
                      </div>

                      {withdrawTargetId === listing.id ? (
                        <div className="mt-3 rounded-lg border border-irie-red/30 bg-irie-red/5 p-3 space-y-2">
                          <label
                            htmlFor={`withdraw-reason-${listing.id}`}
                            className="block text-xs font-medium text-gray-800"
                          >
                            Reason for withdrawing this listing (minimum 5 characters)
                          </label>
                          <input
                            id={`withdraw-reason-${listing.id}`}
                            type="text"
                            value={withdrawReason}
                            onChange={(e) => setWithdrawReason(e.target.value)}
                            placeholder="e.g., Catch sold out locally at harbour"
                            className="h-10 w-full rounded-button border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-irie-red"
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
                              loading={isMutating}
                              onClick={() => void handleConfirmWithdraw(listing.id)}
                            >
                              Confirm withdrawal
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={isMutating}
                              onClick={() => {
                                setWithdrawTargetId(null);
                                setWithdrawError(null);
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
