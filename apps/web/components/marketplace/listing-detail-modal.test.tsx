import {
  ListingLifecycleStatus,
  ListingPhotoModerationStatus,
  ProductUnit,
  type AvailableTodayItem,
  type DailyListingResponse,
} from '@iriefishmongers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { useCatalogueItemListings } from '@/lib/hooks/use-available-today';

import { ListingDetailModal } from './listing-detail-modal';

jest.mock('@/lib/hooks/use-available-today');

const mockUseCatalogueItemListings = useCatalogueItemListings as jest.MockedFunction<
  typeof useCatalogueItemListings
>;

const mockItem: AvailableTodayItem = {
  catalogueItemId: 'cat-snook',
  name: 'Snook (Robalo)',
  commonName: 'Snook',
  scientificName: 'Centropomus undecimalis',
  categoryId: 'cat-fish',
  categoryName: 'FISH',
  referenceImageUrl: 'https://placehold.co/600x400',
  totalQuantityAvailable: 85,
  unit: ProductUnit.PER_POUND,
  sellerCount: 2,
  minPrice: 1200,
  maxPrice: 1500,
  currency: 'JMD',
  earliestCatchDate: '2026-10-19T06:00:00.000Z',
  activeListingsCount: 2,
  hasPreparationOptions: true,
  deliveryAvailable: true,
  pickupAvailable: true,
  parishes: ['KINGSTON', 'WESTMORELAND'],
  listingsPreview: [],
};

const mockListings: DailyListingResponse[] = [
  {
    id: 'listing-1',
    vendorId: 'vendor-1',
    productId: 'prod-snook-1',
    catalogueItemId: 'cat-snook',
    lotId: 'LOT-PR-001',
    quantityUploaded: 35,
    quantityAvailable: 35,
    quantityReserved: 0,
    quantitySold: 0,
    unit: ProductUnit.PER_POUND,
    price: 1500,
    currency: 'JMD',
    catchDate: '2026-10-19T06:00:00.000Z',
    availableFrom: '2026-10-19T06:00:00.000Z',
    landingSiteId: 'site-1',
    landingSite: {
      id: 'site-1',
      name: 'Port Royal Beach',
      parish: 'KINGSTON',
    },
    vendor: {
      id: 'vendor-1',
      businessName: 'Port Royal Fishery',
      tier: 'TIER_1',
      parish: 'KINGSTON',
    },
    status: ListingLifecycleStatus.PUBLISHED,
    derivedStatus: 'PUBLISHED',
    deliveryAvailable: true,
    pickupAvailable: true,
    listingTitle: 'Fresh Snook',
    description: 'Caught this morning near the cays.',
    publishedAt: '2026-10-19T06:30:00.000Z',
    withdrawnAt: null,
    withdrawnReason: null,
    suspendedAt: null,
    suspensionReason: null,
    photos: [
      {
        id: 'photo-1',
        vendorDailyListingId: 'listing-1',
        url: 'https://placehold.co/400x300',
        caption: 'Fresh snook catch',
        moderationStatus: ListingPhotoModerationStatus.APPROVED,
        isPrimary: true,
        uploadedAt: '2026-10-19T06:00:00.000Z',
        captureDate: null,
        withdrawnAt: null,
        withdrawnReason: null,
        createdAt: '2026-10-19T06:00:00.000Z',
        updatedAt: '2026-10-19T06:00:00.000Z',
      },
    ],
    primaryPhoto: null,
    speciesDeclarations: [],
    preparationOptions: [
      { id: 'p1', name: 'Scaled And Gutted', pricePerUnit: 100 },
      { id: 'p2', name: 'Filleted', pricePerUnit: 200 },
    ],
    expiresAt: '2026-10-20T06:00:00.000Z',
    createdAt: '2026-10-19T06:30:00.000Z',
    updatedAt: '2026-10-19T06:30:00.000Z',
  },
  {
    id: 'listing-2',
    vendorId: 'vendor-2',
    productId: 'prod-snook-2',
    catalogueItemId: 'cat-snook',
    lotId: 'LOT-WH-002',
    quantityUploaded: 50,
    quantityAvailable: 50,
    quantityReserved: 0,
    quantitySold: 0,
    unit: ProductUnit.PER_POUND,
    price: 1200,
    currency: 'JMD',
    catchDate: '2026-10-19T07:00:00.000Z',
    availableFrom: '2026-10-19T07:00:00.000Z',
    landingSiteId: 'site-2',
    landingSite: {
      id: 'site-2',
      name: 'Whitehouse Pier',
      parish: 'WESTMORELAND',
    },
    vendor: {
      id: 'vendor-2',
      businessName: 'Whitehouse Cooperative',
      tier: 'TIER_1',
      parish: 'WESTMORELAND',
    },
    status: ListingLifecycleStatus.PUBLISHED,
    derivedStatus: 'PUBLISHED',
    deliveryAvailable: false,
    pickupAvailable: true,
    listingTitle: null,
    description: null,
    publishedAt: '2026-10-19T07:15:00.000Z',
    withdrawnAt: null,
    withdrawnReason: null,
    suspendedAt: null,
    suspensionReason: null,
    photos: [],
    primaryPhoto: null,
    speciesDeclarations: [],
    preparationOptions: [],
    expiresAt: '2026-10-20T07:00:00.000Z',
    createdAt: '2026-10-19T07:15:00.000Z',
    updatedAt: '2026-10-19T07:15:00.000Z',
  },
];

