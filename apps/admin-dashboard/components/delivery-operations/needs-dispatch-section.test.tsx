import { DeliveryRunStatus, type DeliveryRun, type DeliveryZone, type Paginated } from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useDeliveryZones } from '@/lib/hooks/use-delivery-zones';
import { useDeliveryRuns, useDispatchDeliveryRun } from '@/lib/hooks/use-delivery-operations';
import { NeedsDispatchSection } from './needs-dispatch-section';

jest.mock('@/lib/hooks/use-delivery-operations');
jest.mock('@/lib/hooks/use-delivery-zones');

const push = jest.fn();
let searchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/delivery-operations',
  useSearchParams: () => searchParams,
}));

const mockUseDeliveryRuns = useDeliveryRuns as jest.MockedFunction<typeof useDeliveryRuns>;
const mockUseDispatchDeliveryRun = useDispatchDeliveryRun as jest.MockedFunction<typeof useDispatchDeliveryRun>;
const mockUseDeliveryZones = useDeliveryZones as jest.MockedFunction<typeof useDeliveryZones>;

function run(overrides: Partial<DeliveryRun> = {}): DeliveryRun {
  return {
    id: 'run-1',
    zoneId: 'zone-1',
    driverId: null,
    fleetAssetId: null,
    status: DeliveryRunStatus.PLANNED,
    stops: [{ id: 'stop-1', deliveryId: 'delivery-1', sequence: 1 }],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}

function withData(data: Paginated<DeliveryRun>): UseQueryResult<Paginated<DeliveryRun>> {
  return { data, isPending: false, isError: false, refetch: jest.fn() } as unknown as UseQueryResult<
    Paginated<DeliveryRun>
  >;
}

function withZones(data: DeliveryZone[]): UseQueryResult<DeliveryZone[]> {
  return { data, isPending: false, isError: false } as unknown as UseQueryResult<DeliveryZone[]>;
}

describe('NeedsDispatchSection', () => {
  const mutate = jest.fn();

  beforeEach(() => {
    searchParams = new URLSearchParams();
    push.mockReset();
    mutate.mockReset();
    mockUseDispatchDeliveryRun.mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useDispatchDeliveryRun>);
    mockUseDeliveryZones.mockReturnValue(
      withZones([
        {
          id: 'zone-1',
          name: 'Kingston Metro',
          code: 'ZONE_1',
          description: null,
          active: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    );
  });

  it('shows an empty state when no runs need dispatch', () => {
    mockUseDeliveryRuns.mockReturnValue(withData({ items: [], total: 0, page: 1, pageSize: 20 }));

    render(<NeedsDispatchSection />);

    expect(screen.getByText('No delivery runs are waiting for dispatch.')).toBeInTheDocument();
  });

  it('renders a run row with its zone name and stop count', () => {
    mockUseDeliveryRuns.mockReturnValue(withData({ items: [run()], total: 1, page: 1, pageSize: 20 }));

    render(<NeedsDispatchSection />);

    expect(screen.getByText('Kingston Metro')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('requires confirmation before dispatching a run', async () => {
    mockUseDeliveryRuns.mockReturnValue(withData({ items: [run()], total: 1, page: 1, pageSize: 20 }));
    const user = userEvent.setup();

    render(<NeedsDispatchSection />);

    await user.click(screen.getByRole('button', { name: 'Dispatch' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/best-fit eligible driver/i)).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Dispatch' }));
    expect(mutate).toHaveBeenCalledWith('run-1');
  });
});
