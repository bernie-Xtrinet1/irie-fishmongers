import type { DeliveryAnalytics } from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useDeliveryAnalytics } from '@/lib/hooks/use-delivery-analytics';
import { DeliveryAnalyticsView } from './delivery-analytics-view';

jest.mock('@/lib/hooks/use-delivery-analytics');

const mockUseDeliveryAnalytics = useDeliveryAnalytics as jest.MockedFunction<typeof useDeliveryAnalytics>;

function deliveryAnalytics(overrides: Partial<DeliveryAnalytics> = {}): DeliveryAnalytics {
  return {
    slaBreachesByZone: [{ zoneId: 'zone-kingston', totalBreaches: 3, unresolvedBreaches: 1 }],
    totalUnresolvedBreaches: 1,
    fleetByZone: [{ zoneId: 'zone-kingston', status: 'AVAILABLE', count: 4 }],
    byCustomerAcceptanceStatus: { PENDING: 1, ACCEPTED: 8, REJECTED: 1 },
    ...overrides,
  };
}

function withData(data: DeliveryAnalytics): UseQueryResult<DeliveryAnalytics> {
  return {
    data,
    isPending: false,
    isError: false,
    refetch: jest.fn(),
  } as unknown as UseQueryResult<DeliveryAnalytics>;
}

describe('DeliveryAnalyticsView', () => {
  it('shows a loading state', () => {
    mockUseDeliveryAnalytics.mockReturnValue({ isPending: true, isError: false } as UseQueryResult<DeliveryAnalytics>);

    render(<DeliveryAnalyticsView />);

    expect(screen.getByText('Delivery Analytics')).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    const refetch = jest.fn();
    mockUseDeliveryAnalytics.mockReturnValue({
      isPending: false,
      isError: true,
      refetch,
    } as unknown as UseQueryResult<DeliveryAnalytics>);
    const user = userEvent.setup();

    render(<DeliveryAnalyticsView />);

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows empty states when there is no SLA breach or fleet data', () => {
    mockUseDeliveryAnalytics.mockReturnValue(
      withData(deliveryAnalytics({ slaBreachesByZone: [], fleetByZone: [] })),
    );

    render(<DeliveryAnalyticsView />);

    expect(screen.getByText('No SLA breaches recorded.')).toBeInTheDocument();
    expect(screen.getByText('No fleet assets assigned to a zone yet.')).toBeInTheDocument();
  });

  it('renders unresolved breach count, acceptance counts, zone breaches, and fleet by zone', () => {
    mockUseDeliveryAnalytics.mockReturnValue(withData(deliveryAnalytics()));

    render(<DeliveryAnalyticsView />);

    expect(screen.getByText('1', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getAllByText('zone-kingston').length).toBeGreaterThan(0);
    expect(screen.getByText('1 unresolved')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
  });
});
