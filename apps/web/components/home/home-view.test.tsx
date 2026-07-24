import { ProductAvailability, ProductUnit, type Paginated, type ProductResponse } from '@iriefishmongers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { fetchProducts } from '@/lib/api/products';

import { HomeView } from './home-view';

jest.mock('@/lib/api/products');

const mockFetchProducts = fetchProducts as jest.MockedFunction<typeof fetchProducts>;

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

function page(items: ProductResponse[]): Paginated<ProductResponse> {
  return { items, total: items.length, page: 1, pageSize: 24 };
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
});
