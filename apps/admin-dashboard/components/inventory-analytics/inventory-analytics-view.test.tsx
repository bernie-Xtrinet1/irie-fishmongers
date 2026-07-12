import type { InventoryAnalytics } from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useInventoryAnalytics } from '@/lib/hooks/use-inventory-analytics';
import { InventoryAnalyticsView } from './inventory-analytics-view';

jest.mock('@/lib/hooks/use-inventory-analytics');

const mockUseInventoryAnalytics = useInventoryAnalytics as jest.MockedFunction<typeof useInventoryAnalytics>;

function inventoryAnalytics(overrides: Partial<InventoryAnalytics> = {}): InventoryAnalytics {
  return {
    byAvailability: { ACTIVE: 12, OUT_OF_STOCK: 2, INACTIVE: 1, ON_HOLD: 0 },
    lowStockProducts: [{ productId: 'product-1', productName: 'Snapper', quantityAvailable: 3, vendorId: 'vendor-1' }],
    eventsByType: {
      DECREMENTED: { count: 10, totalQuantityDelta: -50 },
      RESTOCKED: { count: 3, totalQuantityDelta: 100 },
      MANUAL_ADJUSTMENT: { count: 1, totalQuantityDelta: -2 },
      DISPOSED: { count: 0, totalQuantityDelta: 0 },
    },
    ...overrides,
  };
}

function withData(data: InventoryAnalytics): UseQueryResult<InventoryAnalytics> {
  return {
    data,
    isPending: false,
    isError: false,
    refetch: jest.fn(),
  } as unknown as UseQueryResult<InventoryAnalytics>;
}

describe('InventoryAnalyticsView', () => {
  it('shows a loading state', () => {
    mockUseInventoryAnalytics.mockReturnValue({ isPending: true, isError: false } as UseQueryResult<InventoryAnalytics>);

    render(<InventoryAnalyticsView />);

    expect(screen.getByText('Inventory Analytics')).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    const refetch = jest.fn();
    mockUseInventoryAnalytics.mockReturnValue({
      isPending: false,
      isError: true,
      refetch,
    } as unknown as UseQueryResult<InventoryAnalytics>);
    const user = userEvent.setup();

    render(<InventoryAnalyticsView />);

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when no products are low on stock', () => {
    mockUseInventoryAnalytics.mockReturnValue(withData(inventoryAnalytics({ lowStockProducts: [] })));

    render(<InventoryAnalyticsView />);

    expect(screen.getByText('No products are currently low on stock.')).toBeInTheDocument();
  });

  it('renders availability counts, event type activity, and low stock products', () => {
    mockUseInventoryAnalytics.mockReturnValue(withData(inventoryAnalytics()));

    render(<InventoryAnalyticsView />);

    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Restocked')).toBeInTheDocument();
    expect(screen.getByText('Snapper')).toBeInTheDocument();
    expect(screen.getByText('3 left')).toBeInTheDocument();
  });
});
