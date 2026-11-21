'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ListingLifecycleStatus,
  ProductUnit,
  type CreateDailyListingInput,
  type DailyListingResponse,
  type DeclareListingSpeciesInput,
  type LandingSite,
  type ManagedSpecies,
  type SeafoodCatalogueItem,
  type SeafoodLotAdmin,
  type UpdateDailyListingInput,
} from '@iriefishmongers/types';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatEnumLabel } from '@/lib/format';

import {
  formatDateTimeReadable,
  fromDateTimeLocalInput,
  getDefaultDraftDateInputs,
  getLotEligibility,
  PRODUCT_UNIT_OPTIONS,
  toDateTimeLocalInput,
} from './vendor-daily-listings-helpers';

export interface VendorListingDraftFormProps {
  editingListing: DailyListingResponse | null;
  lots: SeafoodLotAdmin[];
  catalogueItems: SeafoodCatalogueItem[];
  landingSites: LandingSite[];
  speciesList: ManagedSpecies[];
  canVendorSell: boolean;
  isSubmitting: boolean;
  onCreateDraft: (input: CreateDailyListingInput) => Promise<void>;
  onUpdateListing: (listingId: string, input: UpdateDailyListingInput) => Promise<void>;
  onCancel?: () => void;
}

interface SpeciesDeclarationRow {
  speciesId: string;
  proportion: string;
  notes: string;
}

const SELECT_FIELD_CLASS =
  'h-auto min-h-11 w-full rounded-button border border-gray-300 bg-white px-3 py-2 text-sm leading-snug focus:outline-none focus:ring-2 focus:ring-irie-green disabled:bg-gray-100';

