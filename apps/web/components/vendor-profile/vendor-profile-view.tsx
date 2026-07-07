'use client';

import { VendorTierBadge } from '@iriefishmongers/ui';
import Image from 'next/image';
import Link from 'next/link';

import { ApiError } from '@/lib/api-client';
import { formatEnumLabel } from '@/lib/format';
import { useVendorProducts } from '@/lib/hooks/use-vendor-products';
import { useVendorProfile } from '@/lib/hooks/use-vendor-profile';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function VendorProfileView({ vendorId }: { vendorId: string }): React.ReactElement {
  const profile = useVendorProfile(vendorId);
  const products = useVendorProducts(vendorId);

  if (profile.isPending) {
    return <VendorProfileSkeleton />;
  }

  if (profile.isError) {
    const notFound = profile.error instanceof ApiError && profile.error.status === 404;
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="text-lg font-medium text-gray-900">
          {notFound ? 'Vendor not found.' : 'Something went wrong loading this vendor.'}
        </p>
        {!notFound ? (
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() => {
              void profile.refetch();
            }}
          >
            Try again
          </Button>
        ) : null}
      </div>
    );
  }

  const vendor = profile.data;

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-gray-900">{vendor.businessName}</h1>
          <div className="mt-2">
            <VendorTierBadge tier={vendor.tier} badge={vendor.badge} complianceStatus={vendor.foodSafetyStatus} />
          </div>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Overview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-gray-700">
            <DetailRow label="Operating Area" value={formatEnumLabel(vendor.parish)} />
            <DetailRow label="Ratings" value={vendor.rating !== null ? vendor.rating.toFixed(1) : 'Not yet rated'} />
            <DetailRow label="Orders Completed" value={String(vendor.ordersCompleted)} />
            <DetailRow
              label="Compliance Score"
              value={vendor.complianceScore !== null ? String(vendor.complianceScore) : 'Not yet assessed'}
            />
            <DetailRow
              label="Cold Chain Score"
              value={vendor.coldChainScore !== null ? String(vendor.coldChainScore) : 'Not yet assessed'}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Compliance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-gray-700">
            <DetailRow label="Food Safety Status" value={formatEnumLabel(vendor.foodSafetyStatus)} />
            <DetailRow label="Traceability Status" value={formatEnumLabel(vendor.traceabilityStatus)} />
          </CardContent>
        </Card>
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-medium text-gray-900">Products</h2>
        {products.isPending ? (
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {[1, 2, 3, 4].map((key) => (
              <Skeleton key={key} className="aspect-square rounded-card" />
            ))}
          </div>
        ) : null}
        {products.isSuccess && products.data.items.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">This vendor has no active products right now.</p>
        ) : null}
        {products.isSuccess && products.data.items.length > 0 ? (
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {products.data.items.map((product) => (
              <Link
                key={product.id}
                href={`/products/${product.id}`}
                className="block rounded-card border border-gray-200 bg-white p-3 shadow-md hover:shadow-lg"
              >
                <div className="relative aspect-square overflow-hidden rounded-md bg-gray-100">
                  <Image src={product.imageUrl} alt={product.name} fill className="object-cover" />
                </div>
                <p className="mt-2 truncate text-sm font-medium text-gray-900">{product.name}</p>
                <p className="text-sm text-irie-green">
                  {product.currency} ${product.price}
                </p>
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-medium text-gray-900">Recent Reviews</h2>
        {vendor.recentReviews.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">This vendor has no reviews yet.</p>
        ) : null}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-gray-500">{label}</span>
      <span className="text-right text-gray-900">{value}</span>
    </div>
  );
}

function VendorProfileSkeleton(): React.ReactElement {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <Skeleton className="h-9 w-1/3" />
      <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
        <Skeleton className="h-40 rounded-card" />
        <Skeleton className="h-40 rounded-card" />
      </div>
    </div>
  );
}
