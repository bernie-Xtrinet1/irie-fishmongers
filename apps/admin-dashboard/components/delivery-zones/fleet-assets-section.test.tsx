import {
  FleetAssetStatus,
  FleetAssetType,
  FleetOwnership,
  type DeliveryZone,
  type FleetAsset,
  type Paginated,
} from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useFleetAssets, useUpdateFleetAssetStatus } from '@/lib/hooks/use-fleet';
import { FleetAssetsSection } from './fleet-assets-section';

jest.mock('@/lib/hooks/use-fleet');

const push = jest.fn();
let searchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/delivery-zones',
  useSearchParams: () => searchParams,
}));

const mockUseFleetAssets = useFleetAssets as jest.MockedFunction<typeof useFleetAssets>;
const mockUseUpdateFleetAssetStatus = useUpdateFleetAssetStatus as jest.MockedFunction<typeof useUpdateFleetAssetStatus>;

const zones: DeliveryZone[] = [
  { id: 'zone-1', name: 'Zone 1', code: 'ZONE_1', description: null, active: true, createdAt: '', updatedAt: '' },
];

function asset(overrides: Partial<FleetAsset> = {}): FleetAsset {
  return {
    id: 'asset-1',
    zoneId: 'zone-1',
    assetType: FleetAssetType.VAN,
    ownership: FleetOwnership.COMPANY_OWNED,
    licensePlate: 'ZN 1234',
    capacityLbs: '2000.00',
    coldChainCapable: true,
    status: FleetAssetStatus.ACTIVE,
    currentDriverId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function withData(data: Paginated<FleetAsset>): UseQueryResult<Paginated<FleetAsset>> {
  return { data, isPending: false, isError: false, refetch: jest.fn() } as unknown as UseQueryResult<
    Paginated<FleetAsset>
  >;
}

describe('FleetAssetsSection', () => {
  const mutate = jest.fn();

  beforeEach(() => {
    searchParams = new URLSearchParams();
    push.mockReset();
    mutate.mockReset();
    mockUseUpdateFleetAssetStatus.mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateFleetAssetStatus>);
  });

  it('shows an empty state when no assets match the filters', () => {
    mockUseFleetAssets.mockReturnValue(withData({ items: [], total: 0, page: 1, pageSize: 20 }));

    render(<FleetAssetsSection zones={zones} />);

    expect(screen.getByText('No fleet assets match these filters.')).toBeInTheDocument();
  });

  it('renders asset rows with license plate, zone name, and status', () => {
    mockUseFleetAssets.mockReturnValue(withData({ items: [asset()], total: 1, page: 1, pageSize: 20 }));

    render(<FleetAssetsSection zones={zones} />);

    expect(screen.getByText('ZN 1234')).toBeInTheDocument();
    expect(screen.getByText('Zone 1')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('reactivates an asset without a confirmation dialog', async () => {
    mockUseFleetAssets.mockReturnValue(
      withData({ items: [asset({ status: FleetAssetStatus.MAINTENANCE })], total: 1, page: 1, pageSize: 20 }),
    );
    const user = userEvent.setup();

    render(<FleetAssetsSection zones={zones} />);

    await user.click(screen.getByRole('button', { name: 'Activate' }));

    expect(mutate).toHaveBeenCalledWith({ id: 'asset-1', status: FleetAssetStatus.ACTIVE });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('requires confirmation before retiring an asset', async () => {
    mockUseFleetAssets.mockReturnValue(withData({ items: [asset()], total: 1, page: 1, pageSize: 20 }));
    const user = userEvent.setup();

    render(<FleetAssetsSection zones={zones} />);

    await user.click(screen.getByRole('button', { name: 'Retire' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/permanently removes it from delivery scheduling/i)).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Retire' }));
    expect(mutate).toHaveBeenCalledWith({ id: 'asset-1', status: FleetAssetStatus.RETIRED });
  });
});
