'use client';

import { Parish, ProductAvailability, type ProductDetail } from '@iriefishmongers/types';
import { VendorTierBadge } from '@iriefishmongers/ui';
import { useMutation } from '@tanstack/react-query';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';

import { ApiError } from '@/lib/api-client';
import { addCartItem } from '@/lib/api/cart';
import { resolveBestVendor } from '@/lib/api/marketplace';
import { formatDate, formatEnumLabel } from '@/lib/format';
import { useProductDetail } from '@/lib/hooks/use-product-detail';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

type PurchaseOption = 'CHOOSE_VENDOR' | 'BEST_AVAILABLE_VENDOR';

interface PurchaseResult {
  bestAvailable: boolean;
  badge: string | null;
}

export function ProductDetailView({ productId }: { productId: string }): React.ReactElement {
  const { data, isPending, isError, error, refetch } = useProductDetail(productId);
  const [quantity, setQuantity] = useState(1);
  const [purchaseOption, setPurchaseOption] = useState<PurchaseOption>('CHOOSE_VENDOR');
  const [deliveryParish, setDeliveryParish] = useState<Parish | ''>('');

  const purchase = useMutation({
    mutationFn: async (): Promise<PurchaseResult> => {
      if (purchaseOption === 'BEST_AVAILABLE_VENDOR' && deliveryParish) {
        const resolution = await resolveBestVendor({ productId, quantity, deliveryParish });
        await addCartItem({ productId: resolution.productId, quantity });
        return { bestAvailable: true, badge: resolution.badge };
      }
      await addCartItem({ productId, quantity });
      return { bestAvailable: false, badge: null };
    },
  });

  if (isPending) {
    return <ProductDetailSkeleton />;
  }

  if (isError) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="text-lg font-medium text-gray-900">
          {notFound ? 'Product not found.' : 'Something went wrong loading this product.'}
        </p>
        {!notFound ? (
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() => {
              void refetch();
            }}
          >
            Try again
          </Button>
        ) : null}
      </div>
    );
  }

  const product = data;
  const purchaseDisabled = purchaseOption === 'BEST_AVAILABLE_VENDOR' && !deliveryParish;

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
        <div className="relative aspect-square overflow-hidden rounded-card bg-gray-100">
          <Image src={product.imageUrl} alt={product.name} fill className="object-cover" />
        </div>

        <div>
          <h1 className="text-3xl font-semibold text-gray-900">{product.name}</h1>
          {product.lot ? <p className="mt-1 text-gray-500">{product.lot.species}</p> : null}
          <p className="mt-4 text-2xl font-semibold text-irie-green">
            {product.currency} ${product.price}
          </p>
          <p className="mt-1 text-sm text-gray-500">
            {product.quantityAvailable} {unitLabel(product.unit)} available
          </p>

          <div className="mt-6 flex items-center gap-3">
            <label htmlFor="quantity" className="text-sm font-medium text-gray-700">
              Quantity
            </label>
            <input
              id="quantity"
              type="number"
              min={1}
              max={product.quantityAvailable}
              value={quantity}
              onChange={(event) => setQuantity(Number(event.target.value))}
              className="w-20 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>

          <PurchaseOptions
            marketplaceModes={product.marketplaceModes}
            selected={purchaseOption}
            onSelect={setPurchaseOption}
            deliveryParish={deliveryParish}
            onSelectParish={setDeliveryParish}
          />

          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              onClick={() => purchase.mutate()}
              loading={purchase.isPending}
              disabled={purchaseDisabled}
            >
              Add To Cart
            </Button>
            <Button
              variant="secondary"
              onClick={() => purchase.mutate()}
              loading={purchase.isPending}
              disabled={purchaseDisabled}
            >
              Buy Now
            </Button>
            <Button variant="ghost" disabled title="Saved products are coming soon">
              Save Product
            </Button>
            <Link href={`/vendors/${product.vendor.id}`}>
              <Button variant="secondary">View Vendor Profile</Button>
            </Link>
          </div>

          {purchase.isSuccess ? (
            <p className="mt-3 text-sm text-irie-green">
              {purchase.data.bestAvailable
                ? `Fulfilled by Irie Fishmongers (${purchase.data.badge}). Added to your cart.`
                : 'Added to your cart.'}
            </p>
          ) : null}
          {purchase.isError ? (
            <p className="mt-3 text-sm text-irie-red">{purchaseErrorMessage(purchase.error)}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2">
        <ProductInformationCard product={product} />
        <TraceabilityCard product={product} />
        <FoodSafetyCard product={product} />
        <VendorInformationCard product={product} />
      </div>
    </div>
  );
}

