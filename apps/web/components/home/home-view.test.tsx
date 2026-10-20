import {
  ListingLifecycleStatus,
  ListingPhotoModerationStatus,
  ProductAvailability,
  ProductUnit,
  type AvailableTodayItem,
  type Paginated,
  type PaginatedAvailableToday,
  type ProductResponse,
} from '@iriefishmongers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { fetchAvailableToday } from '@/lib/api/daily-listings';
import { fetchProducts } from '@/lib/api/products';

import { HomeView } from './home-view';

jest.mock('@/lib/api/products');
jest.mock('@/lib/api/daily-listings');

const mockFetchProducts = fetchProducts as jest.MockedFunction<typeof fetchProducts>;
const mockFetchAvailableToday = fetchAvailableToday as jest.MockedFunction<typeof fetchAvailableToday>;

function product(overrides: Partial<ProductResponse> = {}): ProductResponse {
  return {
    id: 'p1',
    vendorId: 'v1',
    categoryId: 'c1',
    lotId: null,
    name: 'Fresh Red Snapper',
    description: 'Whole red snapper.',
    unit: ProductUnit.PER_POUND,
    price: '950',
    currency: 'JMD',
    quantityAvailable: 40,
    imageUrl: 'https://placehold.co/600x400',
    isActive: true,
    availability: ProductAvailability.ACTIVE,
    createdAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

const mockAvailableItem: AvailableTodayItem = {
  catalogueItemId: 'cat-1',
  name: 'Snook (Robalo)',
  commonName: 'Snook',
  scientificName: 'Centropomus undecimalis',
  categoryId: 'cat-fish',
  categoryName: 'FISH',
  referenceImageUrl: 'https://placehold.co/600x400',
  totalQuantityAvailable: 50,
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

function page<T>(items: T[]): Paginated<T> {
  return { items, total: items.length, page: 1, pageSize: 24 };
}

function availablePage(items: AvailableTodayItem[]): PaginatedAvailableToday {
  return { items, total: items.length, page: 1, limit: 20, totalPages: 1 };
}

function renderView(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }): React.ReactElement {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  render(<HomeView />, { wrapper: Wrapper });
}

describe('HomeView', () => {
  beforeEach(() => {
    mockFetchProducts.mockReset();
    mockFetchAvailableToday.mockReset();
    mockFetchAvailableToday.mockResolvedValue(availablePage([]));
  });

  it('lists products with price and a link to the detail page', async () => {
    mockFetchProducts.mockResolvedValue(page([product(), product({ id: 'p2', name: 'Jumbo Shrimp', price: '1650' })]));
    renderView();

    await waitFor(() => expect(screen.getByText('Fresh Red Snapper')).toBeInTheDocument());
    expect(screen.getByText('JMD $950 / per pound')).toBeInTheDocument();
    expect(screen.getByText('Jumbo Shrimp')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Fresh Red Snapper/ })).toHaveAttribute('href', '/products/p1');
  });

  it('flags an out-of-stock product instead of a quantity', async () => {
    mockFetchProducts.mockResolvedValue(page([product({ availability: ProductAvailability.OUT_OF_STOCK })]));
    renderView();

    await waitFor(() => expect(screen.getByText('Out of stock')).toBeInTheDocument());
  });

  it('shows an empty state when there are no products', async () => {
    mockFetchProducts.mockResolvedValue(page([]));
    renderView();

    await waitFor(() => expect(screen.getByText('No products are available right now.')).toBeInTheDocument());
  });

  it('shows an error state when the catalog fails to load', async () => {
    mockFetchProducts.mockRejectedValue(new Error('boom'));
    renderView();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  it('renders Available Today marketplace cards with Live Catch badges', async () => {
    mockFetchProducts.mockResolvedValue(page([product()]));
    mockFetchAvailableToday.mockResolvedValue(availablePage([mockAvailableItem]));

    renderView();

    await waitFor(() => expect(screen.getByText('Snook (Robalo)')).toBeInTheDocument());
    expect(screen.getByText('Centropomus undecimalis')).toBeInTheDocument();
    expect(screen.getByTestId('actual-catch-badge')).toBeInTheDocument();
  });

  it('handles search input and parish filter changes', () => {
    mockFetchProducts.mockResolvedValue(page([product()]));
    mockFetchAvailableToday.mockResolvedValue(availablePage([mockAvailableItem]));

    renderView();

    const searchInput = screen.getByTestId('marketplace-search-input');
    fireEvent.change(searchInput, { target: { value: 'snook' } });
    expect(searchInput).toHaveValue('snook');

    const parishSelect = screen.getByTestId('parish-filter-select');
    fireEvent.change(parishSelect, { target: { value: 'KINGSTON' } });
    expect(parishSelect).toHaveValue('KINGSTON');

    const deliveryCheckbox = screen.getByTestId('delivery-filter-checkbox');
    fireEvent.click(deliveryCheckbox);
    expect(deliveryCheckbox).toBeChecked();

    expect(screen.getByText('Clear filters')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Clear filters'));

    expect(searchInput).toHaveValue('');
    expect(parishSelect).toHaveValue('');
    expect(deliveryCheckbox).not.toBeChecked();
  });
});