function renderModal(props: Partial<Parameters<typeof ListingDetailModal>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  return render(
    <ListingDetailModal
      item={mockItem}
      isOpen={true}
      onClose={jest.fn()}
      {...props}
    />,
    { wrapper: Wrapper },
  );
}

function mockQueryResult(data: DailyListingResponse[], isPending = false, isError = false) {
  return {
    data,
    isPending,
    isError,
    isLoading: isPending,
    isSuccess: !isPending && !isError,
    status: isPending ? 'pending' : isError ? 'error' : 'success',
  } as unknown as ReturnType<typeof useCatalogueItemListings>;
}

describe('ListingDetailModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders nothing when isOpen is false', () => {
    mockUseCatalogueItemListings.mockReturnValue(mockQueryResult(mockListings));

    renderModal({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders Compare Available Vendors section and seller breakdown', () => {
    mockUseCatalogueItemListings.mockReturnValue(mockQueryResult(mockListings));

    renderModal();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Snook (Robalo)')).toBeInTheDocument();
    expect(screen.getByTestId('compare-vendors-banner')).toBeInTheDocument();
    expect(screen.getByText('Compare Available Vendors')).toBeInTheDocument();
    expect(screen.getAllByText('Whitehouse Cooperative').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Port Royal Fishery').length).toBeGreaterThan(0);

    // Customer-Facing Ordering Availability Notice
    expect(screen.getByTestId('phase-16d-cutover-notice')).toBeInTheDocument();
    expect(screen.getByText(/Online ordering for today's catch is coming soon/i)).toBeInTheDocument();

    // Add to cart must be strictly disabled
    const addToCartBtn = screen.getByTestId('add-to-cart-disabled-btn');
    expect(addToCartBtn).toBeDisabled();
    expect(addToCartBtn).toHaveTextContent(/Add to Cart \(Coming Soon\)/i);
  });

  it('closes modal when Escape key is pressed', () => {
    mockUseCatalogueItemListings.mockReturnValue(mockQueryResult(mockListings));

    const onClose = jest.fn();
    renderModal({ onClose });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('switches active listing when another vendor choice is clicked', () => {
    mockUseCatalogueItemListings.mockReturnValue(mockQueryResult(mockListings));

    renderModal();

    // Click on Port Royal Fishery
    fireEvent.click(screen.getByTestId('vendor-choice-listing-1'));

    // Should now show Port Royal's note and prep options
    expect(screen.getByText(/Caught this morning near the cays/i)).toBeInTheDocument();
    expect(screen.getByText(/Scaled And Gutted/i)).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    mockUseCatalogueItemListings.mockReturnValue(mockQueryResult(mockListings));

    const onClose = jest.fn();
    renderModal({ onClose });

    fireEvent.click(screen.getByLabelText('Close details'));
    expect(onClose).toHaveBeenCalled();
  });

  it('labels bundled /demo-products/ listing photos as Sample Photo (Demo) in detail view', () => {
    const firstListing = mockListings[0]!;
    const firstPhoto = firstListing.photos[0]!;
    const demoListings: DailyListingResponse[] = [
      {
        ...firstListing,
        photos: [
          {
            ...firstPhoto,
            url: 'https://ca-irie-web.agreeablerock-458effa7.eastus2.azurecontainerapps.io/demo-products/red-snapper.png',
          },
        ],
      },
    ];
    mockUseCatalogueItemListings.mockReturnValue(mockQueryResult(demoListings));

    renderModal();

    expect(screen.getByTestId('modal-sample-photo-badge')).toHaveTextContent(/Sample Photo \(Demo\)/i);
    expect(screen.getByText(/Sample photo shown for demonstration purposes/i)).toBeInTheDocument();
    expect(screen.getAllByText('Sample Photo (Demo)').length).toBeGreaterThanOrEqual(2);
  });
});
