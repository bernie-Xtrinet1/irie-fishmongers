import { FoodSafetyStatus, SeafoodStorageType, WeightUnit, type Paginated, type SeafoodLotAdmin } from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useUpdateLotStatus, useQuarantinedLots } from '@/lib/hooks/use-cold-chain';
import { QuarantinedLotsSection } from './quarantined-lots-section';

jest.mock('@/lib/hooks/use-cold-chain');

const push = jest.fn();
let searchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/cold-chain',
  useSearchParams: () => searchParams,
}));

const mockUseQuarantinedLots = useQuarantinedLots as jest.MockedFunction<typeof useQuarantinedLots>;
const mockUseUpdateLotStatus = useUpdateLotStatus as jest.MockedFunction<typeof useUpdateLotStatus>;

function lot(overrides: Partial<SeafoodLotAdmin> = {}): SeafoodLotAdmin {
  return {
    id: 'lot-1',
    lotNumber: 'LOT-2026-000001',
    vendorId: 'vendor-1',
    species: 'Snapper',
    storageType: SeafoodStorageType.FRESH,
    catchDate: '2026-01-01T00:00:00.000Z',
    catchLocation: null,
    landingSite: null,
    weight: '15',
    weightUnit: WeightUnit.POUNDS,
    freshnessGrade: null,
    qualityScore: null,
    foodSafetyStatus: FoodSafetyStatus.QUARANTINED,
    statusNotes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    retentionExpiresAt: '2033-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function withData(data: Paginated<SeafoodLotAdmin>): UseQueryResult<Paginated<SeafoodLotAdmin>> {
  return { data, isPending: false, isError: false, refetch: jest.fn() } as unknown as UseQueryResult<
    Paginated<SeafoodLotAdmin>
  >;
}

describe('QuarantinedLotsSection', () => {
  const mutateAsync = jest.fn();

  beforeEach(() => {
    searchParams = new URLSearchParams();
    push.mockReset();
    mutateAsync.mockReset().mockResolvedValue(lot());
    mockUseUpdateLotStatus.mockReturnValue({
      mutateAsync,
    } as unknown as ReturnType<typeof useUpdateLotStatus>);
  });

  it('shows an empty state when no lots are quarantined', () => {
    mockUseQuarantinedLots.mockReturnValue(withData({ items: [], total: 0, page: 1, pageSize: 20 }));

    render(<QuarantinedLotsSection />);

    expect(screen.getByText('No lots are currently quarantined.')).toBeInTheDocument();
  });

  it('renders lot rows with lot number and species', () => {
    mockUseQuarantinedLots.mockReturnValue(withData({ items: [lot()], total: 1, page: 1, pageSize: 20 }));

    render(<QuarantinedLotsSection />);

    expect(screen.getByText('LOT-2026-000001')).toBeInTheDocument();
    expect(screen.getByText('Snapper')).toBeInTheDocument();
  });

  it('submits an updated status with an optional reason', async () => {
    mockUseQuarantinedLots.mockReturnValue(withData({ items: [lot()], total: 1, page: 1, pageSize: 20 }));
    const user = userEvent.setup();

    render(<QuarantinedLotsSection />);

    await user.click(screen.getByRole('button', { name: 'Update status' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update lot status' });
    await user.type(within(dialog).getByLabelText('Reason (optional)'), 'Cleared after corrective review');
    await user.click(within(dialog).getByRole('button', { name: 'Update status' }));

    expect(mutateAsync).toHaveBeenCalledWith({
      id: 'lot-1',
      input: { status: FoodSafetyStatus.SAFE, reason: 'Cleared after corrective review' },
    });
  });

  it('rejects a reason shorter than 5 characters', async () => {
    mockUseQuarantinedLots.mockReturnValue(withData({ items: [lot()], total: 1, page: 1, pageSize: 20 }));
    const user = userEvent.setup();

    render(<QuarantinedLotsSection />);

    await user.click(screen.getByRole('button', { name: 'Update status' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update lot status' });
    await user.type(within(dialog).getByLabelText('Reason (optional)'), 'no');
    await user.click(within(dialog).getByRole('button', { name: 'Update status' }));

    expect(await within(dialog).findByText('Reason must be at least 5 characters if provided')).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
