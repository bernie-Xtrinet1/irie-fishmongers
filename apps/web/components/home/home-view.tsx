'use client';

import { useId, useState } from 'react';
import {
  Parish,
  ProductAvailability,
  type AvailableTodayItem,
  type ProductResponse,
} from '@iriefishmongers/types';
import { Fish, MapPin, Search, Truck, X } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';

import { AvailableTodayCard } from '@/components/marketplace/available-today-card';
import { ListingDetailModal } from '@/components/marketplace/listing-detail-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatEnumLabel, isDemoSamplePhotoUrl } from '@/lib/format';
import { useAvailableToday } from '@/lib/hooks/use-available-today';
import { useProducts } from '@/lib/hooks/use-products';

import { SeafoodShowcase } from './seafood-showcase';

function formatPrice(product: ProductResponse): string {
  const amount = Number(product.price).toLocaleString('en-JM', { minimumFractionDigits: 0 });
  return `${product.currency} $${amount} / ${formatEnumLabel(product.unit).toLowerCase()}`;
}

function ProductCard({ product }: { product: ProductResponse }): React.ReactElement {
  const outOfStock = product.availability !== ProductAvailability.ACTIVE;
  const isSamplePhoto = isDemoSamplePhotoUrl(product.imageUrl);
  return (
    <Link href={`/products/${product.id}`} className="group focus:outline-none">
      <Card className="h-full overflow-hidden transition-shadow group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-irie-green">
        <div className="relative aspect-square bg-gray-100">
          <Image
            src={product.imageUrl}
            alt={product.name}
            fill
            className="object-cover"
            sizes="(max-width: 768px) 50vw, 25vw"
          />
          {isSamplePhoto ? (
            <Badge
              variant="warning"
              className="absolute left-2 top-2 bg-amber-600/95 text-white shadow-xs"
            >
              Sample Photo (Demo)
            </Badge>
          ) : null}
        </div>
        <CardContent className="space-y-1 p-4">
          <h2 className="line-clamp-1 font-medium text-gray-900">{product.name}</h2>
          <p className="text-sm font-semibold text-irie-green">{formatPrice(product)}</p>
          {outOfStock ? (
            <Badge variant="danger">Out of stock</Badge>
          ) : (
            <p className="text-xs text-gray-500">{product.quantityAvailable} available</p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

export function HomeView(): React.ReactElement {
  const searchInputId = useId();
  const parishSelectId = useId();

  // Available-Today discovery filters
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedParish, setSelectedParish] = useState<string>('');
  const [deliveryOnly, setDeliveryOnly] = useState(false);
  const [prepOnly, setPrepOnly] = useState(false);

  // Modal inspection state
  const [inspectedItem, setInspectedItem] = useState<AvailableTodayItem | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Available Today marketplace query
  const availableTodayQuery = useAvailableToday({
    search: searchTerm || undefined,
    parish: selectedParish ? (selectedParish as Parish) : undefined,
    deliveryAvailable: deliveryOnly ? true : undefined,
    hasPreparationOptions: prepOnly ? true : undefined,
  });

  // Legacy/Standard product catalog query
  const productsQuery = useProducts();

  const handleOpenDetail = (item: AvailableTodayItem): void => {
    setInspectedItem(item);
    setIsModalOpen(true);
  };

  const handleCloseDetail = (): void => {
    setIsModalOpen(false);
    setInspectedItem(null);
  };

  const hasActiveFilters = Boolean(searchTerm || selectedParish || deliveryOnly || prepOnly);

  const resetFilters = (): void => {
    setSearchTerm('');
    setSelectedParish('');
    setDeliveryOnly(false);
    setPrepOnly(false);
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 space-y-12">
      <SeafoodShowcase />

      {/* Available Today Discovery Subsystem */}
      <section id="available-today" aria-labelledby="available-today-heading" className="space-y-6">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-gray-200 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <h2
                id="available-today-heading"
                className="text-2xl font-bold text-gray-900 flex items-center gap-2"
              >
                Available Today
                <Badge variant="success" className="text-xs">
                  Live Catch
                </Badge>
              </h2>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              Aggregated daily listings from Jamaican vendors, verified for regulatory compliance and
              traceability.
            </p>
          </div>

          {/* Active Filter Badges */}
          {hasActiveFilters && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              className="text-xs text-gray-500 hover:text-gray-900 self-start md:self-auto"
            >
              <X className="mr-1 h-3.5 w-3.5" /> Clear filters
            </Button>
          )}
        </div>

        {/* Discovery Filter Controls */}
        <div className="grid gap-3 rounded-xl bg-gray-50 p-4 border border-gray-200 sm:grid-cols-2 lg:grid-cols-4">
          {/* Keyword Search */}
          <div className="relative">
            <label htmlFor={searchInputId} className="sr-only">
              Search seafood
            </label>
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              id={searchInputId}
              type="text"
              placeholder="Search snapper, lobster, shrimp..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white pl-9 pr-3 py-2 text-xs text-gray-900 placeholder-gray-400 focus:border-irie-green focus:outline-none focus:ring-1 focus:ring-irie-green"
              data-testid="marketplace-search-input"
            />
          </div>

          {/* Parish Filter */}
          <div className="relative">
            <label htmlFor={parishSelectId} className="sr-only">
              Filter by Parish
            </label>
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
            <select
              id={parishSelectId}
              value={selectedParish}
              onChange={(e) => setSelectedParish(e.target.value)}
              className="w-full appearance-none rounded-lg border border-gray-300 bg-white pl-9 pr-8 py-2 text-xs text-gray-900 focus:border-irie-green focus:outline-none focus:ring-1 focus:ring-irie-green"
              data-testid="parish-filter-select"
            >
              <option value="">All Parishes (Islandwide)</option>
              {Object.values(Parish).map((p) => (
                <option key={p} value={p}>
                  {formatEnumLabel(p)}
                </option>
              ))}
            </select>
          </div>

          {/* Delivery Available Toggle */}
          <label className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs text-gray-700 cursor-pointer hover:bg-gray-50">
            <input
              type="checkbox"
              checked={deliveryOnly}
              onChange={(e) => setDeliveryOnly(e.target.checked)}
              className="rounded text-irie-green focus:ring-irie-green"
              data-testid="delivery-filter-checkbox"
            />
            <Truck className="h-3.5 w-3.5 text-gray-500" />
            <span>Delivery available</span>
          </label>

          {/* Preparation Options Toggle */}
          <label className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs text-gray-700 cursor-pointer hover:bg-gray-50">
            <input
              type="checkbox"
              checked={prepOnly}
              onChange={(e) => setPrepOnly(e.target.checked)}
              className="rounded text-irie-green focus:ring-irie-green"
              data-testid="prep-filter-checkbox"
            />
            <Fish className="h-3.5 w-3.5 text-gray-500" />
            <span>Custom prep available</span>
          </label>
        </div>

        {/* Available Today Results */}
        {availableTodayQuery.isPending ? (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="aspect-[4/3] rounded-xl" />
            ))}
          </div>
        ) : availableTodayQuery.isError ? (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-800">
            Unable to load Available Today marketplace. Please refresh or try again shortly.
          </div>
        ) : availableTodayQuery.data?.items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-gray-500">
            <Fish className="mx-auto h-8 w-8 text-gray-400 stroke-1" />
            <p className="mt-2 text-sm font-medium text-gray-700">No active seafood listings matching your filters today.</p>
            <p className="text-xs text-gray-400">Try adjusting your search criteria or parish selection.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3" data-testid="available-today-grid">
            {availableTodayQuery.data?.items.map((item) => (
              <AvailableTodayCard
                key={item.catalogueItemId}
                item={item}
                onSelect={handleOpenDetail}
              />
            ))}
          </div>
        )}
      </section>

      {/* Detail Inspection Modal with Choose Your Seller & Best Available Vendor */}
      <ListingDetailModal
        item={inspectedItem}
        isOpen={isModalOpen}
        onClose={handleCloseDetail}
      />

      {/* Standard Product Catalog Section (Maintains Backward Compatibility) */}
      <section aria-labelledby="standard-catalog-heading" className="space-y-6 pt-6 border-t border-gray-200">
        <div>
          <h2 id="standard-catalog-heading" className="text-xl font-bold text-gray-900">
            Fresh catch &amp; Seafood Catalog
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Explore products available across participating Jamaican suppliers.
          </p>
        </div>

        {productsQuery.isPending ? (
          <div className="grid grid-cols-2 gap-6 md:grid-cols-3 lg:grid-cols-4" aria-hidden>
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="aspect-[3/4] rounded-card" />
            ))}
          </div>
        ) : productsQuery.isError ? (
          <p role="alert" className="py-12 text-center text-lg text-irie-red">
            We couldn&apos;t load the catalog. Please try again shortly.
          </p>
        ) : productsQuery.data?.items.length === 0 ? (
          <p className="py-12 text-center text-lg text-gray-500">
            No products are available right now.
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-6 md:grid-cols-3 lg:grid-cols-4">
            {productsQuery.data?.items.map((product) => (
              <li key={product.id}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
