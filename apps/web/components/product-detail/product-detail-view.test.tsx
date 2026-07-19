import {
  ComplianceBand,
  FreshnessGrade,
  Parish,
  ProductAvailability,
  ProductUnit,
  SeafoodStorageType,
  VendorComplianceStatusLabel,
  VendorTier,
  type ProductDetail,
} from '@iriefishmongers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

import { ApiError } from '@/lib/api-client';
import { addCartItem } from '@/lib/api/cart';
import { resolveBestVendor } from '@/lib/api/marketplace';
import { fetchProductDetail } from '@/lib/api/products';
import { fetchProductReviews } from '@/lib/api/reviews';
import { ProductDetailView } from './product-detail-view';

jest.mock('@/lib/api/products');
jest.mock('@/lib/api/cart');
jest.mock('@/lib/api/marketplace');
jest.mock('@/lib/api/reviews');

const mockFetchProductDetail = fetchProductDetail as jest.MockedFunction<typeof fetchProductDetail>;
const mockAddCartItem = addCartItem as jest.MockedFunction<typeof addCartItem>;
const mockResolveBestVendor = resolveBestVendor as jest.MockedFunction<typeof resolveBestVendor>;
const mockFetchProductReviews = fetchProductReviews as jest.MockedFunction<typeof fetchProductReviews>;

const baseProduct: ProductDetail = {
  id: 'product-1',
  vendorId: 'vendor-1',
  categoryId: 'cat-1',
  lotId: 'lot-1',
  name: 'Fresh Snapper',
  description: 'Caught this morning off the north coast.',
  unit: ProductUnit.PER_POUND,
  price: '850.00',
  currency: 'JMD',
  quantityAvailable: 10,
  imageUrl: 'https://cdn.example.com/snapper.jpg',
  isActive: true,
  availability: ProductAvailability.ACTIVE,
  createdAt: new Date().toISOString(),
  lot: {
    lotNumber: 'LOT-2026-000001',
    species: 'Snapper',
    storageType: SeafoodStorageType.FRESH,
    catchDate: new Date('2026-01-15').toISOString(),
    catchLocation: 'North Coast',
    landingSite: 'Falmouth Landing Site',
    freshnessGrade: FreshnessGrade.GRADE_A,
    qualityScore: 92,
    lastInspectedAt: new Date('2026-01-16').toISOString(),
    vendorBusinessName: "Vera's Catch",
    temperatureVerified: true,
  },
  vendor: {
    id: 'vendor-1',
    businessName: "Vera's Catch",
    tier: VendorTier.COMMUNITY_FISHER,
    badge: '🐟 Community Fisher',
    parish: Parish.KINGSTON,
    complianceScore: 90,
    complianceStatus: VendorComplianceStatusLabel.COMPLIANT,
    complianceBand: ComplianceBand.EXCELLENT,
    rating: 4.5,
    logoUrl: null,
  },
  marketplaceModes: { customerSelectedEnabled: true, bestAvailableEnabled: false },
};

