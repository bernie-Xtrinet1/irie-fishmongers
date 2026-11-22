import {
  ListingLifecycleStatus,
  ListingPhotoModerationStatus,
  ProductUnit,
  type AvailableTodayItem,
} from '@iriefishmongers/types';
import { fireEvent, render, screen } from '@testing-library/react';

import { AvailableTodayCard, formatPriceRange } from './available-today-card';

const mockItem: AvailableTodayItem = {
  catalogueItemId: 'cat-1',
  name: 'Snook (Robalo)',
  commonName: 'Snook',
  scientificName: 'Centropomus undecimalis',
  categoryId: 'cat-fish',
  categoryName: 'FISH',
  referenceImageUrl: 'https://placehold.co/600x400',
  totalQuantityAvailable: 85,
  unit: ProductUnit.PER_POUND,
  sellerCount: 3,
  minPrice: 1200,
  maxPrice: 1500,
  currency: 'JMD',
  earliestCatchDate: '2026-10-19T06:00:00.000Z',
  activeListingsCount: 3,
  hasPreparationOptions: true,
  deliveryAvailable: true,
  pickupAvailable: true,
  parishes: ['KINGSTON'],
  listingsPreview: [
    {
      id: 'listing-1',
      vendorId: 'vendor-1',
      productId: 'prod-1',
      catalogueItemId: 'cat-1',
      lotId: 'lot-1',
      landingSiteId: null,
      listingTitle: null,
      description: null,
      catchDate: '2026-10-19T06:00:00.000Z',
      availableFrom: '2026-10-19T06:00:00.000Z',
      expiresAt: '2026-10-20T06:00:00.000Z',
      unit: ProductUnit.PER_POUND,
      price: 1200,
      currency: 'JMD',
      quantityUploaded: 50,
      quantityAvailable: 50,
      quantityReserved: 0,
      quantitySold: 0,
      deliveryAvailable: true,
      pickupAvailable: true,
      status: ListingLifecycleStatus.PUBLISHED,
      derivedStatus: 'PUBLISHED',
      publishedAt: '2026-10-19T06:00:00.000Z',
      withdrawnAt: null,
      withdrawnReason: null,
      suspendedAt: null,
      suspensionReason: null,
      createdAt: '2026-10-19T06:00:00.000Z',
      updatedAt: '2026-10-19T06:00:00.000Z',
      primaryPhoto: {
        id: 'photo-1',
        vendorDailyListingId: 'listing-1',
        url: 'https://placehold.co/400x300',
        caption: 'Actual catch',
        isPrimary: true,
        moderationStatus: ListingPhotoModerationStatus.APPROVED,
        uploadedAt: '2026-10-19T06:00:00.000Z',
        captureDate: null,
        withdrawnAt: null,
        withdrawnReason: null,
        createdAt: '2026-10-19T06:00:00.000Z',
        updatedAt: '2026-10-19T06:00:00.000Z',
      },
      photos: [],
      speciesDeclarations: [],
    },
  ],
};

describe('AvailableTodayCard', () => {
  it('formats single price and price range accurately', () => {
    expect(formatPriceRange(mockItem)).toBe('JMD $1,200 – $1,500 / per pound');
    expect(formatPriceRange({ ...mockItem, minPrice: 1200, maxPrice: 1200 })).toBe(
      'JMD $1,200 / per pound',
    );
  });

  it('renders card with actual catch photo badge and custom prep badge', () => {
    const handleSelect = jest.fn();
    render(<AvailableTodayCard item={mockItem} onSelect={handleSelect} />);

    expect(screen.getByText('Snook (Robalo)')).toBeInTheDocument();
    expect(screen.getByText('Centropomus undecimalis')).toBeInTheDocument();
    expect(screen.getByText('FISH')).toBeInTheDocument();
    expect(screen.getByText('3 vendors')).toBeInTheDocument();
    expect(screen.getByTestId('actual-catch-badge')).toHaveTextContent(/Today's Catch Photo/i);
    expect(screen.getByText('Prep Available')).toBeInTheDocument();
    expect(screen.getByTestId('price-range')).toHaveTextContent('JMD $1,200 – $1,500 / per pound');

    fireEvent.click(screen.getByTestId('view-sellers-button'));
    expect(handleSelect).toHaveBeenCalledWith(mockItem);
  });

  it('renders catalogue reference badge when photo is not actual catch', () => {
    const itemWithoutActualPhoto: AvailableTodayItem = {
      ...mockItem,
      sellerCount: 1,
      listingsPreview: [],
    };

    render(<AvailableTodayCard item={itemWithoutActualPhoto} onSelect={jest.fn()} />);

    expect(screen.getByTestId('reference-photo-badge')).toHaveTextContent(/Catalogue Reference/i);
    expect(screen.getByText('1 vendor')).toBeInTheDocument();
  });

  it('labels bundled /demo-products/ images explicitly as a Sample Photo (Demo)', () => {
    const firstListing = mockItem.listingsPreview[0]!;
    const demoItem: AvailableTodayItem = {
      ...mockItem,
      listingsPreview: [
        {
          ...firstListing,
          primaryPhoto: {
            ...firstListing.primaryPhoto!,
            url: 'https://ca-irie-web.agreeablerock-458effa7.eastus2.azurecontainerapps.io/demo-products/red-snapper.png',
          },
        },
      ],
    };

    render(<AvailableTodayCard item={demoItem} onSelect={jest.fn()} />);

    expect(screen.getByTestId('sample-demo-photo-badge')).toHaveTextContent(/Sample Photo \(Demo\)/i);
    expect(screen.queryByTestId('actual-catch-badge')).not.toBeInTheDocument();
  });
});
