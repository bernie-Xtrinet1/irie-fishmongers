import { DeviceStatus, type TemperatureDevice } from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useCalibrateTemperatureDevice, useTemperatureDevices } from '@/lib/hooks/use-cold-chain';
import { TemperatureDevicesSection } from './temperature-devices-section';

jest.mock('@/lib/hooks/use-cold-chain');

const mockUseTemperatureDevices = useTemperatureDevices as jest.MockedFunction<typeof useTemperatureDevices>;
const mockUseCalibrateTemperatureDevice = useCalibrateTemperatureDevice as jest.MockedFunction<
  typeof useCalibrateTemperatureDevice
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
});
