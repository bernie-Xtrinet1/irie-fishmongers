import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';

import { useDashboardSummary } from '@/lib/hooks/use-dashboard-summary';
import { NeedsAttentionPanel } from './needs-attention-panel';

jest.mock('@/lib/hooks/use-dashboard-summary');

const mockUseDashboardSummary = useDashboardSummary as jest.MockedFunction<typeof useDashboardSummary>;

interface AttentionSlice {
  pendingVendors: number;
  activeRecalls: number;
  urgentAlerts: number;
}

// The component calls useDashboardSummary(select) - since the mock
// replaces the hook wholesale, these fixtures must already be in the
// post-select shape the component actually reads.
function withSlice(data: AttentionSlice): UseQueryResult<AttentionSlice> {
  return {
    data,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  } as unknown as UseQueryResult<AttentionSlice>;
}

describe('NeedsAttentionPanel', () => {
  it('renders nothing while the summary is still loading', () => {
    mockUseDashboardSummary.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
    } as unknown as UseQueryResult<AttentionSlice>);

    const { container } = render(<NeedsAttentionPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a reassuring message when nothing needs attention', () => {
    mockUseDashboardSummary.mockReturnValue(
      withSlice({ pendingVendors: 0, activeRecalls: 0, urgentAlerts: 0 }),
    );

    render(<NeedsAttentionPanel />);

    expect(screen.getByText('Nothing needs attention right now.')).toBeInTheDocument();
  });

  it('lists pending vendors, active recalls, and urgent alerts with correct singular/plural copy and links', () => {
    mockUseDashboardSummary.mockReturnValue(
      withSlice({ pendingVendors: 1, activeRecalls: 3, urgentAlerts: 3 }),
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
