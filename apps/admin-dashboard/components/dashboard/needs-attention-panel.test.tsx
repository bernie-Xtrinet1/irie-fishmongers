import type { DashboardSummary } from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';

import { useDashboardSummary } from '@/lib/hooks/use-dashboard-summary';
import { NeedsAttentionPanel } from './needs-attention-panel';

jest.mock('@/lib/hooks/use-dashboard-summary');

const mockUseDashboardSummary = useDashboardSummary as jest.MockedFunction<typeof useDashboardSummary>;

const baseSummary: DashboardSummary = {
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

function withData(data: DashboardSummary): UseQueryResult<DashboardSummary> {
  return {
    data,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  } as unknown as UseQueryResult<DashboardSummary>;
}

describe('NeedsAttentionPanel', () => {
  it('renders nothing while the summary is still loading', () => {
    mockUseDashboardSummary.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
    } as UseQueryResult<DashboardSummary>);

    const { container } = render(<NeedsAttentionPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a reassuring message when nothing needs attention', () => {
    mockUseDashboardSummary.mockReturnValue(withData(baseSummary));

    render(<NeedsAttentionPanel />);

    expect(screen.getByText('Nothing needs attention right now.')).toBeInTheDocument();
  });

  it('lists pending vendors, active recalls, and urgent alerts with correct singular/plural copy and links', () => {
    mockUseDashboardSummary.mockReturnValue(
      withData({
        ...baseSummary,
        vendors: { byStatus: { ...baseSummary.vendors.byStatus, PENDING: 1 } },
        compliance: { activeAlertsBySeverity: { WARNING: 0, CRITICAL: 2, EMERGENCY: 1 }, activeRecalls: 3 },
      }),
    );

    render(<NeedsAttentionPanel />);

    expect(screen.getByRole('link', { name: '1 vendor application awaiting review' })).toHaveAttribute(
      'href',
      '/vendors?status=PENDING',
    );
    expect(screen.getByRole('link', { name: '3 active recalls' })).toHaveAttribute('href', '/recalls');
    expect(screen.getByRole('link', { name: '3 critical or emergency cold-chain alerts' })).toHaveAttribute(
      'href',
      '/cold-chain',
    );
  });
});
