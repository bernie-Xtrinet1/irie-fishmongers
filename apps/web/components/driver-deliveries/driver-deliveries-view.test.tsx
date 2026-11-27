import {
  CompartmentKind,
  CustomerAcceptanceStatus,
  DriverAvailabilityStatus,
  DriverStatus,
  FleetAssetStatus,
  FleetAssetType,
  Parish,
  ProductUnit,
  ProofOfDeliveryType,
  UserRole,
  UserStatus,
  VehicleOwnership,
  VehicleType,
  type AvailableDelivery,
  type AuthUser,
  type DriverDelivery,
  type DriverProfile,
} from '@iriefishmongers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  claimAvailableDelivery,
  fetchAvailableDeliveries,
  fetchDriverLoadingContext,
  fetchMyDeliveries,
  fetchMyDriverProfile,
  recordCargoHandover,
  recordCargoPickup,
  recordManualTemperatureCheck,
  updateDeliverySchedule,
  updateDeliveryStatus,
  updateMyDriverAvailability,
} from '@/lib/api/drivers';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth/auth-context';

import { DriverDeliveriesView } from './driver-deliveries-view';
import { formatJamaicaDateTime, fromJamaicaDateTimeInput } from './driver-deliveries-helpers';

jest.mock('@/lib/auth/auth-context');
jest.mock('@/lib/api/drivers');

const mockUseAuth = jest.mocked(useAuth);
const mockFetchProfile = jest.mocked(fetchMyDriverProfile);
const mockUpdateAvailability = jest.mocked(updateMyDriverAvailability);
const mockFetchAvailable = jest.mocked(fetchAvailableDeliveries);
const mockClaim = jest.mocked(claimAvailableDelivery);
const mockFetchMine = jest.mocked(fetchMyDeliveries);
const mockUpdateSchedule = jest.mocked(updateDeliverySchedule);
const mockUpdateStatus = jest.mocked(updateDeliveryStatus);
const mockFetchLoadingContext = jest.mocked(fetchDriverLoadingContext);
const mockRecordCargoPickup = jest.mocked(recordCargoPickup);
const mockRecordCargoHandover = jest.mocked(recordCargoHandover);
const mockRecordManualTemp = jest.mocked(recordManualTemperatureCheck);

const driverUser: AuthUser = {
  id: 'driver-user-1',
  email: 'driver@example.com',
  firstName: 'Dana',
  lastName: 'Driver',
  phone: '+18765550000',
  status: UserStatus.ACTIVE,
  roles: [UserRole.DRIVER],
  createdAt: '2026-08-31T00:00:00.000Z',
};

const baseProfile: DriverProfile = {
  id: 'driver-1',
  userId: 'driver-user-1',
  licensePlate: 'AB 1234',
  vehicleType: VehicleType.CAR,
  vehicleOwnership: VehicleOwnership.PERSONAL_VEHICLE,
  status: DriverStatus.APPROVED,
  availabilityStatus: DriverAvailabilityStatus.ONLINE,
  capacityLbs: null,
  coldChainCapable: true,
  assignedZoneId: null,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
};

function makeAvailablePickup(overrides: Partial<AvailableDelivery> = {}): AvailableDelivery {
  return {
    vendorOrderId: 'vo-1',
    pickupVendorName: 'Harbour Fresh',
    pickupParish: Parish.KINGSTON,
    items: [{ productName: 'Red Snapper', unit: ProductUnit.PER_POUND, quantity: 3 }],
    readyForPickupAt: '2026-11-21T15:00:00.000Z',
    ...overrides,
  };
}

function makeDelivery(overrides: Partial<DriverDelivery> = {}): DriverDelivery {
  return {
    id: 'del-1',
    vendorOrderId: 'vo-1',
    driverId: 'driver-1',
    stage: 'ASSIGNED',
    pickupVendorName: 'Harbour Fresh',
    pickupParish: Parish.KINGSTON,
    items: [{ productName: 'Red Snapper', unit: ProductUnit.PER_POUND, quantity: 3 }],
    deliveryAddressLine1: '10 Ocean Blvd',
    deliveryAddressLine2: null,
    deliveryParish: Parish.ST_ANDREW,
    deliveryPhone: '+18765559999',
    scheduledPickupWindowStart: null,
    scheduledPickupWindowEnd: null,
    customerDeliveryWindowStart: null,
    customerDeliveryWindowEnd: null,
    vendorConfirmedAt: null,
    vendorConfirmedById: null,
    customerAcceptanceStatus: CustomerAcceptanceStatus.PENDING,
    customerAcceptedAt: null,
    customerRejectedAt: null,
    rejectionReason: null,
    assignedAt: '2026-11-21T15:10:00.000Z',
    pickedUpAt: null,
    deliveredAt: null,
    failedAt: null,
    failureReason: null,
    proofType: null,
    proofUrl: null,
    exceptions: [],
    routeHistory: null,
    ...overrides,
  };
}

function renderWithQueryClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <DriverDeliveriesView />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('DriverDeliveriesView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('formats Jamaica timestamps explicitly with EST/UTC-5 timezone label regardless of host TZ', () => {
    expect(formatJamaicaDateTime('2026-11-21T15:00:00.000Z')).toContain('Jamaica EST (UTC-5)');
    expect(formatJamaicaDateTime('2026-11-21T15:00:00.000Z')).toContain('10:00');
    expect(fromJamaicaDateTimeInput('2026-11-21T10:00')).toBe('2026-11-21T15:00:00.000Z');
  });

  it('prompts unauthenticated visitors to sign in with driver returnUrl', () => {
    mockUseAuth.mockReturnValue({
      status: 'unauthenticated',
      user: null,
      login: jest.fn(),
      logout: jest.fn(),
    });

    renderWithQueryClient();

    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?returnUrl=%2Fdriver%2Fdeliveries',
    );
  });

  it('denies non-driver accounts (customer or vendor) cleanly', () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: { ...driverUser, roles: [UserRole.CUSTOMER, UserRole.VENDOR] },
      login: jest.fn(),
      logout: jest.fn(),
    });

    renderWithQueryClient();

    expect(
      screen.getByText('This page is available only to signed-in driver accounts.'),
    ).toBeInTheDocument();
    expect(mockFetchProfile).not.toHaveBeenCalled();
  });

  it('explains missing driver profile when /drivers/me returns 404', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: driverUser,
      login: jest.fn(),
      logout: jest.fn(),
    });
    mockFetchProfile.mockRejectedValue(new ApiError('No driver profile exists', 404));

    renderWithQueryClient();

    await waitFor(() => {
      expect(screen.getByText('Driver profile not registered yet')).toBeInTheDocument();
    });
    expect(screen.getByText(/POST \/api\/v1\/drivers/i)).toBeInTheDocument();
    expect(mockFetchAvailable).not.toHaveBeenCalled();
  });

  it('shows awaiting approval next steps and skips /delivery/available when PENDING', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: driverUser,
      login: jest.fn(),
      logout: jest.fn(),
    });
    mockFetchProfile.mockResolvedValue({ ...baseProfile, status: DriverStatus.PENDING });
    mockFetchMine.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });

    renderWithQueryClient();

    await waitFor(() => {
      expect(screen.getByText('Awaiting administrator approval')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Go online' })).not.toBeInTheDocument();
    expect(mockFetchAvailable).not.toHaveBeenCalled();
  });

  it('allows an approved driver to toggle online and handles concurrent-claim 409 conflict', async () => {
    const user = userEvent.setup();
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: driverUser,
      login: jest.fn(),
      logout: jest.fn(),
    });
    mockFetchProfile
      .mockResolvedValueOnce({
        ...baseProfile,
        availabilityStatus: DriverAvailabilityStatus.OFFLINE,
      })
      .mockResolvedValue(baseProfile);
    mockUpdateAvailability.mockResolvedValue(baseProfile);
    mockFetchAvailable
      .mockResolvedValueOnce({ items: [makeAvailablePickup()], total: 1, page: 1, pageSize: 20 })
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    mockFetchMine.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
    mockClaim.mockRejectedValueOnce(
      new ApiError('This delivery has already been claimed by another driver', 409),
    );

    renderWithQueryClient();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Go online' })).toBeInTheDocument();
    });
    expect(mockFetchAvailable).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Go online' }));
    expect(mockUpdateAvailability).toHaveBeenCalledWith('ONLINE');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Claim pickup' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Claim pickup' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This delivery has already been claimed by another driver. We refreshed the pickup list.',
      );
    });
  });

  it('puts active delivery first above past deliveries, schedules Jamaica windows, and transitions PICKED_UP -> DELIVERED', async () => {
    const user = userEvent.setup();
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: driverUser,
      login: jest.fn(),
      logout: jest.fn(),
    });
    mockFetchProfile.mockResolvedValue({
      ...baseProfile,
      availabilityStatus: DriverAvailabilityStatus.BUSY,
    });

    const pastFailed = makeDelivery({
      id: 'del-old',
      pickupVendorName: 'Old Pier Vendor',
      stage: 'FAILED',
      assignedAt: '2026-11-21T16:00:00.000Z',
      failedAt: '2026-11-21T16:30:00.000Z',
      failureReason: 'Customer unreachable',
    });
    const activeAssigned = makeDelivery({
      id: 'del-active',
      pickupVendorName: 'Active Catch Vendor',
      stage: 'ASSIGNED',
      assignedAt: '2026-11-21T14:00:00.000Z',
    });

    mockFetchMine
      .mockResolvedValueOnce({
        items: [pastFailed, activeAssigned],
        total: 2,
        page: 1,
        pageSize: 50,
      })
      .mockResolvedValueOnce({
        items: [
          {
            ...activeAssigned,
            scheduledPickupWindowStart: '2026-11-21T15:00:00.000Z',
            scheduledPickupWindowEnd: '2026-11-21T16:00:00.000Z',
          },
          pastFailed,
        ],
        total: 2,
        page: 1,
        pageSize: 50,
      })
      .mockResolvedValue({
        items: [
          {
            ...activeAssigned,
            stage: 'PICKED_UP',
            pickedUpAt: '2026-11-21T15:15:00.000Z',
          },
          pastFailed,
        ],
        total: 2,
        page: 1,
        pageSize: 50,
      });

    mockUpdateSchedule.mockResolvedValue({
      ...activeAssigned,
      scheduledPickupWindowStart: '2026-11-21T15:00:00.000Z',
      scheduledPickupWindowEnd: '2026-11-21T16:00:00.000Z',
    });
    mockUpdateStatus.mockResolvedValue({
      ...activeAssigned,
      stage: 'PICKED_UP',
      pickedUpAt: '2026-11-21T15:15:00.000Z',
    });

    renderWithQueryClient();

    await waitFor(() => {
      expect(screen.getByText('Pickup: Active Catch Vendor')).toBeInTheDocument();
    });

    // Active delivery must precede past failed delivery in DOM order
    const headings = screen.getAllByRole('heading', { level: 4 }).map((el) => el.textContent);
    expect(headings).toEqual(['Pickup: Active Catch Vendor', 'Pickup: Old Pier Vendor']);
    // Busy profile disables manual availability toggle and skips /delivery/available
    expect(screen.queryByRole('button', { name: 'Go offline' })).not.toBeInTheDocument();
    expect(mockFetchAvailable).not.toHaveBeenCalled();

    // Open schedule form and save Jamaica-time windows
    await user.click(screen.getByRole('button', { name: 'Set pickup & delivery windows' }));
    fireEvent.change(screen.getByLabelText(/Pickup window start/i), {
      target: { value: '2026-11-21T10:00' },
    });
    fireEvent.change(screen.getByLabelText(/Pickup window end/i), {
      target: { value: '2026-11-21T11:00' },
    });
    await user.click(screen.getByRole('button', { name: 'Save schedule windows' }));

    await waitFor(() => {
      expect(mockUpdateSchedule).toHaveBeenCalledWith('del-active', {
        scheduledPickupWindowStart: '2026-11-21T15:00:00.000Z',
        scheduledPickupWindowEnd: '2026-11-21T16:00:00.000Z',
      });
    });

    // Transition ASSIGNED -> PICKED_UP
    await user.click(screen.getByRole('button', { name: 'Mark picked up' }));
    await waitFor(() => {
      expect(mockUpdateStatus).toHaveBeenCalledWith('del-active', { action: 'PICKED_UP' });
    });

    // Once PICKED_UP, Mark delivered form appears and submits HTTPS proof
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Mark delivered' })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Mark delivered' }));
    fireEvent.change(screen.getByLabelText(/Proof reference URL/i), {
      target: { value: 'https://cdn.example.com/proof/signature-123.png' },
    });
    await user.click(screen.getByRole('button', { name: 'Confirm delivery' }));

    await waitFor(() => {
      expect(mockUpdateStatus).toHaveBeenLastCalledWith('del-active', {
        action: 'DELIVERED',
        proofType: ProofOfDeliveryType.PHOTO,
        proofUrl: 'https://cdn.example.com/proof/signature-123.png',
      });
    });
  }, 15_000);

  it('supports reporting delivery failure and enforces minimum reason length', async () => {
    const user = userEvent.setup();
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: driverUser,
      login: jest.fn(),
      logout: jest.fn(),
    });
    mockFetchProfile.mockResolvedValue({
      ...baseProfile,
      availabilityStatus: DriverAvailabilityStatus.BUSY,
    });
    const active = makeDelivery({ id: 'del-fail', stage: 'PICKED_UP' });
    mockFetchMine
      .mockResolvedValueOnce({ items: [active], total: 1, page: 1, pageSize: 50 })
      .mockResolvedValue({
        items: [{ ...active, stage: 'FAILED', failureReason: 'Customer gate locked' }],
        total: 1,
        page: 1,
        pageSize: 50,
      });
    mockUpdateStatus.mockResolvedValue({
      ...active,
      stage: 'FAILED',
      failureReason: 'Customer gate locked',
    });

    renderWithQueryClient();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Report failure' })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Report failure' }));

    fireEvent.change(screen.getByLabelText(/Failure reason/i), { target: { value: 'abc' } });
    await user.click(screen.getByRole('button', { name: 'Confirm failure' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Failure reason must be at least 5 characters.',
    );

    fireEvent.change(screen.getByLabelText(/Failure reason/i), {
      target: { value: 'Customer gate locked' },
    });
    await user.click(screen.getByRole('button', { name: 'Confirm failure' }));

    await waitFor(() => {
      expect(mockUpdateStatus).toHaveBeenCalledWith('del-fail', {
        action: 'FAILED',
        failureReason: 'Customer gate locked',
      });
    });
  }, 15_000);

  it('handles mid-session access revocation cleanly on 403', async () => {
    const mockRefreshSession = jest.fn().mockResolvedValue(null);
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: driverUser,
      login: jest.fn(),
      logout: jest.fn(),
      refreshSession: mockRefreshSession,
    });
    mockFetchProfile.mockRejectedValue(new ApiError('Forbidden', 403));

    renderWithQueryClient();

    await waitFor(() => {
      expect(
        screen.getByText('Driver access is unavailable for this session.'),
      ).toBeInTheDocument();
    });
  });

  it('confirms pickup cooler ID & lot custody and keeps manual product checks distinct', async () => {
    const user = userEvent.setup();
    const assigned = makeDelivery({
      id: 'del-cooler',
      stage: 'ASSIGNED',
      items: [
        {
          productName: 'Red Snapper',
          unit: ProductUnit.PER_POUND,
          quantity: 4,
          lotId: 'lot-1',
          lotNumber: 'LOT-SNAPPER-01',
          species: 'Red Snapper',
          storageType: 'FRESH',
        },
      ],
    });
    mockFetchProfile.mockResolvedValue({ ...baseProfile, availabilityStatus: DriverAvailabilityStatus.BUSY });
    mockFetchMine.mockResolvedValue({ items: [assigned], total: 1, page: 1, pageSize: 50 });
    mockFetchLoadingContext.mockResolvedValue({
      deliveryId: 'del-cooler',
      vendorOrderId: 'vo-1',
      driverId: 'driver-1',
      fleetAssets: [
        {
          id: 'bike-1',
          licensePlate: 'MB-101',
          assetType: FleetAssetType.MOTORBIKE,
          status: FleetAssetStatus.ACTIVE,
          trackers: [{ id: 'trk-1', imei: '356307042449901', hardwareModel: 'TELTONIKA_FMC234' }],
          compartments: [
            {
              id: 'comp-1',
              compartmentCode: 'IGLOO-MOTO-01',
              coolerCode: 'IGLOO-MOTO-01',
              compartmentKind: CompartmentKind.PORTABLE_COOLER,
              label: 'Igloo Marine 48qt',
              storageType: 'FRESH',
              sensors: [
                {
                  id: 'sens-1',
                  deviceCode: 'EYE-MOTO-01',
                  sensorSlot: 1,
                  reportingStatus: 'REPORTING',
                  lastTemperatureC: 2.3,
                },
              ],
            },
          ],
        },
      ],
      items: [
        {
          orderItemId: 'oi-1',
          productName: 'Red Snapper',
          quantity: 4,
          lotId: 'lot-1',
          lotNumber: 'LOT-SNAPPER-01',
          species: 'Red Snapper',
          storageType: 'FRESH',
        },
      ],
      openAssignments: [],
    });
    mockRecordCargoPickup.mockResolvedValue({});
    mockRecordCargoHandover.mockResolvedValue({});
    mockRecordManualTemp.mockResolvedValue({});

    renderWithQueryClient();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Cooler & Lot Cold-Chain Custody/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Cooler & Lot Cold-Chain Custody/i }));

    await waitFor(() => {
      expect(screen.getByText(/Confirm Pickup & Cooler Loading/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Confirm Pickup & Cooler ID/i }));
    await waitFor(() => {
      expect(mockRecordCargoPickup).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'del-cooler',
          fleetAssetId: 'bike-1',
          compartmentId: 'comp-1',
          lots: [{ lotId: 'lot-1', quantityUnits: 4 }],
        }),
      );
    });

    fireEvent.change(screen.getByPlaceholderText(/Core °C/i), { target: { value: '2.1' } });
    await user.click(screen.getByRole('button', { name: /Save Manual Product Check/i }));
    await waitFor(() => {
      expect(mockRecordManualTemp).toHaveBeenCalledWith(
        expect.objectContaining({
          lotId: 'lot-1',
          checkpoint: 'DRIVER_PICKUP',
          temperatureC: 2.1,
        }),
      );
    });
  }, 15_000);
});
