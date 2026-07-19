import { Parish, VendorStatus, VendorTier, type Paginated, type VendorAdmin } from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useUpdateVendorStatus, useVendors } from '@/lib/hooks/use-vendors';
import { VendorsView } from './vendors-view';

jest.mock('@/lib/hooks/use-vendors');

const push = jest.fn();
let searchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/vendors',
  useSearchParams: () => searchParams,
}));

const mockUseVendors = useVendors as jest.MockedFunction<typeof useVendors>;
const mockUseUpdateVendorStatus = useUpdateVendorStatus as jest.MockedFunction<typeof useUpdateVendorStatus>;

function vendor(overrides: Partial<VendorAdmin> = {}): VendorAdmin {
  return {
    id: 'vendor-1',
    userId: 'user-1',
    businessName: "Vera's Catch",
    description: null,
    phone: null,
    parish: Parish.KINGSTON,
    logoUrl: null,
    status: VendorStatus.PENDING,
    tier: VendorTier.COMMUNITY_FISHER,
    complianceScore: 82,
    termsAcceptedAt: '2026-01-01T00:00:00.000Z',
    primaryZoneId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function withVendorsData(data: Paginated<VendorAdmin>): UseQueryResult<Paginated<VendorAdmin>> {
  return {
    data,
    isPending: false,
    isError: false,
    refetch: jest.fn(),
  } as unknown as UseQueryResult<Paginated<VendorAdmin>>;
}

describe('VendorsView', () => {
  const mutate = jest.fn();

  beforeEach(() => {
    searchParams = new URLSearchParams();
    push.mockReset();
    mutate.mockReset();
    mockUseUpdateVendorStatus.mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateVendorStatus>);
  });

  it('shows a loading state', () => {
    mockUseVendors.mockReturnValue({ isPending: true, isError: false } as UseQueryResult<Paginated<VendorAdmin>>);

    render(<VendorsView />);

    expect(screen.getByText('Vendors')).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    const refetch = jest.fn();
    mockUseVendors.mockReturnValue({
      isPending: false,
      isError: true,
      refetch,
    } as unknown as UseQueryResult<Paginated<VendorAdmin>>);
    const user = userEvent.setup();

    render(<VendorsView />);

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when no vendors match the filters', () => {
    mockUseVendors.mockReturnValue(withVendorsData({ items: [], total: 0, page: 1, pageSize: 20 }));

    render(<VendorsView />);

    expect(screen.getByText('No vendors match these filters.')).toBeInTheDocument();
  });

  it('renders vendor rows with business name, status, and tier', () => {
    mockUseVendors.mockReturnValue(
      withVendorsData({ items: [vendor()], total: 1, page: 1, pageSize: 20 }),
    );

    render(<VendorsView />);

    expect(screen.getByText("Vera's Catch")).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Community Fisher')).toBeInTheDocument();
  });

  it('approves a vendor without a confirmation dialog', async () => {
    mockUseVendors.mockReturnValue(
      withVendorsData({ items: [vendor({ status: VendorStatus.SUSPENDED })], total: 1, page: 1, pageSize: 20 }),
    );
    const user = userEvent.setup();

    render(<VendorsView />);

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(mutate).toHaveBeenCalledWith({ id: 'vendor-1', status: VendorStatus.APPROVED });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('requires confirmation with consequence-specific copy before suspending a vendor', async () => {
    mockUseVendors.mockReturnValue(
      withVendorsData({ items: [vendor({ status: VendorStatus.APPROVED })], total: 1, page: 1, pageSize: 20 }),
    );
    const user = userEvent.setup();

    render(<VendorsView />);

    await user.click(screen.getByRole('button', { name: 'Suspend' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/prevent new listings and order fulfillment/i)).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    expect(mutate).toHaveBeenCalledWith({ id: 'vendor-1', status: VendorStatus.SUSPENDED });
  });

  it('updates the URL when the status filter changes, resetting to page 1', async () => {
    searchParams = new URLSearchParams('page=2');
    mockUseVendors.mockReturnValue(withVendorsData({ items: [vendor()], total: 1, page: 1, pageSize: 20 }));
    const user = userEvent.setup();

    render(<VendorsView />);

    await user.click(screen.getByRole('combobox', { name: /status/i }));
    await user.click(await screen.findByRole('option', { name: 'Approved' }));

    expect(push).toHaveBeenCalledWith('/vendors?status=APPROVED');
  });
});