function renderWithClient(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('ProductDetailView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchProductReviews.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      averageRating: null,
    });
  });

  it('shows a loading skeleton while fetching', () => {
    mockFetchProductDetail.mockReturnValue(new Promise(() => {}));
    const { container } = renderWithClient(<ProductDetailView productId="product-1" />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('shows a not-found message for a 404', async () => {
    mockFetchProductDetail.mockRejectedValue(new ApiError('Product not found', 404));
    renderWithClient(<ProductDetailView productId="missing" />);
    expect(await screen.findByText('Product not found.')).toBeInTheDocument();
  });

  it('shows a generic error with retry for other failures', async () => {
    mockFetchProductDetail.mockRejectedValue(new ApiError('Internal server error', 500));
    renderWithClient(<ProductDetailView productId="product-1" />);
    expect(await screen.findByText('Something went wrong loading this product.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('renders all four information sections on success', async () => {
    mockFetchProductDetail.mockResolvedValue(baseProduct);
    renderWithClient(<ProductDetailView productId="product-1" />);

    expect(await screen.findByText('Fresh Snapper')).toBeInTheDocument();
    expect(screen.getByText('Product Information')).toBeInTheDocument();
    expect(screen.getByText('Traceability Information')).toBeInTheDocument();
    expect(screen.getByText('Food Safety Information')).toBeInTheDocument();
    expect(screen.getByText('Vendor Information')).toBeInTheDocument();
    expect(screen.getByText('North Coast')).toBeInTheDocument();
    // Vendor rating renders as stars plus the one-decimal value.
    expect(screen.getByText('4.5')).toBeInTheDocument();
    expect(screen.getByLabelText('Rated 4.5 out of 5 stars')).toBeInTheDocument();
  });

  it('shows the quality & freshness score with its grade and inspection date', async () => {
    mockFetchProductDetail.mockResolvedValue(baseProduct);
    renderWithClient(<ProductDetailView productId="product-1" />);

    expect(await screen.findByText('Quality & Freshness Score')).toBeInTheDocument();
    expect(screen.getByText(/92\/100 · Grade A · Inspected/)).toBeInTheDocument();
  });

  it('shows "Not scored" when the lot has no quality score', async () => {
    mockFetchProductDetail.mockResolvedValue({
      ...baseProduct,
      lot: baseProduct.lot ? { ...baseProduct.lot, qualityScore: null, lastInspectedAt: null } : null,
    });
    renderWithClient(<ProductDetailView productId="product-1" />);

    expect(await screen.findByText('Quality & Freshness Score')).toBeInTheDocument();
    expect(screen.getByText('Not scored')).toBeInTheDocument();
  });

  it('hides Option B when bestAvailableEnabled is false', async () => {
    mockFetchProductDetail.mockResolvedValue(baseProduct);
    renderWithClient(<ProductDetailView productId="product-1" />);

    await screen.findByText('Fresh Snapper');
    expect(screen.queryByText('Best Available Vendor')).not.toBeInTheDocument();
    expect(screen.getByText('Choose Vendor')).toBeInTheDocument();
  });

  it('shows Option B with its explanation when bestAvailableEnabled is true', async () => {
    mockFetchProductDetail.mockResolvedValue({
      ...baseProduct,
      marketplaceModes: { customerSelectedEnabled: true, bestAvailableEnabled: true },
    });
    renderWithClient(<ProductDetailView productId="product-1" />);

    await screen.findByText('Fresh Snapper');
    expect(screen.getByText('Best Available Vendor')).toBeInTheDocument();
    expect(
      screen.getByText('Vendor selected based on availability, freshness, compliance, and delivery capacity.'),
    ).toBeInTheDocument();
  });

  it('adds the product to the cart and shows a success message', async () => {
    mockFetchProductDetail.mockResolvedValue(baseProduct);
    mockAddCartItem.mockResolvedValue({ id: 'item-1', cartId: 'cart-1', productId: 'product-1', quantity: 1 });
    renderWithClient(<ProductDetailView productId="product-1" />);

    await screen.findByText('Fresh Snapper');
    await userEvent.click(screen.getByRole('button', { name: 'Add To Cart' }));

    await waitFor(() => {
      expect(mockAddCartItem).toHaveBeenCalledWith({ productId: 'product-1', quantity: 1 });
    });
    expect(await screen.findByText('Added to your cart.')).toBeInTheDocument();
  });

  it('shows a sign-in message when adding to cart returns 401', async () => {
    mockFetchProductDetail.mockResolvedValue(baseProduct);
    mockAddCartItem.mockRejectedValue(new ApiError('Unauthorized', 401));
    renderWithClient(<ProductDetailView productId="product-1" />);

    await screen.findByText('Fresh Snapper');
    await userEvent.click(screen.getByRole('button', { name: 'Add To Cart' }));

    expect(await screen.findByText('Please sign in to add items to your cart.')).toBeInTheDocument();
  });

  it('disables purchase actions until a delivery parish is chosen for Best Available Vendor', async () => {
    mockFetchProductDetail.mockResolvedValue({
      ...baseProduct,
      marketplaceModes: { customerSelectedEnabled: true, bestAvailableEnabled: true },
    });
    renderWithClient(<ProductDetailView productId="product-1" />);

    await screen.findByText('Fresh Snapper');
    await userEvent.click(screen.getByRole('radio', { name: /Best Available Vendor/ }));

    expect(screen.getByRole('button', { name: 'Add To Cart' })).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText('Delivery Parish'), 'KINGSTON');

    expect(screen.getByRole('button', { name: 'Add To Cart' })).toBeEnabled();
  });

  it('resolves the best vendor, adds it to the cart, and shows the assigned badge', async () => {
    mockFetchProductDetail.mockResolvedValue({
      ...baseProduct,
      marketplaceModes: { customerSelectedEnabled: true, bestAvailableEnabled: true },
    });
    mockResolveBestVendor.mockResolvedValue({
      productId: 'product-2',
      vendorId: 'vendor-2',
      badge: '✓ Verified Vendor',
      totalScore: '88.00',
      fulfillmentDecisionId: 'decision-1',
    });
    mockAddCartItem.mockResolvedValue({ id: 'item-1', cartId: 'cart-1', productId: 'product-2', quantity: 1 });
    renderWithClient(<ProductDetailView productId="product-1" />);

    await screen.findByText('Fresh Snapper');
    await userEvent.click(screen.getByRole('radio', { name: /Best Available Vendor/ }));
    await userEvent.selectOptions(screen.getByLabelText('Delivery Parish'), 'KINGSTON');
    await userEvent.click(screen.getByRole('button', { name: 'Add To Cart' }));

    await waitFor(() => {
      expect(mockResolveBestVendor).toHaveBeenCalledWith({
        productId: 'product-1',
        quantity: 1,
        deliveryParish: 'KINGSTON',
      });
    });
    await waitFor(() => {
      expect(mockAddCartItem).toHaveBeenCalledWith({ productId: 'product-2', quantity: 1 });
    });
    expect(
      await screen.findByText('Fulfilled by Irie Fishmongers (✓ Verified Vendor). Added to your cart.'),
    ).toBeInTheDocument();
  });

  it('shows an honest message when no vendor can fulfill a Best Available Vendor request', async () => {
    mockFetchProductDetail.mockResolvedValue({
      ...baseProduct,
      marketplaceModes: { customerSelectedEnabled: true, bestAvailableEnabled: true },
    });
    mockResolveBestVendor.mockRejectedValue(new ApiError('No eligible vendor', 404));
    renderWithClient(<ProductDetailView productId="product-1" />);

    await screen.findByText('Fresh Snapper');
    await userEvent.click(screen.getByRole('radio', { name: /Best Available Vendor/ }));
    await userEvent.selectOptions(screen.getByLabelText('Delivery Parish'), 'KINGSTON');
    await userEvent.click(screen.getByRole('button', { name: 'Add To Cart' }));

    expect(
      await screen.findByText('No vendor is currently able to fulfill this request.'),
    ).toBeInTheDocument();
    expect(mockAddCartItem).not.toHaveBeenCalled();
  });
});
