import {
  AlertSeverity,
  DeviceStatus,
  EmergencyResponseStatus,
  TelemetryGapKind,
  TelemetryProtocol,
  TemperatureReadingOrigin,
} from '@iriefishmongers/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { DeliveryTelemetryDialog } from '@/components/delivery-operations/delivery-telemetry-dialog';
import { LiveFleetMap } from '@/components/delivery-operations/live-fleet-map';
import { SensorTelemetryDialog } from '@/components/cold-chain/sensor-telemetry-dialog';
import {
  useDeliveryTelemetryDetail,
  useSensorTelemetryHistory,
  useUploadEyeAppCsvRecovery,
} from '@/lib/hooks/use-telemetry';

jest.mock('@/lib/hooks/use-telemetry');

const mockUseDeliveryTelemetryDetail = useDeliveryTelemetryDetail as jest.MockedFunction<
  typeof useDeliveryTelemetryDetail
>;
const mockUseSensorTelemetryHistory = useSensorTelemetryHistory as jest.MockedFunction<
  typeof useSensorTelemetryHistory
>;
const mockUseUploadEyeAppCsvRecovery = useUploadEyeAppCsvRecovery as jest.MockedFunction<
  typeof useUploadEyeAppCsvRecovery
>;

describe('Live Telemetry Admin Views', () => {
  it('renders vehicle markers, coordinates, capture timestamps, and stale warnings on LiveFleetMap', () => {
    render(
      <LiveFleetMap
        vehicles={[
          {
            fleetAssetId: 'veh-1',
            licensePlate: 'VN-JM01',
            assetType: 'VAN',
            gpsStatus: 'STALE',
            lastLatitude: 17.99702,
            lastLongitude: -76.79358,
            lastSpeedKph: 45,
            lastHeadingDeg: 90,
            lastSatellites: 10,
            lastGpsCapturedAt: '2026-11-25T10:00:00.000Z',
            lastTelemetryReceivedAt: '2026-11-25T10:00:05.000Z',
            lastTelemetryDelayed: false,
            trackerImei: '356307042441013',
            compartments: [
              {
                id: 'comp-1',
                compartmentCode: 'CHILLER-MAIN',
                label: 'Main Chiller',
                storageType: 'FRESH',
                sensors: [
                  {
                    id: 'sens-1',
                    deviceCode: 'EYE-001',
                    lastTemperatureC: 2.35,
                    lastCapturedAt: '2026-11-25T10:00:00.000Z',
                    lastDelaySeconds: 5,
                    reportingStatus: 'STALE',
                  },
                ],
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getAllByText('VN-JM01').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/17\.99702, -76\.79358/)).toBeInTheDocument();
    expect(screen.getByText(/2\.35 °C/)).toBeInTheDocument();
    expect(screen.getByText(/Location is stale/)).toBeInTheDocument();
  });

  it('displays separate manual product checks vs automated cargo-air readings and gaps in DeliveryTelemetryDialog', () => {
    mockUseDeliveryTelemetryDetail.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        delivery: {
          id: 'del-1',
          vendorOrderId: 'vo-1',
          status: 'IN_TRANSIT',
          deliveryAddress: '12 Harbour St, KINGSTON',
          assignedAt: '2026-11-25T09:00:00.000Z',
          pickedUpAt: '2026-11-25T09:15:00.000Z',
          deliveredAt: null,
          vendorName: "Miss Joyce's Catch",
          driverName: 'Dan Driver',
        },
        vehicle: {
          id: 'veh-1',
          licensePlate: 'VN-JM01',
          assetType: 'VAN',
          gpsStatus: 'LIVE',
          lastLatitude: 17.99702,
          lastLongitude: -76.79358,
          lastSpeedKph: 38,
          lastHeadingDeg: 180,
          lastSatellites: 11,
          lastGpsCapturedAt: '2026-11-25T09:30:00.000Z',
          lastTelemetryReceivedAt: '2026-11-25T09:30:02.000Z',
          lastTelemetryDelayed: false,
        },
        assignments: [
          {
            id: 'assign-1',
            lotId: 'lot-1',
            lotNumber: 'LOT-SNAPPER-01',
            species: 'Red Snapper',
            storageType: 'FRESH',
            foodSafetyStatus: 'QUARANTINED',
            compartmentId: 'comp-1',
            compartmentCode: 'CHILLER-MAIN',
            compartmentLabel: 'Main Chiller',
            trackerImei: '356307042441013',
            sensorId: 'sens-1',
            sensorDeviceCode: 'EYE-001',
            sensorReportingStatus: 'REPORTING',
            sensorLastTempC: 11.4,
            quantityUnits: 10,
            handedOverQuantity: 4,
            loadedAt: '2026-11-25T09:15:00.000Z',
            unloadedAt: null,
            pickupCustodyEventId: 'cust-1',
            handoverCustodyEventId: null,
          },
        ],
        manualProductChecks: [],
        cargoAirReadings: [
          {
            id: 'read-1',
            lotId: 'lot-1',
            lotNumber: 'LOT-SNAPPER-01',
            deviceId: 'sens-1',
            deviceCode: 'EYE-001',
            checkpoint: 'IN_TRANSIT',
            temperatureC: '11.40',
            origin: TemperatureReadingOrigin.CARGO_AIR_SENSOR,
            capturedAt: '2026-11-25T09:25:00.000Z',
            receivedAt: '2026-11-25T09:30:00.000Z',
            isDelayed: true,
            latitude: 17.99702,
            longitude: -76.79358,
          },
        ],
        complianceChecklist: {
          pickupManualCheckRecorded: false,
          deliveryManualCheckRecorded: false,
          continuousSensorActive: true,
          manualChecksDistinctNotice:
            'Continuous cargo-air sensor readings never automatically satisfy required manual pickup or delivery product-temperature checks.',
        },
        alerts: [
          {
            id: 'alert-1',
            lotId: 'lot-1',
            severity: AlertSeverity.EMERGENCY,
            actualC: '11.40',
            resolved: false,
            createdAt: '2026-11-25T09:30:00.000Z',
            readingOrigin: TemperatureReadingOrigin.CARGO_AIR_SENSOR,
            readingCapturedAt: '2026-11-25T09:25:00.000Z',
            isDelayed: true,
            emergencyResponse: {
              id: 'resp-1',
              status: EmergencyResponseStatus.OPEN,
              acknowledgedAt: null,
              resolvedAt: null,
            },
          },
        ],
        telemetryGaps: [
          {
            frameId: 'frame-1',
            gapKind: TelemetryGapKind.LTE_BUFFERED_RECOVERY,
            capturedAt: '2026-11-25T09:25:00.000Z',
            receivedAt: '2026-11-25T09:30:00.000Z',
            delaySeconds: 300,
            latitude: 17.99702,
            longitude: -76.79358,
          },
        ],
        gpsTrail: [],
      },
    } as never);

    render(<DeliveryTelemetryDialog deliveryId="del-1" onClose={jest.fn()} />);

    expect(screen.getByText(/Manual Pickup Check: Required \/ Pending/)).toBeInTheDocument();
    expect(screen.getByText(/LOT-SNAPPER-01/)).toBeInTheDocument();
    expect(screen.getByText(/4 \/ 10/)).toBeInTheDocument();
    expect(screen.getByText(/Delayed/)).toBeInTheDocument();
    expect(screen.getByText(/Emergency Response: Open/i)).toBeInTheDocument();
  });

  it('supports EYE App CSV recovery uploads inside SensorTelemetryDialog', async () => {
    const mutateAsync = jest.fn().mockResolvedValue({
      sensorId: 'sens-1',
      deviceCode: 'EYE-001',
      totalRows: 1,
      importedFrames: 1,
      deduplicatedFrames: 0,
      unmatchedFrames: 0,
      lotReadingsCreated: 1,
      alertsCreated: 0,
    });

    mockUseSensorTelemetryHistory.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        sensor: {
          id: 'sens-1',
          deviceCode: 'EYE-001',
          hardwareModel: 'TELTONIKA_EYE_BTSMP1_EN12830',
          bleMacAddress: '7C:D9:F4:11:22:33',
          sensorSlot: 1,
          fleetAssetId: 'veh-1',
          licensePlate: 'VN-JM01',
          compartmentCode: 'CHILLER-MAIN',
          compartmentLabel: 'Main Chiller',
          lastTemperatureC: 2.4,
          lastCapturedAt: '2026-11-25T10:00:00.000Z',
          lastReceivedAt: '2026-11-25T10:00:05.000Z',
          lastDelaySeconds: 5,
          reportingStatus: 'REPORTING',
        },
        frames: [
          {
            id: 'f-1',
            protocol: TelemetryProtocol.TELTONIKA_CODEC_8E,
            origin: TemperatureReadingOrigin.CARGO_AIR_SENSOR,
            capturedAt: '2026-11-25T10:00:00.000Z',
            receivedAt: '2026-11-25T10:00:05.000Z',
            delaySeconds: 5,
            isDelayed: false,
            cargoTempC: 2.4,
            humidityPct: 77,
            doorOpen: false,
            movement: true,
            batteryMv: 2950,
            latitude: 17.997,
            longitude: -76.793,
            gnssValid: true,
            gapKind: null,
            linkedLotsCount: 1,
            alertsCount: 0,
          },
        ],
      },
    } as never);

    mockUseUploadEyeAppCsvRecovery.mockReturnValue({
      mutateAsync,
      isPending: false,
      isError: false,
      data: undefined,
    } as never);

    render(<SensorTelemetryDialog sensorId="sens-1" onClose={jest.fn()} />);

    const textarea = screen.getByLabelText(/Import Teltonika EYE App EN12830 Recovery CSV/i);
    fireEvent.change(textarea, {
      target: { value: 'Timestamp,Temperature\n2026-11-25T10:05:00Z,3.1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Import Recovery CSV/i }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        sensorId: 'sens-1',
        csvContent: 'Timestamp,Temperature\n2026-11-25T10:05:00Z,3.1',
        notes: undefined,
      }),
    );
    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(DeviceStatus.ACTIVE).toBe('ACTIVE');
  });
});
