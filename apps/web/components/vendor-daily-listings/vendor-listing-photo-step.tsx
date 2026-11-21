'use client';

import { useState } from 'react';
import {
  ListingPhotoModerationStatus,
  type AddListingPhotoInput,
  type DailyListingResponse,
} from '@iriefishmongers/types';
import { Camera, CheckCircle2, Info, RotateCcw, Star, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import {
  formatDateTimeReadable,
  fromDateTimeLocalInput,
  getActiveListingPhotos,
  validateCatchPhotoUrl,
} from './vendor-daily-listings-helpers';

export interface VendorListingPhotoStepProps {
  listing: DailyListingResponse;
  isSubmitting: boolean;
  onAddPhoto: (listingId: string, input: AddListingPhotoInput) => Promise<void>;
  onSetPrimaryPhoto: (listingId: string, photoId: string) => Promise<void>;
  onWithdrawPhoto: (listingId: string, photoId: string, reason: string) => Promise<void>;
  onBackToDraft: () => void;
  onContinueToReview: () => void;
}

export function VendorListingPhotoStep({
  listing,
  isSubmitting,
  onAddPhoto,
  onSetPrimaryPhoto,
  onWithdrawPhoto,
  onBackToDraft,
  onContinueToReview,
}: VendorListingPhotoStepProps): React.ReactElement {
  const activePhotos = getActiveListingPhotos(listing);

  const [photoUrl, setPhotoUrl] = useState('');
  const [caption, setCaption] = useState('');
  const [captureDateLocal, setCaptureDateLocal] = useState('');
  const [isPrimary, setIsPrimary] = useState(activePhotos.length === 0);
  const [previewFailed, setPreviewFailed] = useState(false);

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [withdrawTargetId, setWithdrawTargetId] = useState<string | null>(null);
  const [withdrawReason, setWithdrawReason] = useState('');

  const previewUrlError = photoUrl.trim() ? validateCatchPhotoUrl(photoUrl) : null;
  const canRenderPreview = Boolean(photoUrl.trim()) && !previewUrlError;

  async function submitPhoto(): Promise<void> {
    setSubmitError(null);
    const urlError = validateCatchPhotoUrl(photoUrl);
    if (urlError) {
      setSubmitError(urlError);
      return;
    }

    let captureDateIso: string | undefined;
    if (captureDateLocal.trim()) {
      const converted = fromDateTimeLocalInput(captureDateLocal);
      if (!converted) {
        setSubmitError('Enter a valid capture date and time.');
        return;
      }
      captureDateIso = converted;
    }

    try {
      await onAddPhoto(listing.id, {
        url: photoUrl.trim(),
        caption: caption.trim() || undefined,
        isPrimary,
        captureDate: captureDateIso,
      });
      setPhotoUrl('');
      setCaption('');
      setCaptureDateLocal('');
      setIsPrimary(false);
      setPreviewFailed(false);
    } catch (err) {
      // Draft and entered photo fields intentionally stay intact so the vendor can retry.
      setSubmitError(
        err instanceof Error
          ? err.message
          : 'Could not save the catch photograph. Your draft is preserved — please retry.',
      );
    }
  }

  async function handleFormSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await submitPhoto();
  }

  async function handleSetPrimary(photoId: string): Promise<void> {
    setActionError(null);
    try {
      await onSetPrimaryPhoto(listing.id, photoId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to set primary photo.');
    }
  }

  async function handleConfirmWithdrawPhoto(photoId: string): Promise<void> {
    const trimmed = withdrawReason.trim();
    if (trimmed.length < 5) {
      setActionError('Please enter a removal reason (at least 5 characters).');
      return;
    }
    setActionError(null);
    try {
      await onWithdrawPhoto(listing.id, photoId, trimmed);
      setWithdrawTargetId(null);
      setWithdrawReason('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to remove photo.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 2 · Actual catch photographs</CardTitle>
        <p className="text-sm text-gray-600">
          Attach at least one photograph of today’s actual catch before publishing to Available Today. Your draft ({listing.listingTitle?.trim() || listing.catalogueItem?.name || listing.id}) is already saved.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="rounded-lg border border-ocean-blue/25 bg-ocean-blue/5 p-3.5 text-xs text-gray-700 flex items-start gap-2.5">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-ocean-blue" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-medium text-gray-900">
              Photo reference contract (direct file upload not yet wired)
            </p>
            <p>
              The platform does not have cloud object storage / multipart upload wired yet; the{' '}
              <code>/api/v1/vendor/daily-listings/:id/photos</code> endpoint records hosted{' '}
              <code>https://</code> image URLs for storefront rendering.
            </p>
          </div>
        </div>

        <form className="space-y-4" onSubmit={(e) => void handleFormSubmit(e)} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <label htmlFor="catch-photo-url" className="block text-sm font-medium text-gray-800">
                Actual catch photograph URL *
              </label>
              <input
                id="catch-photo-url"
                type="url"
                value={photoUrl}
                onChange={(e) => {
                  setPhotoUrl(e.target.value);
                  setPreviewFailed(false);
                }}
                disabled={isSubmitting}
                placeholder="https://images.example.com/harbour-snapper.jpg"
                className="h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-irie-green"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="catch-photo-caption" className="block text-sm font-medium text-gray-800">
                Caption (optional)
              </label>
              <input
                id="catch-photo-caption"
                type="text"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                disabled={isSubmitting}
                placeholder="e.g., Scaled and iced at Old Harbour Bay"
                className="h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-irie-green"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="catch-photo-capture" className="block text-sm font-medium text-gray-800">
                Photo capture time (optional)
              </label>
              <input
                id="catch-photo-capture"
                type="datetime-local"
                value={captureDateLocal}
                onChange={(e) => setCaptureDateLocal(e.target.value)}
                disabled={isSubmitting}
                className="h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-irie-green"
              />
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
              disabled={isSubmitting}
              className="h-4 w-4 rounded border-gray-300 text-irie-green focus:ring-irie-green"
            />
            Make this the primary display image for customers
          </label>

          {canRenderPreview ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
              <p className="text-xs font-medium text-gray-700">Live image preview</p>
              {previewFailed ? (
                <p className="text-xs text-amber-800">
                  Preview could not load in the browser for this URL — double-check the URL is publicly accessible before publishing.
                </p>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={photoUrl.trim()}
                  alt={caption.trim() || 'Actual catch preview'}
                  onError={() => setPreviewFailed(true)}
                  onLoad={() => setPreviewFailed(false)}
                  className="max-h-56 w-full rounded-lg object-cover sm:max-w-sm"
                />
              )}
            </div>
          ) : null}

          {submitError ? (
            <div
              role="alert"
              className="rounded-lg border border-irie-red/40 bg-irie-red/10 p-3 text-sm text-irie-red space-y-2"
            >
              <p>{submitError}</p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                loading={isSubmitting}
                onClick={() => void submitPhoto()}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Retry photo upload
              </Button>
            </div>
          ) : null}

          <div>
            <Button type="submit" variant="primary" loading={isSubmitting}>
              <Camera className="h-4 w-4" aria-hidden="true" />
              Add catch photo
            </Button>
          </div>
        </form>

        <div className="space-y-3 border-t border-gray-200 pt-5">
          <h3 className="text-base font-semibold text-gray-900">
            Attached catch photos ({activePhotos.length})
          </h3>

          {actionError ? (
            <div
              role="alert"
              className="rounded-lg border border-irie-red/40 bg-irie-red/10 p-3 text-sm text-irie-red"
            >
              {actionError}
            </div>
          ) : null}

          {activePhotos.length === 0 ? (
            <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-600">
              No active photos attached yet. Add at least one actual-catch photo to unlock Review & Publish.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {activePhotos.map((photo) => {
                const isApproved =
                  photo.moderationStatus === ListingPhotoModerationStatus.APPROVED;

                return (
                  <div
                    key={photo.id}
                    className={`rounded-card border p-3 space-y-3 ${
                      photo.isPrimary ? 'border-irie-green bg-irie-green/5' : 'border-gray-200 bg-white'
                    }`}
                  >
                    <div className="relative h-44 w-full overflow-hidden rounded-lg bg-gray-100">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={photo.url}
                        alt={photo.caption || 'Vendor catch photo'}
                        className="h-full w-full object-cover"
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {photo.isPrimary ? (
                          <Badge variant="success">
                            <Star className="h-3 w-3" aria-hidden="true" />
                            Primary photo
                          </Badge>
                        ) : null}
                        <Badge variant={isApproved ? 'info' : 'warning'}>
                          {isApproved ? (
                            <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                          ) : null}
                          {photo.moderationStatus}
                        </Badge>
                      </div>
                      {photo.caption ? (
                        <p className="text-sm text-gray-800">{photo.caption}</p>
                      ) : null}
                      <p className="truncate text-xs text-gray-500">{photo.url}</p>
                      {photo.captureDate ? (
                        <p className="text-xs text-gray-500">
                          Captured {formatDateTimeReadable(photo.captureDate)}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {!photo.isPrimary && isApproved ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={isSubmitting}
                          onClick={() => void handleSetPrimary(photo.id)}
                        >
                          <Star className="h-3.5 w-3.5" aria-hidden="true" />
                          Set as primary
                        </Button>
                      ) : null}

                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={isSubmitting}
                        onClick={() => {
                          setWithdrawTargetId(
                            withdrawTargetId === photo.id ? null : photo.id,
                          );
                          setWithdrawReason('');
                          setActionError(null);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-irie-red" aria-hidden="true" />
                        Remove
                      </Button>
                    </div>

                    {withdrawTargetId === photo.id ? (
                      <div className="rounded-lg border border-irie-red/30 bg-irie-red/5 p-2.5 space-y-2">
                        <label
                          htmlFor={`withdraw-photo-${photo.id}`}
                          className="block text-xs font-medium text-gray-800"
                        >
                          Removal reason (minimum 5 characters)
                        </label>
                        <input
                          id={`withdraw-photo-${photo.id}`}
                          type="text"
                          value={withdrawReason}
                          onChange={(e) => setWithdrawReason(e.target.value)}
                          placeholder="e.g., Blurry photo replaced"
                          className="h-9 w-full rounded-button border border-gray-300 bg-white px-2.5 text-xs"
                        />
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="danger"
                            loading={isSubmitting}
                            onClick={() => void handleConfirmWithdrawPhoto(photo.id)}
                          >
                            Confirm removal
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={isSubmitting}
                            onClick={() => setWithdrawTargetId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-4">
          <Button type="button" variant="ghost" disabled={isSubmitting} onClick={onBackToDraft}>
            Back to Draft
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={isSubmitting}
            onClick={onContinueToReview}
          >
            Continue to Review
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
