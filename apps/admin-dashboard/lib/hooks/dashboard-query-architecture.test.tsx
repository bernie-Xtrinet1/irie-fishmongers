import type { DashboardSummary } from '@iriefishmongers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';

import { fetchDashboardSummary } from '@/lib/api/analytics';
import { fetchHealthStatus } from '@/lib/api/health';
import { useDashboardSummary } from './use-dashboard-summary';
import { useHealthStatus } from './use-health-status';

jest.mock('@/lib/api/analytics');
jest.mock('@/lib/api/health');

const mockFetchDashboardSummary = fetchDashboardSummary as jest.MockedFunction<typeof fetchDashboardSummary>;
const mockFetchHealthStatus = fetchHealthStatus as jest.MockedFunction<typeof fetchHealthStatus>;

const summaryFixture: DashboardSummary = {
  financials: { grossPaidAmount: '0', platformCommission: '0', currency: 'JMD' },
  orders: {
    customerOrdersTotal: 0,
    vendorOrdersByStatus: {
      PENDING: 0,
      ACCEPTED: 0,
      PREPARING: 0,
      READY_FOR_PICKUP: 0,
      ASSIGNED_TO_DRIVER: 0,
      IN_TRANSIT: 0,
      DELIVERED: 0,
      DELIVERY_FAILED: 0,
      REJECTED: 0,
      CANCELLED: 0,
    },
  },
  vendors: { byStatus: { PENDING: 0, APPROVED: 0, SUSPENDED: 0, REJECTED: 0 } },
  drivers: { byStatus: { PENDING: 0, APPROVED: 0, SUSPENDED: 0, REJECTED: 0 } },
  compliance: { activeAlertsBySeverity: { WARNING: 0, CRITICAL: 0, EMERGENCY: 0 }, activeRecalls: 0 },
  systemHealth: { postgres: 'up', redis: 'up' },
};

// Mirrors the real overview page: 5 KPI cards each selecting their own
// slice, the header reading dataUpdatedAt off the unselected query, and
// the System Health card polling its own independent endpoint.
function DashboardWidgets(): React.ReactElement {
  useDashboardSummary();
  useDashboardSummary((data) => data.financials);
  useDashboardSummary((data) => data.orders);
  useDashboardSummary((data) => data.vendors);
  useDashboardSummary((data) => data.drivers);
  useDashboardSummary((data) => data.compliance);
  useHealthStatus();
  return <></>;
}

describe('dashboard query architecture', () => {
  beforeEach(() => {
    mockFetchDashboardSummary.mockReset().mockResolvedValue(summaryFixture);
    mockFetchHealthStatus.mockReset().mockResolvedValue({ postgres: 'up', redis: 'up' });
  });

  it('issues exactly one dashboard-summary request when six widgets mount simultaneously', async () => {
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <DashboardWidgets />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(mockFetchDashboardSummary).toHaveBeenCalled());

    expect(mockFetchDashboardSummary).toHaveBeenCalledTimes(1);
  });

  it('polls system health independently, without triggering the dashboard-summary aggregation', async () => {
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <DashboardWidgets />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(mockFetchHealthStatus).toHaveBeenCalled());
    await waitFor(() => expect(mockFetchDashboardSummary).toHaveBeenCalled());

    // Both fire (each widget needs its data), but as two independent
    // single calls, not one triggering extra calls to the other.
    expect(mockFetchHealthStatus).toHaveBeenCalledTimes(1);
    expect(mockFetchDashboardSummary).toHaveBeenCalledTimes(1);
  });
});
