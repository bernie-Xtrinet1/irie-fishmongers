'use client';

import { useState } from 'react';
import {
  FoodSafetyStatus,
  ProductAvailability,
  ProductUnit,
  UserRole,
  type CataloguePhotoOption,
  type CategoryOption,
  type ManagedSpecies,
  type ProductResponse,
} from '@iriefishmongers/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Camera, Image as ImageIcon, Pencil, Plus, Power, RotateCcw } from 'lucide-react';
import Link from 'next/link';

import { ProductPhotoBadge } from '@/components/marketplace/product-photo-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  getVendorSellingBlockers,
  PRODUCT_UNIT_OPTIONS,
} from '@/components/vendor-daily-listings/vendor-daily-listings-helpers';
import { ApiError } from '@/lib/api-client';
import {
  adjustProductStock,
  createProduct,
  fetchCategories,
  fetchMyProducts,
  setProductActive,
  updateProduct,
} from '@/lib/api/products';
import {
  fetchManagedSpecies,
  fetchMySeafoodLots,
  fetchMyVendorCompliance,
  fetchMyVendorProfile,
} from '@/lib/api/vendors';
import { useAuth } from '@/lib/auth/auth-context';
import {
  formatEnumLabel,
  getProductImageBadgeKind,
  isCatalogueReferencePhotoUrl,
} from '@/lib/format';

import { CataloguePhotoPicker } from './catalogue-photo-picker';

type PhotoSourceMode = 'url' | 'catalogue';

const SHELLFISH_KEYWORDS = ['shrimp', 'lobster', 'conch', 'crab', 'oyster'];
const SAFE_BUNDLED_PATH = /^\/(?:catalogue-photos|demo-products)\/[a-z0-9-]+\.(?:png|jpg|jpeg|webp)$/i;

function isValidFormImageUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (SAFE_BUNDLED_PATH.test(trimmed)) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function suggestCategoryIdForSpecies(
  species: ManagedSpecies | null,
  categories: CategoryOption[],
  currentCategoryId: string,
): string {
  if (categories.length === 0) {
    return currentCategoryId;
  }
  if (!species) {
    return currentCategoryId || categories[0]!.id;
  }
  const lowerName = species.commercialName.toLowerCase();
  const wantsShellfish = SHELLFISH_KEYWORDS.some((kw) => lowerName.includes(kw));
  const preferred = categories.find((cat) =>
    wantsShellfish
      ? cat.slug.includes('shellfish') || cat.name.toLowerCase().includes('shellfish')
      : cat.slug.includes('fish') || cat.name.toLowerCase().includes('fish'),
  );
  return preferred?.id ?? currentCategoryId ?? categories[0]!.id;
}

