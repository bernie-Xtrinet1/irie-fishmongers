'use client';

import type { AdminCataloguePhotoItem, ManagedSpecies } from '@iriefishmongers/types';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCataloguePhotoMutations } from '@/lib/hooks/use-catalogue-photos';
import {
  renderCroppedStorefrontFile,
  StorefrontCropPreview,
  type CropTransformSettings,
} from './storefront-crop-preview';

export type CataloguePhotoDialogMode = 'create' | 'edit' | 'replace';

export function CataloguePhotoFormDialog({
  open,
  mode,
  speciesList,
  targetPhoto,
  canPublish,
  onOpenChange,
  onCompleted,
}: {
  open: boolean;
  mode: CataloguePhotoDialogMode;
  speciesList: ManagedSpecies[];
  targetPhoto: AdminCataloguePhotoItem | null;
  canPublish: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: (message: string) => void;
}): React.ReactElement {
  const mutations = useCataloguePhotoMutations();

  const [speciesId, setSpeciesId] = useState('');
  const [title, setTitle] = useState('');
  const [aliasesText, setAliasesText] = useState('');
  const [photographer, setPhotographer] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [licenseName, setLicenseName] = useState('');
  const [licenseUrl, setLicenseUrl] = useState('');
  const [modifications, setModifications] = useState('Cropped/resized to 900x600 PNG');
  const [requiresAttribution, setRequiresAttribution] = useState(true);
  const [publishImmediately, setPublishImmediately] = useState(false);
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [crop, setCrop] = useState<CropTransformSettings>({
    focusX: 50,
    focusY: 50,
    zoom: 1,
    applyCrop: true,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSelectedFile(null);
    setPublishImmediately(false);
    setSetAsDefault(false);
    setCrop({ focusX: 50, focusY: 50, zoom: 1, applyCrop: true });

    if ((mode === 'edit' || mode === 'replace') && targetPhoto) {
      setSpeciesId(targetPhoto.speciesId);
      setTitle(mode === 'replace' ? `${targetPhoto.title} (Updated)` : targetPhoto.title);
      setAliasesText(targetPhoto.jamaicanAliases.join(', '));
      setPhotographer(targetPhoto.photographer);
      setSourceName(targetPhoto.sourceName);
      setSourceUrl(targetPhoto.sourceUrl);
      setLicenseName(targetPhoto.licenseName);
      setLicenseUrl(targetPhoto.licenseUrl);
      setModifications(targetPhoto.modifications);
      setRequiresAttribution(targetPhoto.requiresAttribution);
    } else {
      const defaultSpecies = speciesList.find((s) => s.regulatoryStatus === 'UNRESTRICTED') ?? speciesList[0];
      setSpeciesId(defaultSpecies?.id ?? '');
      setTitle('');
      setAliasesText('');
      setPhotographer('');
      setSourceName('');
      setSourceUrl('');
      setLicenseName('');
      setLicenseUrl('');
      setModifications('Cropped/resized to 900x600 PNG');
      setRequiresAttribution(true);
    }
  }, [open, mode, targetPhoto, speciesList]);

  const isSubmitting =
    mutations.uploadDraft.isPending ||
    mutations.updateMetadata.isPending ||
    mutations.replaceVersion.isPending;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);

    if (mode !== 'edit' && !selectedFile) {
      setError('Select a PNG, JPEG, or WebP image file before submitting.');
      return;
    }
    if (!speciesId) {
      setError('Select a species before submitting.');
      return;
    }
    if (!title.trim() || !photographer.trim() || !sourceName.trim() || !licenseName.trim()) {
      setError('Title, photographer, source, and licence/usage rights are required.');
      return;
    }

    try {
      const formData = new FormData();
      let finalMods = modifications.trim() || 'Original framing';

      if (selectedFile) {
        const prepared = await renderCroppedStorefrontFile(selectedFile, crop);
        formData.append('file', prepared.file);
        if (!modifications.trim() || modifications === 'Cropped/resized to 900x600 PNG') {
          finalMods = prepared.description;
        }
      }

      if (mode === 'create') {
        formData.append('speciesId', speciesId);
      }
      formData.append('title', title.trim());
      formData.append(
        'jamaicanAliases',
        JSON.stringify(
          aliasesText
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean),
        ),
      );
      formData.append('photographer', photographer.trim());
      formData.append('sourceName', sourceName.trim());
      if (sourceUrl.trim()) formData.append('sourceUrl', sourceUrl.trim());
      formData.append('licenseName', licenseName.trim());
      if (licenseUrl.trim()) formData.append('licenseUrl', licenseUrl.trim());
      formData.append('modifications', finalMods);
      formData.append('requiresAttribution', String(requiresAttribution));

      if (mode === 'create') {
        const created = await mutations.uploadDraft.mutateAsync(formData);
        onCompleted(`Uploaded private draft "${created.title}" for ${created.species.commercialName}.`);
      } else if (mode === 'edit' && targetPhoto) {
        const updated = await mutations.updateMetadata.mutateAsync({ id: targetPhoto.id, formData });
        onCompleted(`Saved metadata updates for "${updated.title}".`);
      } else if (mode === 'replace' && targetPhoto) {
        if (canPublish && publishImmediately) {
          formData.append('publishImmediately', 'true');
          if (setAsDefault) {
            formData.append('setAsDefault', 'true');
          }
        }
        const res = await mutations.replaceVersion.mutateAsync({ id: targetPhoto.id, formData });
        onCompleted(
          `Uploaded replacement v${res.photo.versionNumber} (${res.photo.lifecycleStatus}). ${res.oldVersionUsageCount} existing listing(s) retain v${targetPhoto.versionNumber} by default.`,
        );
      }

      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed. Please verify the inputs.');
    }
  }

  const heading =
    mode === 'create'
      ? 'Upload Catalogue Photo'
      : mode === 'replace'
        ? `Replace Photo Version (v${targetPhoto?.versionNumber ?? 1})`
        : 'Edit Catalogue Photo Details';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Uploaded images are stored privately as drafts in Azure Blob Storage until approved and published by an administrator.'
              : mode === 'replace'
                ? 'Uploads a brand-new immutable version under a new storage key so cached listings and rollbacks stay intact.'
                : 'Update species aliases, photographer attribution, source, or licence rights.'}
          </DialogDescription>
        </DialogHeader>

        {mode === 'replace' && targetPhoto ? (
          <div
            className="mb-4 rounded-lg border border-irie-yellow/50 bg-irie-yellow/10 p-3 text-sm text-gray-800"
            data-testid="replace-usage-banner"
          >
            <strong>{targetPhoto.usageCount}</strong> product listing(s) currently use{' '}
            <strong>
              {targetPhoto.title} (v{targetPhoto.versionNumber})
            </strong>
            . By default, existing listings remain on v{targetPhoto.versionNumber} and its stored
            image. Switching existing listings requires a separate explicit confirmation after publishing.
          </div>
        ) : null}

        <form className="space-y-4" onSubmit={(e) => void handleSubmit(e)}>
          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-irie-red/30 bg-irie-red/5 p-3 text-sm text-irie-red"
            >
              {error}
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
              Species
              <select
                value={speciesId}
                onChange={(e) => setSpeciesId(e.target.value)}
                disabled={mode !== 'create'}
                className="h-11 rounded-button border border-gray-300 bg-white px-3 text-sm text-gray-900 disabled:bg-gray-100"
                data-testid="photo-species-select"
              >
                {speciesList.map((sp) => (
                  <option key={sp.id} value={sp.id}>
                    {sp.commercialName} ({sp.scientificName})
                    {sp.regulatoryStatus !== 'UNRESTRICTED' ? ` — ${sp.regulatoryStatus}` : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
              Photo Title
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Jamaican Red Belly Tilapia"
                className="h-11 rounded-button border border-gray-300 px-3 text-sm text-gray-900"
                data-testid="photo-title-input"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
            Jamaican Market Names &amp; Aliases (comma-separated)
            <input
              type="text"
              value={aliasesText}
              onChange={(e) => setAliasesText(e.target.value)}
              placeholder="e.g. Tilapia, Red Belly, Pond Fish"
              className="h-11 rounded-button border border-gray-300 px-3 text-sm text-gray-900"
              data-testid="photo-aliases-input"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
              Photographer / Creator
              <input
                type="text"
                value={photographer}
                onChange={(e) => setPhotographer(e.target.value)}
                placeholder="e.g. Irie Fisheries Media Team"
                className="h-11 rounded-button border border-gray-300 px-3 text-sm text-gray-900"
                data-testid="photo-photographer-input"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
              Source Name
              <input
                type="text"
                value={sourceName}
                onChange={(e) => setSourceName(e.target.value)}
                placeholder="e.g. Wikimedia Commons or Company Studio"
                className="h-11 rounded-button border border-gray-300 px-3 text-sm text-gray-900"
                data-testid="photo-source-name-input"
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
              Source URL (optional for internal studio)
              <input
                type="url"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://commons.wikimedia.org/wiki/..."
                className="h-11 rounded-button border border-gray-300 px-3 text-sm text-gray-900"
                data-testid="photo-source-url-input"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
              Licence / Usage Rights
              <input
                type="text"
                value={licenseName}
                onChange={(e) => setLicenseName(e.target.value)}
                placeholder="e.g. CC BY-SA 4.0 or Company Owned"
                className="h-11 rounded-button border border-gray-300 px-3 text-sm text-gray-900"
                data-testid="photo-license-name-input"
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
              Licence URL
              <input
                type="url"
                value={licenseUrl}
                onChange={(e) => setLicenseUrl(e.target.value)}
                placeholder="https://creativecommons.org/licenses/by-sa/4.0/"
                className="h-11 rounded-button border border-gray-300 px-3 text-sm text-gray-900"
                data-testid="photo-license-url-input"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
              Modifications / Crop Disclosure
              <input
                type="text"
                value={modifications}
                onChange={(e) => setModifications(e.target.value)}
                className="h-11 rounded-button border border-gray-300 px-3 text-sm text-gray-900"
                data-testid="photo-modifications-input"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={requiresAttribution}
                onChange={(e) => setRequiresAttribution(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              Requires public attribution line
            </label>

            {mode === 'replace' && canPublish ? (
              <>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={publishImmediately}
                    onChange={(e) => setPublishImmediately(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300"
                    data-testid="replace-publish-immediately-checkbox"
                  />
                  Approve &amp; publish v{(targetPhoto?.versionNumber ?? 1) + 1} immediately
                </label>
                {publishImmediately ? (
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={setAsDefault}
                      onChange={(e) => setSetAsDefault(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    Make replacement default for future listings
                  </label>
                ) : null}
              </>
            ) : null}
          </div>

          {mode !== 'edit' || targetPhoto?.lifecycleStatus !== 'APPROVED' ? (
            <div className="space-y-2">
              <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
                {mode === 'edit'
                  ? 'Replace Draft Image File (PNG, JPEG, or WebP, max 5 MiB, min 400×300px)'
                  : 'Image File (PNG, JPEG, or WebP, max 5 MiB, min 400×300px)'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
                  className="text-sm text-gray-700 file:mr-3 file:rounded-button file:border file:border-gray-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-gray-50"
                  data-testid="photo-file-input"
                />
              </label>

              <StorefrontCropPreview
                file={selectedFile}
                title={title}
                value={crop}
                onChange={setCrop}
              />
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting} data-testid="submit-catalogue-photo-btn">
              {mode === 'create'
                ? 'Upload Draft Photo'
                : mode === 'replace'
                  ? 'Upload New Version'
                  : 'Save Changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
