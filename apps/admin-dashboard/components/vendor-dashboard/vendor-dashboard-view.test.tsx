import type { VendorDashboard } from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useVendorDashboard } from '@/lib/hooks/use-vendor-dashboard';
import { VendorDashboardView } from './vendor-dashboard-view';

jest.mock('@/lib/hooks/use-vendor-dashboard');

const mockUseVendorDashboard = useVendorDashboard as jest.MockedFunction<typeof useVendorDashboard>;

function vendorDashboard(overrides: Partial<VendorDashboard> = {}): VendorDashboard {
  return {
    byStatus: { PENDING: 1, APPROVED: 10, SUSPENDED: 1, REJECTED: 0 },
    byTier: { COMMUNITY_FISHER: 5, VERIFIED_VENDOR: 4, COMMERCIAL_SUPPLIER: 3, ENTERPRISE_SUPPLIER: 1 },
    averageComplianceScore: 88,
    topVendorsByRevenue: [{ vendorId: 'vendor-1', businessName: "Vera's Catch", grossAmount: '150000' }],
    ...overrides,
  };
}

function withData(data: VendorDashboard): UseQueryResult<VendorDashboard> {
  return { data, isPending: false, isError: false, refetch: jest.fn() } as unknown as UseQueryResult<VendorDashboard>;
}

describe('VendorDashboardView', () => {
  it('shows a loading state', () => {
    mockUseVendorDashboard.mockReturnValue({ isPending: true, isError: false } as UseQueryResult<VendorDashboard>);

    render(<VendorDashboardView />);

    expect(screen.getByText('Vendor Dashboard')).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    const refetch = jest.fn();
    mockUseVendorDashboard.mockReturnValue({
      isPending: false,
      isError: true,
      refetch,
    } as unknown as UseQueryResult<VendorDashboard>);
    const user = userEvent.setup();

    render(<VendorDashboardView />);

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when there is no settled vendor revenue yet', () => {
    mockUseVendorDashboard.mockReturnValue(withData(vendorDashboard({ topVendorsByRevenue: [] })));

    render(<VendorDashboardView />);

    expect(screen.getByText('No settled vendor revenue yet.')).toBeInTheDocument();
  });

  it('renders status/tier counts, average compliance score, and top vendors by revenue', () => {
    mockUseVendorDashboard.mockReturnValue(withData(vendorDashboard()));

    render(<VendorDashboardView />);

    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('Community Fisher')).toBeInTheDocument();
    expect(screen.getByText('88')).toBeInTheDocument();
    expect(screen.getByText("Vera's Catch")).toBeInTheDocument();
  });

  it('shows a dash when there is no average compliance score yet', () => {
    mockUseVendorDashboard.mockReturnValue(withData(vendorDashboard({ averageComplianceScore: null })));

    render(<VendorDashboardView />);

    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
