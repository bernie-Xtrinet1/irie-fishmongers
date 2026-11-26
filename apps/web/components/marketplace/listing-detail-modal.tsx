'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AvailableTodayItem } from '@iriefishmongers/types';
import {
  AlertCircle,
  Camera,
  Clock,
  MapPin,
  ShieldCheck,
  Store,
  Truck,
  X,
} from 'lucide-react';
import Image from 'next/image';

import { DemoPhotoCreditLine } from '@/components/marketplace/demo-photo-credit';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate, formatEnumLabel, isDemoSamplePhotoUrl } from '@/lib/format';
import { useCatalogueItemListings } from '@/lib/hooks/use-available-today';

export interface ListingDetailModalProps {
  item: AvailableTodayItem | null;
  isOpen: boolean;
  onClose: () => void;
}

export function ListingDetailModal({
  item,
  isOpen,
  onClose,
}: ListingDetailModalProps): React.ReactElement | null {
  const { data: listings, isPending, isError } = useCatalogueItemListings(
    item?.catalogueItemId ?? null,
  );

  // Keyboard navigation: Escape key closes modal
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Selected listing ID within this catalogue item
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);

  // Filter listings to ensure strictly comparable units with the inspected item
  const comparableListings = useMemo(() => {
    if (!listings) return [];
    if (!item?.unit) return listings;
    return listings.filter((l) => l.unit === item.unit);
  }, [listings, item?.unit]);

  // Sorted listing for initial selection (sort by price per unit, then quantity)
  const defaultListing = useMemo(() => {
    if (comparableListings.length === 0) return listings?.[0] ?? null;
    return [...comparableListings].sort((a, b) => {
      const priceA = Number(a.price);
      const priceB = Number(b.price);
      if (priceA !== priceB) return priceA - priceB;
      return b.quantityAvailable - a.quantityAvailable;
    })[0];
  }, [comparableListings, listings]);

  // Current active listing
  const activeListing = useMemo(() => {
    if (!listings || listings.length === 0) return null;
    if (selectedListingId) {
      const found = listings.find((l) => l.id === selectedListingId);
      if (found) return found;
    }
    return defaultListing;
  }, [listings, selectedListingId, defaultListing]);

  if (!isOpen || !item) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-catalogue-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-4xl rounded-2xl bg-white shadow-2xl overflow-hidden my-8 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 bg-gray-50/80">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-ocean-blue">
                {item.categoryName}
              </span>
              <span className="text-xs text-gray-400">•</span>
              <span className="text-xs text-gray-500">Available Today Catch</span>
            </div>
            <h2 id="modal-catalogue-title" className="text-xl font-bold text-gray-900">
              {item.name}
            </h2>
            <p className="text-xs italic text-gray-500">{item.scientificName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-gray-400 hover:bg-gray-200 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-irie-green"
            aria-label="Close details"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {isPending ? (
            <div className="space-y-4">
              <Skeleton className="h-48 w-full rounded-xl" />
              <Skeleton className="h-24 w-full rounded-xl" />
            </div>
          ) : isError ? (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              Failed to load daily vendor listings for this item. Please try again later.
            </div>
          ) : !listings || listings.length === 0 ? (
            <div className="py-8 text-center text-gray-500">
              No active listings currently available for this species today.
            </div>
          ) : (
            <>
              {/* Compare Available Vendors Section Header */}
              <div className="rounded-xl border border-ocean-blue/30 bg-blue-50/50 p-4 transition-all" data-testid="compare-vendors-banner">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                  <div className="space-y-1">
                    <span className="text-xs font-bold uppercase tracking-wider text-ocean-blue">
                      Compare Available Vendors
                    </span>
                    <p className="text-xs text-gray-600">
                      Listing options sorted by price per unit and quantity available for transparent comparison across licensed vendors on an equivalent {formatEnumLabel(item.unit).toLowerCase()} basis.
                    </p>
                  </div>
                  <Badge variant="info" className="text-[11px] self-start sm:self-auto">
                    {comparableListings.length} {comparableListings.length === 1 ? 'seller' : 'sellers'} offering
                  </Badge>
                </div>
              </div>

              {/* "Choose Your Seller" Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-gray-700">
                    Choose Your Seller ({comparableListings.length} {comparableListings.length === 1 ? 'vendor' : 'vendors'} offering {formatEnumLabel(item.unit).toLowerCase()})
                  </h3>
                  <span className="text-xs text-gray-500">Select a seller to inspect details</span>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {comparableListings.map((listing) => {
                    const isSelected = activeListing?.id === listing.id;
                    const hasCatchPhoto = (listing.photos && listing.photos.length > 0) || Boolean(listing.primaryPhoto);
                    const vendorName = listing.vendor?.businessName ?? 'Certified Vendor';
                    const parishName = listing.landingSite?.parish || listing.vendor?.parish || 'Jamaica';

                    return (
                      <button
                        key={listing.id}
                        type="button"
                        onClick={() => setSelectedListingId(listing.id)}
                        className={`text-left rounded-xl border p-4 transition-all focus:outline-none focus:ring-2 focus:ring-irie-green ${
                          isSelected
                            ? 'border-irie-green bg-emerald-50/30 shadow-md ring-1 ring-irie-green'
                            : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-xs'
                        }`}
                        data-testid={`vendor-choice-${listing.id}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Store className="h-4 w-4 text-ocean-blue shrink-0" />
                            <span className="font-semibold text-gray-900 text-sm">
                              {vendorName}
                            </span>
                          </div>
                          {isSelected && (
                            <Badge variant="success" className="text-[10px]">
                              Active Choice
                            </Badge>
                          )}
                        </div>

                        <div className="mt-2 text-xs text-gray-600 space-y-1">
                          <div className="flex items-center gap-1.5">
                            <MapPin className="h-3.5 w-3.5 text-gray-400" />
                            <span>
                              {listing.landingSite?.name
                                ? `${listing.landingSite.name}, `
                                : ''}
                              {formatEnumLabel(parishName)}
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <Clock className="h-3.5 w-3.5 text-gray-400" />
                            <span>Caught {formatDate(listing.catchDate)}</span>
                          </div>
                        </div>

                        <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-2">
                          <div className="text-xs font-bold text-irie-green">
                            JMD ${Number(listing.price).toLocaleString()} /{' '}
                            {formatEnumLabel(listing.unit).toLowerCase()}
                          </div>
                          <span className="text-xs text-gray-500">
                            {listing.quantityAvailable} in stock
                          </span>
                        </div>

                        <div className="mt-2 flex flex-wrap gap-1">
                          {hasCatchPhoto && (
                            <Badge variant="success" className="text-[10px] py-0 px-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200">
                              <Camera className="mr-0.5 h-2.5 w-2.5" /> Catch Photo
                            </Badge>
                          )}
                          {listing.deliveryAvailable && (
                            <Badge variant="neutral" className="text-[10px] py-0 px-1.5">
                              <Truck className="mr-0.5 h-2.5 w-2.5" /> Delivery
                            </Badge>
                          )}
                          {listing.pickupAvailable && (
                            <Badge variant="neutral" className="text-[10px] py-0 px-1.5">
                              Pickup
                            </Badge>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Active Selected Listing Full Inspection */}
              {activeListing && (
                <Card className="border-gray-200 bg-gray-50/50">
                  <CardContent className="p-4 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 pb-3">
                      <div>
                        <h4 className="font-bold text-gray-900 text-sm">
                          Selected Vendor Catch Details
                        </h4>
                        <p className="text-xs text-gray-500">
                          Traceable batch ID: {activeListing.lotId ?? activeListing.id}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 text-xs text-emerald-700 bg-emerald-100/60 rounded-md px-2 py-1">
                        <ShieldCheck className="h-4 w-4" />
                        <span>Regulatory &amp; Food Safety Verified</span>
                      </div>
                    </div>

                    {/* Listing Photographs */}
                    {activeListing.photos && activeListing.photos.length > 0 && (() => {
                      const firstSamplePhotoUrl = activeListing.photos.find((photo) =>
                        isDemoSamplePhotoUrl(photo.url),
                      )?.url;
                      const hasSampleDemoPhoto = Boolean(firstSamplePhotoUrl);
                      return (
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold uppercase text-gray-500 tracking-wider">
                              Actual Vendor Catch Photos
                            </span>
                            {hasSampleDemoPhoto && (
                              <Badge
                                variant="warning"
                                className="bg-amber-600/95 text-white text-[10px]"
                                data-testid="modal-sample-photo-badge"
                              >
                                Sample Photo (Demo)
                              </Badge>
                            )}
                          </div>
                          {hasSampleDemoPhoto && (
                            <div className="mt-1 space-y-1">
                              <p className="text-xs text-amber-800">
                                Sample photo shown for demonstration purposes.
                              </p>
                              <DemoPhotoCreditLine imageUrl={firstSamplePhotoUrl} />
                            </div>
                          )}
                          <div className="mt-2 flex gap-3 overflow-x-auto pb-2">
                            {activeListing.photos.map((photo) => {
                              const isSamplePhoto = isDemoSamplePhotoUrl(photo.url);
                              return (
                                <div
                                  key={photo.id}
                                  className="relative h-28 w-28 shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
                                >
                                  <Image
                                    src={photo.url}
                                    alt={isSamplePhoto ? 'Sample demo catch photo' : 'Actual catch'}
                                    fill
                                    className="object-cover"
                                  />
                                  <div
                                    className={`absolute bottom-0 inset-x-0 px-1 py-0.5 text-[9px] text-white text-center ${
                                      isSamplePhoto ? 'bg-amber-700/90 font-semibold' : 'bg-black/60'
                                    }`}
                                  >
                                    {isSamplePhoto ? 'Sample Photo (Demo)' : "Today's Catch"}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Preparation Options */}
                    {activeListing.preparationOptions && activeListing.preparationOptions.length > 0 && (
                      <div>
                        <span className="text-xs font-semibold uppercase text-gray-500 tracking-wider">
                          Preparation Options Available
                        </span>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {activeListing.preparationOptions.map((prep) => (
                            <Badge
                              key={prep.id || prep.name}
                              variant="neutral"
                              className="text-xs bg-white border border-gray-200"
                            >
                              {prep.name}
                              {prep.pricePerUnit && Number(prep.pricePerUnit) > 0
                                ? ` (+JMD $${Number(prep.pricePerUnit).toLocaleString()})`
                                : ' (Included)'}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Catch Notes */}
                    {(activeListing.description || activeListing.listingTitle) && (
                      <div>
                        <span className="text-xs font-semibold uppercase text-gray-500 tracking-wider">
                          Vendor Catch Notes
                        </span>
                        <p className="mt-1 text-xs text-gray-700 italic bg-white p-2.5 rounded-lg border border-gray-200">
                          &ldquo;{activeListing.description || activeListing.listingTitle}&rdquo;
                        </p>
                      </div>
                    )}

                    {/* Customer-Facing Ordering Availability Notice */}
                    <div
                      className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 space-y-2"
                      data-testid="phase-16d-cutover-notice"
                    >
                      <div className="flex items-start gap-2">
                        <AlertCircle className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
                        <div>
                          <p className="font-bold">
                            Ordering Notice
                          </p>
                          <p className="mt-0.5 text-amber-800">
                            Online ordering for today&apos;s catch is coming soon. You can currently browse available seafood and compare participating vendors. Secure ordering will be introduced once inventory reservation and checkout protections have been completed and approved.
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Disabled Add to Cart Action */}
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
                      <div className="text-xs text-gray-500">
                        Price: <span className="text-sm font-bold text-gray-900">
                          JMD ${Number(activeListing.price).toLocaleString()}
                        </span> / {formatEnumLabel(activeListing.unit).toLowerCase()}
                      </div>
                      <Button
                        type="button"
                        variant="primary"
                        disabled
                        className="w-full sm:w-auto opacity-60 cursor-not-allowed"
                        data-testid="add-to-cart-disabled-btn"
                        title="Ordering available once inventory reservation and checkout protections are approved"
                      >
                        Add to Cart (Coming Soon)
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div className="border-t border-gray-200 px-6 py-3 bg-gray-50 flex justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
