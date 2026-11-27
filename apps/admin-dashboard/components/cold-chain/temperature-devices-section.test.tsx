import { DeviceStatus, type TemperatureDevice } from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useCalibrateTemperatureDevice, useTemperatureDevices } from '@/lib/hooks/use-cold-chain';
import { useTelemetryDevicesOverview } from '@/lib/hooks/use-telemetry';
import { TemperatureDevicesSection } from './temperature-devices-section';

jest.mock('@/lib/hooks/use-cold-chain');
jest.mock('@/lib/hooks/use-telemetry', () => ({
  useTelemetryDevicesOverview: jest.fn(() => ({ data: undefined, isPending: false, isError: false })),
  useSensorTelemetryHistory: jest.fn(() => ({ data: undefined, isPending: false, isError: false })),
  useUploadEyeAppCsvRecovery: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, isError: false, data: undefined })),
}));

const mockUseTemperatureDevices = useTemperatureDevices as jest.MockedFunction<typeof useTemperatureDevices>;
const mockUseCalibrateTemperatureDevice = useCalibrateTemperatureDevice as jest.MockedFunction<
  typeof useCalibrateTemperatureDevice
>;
const mockUseTelemetryDevicesOverview = useTelemetryDevicesOverview as jest.MockedFunction<
  typeof useTelemetryDevicesOverview
>;

function device(overrides: Partial<TemperatureDevice> = {}): TemperatureDevice {
  return {
    id: 'device-1',
    vendorId: 'vendor-1',
    deviceCode: 'DEV-001',
    status: DeviceStatus.ACTIVE,
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    isOffline: false,
    lastCalibratedAt: '2025-12-01T00:00:00.000Z',
    calibrationDueAt: '2026-03-01T00:00:00.000Z',
    isCalibrationOverdue: false,
    createdAt: '2025-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function withData(data: TemperatureDevice[]): UseQueryResult<TemperatureDevice[]> {
  return { data, isPending: false, isError: false, refetch: jest.fn() } as unknown as UseQueryResult<
    TemperatureDevice[]
  >;
}

describe('TemperatureDevicesSection', () => {
  const mutate = jest.fn();

  beforeEach(() => {
    mutate.mockReset();
    mockUseCalibrateTemperatureDevice.mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useCalibrateTemperatureDevice>);
  });

  it('shows an empty state when no devices are registered', () => {
    mockUseTemperatureDevices.mockReturnValue(withData([]));

    render(<TemperatureDevicesSection />);

    expect(screen.getByText('No temperature devices registered yet.')).toBeInTheDocument();
  });

  it('flags an overdue-calibration device', () => {
    mockUseTemperatureDevices.mockReturnValue(withData([device({ isCalibrationOverdue: true })]));

    render(<TemperatureDevicesSection />);

    expect(screen.getByText('DEV-001')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });

  it('flags an offline device', () => {
    mockUseTemperatureDevices.mockReturnValue(withData([device({ isOffline: true })]));

    render(<TemperatureDevicesSection />);

    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('calibrates a device directly with no confirmation dialog', async () => {
    mockUseTemperatureDevices.mockReturnValue(withData([device()]));
    const user = userEvent.setup();

    render(<TemperatureDevicesSection />);

    await user.click(screen.getByRole('button', { name: 'Calibrate' }));

    expect(mutate).toHaveBeenCalledWith('device-1');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows linked seafood lots, stale/LTE-offline distinction, and flagged unmatched readings', () => {
    mockUseTemperatureDevices.mockReturnValue(withData([]));
    mockUseTelemetryDevicesOverview.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        generatedAt: '2026-11-27T08:00:00.000Z',
        trackers: [
          {
            id: 'trk-1',
            imei: '356307042449901',
            hardwareModel: 'TELTONIKA_FMC234',
            firmwareVersion: '03.29.00.Rev.18',
            simCarrier: 'Digicel Jamaica LTE',
            protocol: 'TELTONIKA_CODEC_8E' as never,
            status: DeviceStatus.ACTIVE,
            fleetAssetId: 'bike-1',
            licensePlate: 'MB-101',
            gpsStatus: 'OFFLINE',
            lastCapturedAt: '2026-11-27T07:10:00.000Z',
            lastReceivedAt: '2026-11-27T07:10:05.000Z',
            activeCredentialCount: 1,
          },
        ],
        sensors: [
          {
            id: 'sens-1',
            deviceCode: 'EYE-MOTO-01',
            hardwareModel: 'TELTONIKA_EYE_BTSMP1_EN12830',
            bleMacAddress: '7C:D9:F4:AA:00:01',
            sensorSlot: 1,
            firmwareVersion: '1.12.5',
            status: DeviceStatus.ACTIVE,
            vendorId: null,
            vendorName: null,
            compartmentId: 'comp-1',
            compartmentCode: 'IGLOO-MOTO-01',
            coolerCode: 'IGLOO-MOTO-01',
            compartmentLabel: 'Igloo Cooler',
            storageType: 'FRESH',
            fleetAssetId: 'bike-1',
            licensePlate: 'MB-101',
            vehicleAssetType: 'MOTORBIKE',
            vehicleGpsStatus: 'OFFLINE',
            lastTemperatureC: 2.8,
            lastCapturedAt: '2026-11-27T07:10:00.000Z',
            lastReceivedAt: '2026-11-27T07:10:05.000Z',
            lastDelaySeconds: 10,
            lastHumidityPct: 76,
            lastBatteryMv: 2950,
            lastDoorOpen: false,
            lastMovement: true,
            lastGapKind: null,
            lastSignalMissingAt: null,
            reportingStatus: 'STALE',
            gapClassification: 'VEHICLE_OFFLINE',
            onboardLots: [
              {
                assignmentId: 'a-1',
                lotId: 'lot-1',
                lotNumber: 'LOT-BIKE-01',
                species: 'Red Snapper',
                quantityUnits: 4,
                remainingUnits: 4,
                deliveryId: 'del-1',
                loadedAt: '2026-11-27T07:00:00.000Z',
              },
            ],
          },
        ],
        unmatchedFrames: [
          {
            id: 'frm-unmatched',
            capturedAt: '2026-11-27T06:55:00.000Z',
            receivedAt: '2026-11-27T06:55:02.000Z',
            cargoTempC: 3.4,
            reason: 'NO_ACTIVE_LOT_AT_CAPTURE_TIME',
            sensorId: 'sens-1',
            sensorDeviceCode: 'EYE-MOTO-01',
            compartmentId: 'comp-1',
            compartmentCode: 'IGLOO-MOTO-01',
            coolerCode: 'IGLOO-MOTO-01',
            fleetAssetId: 'bike-1',
            licensePlate: 'MB-101',
          },
        ],
      },
    } as unknown as ReturnType<typeof useTelemetryDevicesOverview>);

    render(<TemperatureDevicesSection />);

    expect(screen.getAllByText('IGLOO-MOTO-01').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/LOT-BIKE-01/)).toBeInTheDocument();
    expect(screen.getByText('Vehicle LTE Offline')).toBeInTheDocument();
    expect(screen.getByText('Flagged Unmatched Cooler Readings (1)')).toBeInTheDocument();
  });
});
