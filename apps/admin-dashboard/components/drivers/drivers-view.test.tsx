import {
  DriverAvailabilityStatus,
  DriverStatus,
  VehicleOwnership,
  VehicleType,
  type DriverAdmin,
  type Paginated,
} from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useDriverPerformance, useDrivers, useUpdateDriverStatus } from '@/lib/hooks/use-drivers';
import { DriversView } from './drivers-view';

jest.mock('@/lib/hooks/use-drivers');

const push = jest.fn();
let searchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/drivers',
  useSearchParams: () => searchParams,
}));

const mockUseDrivers = useDrivers as jest.MockedFunction<typeof useDrivers>;
const mockUseUpdateDriverStatus = useUpdateDriverStatus as jest.MockedFunction<typeof useUpdateDriverStatus>;
const mockUseDriverPerformance = useDriverPerformance as jest.MockedFunction<typeof useDriverPerformance>;

function driver(overrides: Partial<DriverAdmin> = {}): DriverAdmin {
  return {
    id: 'driver-1',
    userId: 'user-1',
    licensePlate: 'AN 1111',
    vehicleType: VehicleType.CAR,
    vehicleOwnership: VehicleOwnership.PERSONAL_VEHICLE,
    status: DriverStatus.PENDING,
    availabilityStatus: DriverAvailabilityStatus.OFFLINE,
    capacityLbs: '200.00',
    coldChainCapable: true,
    assignedZoneId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function withDriversData(data: Paginated<DriverAdmin>): UseQueryResult<Paginated<DriverAdmin>> {
  return {
    data,
    isPending: false,
    isError: false,
    refetch: jest.fn(),
  } as unknown as UseQueryResult<Paginated<DriverAdmin>>;
}

describe('DriversView', () => {
  const mutate = jest.fn();

  beforeEach(() => {
    searchParams = new URLSearchParams();
    push.mockReset();
    mutate.mockReset();
    mockUseUpdateDriverStatus.mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateDriverStatus>);
    mockUseDriverPerformance.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
    } as unknown as ReturnType<typeof useDriverPerformance>);
  });

  it('shows a loading state', () => {
    mockUseDrivers.mockReturnValue({ isPending: true, isError: false } as UseQueryResult<Paginated<DriverAdmin>>);

    render(<DriversView />);

    expect(screen.getByText('Drivers')).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    const refetch = jest.fn();
    mockUseDrivers.mockReturnValue({
      isPending: false,
      isError: true,
      refetch,
    } as unknown as UseQueryResult<Paginated<DriverAdmin>>);
    const user = userEvent.setup();

    render(<DriversView />);

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when no drivers match the filters', () => {
    mockUseDrivers.mockReturnValue(withDriversData({ items: [], total: 0, page: 1, pageSize: 20 }));

    render(<DriversView />);

    expect(screen.getByText('No drivers match these filters.')).toBeInTheDocument();
  });

  it('renders driver rows with license plate, vehicle, and status', () => {
    mockUseDrivers.mockReturnValue(withDriversData({ items: [driver()], total: 1, page: 1, pageSize: 20 }));

    render(<DriversView />);

    expect(screen.getByText('AN 1111')).toBeInTheDocument();
    expect(screen.getByText('Car · Personal Vehicle')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Capable')).toBeInTheDocument();
  });

  it('approves a driver without a confirmation dialog', async () => {
    mockUseDrivers.mockReturnValue(
      withDriversData({ items: [driver({ status: DriverStatus.SUSPENDED })], total: 1, page: 1, pageSize: 20 }),
    );
    const user = userEvent.setup();

    render(<DriversView />);

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(mutate).toHaveBeenCalledWith({ id: 'driver-1', status: DriverStatus.APPROVED });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('requires confirmation with consequence-specific copy before suspending a driver', async () => {
    mockUseDrivers.mockReturnValue(
      withDriversData({ items: [driver({ status: DriverStatus.APPROVED })], total: 1, page: 1, pageSize: 20 }),
    );
    const user = userEvent.setup();

    render(<DriversView />);

    await user.click(screen.getByRole('button', { name: 'Suspend' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/prevents new delivery assignments/i)).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    expect(mutate).toHaveBeenCalledWith({ id: 'driver-1', status: DriverStatus.SUSPENDED });
  });

  it('opens the performance dialog for a driver', async () => {
    mockUseDrivers.mockReturnValue(withDriversData({ items: [driver()], total: 1, page: 1, pageSize: 20 }));
    const user = userEvent.setup();

    render(<DriversView />);

    await user.click(screen.getByRole('button', { name: 'Performance' }));

    expect(await screen.findByText('Performance metrics')).toBeInTheDocument();
  });

  it('updates the URL when the status filter changes, resetting to page 1', async () => {
    searchParams = new URLSearchParams('page=2');
    mockUseDrivers.mockReturnValue(withDriversData({ items: [driver()], total: 1, page: 1, pageSize: 20 }));
    const user = userEvent.setup();

    render(<DriversView />);

    await user.click(screen.getByRole('combobox', { name: /status/i }));
    await user.click(await screen.findByRole('option', { name: 'Approved' }));

    expect(push).toHaveBeenCalledWith('/drivers?status=APPROVED');
  });
});
