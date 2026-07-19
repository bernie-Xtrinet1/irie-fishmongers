import { AlertSeverity, type Paginated, type TemperatureAlert } from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useResolveTemperatureAlert, useTemperatureAlerts } from '@/lib/hooks/use-cold-chain';
import { TemperatureAlertsSection } from './temperature-alerts-section';

jest.mock('@/lib/hooks/use-cold-chain');

const push = jest.fn();
let searchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/cold-chain',
  useSearchParams: () => searchParams,
}));

const mockUseTemperatureAlerts = useTemperatureAlerts as jest.MockedFunction<typeof useTemperatureAlerts>;
const mockUseResolveTemperatureAlert = useResolveTemperatureAlert as jest.MockedFunction<typeof useResolveTemperatureAlert>;

function alert(overrides: Partial<TemperatureAlert> = {}): TemperatureAlert {
  return {
    id: 'alert-1',
    readingId: 'reading-1',
    lotId: 'lot-1',
    severity: AlertSeverity.CRITICAL,
    actualC: '15',
    resolved: false,
    resolvedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function withData(data: Paginated<TemperatureAlert>): UseQueryResult<Paginated<TemperatureAlert>> {
  return { data, isPending: false, isError: false, refetch: jest.fn() } as unknown as UseQueryResult<
    Paginated<TemperatureAlert>
  >;
}

describe('TemperatureAlertsSection', () => {
  const mutate = jest.fn();

  beforeEach(() => {
    searchParams = new URLSearchParams();
    push.mockReset();
    mutate.mockReset();
    mockUseResolveTemperatureAlert.mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useResolveTemperatureAlert>);
  });

  it('shows an empty state when no alerts match the filters', () => {
    mockUseTemperatureAlerts.mockReturnValue(withData({ items: [], total: 0, page: 1, pageSize: 20 }));

    render(<TemperatureAlertsSection />);

    expect(screen.getByText('No temperature alerts match these filters.')).toBeInTheDocument();
  });

  it('renders alert rows with severity and resolved status', () => {
    mockUseTemperatureAlerts.mockReturnValue(withData({ items: [alert()], total: 1, page: 1, pageSize: 20 }));

    render(<TemperatureAlertsSection />);

    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.getByText('Unresolved')).toBeInTheDocument();
  });

  it('does not show a resolve action for an already-resolved alert', () => {
    mockUseTemperatureAlerts.mockReturnValue(
      withData({ items: [alert({ resolved: true, resolvedAt: '2026-01-02T00:00:00.000Z' })], total: 1, page: 1, pageSize: 20 }),
    );

    render(<TemperatureAlertsSection />);

    expect(screen.getByText('Resolved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });

  it('requires confirmation before resolving an alert', async () => {
    mockUseTemperatureAlerts.mockReturnValue(withData({ items: [alert()], total: 1, page: 1, pageSize: 20 }));
    const user = userEvent.setup();

    render(<TemperatureAlertsSection />);

    await user.click(screen.getByRole('button', { name: 'Resolve' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/does not change the affected lot's food safety status/i)).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }));
    expect(mutate).toHaveBeenCalledWith('alert-1');
  });
});
