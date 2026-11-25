import type { SalesAnalytics } from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useOptionalAuth } from '@/lib/auth/auth-context';
import { useSalesAnalytics } from '@/lib/hooks/use-sales-analytics';
import { SalesAnalyticsView } from './sales-analytics-view';

jest.mock('@/lib/hooks/use-sales-analytics');
jest.mock('@/lib/auth/auth-context', () => ({
  useOptionalAuth: jest.fn(),
}));

const mockUseSalesAnalytics = useSalesAnalytics as jest.MockedFunction<typeof useSalesAnalytics>;
const mockUseOptionalAuth = useOptionalAuth as jest.MockedFunction<typeof useOptionalAuth>;

function salesAnalytics(overrides: Partial<SalesAnalytics> = {}): SalesAnalytics {
  return {
    topProductsByRevenue: [{ productId: 'product-1', productName: 'Snapper', quantitySold: 20, revenue: '10000' }],
    salesByCategory: [{ categoryId: 'category-1', categoryName: 'Fish', quantitySold: 20, revenue: '10000' }],
    salesByPaymentMethod: { WIPAY: '6000', CASH_ON_DELIVERY: '4000' },
    averageOrderValue: '500.00',
    currency: 'JMD',
    ...overrides,
  };
}

function withData(data: SalesAnalytics): UseQueryResult<SalesAnalytics> {
  return { data, isPending: false, isError: false, refetch: jest.fn() } as unknown as UseQueryResult<SalesAnalytics>;
}

describe('SalesAnalyticsView', () => {
  beforeEach(() => {
    mockUseOptionalAuth.mockReturnValue(null);
  });

  it('blocks OPERATIONS_STAFF without enabling sales-analytics query', () => {
    mockUseOptionalAuth.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'staff-1',
        email: 'staff.operations@iriefishmongers.test',
        firstName: 'Ops',
        lastName: 'Staff',
        status: 'ACTIVE',
        roles: ['OPERATIONS_STAFF'],
      },
      login: jest.fn(),
      logout: jest.fn(),
    });
    mockUseSalesAnalytics.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: false,
    } as unknown as UseQueryResult<SalesAnalytics>);

    render(<SalesAnalyticsView />);

    expect(mockUseSalesAnalytics).toHaveBeenCalledWith(false);
    expect(screen.getByRole('alert')).toHaveTextContent('Access Denied');
  });

  it('shows a loading state', () => {
    mockUseOptionalAuth.mockReturnValue(null);
    mockUseSalesAnalytics.mockReturnValue({ isPending: true, isError: false } as UseQueryResult<SalesAnalytics>);

    render(<SalesAnalyticsView />);

    expect(screen.getByText('Sales Analytics')).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    const refetch = jest.fn();
    mockUseSalesAnalytics.mockReturnValue({
      isPending: false,
      isError: true,
      refetch,
    } as unknown as UseQueryResult<SalesAnalytics>);
    const user = userEvent.setup();

    render(<SalesAnalyticsView />);

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when there are no paid sales yet', () => {
    mockUseSalesAnalytics.mockReturnValue(
      withData(salesAnalytics({ topProductsByRevenue: [], salesByCategory: [] })),
    );

    render(<SalesAnalyticsView />);

    expect(screen.getAllByText('No paid sales yet.')).toHaveLength(2);
  });

  it('renders average order value, payment method breakdown, top products, and category sales', () => {
    mockUseSalesAnalytics.mockReturnValue(withData(salesAnalytics()));

    render(<SalesAnalyticsView />);

    expect(screen.getByText('$500.00')).toBeInTheDocument();
    expect(screen.getByText('$6,000.00')).toBeInTheDocument();
    expect(screen.getByText('$4,000.00')).toBeInTheDocument();
    expect(screen.getByText('Snapper')).toBeInTheDocument();
    expect(screen.getByText('Fish')).toBeInTheDocument();
  });
});