export function VendorProductsView(): React.ReactElement {
  const { status: authStatus, user } = useAuth();
  const queryClient = useQueryClient();

  const isVendor = user?.roles.includes(UserRole.VENDOR) ?? false;

  const vendorProfileQuery = useQuery({
    queryKey: ['vendors', 'me'],
    queryFn: fetchMyVendorProfile,
    enabled: authStatus === 'authenticated' && isVendor,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 1,
  });

  const vendorComplianceQuery = useQuery({
    queryKey: ['vendors', 'me', 'compliance'],
    queryFn: fetchMyVendorCompliance,
    enabled: authStatus === 'authenticated' && isVendor && Boolean(vendorProfileQuery.data),
  });

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: fetchCategories,
    enabled: authStatus === 'authenticated' && isVendor,
  });

  const speciesQuery = useQuery({
    queryKey: ['species'],
    queryFn: fetchManagedSpecies,
    enabled: authStatus === 'authenticated' && isVendor,
  });

  const lotsQuery = useQuery({
    queryKey: ['seafood-lots', 'mine'],
    queryFn: () => fetchMySeafoodLots(1, 100),
    enabled: authStatus === 'authenticated' && isVendor,
  });

  const myProductsQuery = useQuery({
    queryKey: ['products', 'mine'],
    queryFn: () => fetchMyProducts(1, 100),
    enabled: authStatus === 'authenticated' && isVendor,
  });

  // Form state
  const [editingProduct, setEditingProduct] = useState<ProductResponse | null>(null);
  const [speciesId, setSpeciesId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [lotId, setLotId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [unit, setUnit] = useState<ProductUnit>(ProductUnit.PER_POUND);
  const [price, setPrice] = useState('');
  const [quantityAvailable, setQuantityAvailable] = useState('10');
  const [weightLbs, setWeightLbs] = useState('');
  const [photoMode, setPhotoMode] = useState<PhotoSourceMode>('url');
  const [imageUrl, setImageUrl] = useState('');
  const [selectedCataloguePhoto, setSelectedCataloguePhoto] =
    useState<CataloguePhotoOption | null>(null);
  const [selectedCataloguePhotoId, setSelectedCataloguePhotoId] = useState<string | null>(null);

  const [formError, setFormError] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);

  if (authStatus === 'loading') {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <p className="text-sm text-gray-600">Loading your vendor product workspace…</p>
      </main>
    );
  }

  if (authStatus === 'unauthenticated' || !user) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>Sign in required</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600">
              Sign in with an approved vendor account to create and edit storefront seafood products.
            </p>
            <Link
              href="/login?next=/vendor/products"
              className="inline-flex h-11 items-center justify-center rounded-button bg-irie-green px-5 text-sm font-medium text-white hover:bg-irie-green/90"
            >
              Sign in as vendor
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (!isVendor) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>Vendor access required</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600">
              This workspace is restricted to approved seafood vendor accounts.
            </p>
            <Link
              href="/account"
              className="inline-flex h-11 items-center justify-center rounded-button border border-gray-300 bg-white px-5 text-sm font-medium text-gray-800 hover:bg-gray-50"
            >
              Return to your account
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  const vendorProfile = vendorProfileQuery.data ?? null;
  const vendorNotFound =
    vendorProfileQuery.isError &&
    vendorProfileQuery.error instanceof ApiError &&
    vendorProfileQuery.error.status === 404;
  const compliance = vendorComplianceQuery.data ?? null;
  const vendorBlockers = getVendorSellingBlockers(
    vendorNotFound ? null : vendorProfile,
    compliance,
  );
  const categories = categoriesQuery.data ?? [];
  const speciesList = speciesQuery.data ?? [];
  const safeLots = (lotsQuery.data?.items ?? []).filter(
    (lot) => lot.foodSafetyStatus === FoodSafetyStatus.SAFE,
  );
  const products = myProductsQuery.data?.items ?? [];

  const selectedSpecies = speciesList.find((sp) => sp.id === speciesId) ?? null;
  const effectiveCategoryId =
    categoryId || suggestCategoryIdForSpecies(selectedSpecies, categories, categories[0]?.id ?? '');
  const isRestrictedSpecies =
    selectedSpecies?.regulatoryStatus === 'RESTRICTED' ||
    selectedSpecies?.regulatoryStatus === 'PROHIBITED';

  function resetToCreateMode(notice?: string): void {
    setEditingProduct(null);
    setSpeciesId('');
    setCategoryId(categories[0]?.id ?? '');
    setLotId('');
    setName('');
    setDescription('');
    setUnit(ProductUnit.PER_POUND);
    setPrice('');
    setQuantityAvailable('10');
    setWeightLbs('');
    setPhotoMode('url');
    setImageUrl('');
    setSelectedCataloguePhoto(null);
    setSelectedCataloguePhotoId(null);
    setFormError(null);
    setFormNotice(notice ?? null);
  }

  function handleEditProduct(product: ProductResponse): void {
    const resolvedSpeciesId =
      product.speciesId ?? product.cataloguePhoto?.speciesId ?? '';
    const usesCataloguePhoto = Boolean(
      product.cataloguePhotoId ||
        product.isCatalogueReferencePhoto ||
        isCatalogueReferencePhotoUrl(product.imageUrl),
    );

    setEditingProduct(product);
    setSpeciesId(resolvedSpeciesId);
    setCategoryId(product.categoryId);
    setLotId(product.lotId ?? '');
    setName(product.name);
    setDescription(product.description);
    setUnit(product.unit);
    setPrice(String(product.price));
    setQuantityAvailable(String(product.quantityAvailable));
    setWeightLbs(product.weightLbs ?? '');
    setPhotoMode(usesCataloguePhoto ? 'catalogue' : 'url');
    setImageUrl(product.imageUrl);
    setSelectedCataloguePhoto(product.cataloguePhoto ?? null);
    setSelectedCataloguePhotoId(product.cataloguePhotoId ?? product.cataloguePhoto?.id ?? null);
    setFormError(null);
    setFormNotice(null);
  }

  function handleSpeciesChange(nextSpeciesId: string): void {
    setSpeciesId(nextSpeciesId);
    const nextSpecies = speciesList.find((sp) => sp.id === nextSpeciesId) ?? null;
    if (!editingProduct?.catalogueItemId) {
      setCategoryId(suggestCategoryIdForSpecies(nextSpecies, categories, categoryId));
    }
    if (selectedCataloguePhoto && selectedCataloguePhoto.speciesId !== nextSpeciesId) {
      setSelectedCataloguePhoto(null);
      setSelectedCataloguePhotoId(null);
      if (photoMode === 'catalogue') {
        setImageUrl('');
      }
    } else if (selectedCataloguePhotoId && nextSpeciesId !== editingProduct?.speciesId) {
      setSelectedCataloguePhotoId(null);
      if (photoMode === 'catalogue') {
        setImageUrl('');
      }
    }
  }

  function handleSelectCataloguePhoto(photo: CataloguePhotoOption): void {
    setSelectedCataloguePhoto(photo);
    setSelectedCataloguePhotoId(photo.id);
    setImageUrl(photo.imageUrl);
    setPhotoMode('catalogue');
    if (!speciesId) {
      setSpeciesId(photo.speciesId);
    }
    setFormError(null);
  }

  async function refreshAllProducts(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ['products', 'mine'] });
    await queryClient.invalidateQueries({ queryKey: ['products'] });
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setFormError(null);
    setFormNotice(null);

    if (vendorBlockers.length > 0) {
      setFormError(vendorBlockers[0]!);
      return;
    }

    if (isRestrictedSpecies && selectedSpecies) {
      setFormError(
        `${selectedSpecies.commercialName} is ${selectedSpecies.regulatoryStatus} under regulatory rules and cannot be listed.`,
      );
      return;
    }

    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const numericPrice = Number(price);
    const numericQty = Number.parseInt(quantityAvailable, 10);
    const numericWeight = weightLbs.trim() ? Number(weightLbs.trim()) : undefined;
    const trimmedUrl = imageUrl.trim();

    if (trimmedName.length < 2) {
      setFormError('Enter a product name of at least 2 characters.');
      return;
    }
    if (trimmedDescription.length < 10) {
      setFormError('Enter a product description of at least 10 characters.');
      return;
    }
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
      setFormError('Enter a valid price greater than 0.');
      return;
    }
    if (!editingProduct && (!Number.isInteger(numericQty) || numericQty < 0)) {
      setFormError('Enter a valid non-negative integer quantity.');
      return;
    }
    if (numericWeight !== undefined && (!Number.isFinite(numericWeight) || numericWeight <= 0)) {
      setFormError('Unit weight in lbs must be greater than 0.');
      return;
    }

    if (photoMode === 'catalogue' && !selectedCataloguePhotoId && !isCatalogueReferencePhotoUrl(trimmedUrl)) {
      setFormError('Preview and select a catalogue reference photo before saving, or switch to Enter photo URL.');
      return;
    }
    if (!isValidFormImageUrl(trimmedUrl)) {
      setFormError('Provide a valid https:// product photo URL or choose a catalogue photo.');
      return;
    }
    if (!editingProduct && !effectiveCategoryId) {
      setFormError('Select a product category before saving.');
      return;
    }

    const usingCataloguePhoto =
      photoMode === 'catalogue'
        ? Boolean(selectedCataloguePhotoId || isCatalogueReferencePhotoUrl(trimmedUrl))
        : false;
    const finalCataloguePhotoId = usingCataloguePhoto ? selectedCataloguePhotoId : null;
    const finalSpeciesId = speciesId || selectedCataloguePhoto?.speciesId || null;

    setIsSaving(true);
    try {
      if (editingProduct) {
        const updated = await updateProduct(editingProduct.id, {
          ...(editingProduct.catalogueItemId ? {} : { categoryId: effectiveCategoryId }),
          ...(lotId ? { lotId } : {}),
          speciesId: finalSpeciesId,
          cataloguePhotoId: finalCataloguePhotoId,
          name: trimmedName,
          description: trimmedDescription,
          unit,
          price: numericPrice,
          imageUrl: trimmedUrl,
          ...(numericWeight !== undefined ? { weightLbs: numericWeight } : {}),
        });
        await refreshAllProducts();
        handleEditProduct(updated);
        setFormNotice(`Saved changes to "${updated.name}".`);
      } else {
        const created = await createProduct({
          categoryId: effectiveCategoryId,
          ...(lotId ? { lotId } : {}),
          ...(finalSpeciesId ? { speciesId: finalSpeciesId } : {}),
          ...(finalCataloguePhotoId ? { cataloguePhotoId: finalCataloguePhotoId } : {}),
          name: trimmedName,
          description: trimmedDescription,
          unit,
          price: numericPrice,
          quantityAvailable: numericQty,
          imageUrl: trimmedUrl,
          ...(numericWeight !== undefined ? { weightLbs: numericWeight } : {}),
        });
        await refreshAllProducts();
        resetToCreateMode(`Created product "${created.name}". Click Edit below to inspect or modify it.`);
      }
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Unable to save product right now. Please try again.',
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleStockDelta(product: ProductResponse, delta: number): Promise<void> {
    setPendingActionId(product.id);
    setFormError(null);
    try {
      const updated = await adjustProductStock(product.id, delta);
      await refreshAllProducts();
      if (editingProduct?.id === updated.id) {
        handleEditProduct(updated);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to adjust stock.');
    } finally {
      setPendingActionId(null);
    }
  }

  async function handleToggleActive(product: ProductResponse): Promise<void> {
    setPendingActionId(product.id);
    setFormError(null);
    try {
      const updated = await setProductActive(product.id, !product.isActive);
      await refreshAllProducts();
      if (editingProduct?.id === updated.id) {
        handleEditProduct(updated);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to update product status.');
    } finally {
      setPendingActionId(null);
    }
  }

  const previewBadgeKind = getProductImageBadgeKind({
    imageUrl,
    cataloguePhotoId: photoMode === 'catalogue' ? selectedCataloguePhotoId : null,
  });

  return (
    <main className="mx-auto w-full max-w-5xl min-w-0 px-4 py-8 space-y-8">
      <div className="flex flex-col gap-4 border-b border-gray-200 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-irie-green">
            Vendor Product Catalogue
          </p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900 sm:text-3xl">
            Standard storefront products
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Create or edit standard seafood products, select species-verified catalogue reference
            photos, or publish daily fresh lots under{' '}
            <Link href="/vendor/daily-listings" className="font-medium text-irie-green underline">
              Catch of the Day
            </Link>
            .
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/vendor/daily-listings"
            className="inline-flex h-11 items-center justify-center rounded-button border border-gray-300 bg-white px-4 text-sm font-medium text-gray-800 hover:bg-gray-50"
          >
            Catch of the Day
          </Link>
          <Button
            type="button"
            variant="primary"
            onClick={() => resetToCreateMode()}
            data-testid="new-standard-product-btn"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New product
          </Button>
        </div>
      </div>

      {vendorBlockers.length > 0 ? (
        <div
          role="alert"
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 flex items-start gap-3"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-medium">Vendor selling requirements pending</p>
            <ul className="list-disc pl-5 text-xs space-y-0.5">
              {vendorBlockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-start">
        <Card className="min-w-0 w-full overflow-hidden">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>
                {editingProduct ? `Edit product · ${editingProduct.name}` : 'Create standard product'}
              </CardTitle>
              {editingProduct ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => resetToCreateMode()}
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Cancel edit
                </Button>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="min-w-0">
            <form className="min-w-0 space-y-5" onSubmit={(e) => void handleSubmit(e)} noValidate>
              <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="min-w-0 space-y-1.5 sm:col-span-2">
                  <label htmlFor="product-species" className="block text-sm font-medium text-gray-800">
                    Seafood species
                  </label>
                  <select
                    id="product-species"
                    value={speciesId}
                    onChange={(e) => handleSpeciesChange(e.target.value)}
                    disabled={isSaving}
                    className="h-11 w-full max-w-full min-w-0 truncate rounded-button border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-irie-green"
                    data-testid="product-species-select"
                  >
                    <option value="">Select a seafood species (recommended)</option>
                    {speciesList.map((sp) => (
                      <option key={sp.id} value={sp.id}>
                        {sp.commercialName} ({sp.scientificName})
                        {sp.regulatoryStatus !== 'UNRESTRICTED' ? ` — ${sp.regulatoryStatus}` : ''}
                      </option>
                    ))}
                  </select>
                  {isRestrictedSpecies && selectedSpecies ? (
                    <p
                      role="alert"
                      className="rounded-md border border-irie-red/30 bg-irie-red/10 px-3 py-2 text-xs font-medium text-irie-red"
                      data-testid="species-restriction-warning"
                    >
                      {selectedSpecies.commercialName} ({selectedSpecies.scientificName}) is{' '}
                      {selectedSpecies.regulatoryStatus} and cannot be listed on the marketplace.
                    </p>
                  ) : null}
                </div>

                <div className="min-w-0 space-y-1.5 sm:col-span-2">
                  <label htmlFor="product-category" className="block text-sm font-medium text-gray-800">
                    Storefront category *
                  </label>
                  <select
                    id="product-category"
                    value={effectiveCategoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                    disabled={isSaving || Boolean(editingProduct?.catalogueItemId)}
                    className="h-11 w-full max-w-full min-w-0 truncate rounded-button border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-irie-green disabled:bg-gray-100"
                    data-testid="product-category-select"
                  >
                    {categories.length === 0 ? (
                      <option value="">Loading categories...</option>
                    ) : (
                      categories.map((cat) => (
                        <option key={cat.id} value={cat.id}>
                          {cat.name}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <div className="min-w-0 space-y-1.5 sm:col-span-2">
                  <label htmlFor="product-name" className="block text-sm font-medium text-gray-800">
                    Product name *
                  </label>
                  <input
                    id="product-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={isSaving}
                    placeholder="e.g., Fresh Whole Red Tilapia"
                    className="h-11 w-full max-w-full min-w-0 rounded-button border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-irie-green"
                  />
                </div>

                <div className="min-w-0 space-y-1.5 sm:col-span-2">
                  <label
                    htmlFor="product-description"
                    className="block text-sm font-medium text-gray-800"
                  >
                    Description *
                  </label>
                  <textarea
                    id="product-description"
                    rows={3}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={isSaving}
                    placeholder="Describe catch source, sizing, preparation, and icing details..."
                    className="w-full max-w-full min-w-0 rounded-button border border-gray-300 bg-white p-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-irie-green"
                  />
                </div>

                <div className="min-w-0 space-y-1.5">
                  <label htmlFor="product-unit" className="block text-sm font-medium text-gray-800">
                    Selling unit *
                  </label>
                  <select
                    id="product-unit"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value as ProductUnit)}
                    disabled={isSaving}
                    className="h-11 w-full max-w-full min-w-0 truncate rounded-button border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-irie-green"
                  >
                    {PRODUCT_UNIT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="min-w-0 space-y-1.5">
                  <label htmlFor="product-price" className="block text-sm font-medium text-gray-800">
                    Price (JMD) *
                  </label>
                  <input
                    id="product-price"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    disabled={isSaving}
                    placeholder="950.00"
                    className="h-11 w-full max-w-full min-w-0 rounded-button border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-irie-green"
                  />
                </div>

                {!editingProduct ? (
                  <div className="min-w-0 space-y-1.5">
                    <label
                      htmlFor="product-quantity"
                      className="block text-sm font-medium text-gray-800"
                    >
                      Quantity available *
                    </label>
                    <input
                      id="product-quantity"
                      type="number"
                      min="0"
                      step="1"
                      value={quantityAvailable}
                      onChange={(e) => setQuantityAvailable(e.target.value)}
                      disabled={isSaving}
                      className="h-11 w-full max-w-full min-w-0 rounded-button border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-irie-green"
                    />
                  </div>
                ) : (
                  <div className="min-w-0 space-y-1.5">
                    <p className="block text-sm font-medium text-gray-800">Current stock</p>
                    <p className="flex min-h-11 items-center rounded-button border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
                      {editingProduct.quantityAvailable} available (adjust from product list)
                    </p>
                  </div>
                )}

                <div className="min-w-0 space-y-1.5">
                  <label htmlFor="product-weight" className="block text-sm font-medium text-gray-800">
                    Unit weight (lbs, optional)
                  </label>
                  <input
                    id="product-weight"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={weightLbs}
                    onChange={(e) => setWeightLbs(e.target.value)}
                    disabled={isSaving}
                    placeholder="1.5"
                    className="h-11 w-full max-w-full min-w-0 rounded-button border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-irie-green"
                  />
                </div>

                <div className="min-w-0 space-y-1.5 sm:col-span-2">
                  <label htmlFor="product-lot" className="block text-sm font-medium text-gray-800">
                    Linked seafood lot (optional)
                  </label>
                  <select
                    id="product-lot"
                    value={lotId}
                    onChange={(e) => setLotId(e.target.value)}
                    disabled={isSaving}
                    className="h-11 w-full max-w-full min-w-0 truncate rounded-button border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-irie-green"
                  >
                    <option value="">No seafood lot linked</option>
                    {safeLots.map((lot) => (
                      <option key={lot.id} value={lot.id}>
                        {lot.lotNumber} · {lot.species}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="min-w-0 space-y-3 border-t border-gray-200 pt-4">
                <div className="min-w-0 space-y-2">
                  <p className="text-sm font-medium text-gray-800">Product photograph *</p>
                  <div
                    role="tablist"
                    aria-label="Product photo source"
                    className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={photoMode === 'url'}
                      onClick={() => {
                        setPhotoMode('url');
                        setFormError(null);
                      }}
                      className={`inline-flex h-11 items-center justify-center gap-2 rounded-button border px-3 text-sm font-medium transition-colors ${
                        photoMode === 'url'
                          ? 'border-irie-green bg-irie-green/10 text-irie-green'
                          : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                      }`}
                      data-testid="photo-mode-url-tab"
                    >
                      <Camera className="h-4 w-4" aria-hidden="true" />
                      Enter photo URL
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={photoMode === 'catalogue'}
                      onClick={() => {
                        setPhotoMode('catalogue');
                        setFormError(null);
                      }}
                      className={`inline-flex h-11 items-center justify-center gap-2 rounded-button border px-3 text-sm font-medium transition-colors ${
                        photoMode === 'catalogue'
                          ? 'border-irie-green bg-irie-green/10 text-irie-green'
                          : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                      }`}
                      data-testid="photo-mode-catalogue-tab"
                    >
                      <ImageIcon className="h-4 w-4" aria-hidden="true" />
                      Choose from catalogue photos
                    </button>
                  </div>
                </div>

                {photoMode === 'url' ? (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <label htmlFor="product-image-url" className="block text-xs font-medium text-gray-700">
                        Hosted product photo URL (https://)
                      </label>
                      <input
                        id="product-image-url"
                        type="url"
                        value={imageUrl}
                        onChange={(e) => {
                          setImageUrl(e.target.value);
                          setSelectedCataloguePhoto(null);
                          setSelectedCataloguePhotoId(null);
                        }}
                        disabled={isSaving}
                        placeholder="https://images.example.com/tilapia-catch.jpg"
                        className="h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-irie-green"
                      />
                    </div>
                    {isValidFormImageUrl(imageUrl) ? (
                      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-medium text-gray-700">Photo preview</span>
                          <ProductPhotoBadge kind={previewBadgeKind} />
                        </div>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={imageUrl.trim()}
                          alt={name.trim() || 'Product preview'}
                          className="max-h-52 w-full rounded-md object-cover sm:max-w-xs"
                        />
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <CataloguePhotoPicker
                    selectedSpecies={selectedSpecies}
                    selectedPhotoId={selectedCataloguePhotoId}
                    selectedImageUrl={imageUrl}
                    initialSelectedPhoto={selectedCataloguePhoto}
                    disabled={isSaving}
                    onSelectPhoto={handleSelectCataloguePhoto}
                    onSwitchToCustomUrl={() => setPhotoMode('url')}
                  />
                )}
              </div>

              {formError ? (
                <div
                  role="alert"
                  className="rounded-lg border border-irie-red/30 bg-irie-red/10 p-3 text-sm text-irie-red"
                  data-testid="product-form-error"
                >
                  {formError}
                </div>
              ) : null}

              {formNotice ? (
                <div
                  role="status"
                  className="rounded-lg border border-irie-green/30 bg-irie-green/10 p-3 text-sm text-irie-green"
                  data-testid="product-form-notice"
                >
                  {formNotice}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-3">
                <Button
                  type="submit"
                  variant="primary"
                  loading={isSaving}
                  disabled={vendorBlockers.length > 0 || isRestrictedSpecies}
                  data-testid="save-product-submit-btn"
                >
                  {editingProduct ? 'Save product changes' : 'Create product'}
                </Button>
                {editingProduct ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => resetToCreateMode()}
                    disabled={isSaving}
                  >
                    Create another product
                  </Button>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>

        <section aria-labelledby="vendor-products-list-heading" className="min-w-0 w-full space-y-4">
          <div className="flex items-center justify-between">
            <h2 id="vendor-products-list-heading" className="text-lg font-semibold text-gray-900">
              Your standard products ({products.length})
            </h2>
          </div>

          {myProductsQuery.isPending ? (
            <Card>
              <CardContent className="p-6 text-sm text-gray-500">
                Loading your storefront products…
              </CardContent>
            </Card>
          ) : myProductsQuery.isError ? (
            <div
              role="alert"
              className="rounded-lg border border-irie-red/30 bg-irie-red/10 p-4 text-sm text-irie-red"
            >
              Unable to load your products right now.
            </div>
          ) : products.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-center text-sm text-gray-600">
                No standard products created yet. Use the form to add your first product.
              </CardContent>
            </Card>
          ) : (
            <ul className="space-y-3" data-testid="vendor-products-list">
              {products.map((product) => {
                const badgeKind = getProductImageBadgeKind(product);
                const isEditing = editingProduct?.id === product.id;
                const isBusy = pendingActionId === product.id;
                return (
                  <li key={product.id} className="min-w-0">
                    <Card
                      className={`min-w-0 overflow-hidden ${
                        isEditing ? 'ring-2 ring-irie-green border-irie-green' : ''
                      }`}
                    >
                      <CardContent className="p-4 space-y-3">
                        <div className="flex gap-3">
                          <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-md bg-gray-100">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={product.imageUrl}
                              alt={product.name}
                              className="h-full w-full object-cover"
                            />
                          </div>
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <h3 className="truncate font-semibold text-gray-900">{product.name}</h3>
                              <Badge
                                variant={
                                  product.availability === ProductAvailability.ACTIVE
                                    ? 'success'
                                    : 'neutral'
                                }
                              >
                                {product.isActive ? formatEnumLabel(product.availability) : 'Inactive'}
                              </Badge>
                            </div>
                            <p className="text-sm font-semibold text-irie-green">
                              {product.currency} ${product.price} / {formatEnumLabel(product.unit).toLowerCase()}
                            </p>
                            <p className="text-xs text-gray-600">
                              {product.quantityAvailable} in stock
                              {product.speciesName ? ` · ${product.speciesName}` : ''}
                            </p>
                            <ProductPhotoBadge kind={badgeKind} />
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => handleEditProduct(product)}
                            data-testid={`edit-product-${product.id}`}
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={isBusy}
                            onClick={() => void handleStockDelta(product, 1)}
                          >
                            +1 stock
                          </Button>
                          {product.quantityAvailable > 0 ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={isBusy}
                              onClick={() => void handleStockDelta(product, -1)}
                            >
                              -1 stock
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={isBusy}
                            onClick={() => void handleToggleActive(product)}
                          >
                            <Power className="h-3.5 w-3.5" aria-hidden="true" />
                            {product.isActive ? 'Deactivate' : 'Reactivate'}
                          </Button>
                          <Link
                            href={`/products/${product.id}`}
                            className="inline-flex items-center px-2 text-xs font-medium text-irie-green hover:underline"
                          >
                            View storefront
                          </Link>
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