function ProductInformationCard({ product }: { product: ProductDetail }): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Product Information</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm text-gray-700">
        <DetailRow label="Description" value={product.description} />
        <DetailRow label="Species" value={product.lot?.species ?? 'Not recorded'} />
        <DetailRow label="Unit Price" value={`${product.currency} $${product.price}`} />
        <DetailRow label="Available Quantity" value={String(product.quantityAvailable)} />
        <DetailRow
          label="Catch Date"
          value={product.lot ? formatDate(product.lot.catchDate) : 'Not recorded'}
        />
        <DetailRow
          label="Freshness Grade"
          value={product.lot?.freshnessGrade ? formatEnumLabel(product.lot.freshnessGrade) : 'Not graded'}
        />
        <DetailRow
          label="Quality & Freshness Score"
          value={formatQualityFreshness(product.lot)}
        />
      </CardContent>
    </Card>
  );
}

// The "Freshness Score" the customer-facing spec calls for is
// SeafoodLot.qualityScore (0-100, set by a QualityInspection). It's shown
// together with its grade and inspection date so the number is never a
// bare, undated figure that could read as current when it's actually old.
function formatQualityFreshness(lot: ProductDetail['lot']): string {
  if (!lot || lot.qualityScore === null) {
    return 'Not scored';
  }
  const parts = [`${lot.qualityScore}/100`];
  if (lot.freshnessGrade) {
    parts.push(`Grade ${formatEnumLabel(lot.freshnessGrade).replace(/^Grade /, '')}`);
  }
  if (lot.lastInspectedAt) {
    parts.push(`Inspected ${formatDate(lot.lastInspectedAt)}`);
  }
  return parts.join(' · ');
}

function TraceabilityCard({ product }: { product: ProductDetail }): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Traceability Information</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm text-gray-700">
        {product.lot ? (
          <>
            <DetailRow label="Catch Location" value={product.lot.catchLocation ?? 'Not recorded'} />
            <DetailRow label="Landing Site" value={product.lot.landingSite ?? 'Not recorded'} />
            <DetailRow label="Catch Method" value="Not recorded" />
            <DetailRow label="Catch Date" value={formatDate(product.lot.catchDate)} />
            <DetailRow label="Batch Number" value={product.lot.lotNumber} />
            <DetailRow label="Vendor" value={product.lot.vendorBusinessName} />
          </>
        ) : (
          <p className="text-gray-500">No traceability information is available for this product.</p>
        )}
      </CardContent>
    </Card>
  );
}

function FoodSafetyCard({ product }: { product: ProductDetail }): React.ReactElement {
  const onHold = product.availability === ProductAvailability.ON_HOLD;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Food Safety Information</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm text-gray-700">
        <DetailRow
          label="Cold Chain Status"
          value={
            product.lot ? (product.lot.temperatureVerified ? 'Verified' : 'Not Verified') : 'Not applicable'
          }
        />
        <DetailRow
          label="Temperature Compliance"
          value={
            product.lot ? (product.lot.temperatureVerified ? 'Compliant' : 'Non-compliant') : 'Not applicable'
          }
        />
        <DetailRow
          label="Food Safety Status"
          value={onHold ? 'On Hold - Under Review' : 'Cleared for Sale'}
        />
      </CardContent>
    </Card>
  );
}

