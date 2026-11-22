'use client';

import type { AvailableTodayItem } from '@iriefishmongers/types';
import { Camera, Fish, Store } from 'lucide-react';
import Image from 'next/image';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatEnumLabel, isDemoSamplePhotoUrl } from '@/lib/format';

export interface AvailableTodayCardProps {
  item: AvailableTodayItem;
  onSelect: (item: AvailableTodayItem) => void;
}

export function formatPriceRange(item: AvailableTodayItem): string {
  const min = Number(item.minPrice).toLocaleString('en-JM', { minimumFractionDigits: 0 });
  const max = Number(item.maxPrice).toLocaleString('en-JM', { minimumFractionDigits: 0 });
  const unitStr = formatEnumLabel(item.unit).toLowerCase();

  if (item.minPrice === item.maxPrice) {
    return `JMD $${min} / ${unitStr}`;
  }
  return `JMD $${min} – $${max} / ${unitStr}`;
}

export function AvailableTodayCard({
  item,
  onSelect,
}: AvailableTodayCardProps): React.ReactElement {
  // Determine if there is an actual vendor catch photograph or catalogue reference image
  const actualCatchPhoto =
    item.listingsPreview?.find((l) => l.primaryPhoto)?.primaryPhoto?.url ||
    item.listingsPreview?.flatMap((l) => l.photos || [])[0]?.url;

  const displayImageUrl = actualCatchPhoto || item.referenceImageUrl;
  const isActualCatchPhoto = Boolean(actualCatchPhoto);
  const isDemoSamplePhoto = isDemoSamplePhotoUrl(displayImageUrl);

  return (
    <Card className="flex h-full flex-col overflow-hidden transition-all duration-200 hover:shadow-lg focus-within:ring-2 focus-within:ring-irie-green">
      {/* Photograph Container */}
      <div className="relative aspect-video w-full bg-gray-100 sm:aspect-square">
        {displayImageUrl ? (
          <Image
            src={displayImageUrl}
            alt={item.name}
            fill
            className="object-cover"
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gray-100 text-gray-400">
            <Fish className="h-16 w-16 stroke-1" aria-hidden="true" />
          </div>
        )}

        {/* Photo Attribution Badge: Sample Demo Photo vs Today's Catch vs Catalogue Reference */}
        <div className="absolute left-2.5 top-2.5 flex flex-col gap-1">
          {isDemoSamplePhoto ? (
            <Badge
              variant="warning"
              className="bg-amber-600/95 text-white backdrop-blur-xs shadow-xs"
              data-testid="sample-demo-photo-badge"
            >
              <Camera className="mr-1 h-3 w-3" aria-hidden="true" />
              Sample Photo (Demo)
            </Badge>
          ) : isActualCatchPhoto ? (
            <Badge
              variant="success"
              className="bg-emerald-700/90 text-white backdrop-blur-xs shadow-xs"
              data-testid="actual-catch-badge"
            >
              <Camera className="mr-1 h-3 w-3" aria-hidden="true" />
              Today&apos;s Catch Photo
            </Badge>
          ) : (
            <Badge
              variant="neutral"
              className="bg-gray-800/80 text-white backdrop-blur-xs shadow-xs"
              data-testid="reference-photo-badge"
            >
              Catalogue Reference
            </Badge>
          )}

          {item.hasPreparationOptions && (
            <Badge
              variant="info"
              className="bg-blue-600/90 text-white backdrop-blur-xs shadow-xs"
            >
              Prep Available
            </Badge>
          )}
        </div>
      </div>

      {/* Card Details */}
      <CardContent className="flex flex-1 flex-col justify-between p-4">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-ocean-blue">
              {item.categoryName}
            </span>
            <span className="flex items-center gap-1 text-xs text-gray-500">
              <Store className="h-3.5 w-3.5" aria-hidden="true" />
              {item.sellerCount === 1 ? '1 vendor' : `${item.sellerCount} vendors`}
            </span>
          </div>

          <h3 className="line-clamp-1 font-semibold text-gray-900">{item.name}</h3>
          <p className="line-clamp-1 text-xs italic text-gray-500">{item.scientificName}</p>

          <p className="mt-2 text-base font-bold text-irie-green" data-testid="price-range">
            {formatPriceRange(item)}
          </p>

          <p className="text-xs text-gray-600">
            <span className="font-medium text-gray-900">{item.totalQuantityAvailable}</span>{' '}
            {formatEnumLabel(item.unit).toLowerCase()} in stock today
          </p>
        </div>

        <div className="mt-4 pt-3 border-t border-gray-100">
          <Button
            type="button"
            variant="secondary"
            className="w-full text-xs font-medium"
            onClick={() => onSelect(item)}
            data-testid="view-sellers-button"
          >
            Choose Seller &amp; View Details
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
