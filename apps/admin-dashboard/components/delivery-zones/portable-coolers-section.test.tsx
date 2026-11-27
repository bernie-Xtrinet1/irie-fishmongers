import {
  CompartmentKind,
  DeviceStatus,
  FleetAssetStatus,
  FleetAssetType,
  FleetOwnership,
  type DeliveryZone,
  type PortableCoolerSummary,
} from '@iriefishmongers/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useFleetAssets } from '@/lib/hooks/use-fleet';
import {
  useAssignCoolerVehicle,
  useCompartments,
  useCreateCompartment,
  useRegisterCargoSensor,
  useUnassignCoolerVehicle,
} from '@/lib/hooks/use-telemetry';
import { PortableCoolersSection } from './portable-coolers-section';

jest.mock('@/lib/hooks/use-fleet');
jest.mock('@/lib/hooks/use-telemetry');

const mockUseFleetAssets = useFleetAssets as jest.MockedFunction<typeof useFleetAssets>;
const mockUseCompartments = useCompartments as jest.MockedFunction<typeof useCompartments>;
const mockUseCreateCompartment = useCreateCompartment as jest.MockedFunction<typeof useCreateCompartment>;
const mockUseAssignCoolerVehicle = useAssignCoolerVehicle as jest.MockedFunction<typeof useAssignCoolerVehicle>;
const mockUseUnassignCoolerVehicle = useUnassignCoolerVehicle as jest.MockedFunction<typeof useUnassignCoolerVehicle>;
const mockUseRegisterCargoSensor = useRegisterCargoSensor as jest.MockedFunction<typeof useRegisterCargoSensor>;

const zones: DeliveryZone[] = [
  { id: 'zone-1', name: 'Zone 1', code: 'ZONE_1', description: null, active: true, createdAt: '', updatedAt: '' },
];

function cooler(overrides: Partial<PortableCoolerSummary> = {}): PortableCoolerSummary {
  return {
    id: 'comp-1',
    compartmentCode: 'IGLOO-MOTO-01',
    coolerCode: 'IGLOO-MOTO-01',
    compartmentKind: CompartmentKind.PORTABLE_COOLER,
    label: 'Igloo Marine 48qt',
    storageType: 'FRESH',
    targetMinC: 0,
    targetMaxC: 4,
    active: true,
    fleetAssetId: 'bike-1',
    licensePlate: 'MB-101',
    assetType: 'MOTORBIKE',
    sensors: [
      {
        id: 'sens-1',
        deviceCode: 'EYE-MOTO-01',
        hardwareModel: 'TELTONIKA_EYE_BTSMP1_EN12830',
        bleMacAddress: '7C:D9:F4:AA:00:01',
        sensorSlot: 1,
        status: DeviceStatus.ACTIVE,
        lastTemperatureC: 2.3,
        lastCapturedAt: '2026-11-27T08:00:00.000Z',
        reportingStatus: 'REPORTING',
      },
    ],
    assignmentHistory: [
      {
        id: 'hist-1',
        compartmentId: 'comp-1',
        fleetAssetId: 'bike-1',
        licensePlate: 'MB-101',
        assetType: 'MOTORBIKE',
        sensorSlot: 1,
        assignedAt: '2026-11-27T07:00:00.000Z',
        unassignedAt: null,
        notes: 'Morning Kingston motorbike route',
      },
    ],
    ...overrides,
  };
}

describe('PortableCoolersSection', () => {
  beforeEach(() => {
    mockUseFleetAssets.mockReturnValue({
      data: {
        items: [
          {
            id: 'bike-1',
            zoneId: 'zone-1',
            assetType: FleetAssetType.MOTORBIKE,
            ownership: FleetOwnership.COMPANY_OWNED,
            licensePlate: 'MB-101',
            capacityLbs: '120',
            coldChainCapable: true,
            status: FleetAssetStatus.ACTIVE,
            currentDriverId: null,
            createdAt: '',
            updatedAt: '',
          },
          {
            id: 'van-1',
            zoneId: 'zone-1',
            assetType: FleetAssetType.VAN,
            ownership: FleetOwnership.COMPANY_OWNED,
            licensePlate: 'VN-202',
            capacityLbs: '1500',
            coldChainCapable: true,
            status: FleetAssetStatus.ACTIVE,
            currentDriverId: null,
            createdAt: '',
            updatedAt: '',
          },
        ],
        total: 2,
        page: 1,
        pageSize: 100,
      },
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useFleetAssets>);

    mockUseCreateCompartment.mockReturnValue({ mutateAsync: jest.fn(), isPending: false } as unknown as ReturnType<
      typeof useCreateCompartment
    >);
    mockUseAssignCoolerVehicle.mockReturnValue({ mutateAsync: jest.fn(), isPending: false } as unknown as ReturnType<
      typeof useAssignCoolerVehicle
    >);
    mockUseUnassignCoolerVehicle.mockReturnValue({ mutateAsync: jest.fn(), isPending: false } as unknown as ReturnType<
      typeof useUnassignCoolerVehicle
    >);
    mockUseRegisterCargoSensor.mockReturnValue({ mutateAsync: jest.fn(), isPending: false } as unknown as ReturnType<
      typeof useRegisterCargoSensor
    >);
  });

  it('renders portable cooler IDs, paired EYE sensor metadata, and opens assignment history', async () => {
    mockUseCompartments.mockReturnValue({
      data: [cooler()],
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useCompartments>);

    const user = userEvent.setup();
    render(<PortableCoolersSection zones={zones} />);

    expect(screen.getByText('IGLOO-MOTO-01')).toBeInTheDocument();
    expect(screen.getByText('EYE-MOTO-01')).toBeInTheDocument();
    expect(screen.getByText('MB-101')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'History (1)' }));
    expect(screen.getByText('Morning Kingston motorbike route')).toBeInTheDocument();
  });
});