function VendorInformationCard({ product }: { product: ProductDetail }): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Vendor Information</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-gray-700">
        <div className="flex items-center justify-between">
          <span className="font-medium text-gray-900">{product.vendor.businessName}</span>
          <VendorTierBadge
            tier={product.vendor.tier}
            badge={product.vendor.badge}
            complianceStatus={product.vendor.complianceStatus}
          />
        </div>
        <DetailRow label="Vendor Rating" value="Not yet rated" />
        <DetailRow label="Vendor Location" value={formatEnumLabel(product.vendor.parish)} />
        <DetailRow label="Compliance Status" value={formatEnumLabel(product.vendor.complianceStatus)} />
        <Link href={`/vendors/${product.vendor.id}`}>
          <Button variant="secondary" size="sm" className="mt-2">
            View Vendor Profile
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

function PurchaseOptions({
  marketplaceModes,
  selected,
  onSelect,
  deliveryParish,
  onSelectParish,
}: {
  marketplaceModes: { customerSelectedEnabled: boolean; bestAvailableEnabled: boolean };
  selected: PurchaseOption;
  onSelect: (option: PurchaseOption) => void;
  deliveryParish: Parish | '';
  onSelectParish: (parish: Parish | '') => void;
}): React.ReactElement | null {
  if (!marketplaceModes.customerSelectedEnabled && !marketplaceModes.bestAvailableEnabled) {
    return null;
  }

  return (
    <fieldset className="mt-6 space-y-3">
      <legend className="text-sm font-medium text-gray-700">Purchase Options</legend>
      {marketplaceModes.customerSelectedEnabled ? (
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="radio"
            name="purchase-option"
            checked={selected === 'CHOOSE_VENDOR'}
            onChange={() => onSelect('CHOOSE_VENDOR')}
          />
          Choose Vendor
        </label>
      ) : null}
      {marketplaceModes.bestAvailableEnabled ? (
        <div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="radio"
              name="purchase-option"
              checked={selected === 'BEST_AVAILABLE_VENDOR'}
              onChange={() => onSelect('BEST_AVAILABLE_VENDOR')}
            />
            Best Available Vendor
          </label>
          <p className="ml-6 mt-1 text-xs text-gray-500">
            Vendor selected based on availability, freshness, compliance, and delivery capacity.
          </p>
          {selected === 'BEST_AVAILABLE_VENDOR' ? (
            <div className="ml-6 mt-2">
              <label htmlFor="delivery-parish" className="text-xs font-medium text-gray-700">
                Delivery Parish
              </label>
              <select
                id="delivery-parish"
                value={deliveryParish}
                onChange={(event) => onSelectParish(event.target.value as Parish | '')}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              >
                <option value="">Select a parish</option>
                {Object.values(Parish).map((parish) => (
                  <option key={parish} value={parish}>
                    {formatEnumLabel(parish)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

function purchaseErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return 'Please sign in to add items to your cart.';
    }
    if (error.status === 403) {
      return 'Best Available Vendor is not currently available.';
    }
    if (error.status === 404) {
      return 'No vendor is currently able to fulfill this request.';
    }
  }
  return 'Something went wrong. Please try again.';
}

function DetailRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-gray-500">{label}</span>
      <span className="text-right text-gray-900">{value}</span>
    </div>
  );
}

function ProductDetailSkeleton(): React.ReactElement {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
        <Skeleton className="aspect-square rounded-card" />
        <div className="space-y-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </div>
  );
}

function unitLabel(unit: string): string {
  switch (unit) {
    case 'PER_POUND':
      return 'lb';
    case 'PER_KILOGRAM':
      return 'kg';
    case 'PER_PACKAGE':
      return 'packages';
    default:
      return 'items';
  }
}