export function VendorListingDraftForm({
  editingListing,
  lots,
  catalogueItems,
  landingSites,
  speciesList,
  canVendorSell,
  isSubmitting,
  onCreateDraft,
  onUpdateListing,
  onCancel,
}: VendorListingDraftFormProps): React.ReactElement {
  const isEditing = Boolean(editingListing);
  const isPublishedEdit = editingListing?.status === ListingLifecycleStatus.PUBLISHED;

  const lotPartition = useMemo(
    () => lots.map((lot) => ({ lot, ...getLotEligibility(lot) })),
    [lots],
  );
  const eligibleLots = useMemo(
    () => lotPartition.filter((entry) => entry.eligible),
    [lotPartition],
  );
  const ineligibleLots = useMemo(
    () => lotPartition.filter((entry) => !entry.eligible),
    [lotPartition],
  );

  const defaults = getDefaultDraftDateInputs(eligibleLots[0]?.lot.catchDate);

  const [lotId, setLotId] = useState<string>(
    editingListing?.lotId ?? eligibleLots[0]?.lot.id ?? '',
  );
  const [catalogueItemId, setCatalogueItemId] = useState<string>(
    editingListing?.catalogueItemId ?? catalogueItems[0]?.id ?? '',
  );
  const [landingSiteId, setLandingSiteId] = useState<string>(
    editingListing?.landingSiteId ?? '',
  );
  const [listingTitle, setListingTitle] = useState<string>(
    editingListing?.listingTitle ?? '',
  );
  const [description, setDescription] = useState<string>(
    editingListing?.description ?? '',
  );
  const [catchDateLocal, setCatchDateLocal] = useState<string>(
    editingListing ? toDateTimeLocalInput(editingListing.catchDate) : defaults.catchDateLocal,
  );
  const [expiresAtLocal, setExpiresAtLocal] = useState<string>(
    editingListing ? toDateTimeLocalInput(editingListing.expiresAt) : defaults.expiresAtLocal,
  );
  const [unit, setUnit] = useState<ProductUnit>(
    editingListing?.unit ?? catalogueItems[0]?.typicalUnit ?? ProductUnit.PER_POUND,
  );
  const [price, setPrice] = useState<string>(
    editingListing ? String(editingListing.price) : '',
  );
  const [quantityUploaded, setQuantityUploaded] = useState<string>(
    editingListing ? String(editingListing.quantityUploaded) : '',
  );
  const [deliveryAvailable, setDeliveryAvailable] = useState<boolean>(
    editingListing?.deliveryAvailable ?? true,
  );
  const [pickupAvailable, setPickupAvailable] = useState<boolean>(
    editingListing?.pickupAvailable ?? true,
  );
  const [speciesRows, setSpeciesRows] = useState<SpeciesDeclarationRow[]>(() =>
    editingListing?.speciesDeclarations?.map((d) => ({
      speciesId: d.speciesId,
      proportion: d.proportion !== null ? String(d.proportion) : '',
      notes: d.notes ?? '',
    })) ?? [],
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!editingListing) return;
    setLotId(editingListing.lotId);
    setCatalogueItemId(editingListing.catalogueItemId);
    setLandingSiteId(editingListing.landingSiteId ?? '');
    setListingTitle(editingListing.listingTitle ?? '');
    setDescription(editingListing.description ?? '');
    setCatchDateLocal(toDateTimeLocalInput(editingListing.catchDate));
    setExpiresAtLocal(toDateTimeLocalInput(editingListing.expiresAt));
    setUnit(editingListing.unit);
    setPrice(String(editingListing.price));
    setQuantityUploaded(String(editingListing.quantityUploaded));
    setDeliveryAvailable(editingListing.deliveryAvailable);
    setPickupAvailable(editingListing.pickupAvailable);
    setSpeciesRows(
      editingListing.speciesDeclarations?.map((d) => ({
        speciesId: d.speciesId,
        proportion: d.proportion !== null ? String(d.proportion) : '',
        notes: d.notes ?? '',
      })) ?? [],
    );
    setErrorMessage(null);
  }, [editingListing]);

  useEffect(() => {
    const firstEligible = eligibleLots[0];
    if (!editingListing && !lotId && firstEligible) {
      setLotId(firstEligible.lot.id);
      setCatchDateLocal(getDefaultDraftDateInputs(firstEligible.lot.catchDate).catchDateLocal);
    }
  }, [editingListing, eligibleLots, lotId]);

  useEffect(() => {
    const firstItem = catalogueItems[0];
    if (!editingListing && !catalogueItemId && firstItem) {
      setCatalogueItemId(firstItem.id);
      setUnit(firstItem.typicalUnit);
    }
  }, [editingListing, catalogueItemId, catalogueItems]);

  const selectedCatalogueItem =
    catalogueItems.find((item) => item.id === catalogueItemId) ?? null;
  const requiresSpeciesDeclarations =
    selectedCatalogueItem?.compositionMode === 'VARIABLE_COMPOSITE' ||
    editingListing?.catalogueItem?.compositionMode === 'VARIABLE_COMPOSITE';

  function handleLotChange(nextLotId: string): void {
    setLotId(nextLotId);
    const chosen = eligibleLots.find((entry) => entry.lot.id === nextLotId)?.lot;
    if (chosen) {
      setCatchDateLocal(getDefaultDraftDateInputs(chosen.catchDate).catchDateLocal);
    }
  }

  function handleCatalogueChange(nextId: string): void {
    setCatalogueItemId(nextId);
    const item = catalogueItems.find((c) => c.id === nextId);
    if (item && !isEditing) {
      setUnit(item.typicalUnit);
    }
  }

  function buildValidatedSpeciesDeclarations(): DeclareListingSpeciesInput[] | undefined {
    if (!requiresSpeciesDeclarations) {
      return undefined;
    }
    const validRows: DeclareListingSpeciesInput[] = [];
    for (const row of speciesRows) {
      if (!row.speciesId) continue;
      const decl: DeclareListingSpeciesInput = { speciesId: row.speciesId };
      if (row.proportion.trim()) {
        const num = Number(row.proportion);
        if (!Number.isFinite(num) || num < 0 || num > 100) {
          throw new Error('Species proportion must be between 0 and 100.');
        }
        decl.proportion = num;
      }
      if (row.notes.trim()) {
        decl.notes = row.notes.trim();
      }
      validRows.push(decl);
    }
    if (validRows.length === 0) {
      throw new Error(
        'Variable-composite catalogue items require at least one listing-level species declaration.',
      );
    }
    return validRows;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);

    try {
      const numericPrice = Number(price);
      if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
        throw new Error('Price per unit must be greater than 0 JMD.');
      }

      const expiresAtIso = fromDateTimeLocalInput(expiresAtLocal);
      if (!expiresAtIso) {
        throw new Error('Enter a valid listing expiry date and time.');
      }
      if (new Date(expiresAtIso).getTime() <= Date.now()) {
        throw new Error('Sale expiry time must be in the future.');
      }

      if (!deliveryAvailable && !pickupAvailable) {
        throw new Error('Select at least one fulfillment option (delivery or pickup).');
      }

      if (isEditing && editingListing) {
        const updatePayload: UpdateDailyListingInput = {
          listingTitle: listingTitle.trim() || undefined,
          description: description.trim() || undefined,
          expiresAt: expiresAtIso,
          price: numericPrice,
          deliveryAvailable,
          pickupAvailable,
        };

        if (!isPublishedEdit) {
          const numericQty = Number(quantityUploaded);
          if (!Number.isFinite(numericQty) || numericQty <= 0) {
            throw new Error('Quantity uploaded must be greater than 0.');
          }
          updatePayload.quantityUploaded = numericQty;
          const speciesDeclarations = buildValidatedSpeciesDeclarations();
          if (speciesDeclarations) {
            updatePayload.speciesDeclarations = speciesDeclarations;
          }
        }

        await onUpdateListing(editingListing.id, updatePayload);
        return;
      }

      if (!canVendorSell) {
        throw new Error(
          'Your vendor account must be APPROVED with valid compliance documents before creating a listing.',
        );
      }

      if (!lotId) {
        throw new Error('Select an eligible SAFE seafood lot before creating a draft.');
      }
      const chosenLotEntry = lotPartition.find((entry) => entry.lot.id === lotId);
      if (!chosenLotEntry || !chosenLotEntry.eligible) {
        throw new Error(
          chosenLotEntry?.reason ?? 'Selected seafood lot is no longer eligible for listing.',
        );
      }

      if (!catalogueItemId) {
        throw new Error('Select a published master catalogue item.');
      }

      const catchDateIso = fromDateTimeLocalInput(catchDateLocal);
      if (!catchDateIso) {
        throw new Error('Enter a valid catch / sale date.');
      }
      if (new Date(catchDateIso).getTime() > Date.now() + 60_000) {
        throw new Error('Catch / sale date cannot be in the future.');
      }

      const numericQty = Number(quantityUploaded);
      if (!Number.isFinite(numericQty) || numericQty <= 0) {
        throw new Error('Quantity uploaded must be greater than 0.');
      }

      const speciesDeclarations = buildValidatedSpeciesDeclarations();

      await onCreateDraft({
        catalogueItemId,
        lotId,
        landingSiteId: landingSiteId || undefined,
        listingTitle: listingTitle.trim() || undefined,
        description: description.trim() || undefined,
        catchDate: catchDateIso,
        expiresAt: expiresAtIso,
        unit,
        price: numericPrice,
        currency: 'JMD',
        quantityUploaded: numericQty,
        deliveryAvailable,
        pickupAvailable,
        speciesDeclarations,
      });
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Unable to save daily catch listing.',
      );
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {isEditing
            ? isPublishedEdit
              ? 'Step 1 · Edit published listing details'
              : 'Step 1 · Edit catch draft'
            : 'Step 1 · Draft today’s catch'}
        </CardTitle>
        <p className="text-sm text-gray-600">
          Anchor your listing to a verified seafood lot and master catalogue item, then save your draft before adding actual catch photos.
        </p>
      </CardHeader>
      <CardContent>
        {!isEditing && eligibleLots.length === 0 ? (
          <div
            role="status"
            className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 space-y-2"
          >
            <div className="flex items-start gap-2 font-semibold">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>You do not have any eligible seafood lots to list yet.</span>
            </div>
            <p>
              Before you can create a Catch of the Day listing, you need:
            </p>
            <ul className="list-disc pl-5 space-y-1 text-xs">
              <li>An approved vendor profile with approved compliance documents for your tier.</li>
              <li>At least one registered seafood lot owned by your vendor account with food-safety status <strong>SAFE</strong>.</li>
            </ul>
            {ineligibleLots.length > 0 ? (
              <div className="pt-2 border-t border-amber-200">
                <p className="font-medium text-xs mb-1">Existing lots that cannot be listed:</p>
                <ul className="list-disc pl-5 space-y-1 text-xs">
                  {ineligibleLots.map(({ lot, reason }) => (
                    <li key={lot.id}>
                      <strong>{lot.lotNumber}</strong> ({lot.species}): {reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        <form className="space-y-5" onSubmit={(e) => void handleSubmit(e)} noValidate>
          {!isEditing ? (
            <>
              <div className="space-y-1.5">
                <label htmlFor="draft-lot" className="block text-sm font-medium text-gray-800">
                  Eligible seafood lot *
                </label>
                <select
                  id="draft-lot"
                  value={lotId}
                  onChange={(e) => handleLotChange(e.target.value)}
                  disabled={eligibleLots.length === 0 || isSubmitting}
                  className={SELECT_FIELD_CLASS}
                >
                  {eligibleLots.length === 0 ? (
                    <option value="">No SAFE seafood lots available</option>
                  ) : (
                    eligibleLots.map(({ lot }) => (
                      <option key={lot.id} value={lot.id}>
                        {lot.lotNumber} · {lot.species} ({lot.weight}{' '}
                        {formatEnumLabel(lot.weightUnit)} · Caught {formatDateTimeReadable(lot.catchDate)})
                      </option>
                    ))
                  )}
                </select>
                {ineligibleLots.length > 0 && eligibleLots.length > 0 ? (
                  <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600 space-y-1">
                    <p className="font-medium text-gray-700">Unavailable lots (excluded by food safety):</p>
                    {ineligibleLots.map(({ lot, reason }) => (
                      <p key={lot.id}>
                        <span className="font-medium">{lot.lotNumber}</span> ({lot.species}) — {reason}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="draft-catalogue" className="block text-sm font-medium text-gray-800">
                  Master seafood catalogue item *
                </label>
                <select
                  id="draft-catalogue"
                  value={catalogueItemId}
                  onChange={(e) => handleCatalogueChange(e.target.value)}
                  disabled={catalogueItems.length === 0 || isSubmitting}
                  className={SELECT_FIELD_CLASS}
                >
                  {catalogueItems.length === 0 ? (
                    <option value="">No published catalogue items available</option>
                  ) : (
                    catalogueItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.scientificName ? ` (${item.scientificName})` : ''}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </>
          ) : (
            <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-700 space-y-1">
              <p>
                <strong>Seafood Lot:</strong> {editingListing?.lot?.lotNumber ?? editingListing?.lotId} (food safety:{' '}
                {editingListing?.lot?.foodSafetyStatus ?? 'SAFE'})
              </p>
              <p>
                <strong>Catalogue Item:</strong> {editingListing?.catalogueItem?.name ?? editingListing?.catalogueItemId}
              </p>
              {isPublishedEdit ? (
                <p className="text-gray-500">
                  Quantity uploaded ({editingListing?.quantityUploaded}{' '}
                  {formatEnumLabel(editingListing?.unit ?? ProductUnit.PER_POUND).toLowerCase()}) is locked after publication.
                </p>
              ) : null}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <label htmlFor="draft-title" className="block text-sm font-medium text-gray-800">
                Catch title
              </label>
              <input
                id="draft-title"
                type="text"
                value={listingTitle}
                onChange={(e) => setListingTitle(e.target.value)}
                disabled={isSubmitting}
                placeholder="e.g., Fresh Morning Yellowtail Snapper Catch"
                className="h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-irie-green"
              />
            </div>

            {!isEditing ? (
              <div className="space-y-1.5">
                <label htmlFor="draft-catch-date" className="block text-sm font-medium text-gray-800">
                  Catch / sale date *
                </label>
                <input
                  id="draft-catch-date"
                  type="datetime-local"
                  value={catchDateLocal}
                  onChange={(e) => setCatchDateLocal(e.target.value)}
                  disabled={isSubmitting}
                  className="h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-irie-green"
                />
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor="draft-expires-at" className="block text-sm font-medium text-gray-800">
                Available until *
              </label>
              <input
                id="draft-expires-at"
                type="datetime-local"
                value={expiresAtLocal}
                onChange={(e) => setExpiresAtLocal(e.target.value)}
                disabled={isSubmitting}
                className="h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-irie-green"
              />
            </div>

            {!isPublishedEdit ? (
              <div className="space-y-1.5">
                <label htmlFor="draft-quantity" className="block text-sm font-medium text-gray-800">
                  Quantity *
                </label>
                <input
                  id="draft-quantity"
                  type="number"
                  min="0.01"
                  step="any"
                  value={quantityUploaded}
                  onChange={(e) => setQuantityUploaded(e.target.value)}
                  disabled={isSubmitting}
                  placeholder="e.g., 25"
                  className="h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-irie-green"
                />
              </div>
            ) : null}

            {!isEditing ? (
              <div className="space-y-1.5">
                <label htmlFor="draft-unit" className="block text-sm font-medium text-gray-800">
                  Selling unit *
                </label>
                <select
                  id="draft-unit"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value as ProductUnit)}
                  disabled={isSubmitting}
                  className={SELECT_FIELD_CLASS}
                >
                  {PRODUCT_UNIT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor="draft-price" className="block text-sm font-medium text-gray-800">
                Price per unit (JMD) *
              </label>
              <input
                id="draft-price"
                type="number"
                min="1"
                step="any"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                disabled={isSubmitting}
                placeholder="e.g., 950"
                className="h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-irie-green"
              />
            </div>

            {!isEditing && landingSites.length > 0 ? (
              <div className="space-y-1.5">
                <label htmlFor="draft-landing-site" className="block text-sm font-medium text-gray-800">
                  Landing site (optional)
                </label>
                <select
                  id="draft-landing-site"
                  value={landingSiteId}
                  onChange={(e) => setLandingSiteId(e.target.value)}
                  disabled={isSubmitting}
                  className={SELECT_FIELD_CLASS}
                >
                  <option value="">Use vendor default / unspecified</option>
                  {landingSites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name} ({formatEnumLabel(site.parish)})
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="space-y-1.5 sm:col-span-2">
              <label htmlFor="draft-description" className="block text-sm font-medium text-gray-800">
                Catch notes & handling details
              </label>
              <textarea
                id="draft-description"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={isSubmitting}
                placeholder="e.g., Iced at sea, landed early morning at Old Harbour Bay"
                className="w-full rounded-button border border-gray-300 bg-white p-3 text-sm focus:outline-none focus:ring-2 focus:ring-irie-green"
              />
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-gray-800">Fulfillment options</legend>
            <div className="flex flex-wrap gap-5">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={deliveryAvailable}
                  onChange={(e) => setDeliveryAvailable(e.target.checked)}
                  disabled={isSubmitting}
                  className="h-4 w-4 rounded border-gray-300 text-irie-green focus:ring-irie-green"
                />
                Delivery available
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={pickupAvailable}
                  onChange={(e) => setPickupAvailable(e.target.checked)}
                  disabled={isSubmitting}
                  className="h-4 w-4 rounded border-gray-300 text-irie-green focus:ring-irie-green"
                />
                Customer pickup available
              </label>
            </div>
          </fieldset>

          {requiresSpeciesDeclarations && !isPublishedEdit ? (
            <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">
                    Species declarations *
                  </h3>
                  <p className="text-xs text-gray-600">
                    Required because this master catalogue item is a variable composite catch.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={isSubmitting || speciesList.length === 0}
                  onClick={() =>
                    setSpeciesRows((prev) => [
                      ...prev,
                      { speciesId: speciesList[0]?.id ?? '', proportion: '', notes: '' },
                    ])
                  }
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  Add species
                </Button>
              </div>
              {speciesRows.map((row, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-12 items-end">
                  <div className="sm:col-span-6">
                    <label
                      htmlFor={`species-select-${index}`}
                      className="block text-xs font-medium text-gray-700"
                    >
                      Species
                    </label>
                    <select
                      id={`species-select-${index}`}
                      value={row.speciesId}
                      onChange={(e) =>
                        setSpeciesRows((prev) =>
                          prev.map((item, i) =>
                            i === index ? { ...item, speciesId: e.target.value } : item,
                          ),
                        )
                      }
                      className={`mt-1 ${SELECT_FIELD_CLASS}`}
                    >
                      {speciesList.map((sp) => (
                        <option key={sp.id} value={sp.id}>
                          {sp.commercialName} ({sp.scientificName})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-3">
                    <label
                      htmlFor={`species-prop-${index}`}
                      className="block text-xs font-medium text-gray-700"
                    >
                      Proportion %
                    </label>
                    <input
                      id={`species-prop-${index}`}
                      type="number"
                      min="0"
                      max="100"
                      value={row.proportion}
                      onChange={(e) =>
                        setSpeciesRows((prev) =>
                          prev.map((item, i) =>
                            i === index ? { ...item, proportion: e.target.value } : item,
                          ),
                        )
                      }
                      className="mt-1 h-10 w-full rounded-button border border-gray-300 bg-white px-2 text-sm"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove species row ${index + 1}`}
                      onClick={() =>
                        setSpeciesRows((prev) => prev.filter((_, i) => i !== index))
                      }
                    >
                      <Trash2 className="h-4 w-4 text-irie-red" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {errorMessage ? (
            <div
              role="alert"
              className="rounded-lg border border-irie-red/40 bg-irie-red/10 p-3 text-sm text-irie-red"
            >
              {errorMessage}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button
              type="submit"
              variant="primary"
              loading={isSubmitting}
              disabled={!isEditing && (!canVendorSell || eligibleLots.length === 0)}
            >
              {isEditing
                ? isPublishedEdit
                  ? 'Save listing updates'
                  : 'Save draft & continue to photos'
                : 'Save draft & continue to photos'}
            </Button>
            {onCancel ? (
              <Button type="button" variant="ghost" disabled={isSubmitting} onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
