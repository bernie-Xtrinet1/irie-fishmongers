import {
  ComplianceBand,
  Parish,
  ProductAvailability,
  ProductUnit,
  VendorComplianceStatusLabel,
  VendorTier,
  type ProductResponse,
  type VendorProfile,
} from '@iriefishmongers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { ApiError } from '@/lib/api-client';
import { fetchProductsByVendor } from '@/lib/api/products';
import { fetchVendorProfile } from '@/lib/api/vendors';
import { VendorProfileView } from './vendor-profile-view';

jest.mock('@/lib/api/vendors');
jest.mock('@/lib/api/products');

const mockFetchVendorProfile = fetchVendorProfile as jest.MockedFunction<typeof fetchVendorProfile>;
const mockFetchProductsByVendor = fetchProductsByVendor as jest.MockedFunction<typeof fetchProductsByVendor>;

const baseProfile: VendorProfile = {
  id: 'vendor-1',
  businessName: "Vera's Catch",
  tier: VendorTier.VERIFIED_VENDOR,
  badge: '✓ Verified Vendor',
  parish: Parish.ST_ANN,
  complianceScore: 85,
  complianceBand: ComplianceBand.GOOD,
  complianceScoreUpdatedAt: new Date('2026-07-10').toISOString(),
  foodSafetyStatus: VendorComplianceStatusLabel.COMPLIANT,
  traceabilityStatus: VendorComplianceStatusLabel.COMPLIANT,
  ordersCompleted: 42,
  rating: null,
  coldChainScore: null,
  recentReviews: [],
};

const baseProduct: ProductResponse = {
  id: 'product-1',
  vendorId: 'vendor-1',
  categoryId: 'cat-1',
  lotId: null,
  name: 'Fresh Snapper',
  description: 'Caught this morning.',
  unit: ProductUnit.PER_POUND,
  price: '850.00',
  currency: 'JMD',
  quantityAvailable: 10,
  imageUrl: 'https://cdn.example.com/snapper.jpg',
  isActive: true,
  availability: ProductAvailability.ACTIVE,
  createdAt: new Date().toISOString(),
};

function renderWithClient(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('VendorProfileView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchProductsByVendor.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('shows a loading skeleton while fetching', () => {
    mockFetchVendorProfile.mockReturnValue(new Promise(() => {}));
    const { container } = renderWithClient(<VendorProfileView vendorId="vendor-1" />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('shows a not-found message for a 404', async () => {
    mockFetchVendorProfile.mockRejectedValue(new ApiError('Vendor not found', 404));
    renderWithClient(<VendorProfileView vendorId="missing" />);
    expect(await screen.findByText('Vendor not found.')).toBeInTheDocument();
  });

  it('shows a generic error with retry for other failures', async () => {
    mockFetchVendorProfile.mockRejectedValue(new ApiError('Internal server error', 500));
    renderWithClient(<VendorProfileView vendorId="vendor-1" />);
    expect(await screen.findByText('Something went wrong loading this vendor.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('renders vendor overview, compliance, and honest empty rating/reviews', async () => {
    mockFetchVendorProfile.mockResolvedValue(baseProfile);
    renderWithClient(<VendorProfileView vendorId="vendor-1" />);

    expect(await screen.findByText("Vera's Catch")).toBeInTheDocument();
    expect(screen.getByText('✓ Verified Vendor')).toBeInTheDocument();
    expect(screen.getByText('St Ann')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    // Compliance standing shows the customer-facing band, not the raw score.
    expect(screen.getByText(/Good/)).toBeInTheDocument();
    expect(screen.getByText('Not yet rated')).toBeInTheDocument();
    expect(screen.getAllByText('Not yet assessed')).toHaveLength(1);
    expect(screen.getByText('This vendor has no reviews yet.')).toBeInTheDocument();
  });

  it('shows an empty state when the vendor has no active products', async () => {
    mockFetchVendorProfile.mockResolvedValue(baseProfile);
    renderWithClient(<VendorProfileView vendorId="vendor-1" />);

    expect(await screen.findByText('This vendor has no active products right now.')).toBeInTheDocument();
  });

  it("lists the vendor's products, reusing the existing product search endpoint", async () => {
    mockFetchVendorProfile.mockResolvedValue(baseProfile);
    mockFetchProductsByVendor.mockResolvedValue({ items: [baseProduct], total: 1, page: 1, pageSize: 20 });
    renderWithClient(<VendorProfileView vendorId="vendor-1" />);

    expect(await screen.findByText('Fresh Snapper')).toBeInTheDocument();
    expect(mockFetchProductsByVendor).toHaveBeenCalledWith('vendor-1');
  });
});
