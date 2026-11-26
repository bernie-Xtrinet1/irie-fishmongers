'use client';

import { useState } from 'react';
import type { CataloguePhotoOption, ManagedSpecies } from '@iriefishmongers/types';
import { useQuery } from '@tanstack/react-query';
import { Check, ExternalLink, Eye, Fish, Search, X } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fetchCataloguePhotos } from '@/lib/api/vendors';

export interface CataloguePhotoPickerProps {
  selectedSpecies: ManagedSpecies | null;
  selectedPhotoId: string | null;
  selectedImageUrl: string;
  initialSelectedPhoto?: CataloguePhotoOption | null;
  disabled?: boolean;
  onSelectPhoto: (photo: CataloguePhotoOption) => void;
  onSwitchToCustomUrl: () => void;
}

export function CataloguePhotoPicker({
  selectedSpecies,
  selectedPhotoId,
  selectedImageUrl,
  initialSelectedPhoto = null,
  disabled = false,
  onSelectPhoto,
  onSwitchToCustomUrl,
}: CataloguePhotoPickerProps): React.ReactElement {
  const [searchTerm, setSearchTerm] = useState('');
  const [previewPhoto, setPreviewPhoto] = useState<CataloguePhotoOption | null>(null);

  const isRestrictedSpecies =
    selectedSpecies?.regulatoryStatus === 'RESTRICTED' ||
    selectedSpecies?.regulatoryStatus === 'PROHIBITED';

  const photosQuery = useQuery({
    queryKey: ['catalogue', 'photos', selectedSpecies?.id ?? null, searchTerm.trim()],
    queryFn: () =>
      fetchCataloguePhotos({
        speciesId: selectedSpecies?.id,
        search: searchTerm.trim() || undefined,
      }),
    enabled: Boolean(selectedSpecies) || searchTerm.trim().length > 0,
  });

  const matchingPhotos = photosQuery.data ?? [];
  const activeSelectedPhoto =
    matchingPhotos.find(
      (photo) => photo.id === selectedPhotoId || photo.imageUrl === selectedImageUrl.trim(),
    ) ??
    (initialSelectedPhoto &&
    (!selectedSpecies || initialSelectedPhoto.speciesId === selectedSpecies.id) &&
    (initialSelectedPhoto.id === selectedPhotoId ||
      initialSelectedPhoto.imageUrl === selectedImageUrl.trim())
      ? initialSelectedPhoto
      : null);

  return (
    <div
      className="min-w-0 w-full max-w-full space-y-4 rounded-lg border border-gray-200 bg-gray-50/70 p-3 sm:p-4"
      data-testid="catalogue-photo-picker"
    >
      <div className="min-w-0 space-y-1.5">
        <label htmlFor="catalogue-photo-search" className="block text-xs font-medium text-gray-700">
          Search catalogue photos (English, Jamaican market name, or scientific name)
        </label>
        <div className="relative min-w-0">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            aria-hidden="true"
          />
          <input
            id="catalogue-photo-search"
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            disabled={disabled}
            placeholder="e.g. Red Belly, Tilapia, Oreochromis niloticus..."
            className="h-11 w-full max-w-full min-w-0 rounded-button border border-gray-300 bg-white pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-irie-green"
            data-testid="catalogue-photo-search-input"
          />
        </div>
        {selectedSpecies ? (
          <p className="text-xs text-gray-600">
            Showing verified photos for{' '}
            <span className="font-medium text-gray-900">{selectedSpecies.commercialName}</span> (
            <span className="italic">{selectedSpecies.scientificName}</span>).
          </p>
        ) : (
          <p className="text-xs text-gray-600">
            Select a seafood species above or type a name above to search matching reference photos.
          </p>
        )}
      </div>

      {activeSelectedPhoto ? (
        <div
          className="flex min-w-0 w-full flex-col gap-3 rounded-lg border border-irie-green/40 bg-irie-green/5 p-3 sm:flex-row sm:items-center sm:justify-between"
          data-testid="selected-catalogue-photo-summary"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={activeSelectedPhoto.imageUrl}
              alt={activeSelectedPhoto.title}
              className="h-14 w-20 shrink-0 rounded-md object-cover bg-white"
            />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold text-irie-green">
                  Selected catalogue photo
                </span>
                <Badge variant="neutral">Catalogue reference photo</Badge>
              </div>
              <p className="truncate text-sm font-medium text-gray-900">
                {activeSelectedPhoto.title}
              </p>
              <p className="truncate text-xs italic text-gray-600">
                {activeSelectedPhoto.scientificName}
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setPreviewPhoto(activeSelectedPhoto)}
          >
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            Preview credit
          </Button>
        </div>
      ) : null}

      {previewPhoto ? (
        <div
          className="min-w-0 w-full space-y-3 rounded-lg border border-gray-300 bg-white p-3 sm:p-4"
          data-testid="catalogue-photo-preview-panel"
        >
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="break-words text-sm font-semibold text-gray-900">
                  {previewPhoto.title}
                </h4>
                <Badge variant="neutral">Catalogue reference photo</Badge>
              </div>
              <p className="text-xs italic text-gray-600">{previewPhoto.scientificName}</p>
            </div>
            <button
              type="button"
              onClick={() => setPreviewPhoto(null)}
              aria-label="Close photo preview"
              className="rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-800"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="overflow-hidden rounded-lg bg-gray-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewPhoto.imageUrl}
              alt={`${previewPhoto.title} (${previewPhoto.scientificName})`}
              className="max-h-64 w-full object-cover"
            />
          </div>

          <div className="space-y-1 text-xs text-gray-600">
            <p>
              <span className="font-medium text-gray-800">Jamaican aliases:</span>{' '}
              {previewPhoto.jamaicanAliases.join(', ')}
            </p>
            <p>
              <span className="font-medium text-gray-800">Credit:</span>{' '}
              <a
                href={previewPhoto.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline hover:text-gray-900"
              >
                {previewPhoto.sourceName}
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>{' '}
              by {previewPhoto.photographer} (
              <a
                href={previewPhoto.licenseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-gray-900"
              >
                {previewPhoto.licenseName}
              </a>
              ).
            </p>
            <p>
              <span className="font-medium text-gray-800">Modifications:</span>{' '}
              {previewPhoto.modifications}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              onClick={() => {
                onSelectPhoto(previewPhoto);
              }}
              data-testid="preview-select-catalogue-photo-btn"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              Use this catalogue photo
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setPreviewPhoto(null)}>
              Close preview
            </Button>
          </div>
        </div>
      ) : null}

      {!selectedSpecies && searchTerm.trim().length === 0 ? (
        <div
          className="rounded-lg border border-dashed border-gray-300 bg-white p-5 text-center text-sm text-gray-600"
          data-testid="catalogue-photo-prompt"
        >
          <Fish className="mx-auto h-7 w-7 text-gray-400" aria-hidden="true" />
          <p className="mt-2 font-medium text-gray-800">Choose a species to browse its photos</p>
          <p className="mt-1 text-xs text-gray-500">
            Select a species in the form above (for example Snapper, Tilapia, King Fish, or
            Mackerel), or search by Jamaican market alias above.
          </p>
        </div>
      ) : photosQuery.isPending ? (
        <div className="rounded-lg border border-gray-200 bg-white p-5 text-center text-sm text-gray-500">
          Loading approved catalogue photos…
        </div>
      ) : photosQuery.isError ? (
        <div
          role="alert"
          className="rounded-lg border border-irie-red/30 bg-irie-red/5 p-4 text-sm text-irie-red"
        >
          Could not load catalogue photos right now. Please try again or enter a custom HTTPS photo
          URL.
        </div>
      ) : matchingPhotos.length === 0 ? (
        <div
          className="rounded-lg border border-dashed border-gray-300 bg-white p-5 text-center space-y-2"
          data-testid="catalogue-photo-empty-state"
        >
          <Fish className="mx-auto h-7 w-7 text-gray-400" aria-hidden="true" />
          <p className="text-sm font-medium text-gray-900">
            {isRestrictedSpecies && selectedSpecies
              ? `${selectedSpecies.commercialName} (${selectedSpecies.scientificName}) is currently ${selectedSpecies.regulatoryStatus.toLowerCase()} and has no approved catalogue photos available.`
              : `No approved catalogue reference photo matches ${
                  selectedSpecies ? selectedSpecies.commercialName : `"${searchTerm.trim()}"`
                } yet.`}
          </p>
          <p className="text-xs text-gray-500">
            {isRestrictedSpecies
              ? 'Select an unrestricted species to list on the storefront.'
              : 'Try clearing the search box or enter your own hosted https:// product photo URL.'}
          </p>
          {!isRestrictedSpecies ? (
            <Button type="button" size="sm" variant="secondary" onClick={onSwitchToCustomUrl}>
              Enter photo URL instead
            </Button>
          ) : null}
        </div>
      ) : (
        <div
          className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2"
          data-testid="catalogue-photo-grid"
        >
          {matchingPhotos.map((photo) => {
            const isSelected =
              photo.id === selectedPhotoId || photo.imageUrl === selectedImageUrl.trim();
            return (
              <div
                key={photo.id}
                className={`min-w-0 flex flex-col overflow-hidden rounded-lg border bg-white transition-shadow ${
                  isSelected
                    ? 'border-irie-green ring-2 ring-irie-green/40'
                    : 'border-gray-200 hover:shadow-sm'
                }`}
                data-testid={`catalogue-photo-card-${photo.id}`}
              >
                <div className="relative aspect-[3/2] w-full bg-gray-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo.imageUrl}
                    alt={`${photo.title} (${photo.scientificName})`}
                    className="h-full w-full object-cover"
                  />
                  {isSelected ? (
                    <Badge
                      variant="success"
                      className="absolute left-2 top-2 bg-irie-green text-white shadow-xs"
                    >
                      <Check className="h-3 w-3" aria-hidden="true" />
                      Selected
                    </Badge>
                  ) : null}
                </div>

                <div className="flex flex-1 flex-col justify-between gap-3 p-3">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-gray-900">{photo.title}</p>
                    <p className="text-xs italic text-gray-600">{photo.scientificName}</p>
                    <p className="text-xs text-gray-500">
                      Also known locally as: {photo.jamaicanAliases.join(', ')}
                    </p>
                    <p className="text-[11px] text-gray-500">
                      {photo.licenseName} · {photo.photographer}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setPreviewPhoto(photo)}
                      className="flex-1 min-w-[100px]"
                      data-testid={`preview-catalogue-photo-${photo.id}`}
                    >
                      <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                      Preview
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={isSelected ? 'secondary' : 'primary'}
                      disabled={disabled}
                      onClick={() => onSelectPhoto(photo)}
                      className="flex-1 min-w-[110px]"
                      data-testid={`select-catalogue-photo-${photo.id}`}
                    >
                      {isSelected ? 'Selected' : 'Select photo'}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-gray-500">
        Need full licensing or modification notes?{' '}
        <Link href="/photo-credits" className="underline hover:text-gray-800">
          View all storefront photo credits
        </Link>
        .
      </p>
    </div>
  );
}
