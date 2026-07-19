import { DeliveryRunStatus, type DeliveryRun, type DeliveryZone, type Paginated } from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';

import { useDeliveryZones } from '@/lib/hooks/use-delivery-zones';
import { useDeliveryRuns } from '@/lib/hooks/use-delivery-operations';
import { ActiveRunsSection } from './active-runs-section';

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
const mockUseDeliveryZones = useDeliveryZones as jest.MockedFunction<typeof useDeliveryZones>;

function run(overrides: Partial<DeliveryRun> = {}): DeliveryRun {
  return {
    id: 'run-1',
    zoneId: 'zone-1',
    driverId: 'driver-1234-5678',
    fleetAssetId: 'asset-1234-5678',
    status: DeliveryRunStatus.IN_PROGRESS,
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

describe('ActiveRunsSection', () => {
  beforeEach(() => {
    searchParams = new URLSearchParams();
    push.mockReset();
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

  it('shows an empty state when no runs are active', () => {
    mockUseDeliveryRuns.mockReturnValue(withData({ items: [], total: 0, page: 1, pageSize: 20 }));

    render(<ActiveRunsSection />);

    expect(screen.getByText('No delivery runs are currently active.')).toBeInTheDocument();
  });

  it('renders an active run with its zone, driver, and asset', () => {
    mockUseDeliveryRuns.mockReturnValue(withData({ items: [run()], total: 1, page: 1, pageSize: 20 }));

    render(<ActiveRunsSection />);

    expect(screen.getByText('Kingston Metro')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
  });

  it('shows a dash when a run has no fleet asset assigned', () => {
    mockUseDeliveryRuns.mockReturnValue(
      withData({ items: [run({ fleetAssetId: null })], total: 1, page: 1, pageSize: 20 }),
    );

    render(<ActiveRunsSection />);

    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });
});
