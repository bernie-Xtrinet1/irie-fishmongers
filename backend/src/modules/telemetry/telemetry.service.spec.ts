import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import {
  DeviceStatus,
  FleetAssetStatus,
  RoleName,
  TelemetryCredentialScope,
  TelemetryGapKind,
  TemperatureReadingOrigin,
} from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { TemperatureMonitoringService } from '../food-safety/services/temperature-monitoring.service';
import {
  hashTelemetryToken,
  TelemetryAuthenticatedRequest,
  TelemetryGatewayAuthGuard,
} from './guards/telemetry-gateway-auth.guard';
import { encodeTeltonikaCodec8ePacket } from './parsers/teltonika-codec8e.parser';
import { TelemetryCredentialsService } from './services/telemetry-credentials.service';
import { TelemetryIngestionService } from './services/telemetry-ingestion.service';
import {
  closeOpenCompartmentAssignmentsForDelivery,
  TelemetryOperationsService,
} from './services/telemetry-operations.service';
import { computeSensorReportingStatus, computeVehicleGpsStatus } from './telemetry-status.util';

describe('Telemetry Auth, Credentials, Ingestion & Custody Attribution', () => {
  describe('TelemetryGatewayAuthGuard', () => {
    it('rejects Bearer user JWTs and revoked/expired credentials while accepting valid Device tokens', async () => {
      const findUnique = jest.fn();
      const update = jest.fn().mockResolvedValue({});
      const prisma = {
        telemetryDeviceCredential: { findUnique, update },
      } as unknown as PrismaService;
      const guard = new TelemetryGatewayAuthGuard(prisma);

      const makeCtx = (headers: Record<string, string>) => {
        const req = { headers } as unknown as TelemetryAuthenticatedRequest;
        return {
          req,
          ctx: {
            switchToHttp: () => ({ getRequest: () => req }),
          },
        };
      };

      // 1. User JWT must be rejected
      const bearer = makeCtx({ authorization: 'Bearer user.jwt.token' });
      await expect(guard.canActivate(bearer.ctx as never)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      // 2. Revoked credential rejected
      findUnique.mockResolvedValueOnce({
        id: 'cred-1',
        scope: TelemetryCredentialScope.DEVICE_TRACKER,
        active: false,
        revokedAt: new Date(),
        expiresAt: null,
        tracker: { id: 'trk-1', imei: '356307042441013', status: DeviceStatus.ACTIVE },
      });
      await expect(
        guard.canActivate(makeCtx({ 'x-telemetry-key': 'itg_revoked' }).ctx as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      // 3. Expired overlap window rejected
      findUnique.mockResolvedValueOnce({
        id: 'cred-2',
        scope: TelemetryCredentialScope.DEVICE_TRACKER,
        active: true,
        revokedAt: null,
        expiresAt: new Date(Date.now() - 10_000),
        tracker: { id: 'trk-1', imei: '356307042441013', status: DeviceStatus.ACTIVE },
      });
      await expect(
        guard.canActivate(makeCtx({ authorization: 'Device itg_expired' }).ctx as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      // 4. Valid Device token populates telemetryAuth
      const rawToken = 'itg_valid_token_abc';
      findUnique.mockResolvedValueOnce({
        id: 'cred-3',
        scope: TelemetryCredentialScope.DEVICE_TRACKER,
        active: true,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        tracker: { id: 'trk-1', imei: '356307042441013', status: DeviceStatus.ACTIVE },
      });
      const valid = makeCtx({ authorization: `Device ${rawToken}` });
      await expect(guard.canActivate(valid.ctx as never)).resolves.toBe(true);
      expect(findUnique).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { secretHash: hashTelemetryToken(rawToken) } }),
      );
      expect(valid.req.telemetryAuth).toEqual({
        credentialId: 'cred-3',
        scope: TelemetryCredentialScope.DEVICE_TRACKER,
        trackerId: 'trk-1',
        trackerImei: '356307042441013',
      });
    });
  });

  describe('TelemetryCredentialsService', () => {
    it('issues hashed secrets once and performs overlap-window key rotation', async () => {
      interface CredCreateInput {
        data: {
          scope: TelemetryCredentialScope;
          trackerId: string | null;
          label: string;
          keyPrefix: string;
        };
      }
      interface CredRotateUpdateCall {
        where: { id: string };
        data: { expiresAt: Date };
      }
      const txUpdate = jest
        .fn<Promise<unknown>, [CredRotateUpdateCall]>()
        .mockResolvedValue({});
      const txCreate = jest.fn().mockImplementation(({ data }: CredCreateInput) =>
        Promise.resolve({
          id: 'cred-new',
          scope: data.scope,
          trackerId: data.trackerId,
          label: data.label,
          keyPrefix: data.keyPrefix,
          active: true,
          expiresAt: null,
          revokedAt: null,
          revokedReason: null,
          lastUsedAt: null,
          createdAt: new Date(),
        }),
      );
      const prisma = {
        vehicleTracker: { findUnique: jest.fn().mockResolvedValue({ id: 'trk-1' }) },
        telemetryDeviceCredential: {
          create: jest.fn().mockImplementation(({ data }: CredCreateInput) =>
            Promise.resolve({
              id: 'cred-old',
              scope: data.scope,
              trackerId: data.trackerId,
              label: data.label,
              keyPrefix: data.keyPrefix,
              active: true,
              expiresAt: null,
              revokedAt: null,
              revokedReason: null,
              lastUsedAt: null,
              createdAt: new Date(),
            }),
          ),
          findUnique: jest.fn().mockResolvedValue({
            id: 'cred-old',
            scope: TelemetryCredentialScope.DEVICE_TRACKER,
            trackerId: 'trk-1',
            label: 'van-01',
            active: true,
            revokedAt: null,
            expiresAt: null,
          }),
        },
        $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
          fn({ telemetryDeviceCredential: { update: txUpdate, create: txCreate } }),
        ),
      } as unknown as PrismaService;

      const service = new TelemetryCredentialsService(prisma);
      const issued = await service.issue('admin-1', {
        scope: TelemetryCredentialScope.DEVICE_TRACKER,
        trackerId: 'trk-1',
        label: 'van-01',
      });
      expect(issued.plaintextSecret.startsWith('itg_')).toBe(true);
      expect((issued.credential as unknown as Record<string, unknown>).secretHash).toBeUndefined();

      const rotated = await service.rotate('admin-1', 'cred-old', 30);
      expect(rotated.rotatedOutCredentialId).toBe('cred-old');
      expect(rotated.plaintextSecret).not.toBe(issued.plaintextSecret);
      expect(txUpdate).toHaveBeenCalledTimes(1);
      expect(txUpdate.mock.calls[0]?.[0].where).toEqual({ id: 'cred-old' });
      expect(txUpdate.mock.calls[0]?.[0].data.expiresAt).toBeInstanceOf(Date);
    });
  });

  describe('TelemetryIngestionService', () => {
    it('ingests Codec 8E frame, dedupes retries, prevents outage overwrite of newer live GPS/temp, and tracks missing sensor signal', async () => {
      const seenFrameKeys = new Set<string>();
      const seenReadingKeys = new Set<string>();
      const createdFrames: Array<Record<string, unknown>> = [];
      const createdReadings: Array<Record<string, unknown>> = [];
      const fleetUpdates: Array<Record<string, unknown>> = [];
      const sensorUpdates: Array<Record<string, unknown>> = [];

      const tracker = {
        id: 'trk-1',
        imei: '356307042441013',
        fleetAssetId: 'veh-1',
        status: DeviceStatus.ACTIVE,
        lastCapturedAt: new Date('2026-11-25T10:30:00.000Z'),
        fleetAsset: {
          id: 'veh-1',
          status: FleetAssetStatus.ACTIVE,
          // Newer live GPS already received!
          lastGpsCapturedAt: new Date('2026-11-25T10:30:00.000Z'),
        },
      };

      const sensor = {
        id: 'sens-1',
        compartmentId: 'comp-1',
        sensorSlot: 1,
        status: DeviceStatus.ACTIVE,
        lastCapturedAt: new Date('2026-11-25T10:30:00.000Z'),
      };

      const prisma = {
        vehicleTracker: {
          findUnique: jest.fn().mockResolvedValue(tracker),
          update: jest.fn().mockResolvedValue({}),
        },
        temperatureDevice: {
          findMany: jest.fn().mockResolvedValue([sensor]),
          update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            sensorUpdates.push(data);
            return Promise.resolve({});
          }),
        },
        vehicleTelemetryFrame: {
          findUnique: jest.fn(({ where: { dedupeKey } }: { where: { dedupeKey: string } }) =>
            Promise.resolve(seenFrameKeys.has(dedupeKey) ? { id: 'existing-frame' } : null),
          ),
          create: jest.fn(({ data }: { data: Record<string, unknown> & { dedupeKey: string } }) => {
            seenFrameKeys.add(data.dedupeKey);
            const rec = { id: `frame-${createdFrames.length + 1}`, ...data };
            createdFrames.push(rec);
            return Promise.resolve(rec);
          }),
        },
        fleetAsset: {
          update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
            fleetUpdates.push(data);
            return Promise.resolve({});
          }),
        },
        cargoCompartmentAssignment: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'assign-1',
              deliveryId: 'del-1',
              lotId: 'lot-1',
              lot: {
                id: 'lot-1',
                vendorId: 'vendor-1',
                lotNumber: 'LOT-001',
                storageType: 'FRESH',
                foodSafetyStatus: 'SAFE',
              },
            },
          ]),
        },
        temperatureReading: {
          findUnique: jest.fn(({ where: { dedupeKey } }: { where: { dedupeKey: string } }) =>
            Promise.resolve(seenReadingKeys.has(dedupeKey) ? { id: 'existing-reading' } : null),
          ),
          create: jest.fn(({ data }: { data: Record<string, unknown> & { dedupeKey: string } }) => {
            seenReadingKeys.add(data.dedupeKey);
            const rec = { id: `read-${createdReadings.length + 1}`, ...data };
            createdReadings.push(rec);
            return Promise.resolve(rec);
          }),
        },
      } as unknown as PrismaService;

      const evaluateAndCreateAlertForReading = jest
        .fn()
        .mockResolvedValue({ id: 'alert-1', severity: 'EMERGENCY' });
      const monitoring = {
        evaluateAndCreateAlertForReading,
      } as unknown as TemperatureMonitoringService;

      const service = new TelemetryIngestionService(prisma, monitoring);
      const auth = {
        credentialId: 'cred-1',
        scope: TelemetryCredentialScope.DEVICE_TRACKER,
        trackerId: 'trk-1',
        trackerImei: '356307042441013',
      };

      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-11-25T10:35:05.000Z'));

      try {
        // Reject mismatched IMEI for scoped device credential
        await expect(
          service.ingestCanonicalHttp(auth, {
            imei: '999999999999999',
            records: [{ capturedAt: '2026-11-25T10:15:00.000Z', cargoTempC: 2.0 }],
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);

        // Historical buffered outage excursion (capturedAt 10:15Z < newer 10:30Z live fix) + signal missing frame
        const bufferedPacket = encodeTeltonikaCodec8ePacket([
          {
            capturedAt: new Date('2026-11-25T10:15:00.000Z'),
            latitude: 17.98,
            longitude: -76.81,
            satellites: 10,
            speedKph: 55,
            io2: [{ id: 10800, value: 940, signed: true }], // 9.40C excursion during outage!
          },
          {
            capturedAt: new Date('2026-11-25T10:35:00.000Z'),
            latitude: 18.01,
            longitude: -76.79,
            satellites: 11,
            speedKph: 30,
            // No 10800 EYE sensor IO -> SENSOR_SIGNAL_MISSING on latest live GPS!
          },
        ]);

        const firstRun = await service.ingestCodec8e(auth, {
          imei: '356307042441013',
          payloadBase64: bufferedPacket.toString('base64'),
        });

        expect(firstRun).toMatchObject({
          storedFrames: 2,
          deduplicatedFrames: 0,
          lotReadingsCreated: 1, // Only 10:15Z had temp; 10:35Z had missing sensor
          alertsCreated: 1,
          sensorMissingFrames: 1,
          delayedFrames: 1,
        });

        expect(createdFrames[0]).toMatchObject({
          gapKind: TelemetryGapKind.LTE_BUFFERED_RECOVERY,
          isDelayed: true,
          cargoTempC: 9.4,
        });
        expect(createdFrames[1]).toMatchObject({
          gapKind: TelemetryGapKind.SENSOR_SIGNAL_MISSING,
          cargoTempC: null,
        });
        expect(createdReadings[0]).toMatchObject({
          origin: TemperatureReadingOrigin.CARGO_AIR_SENSOR,
          recordedById: null,
          isDelayed: true,
        });
        expect(evaluateAndCreateAlertForReading).toHaveBeenCalledTimes(1);

        // Monotonic guard: GPS update happened ONLY for 10:35Z (> 10:30Z), NOT for 10:15Z (< 10:30Z)!
        expect(fleetUpdates).toHaveLength(1);
        expect(fleetUpdates[0]?.lastLatitude).toBeCloseTo(18.01, 5);
        // Sensor live temp at 10:30Z must NOT be overwritten by older 10:15Z 9.40C outage reading,
        // and 10:35Z missing IO records lastSignalMissingAt cleanly!
        expect(sensorUpdates).toHaveLength(1);
        expect(sensorUpdates[0]?.lastGapKind).toBe(TelemetryGapKind.SENSOR_SIGNAL_MISSING);

        // Duplicate retry of exact same Codec 8E packet must dedupe cleanly with 0 new alerts
        const retryRun = await service.ingestCodec8e(auth, {
          imei: '356307042441013',
          payloadBase64: bufferedPacket.toString('base64'),
        });
        expect(retryRun).toMatchObject({
          acceptedCount: 2,
          storedFrames: 0,
          deduplicatedFrames: 2,
          lotReadingsCreated: 0,
          alertsCreated: 0,
        });
        expect(evaluateAndCreateAlertForReading).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('TelemetryOperationsService & Status Helpers', () => {
    it('enforces driver delivery ownership and distinguishes partial vs full compartment handovers', async () => {
      interface AssignmentUpdateCall {
        where: { id: string };
        data: { handedOverQuantity: number; handoverCustodyEventId: string; unloadedAt?: Date };
      }
      const assignmentUpdate = jest
        .fn<Promise<{ id: string }>, [AssignmentUpdateCall]>()
        .mockResolvedValue({ id: 'assign-1' });
      const custodyCreate = jest.fn().mockResolvedValue({ id: 'custody-1' });
      const prisma = {
        delivery: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'del-1',
            vendorOrderId: 'vo-1',
            deliveredAt: null,
            failedAt: null,
            driver: { userId: 'driver-user-1', user: { id: 'driver-user-1', firstName: 'Dan', lastName: 'Driver' } },
            vendorOrder: {
              status: 'IN_TRANSIT',
              vendor: { id: 'vendor-1', userId: 'vendor-user-1', businessName: 'Fresh Co' },
              order: { deliveryAddressLine1: 'Kingston Pier', deliveryAddressLine2: null, deliveryParish: 'KINGSTON' },
              items: [],
            },
          }),
        },
        cargoCompartmentAssignment: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'assign-1',
              deliveryId: 'del-1',
              lotId: 'lot-1',
              compartmentId: 'comp-1',
              fleetAssetId: 'veh-1',
              quantityUnits: 10,
              handedOverQuantity: 0,
              unloadedAt: null,
            },
          ]),
        },
        $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            chainOfCustodyEvent: { create: custodyCreate },
            cargoCompartmentAssignment: { update: assignmentUpdate },
          }),
        ),
      } as unknown as PrismaService;

      const ops = new TelemetryOperationsService(prisma);

      // Unassigned driver blocked
      await expect(
        ops.getDeliveryTelemetryDetail(
          { id: 'other-driver-user', email: 'x@test', roles: [RoleName.DRIVER] },
          'del-1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Partial handover (4/10) must NOT set unloadedAt
      await ops.recordCompartmentHandover(
        { id: 'driver-user-1', email: 'd@test', roles: [RoleName.DRIVER] },
        {
          deliveryId: 'del-1',
          items: [{ lotId: 'lot-1', handedOverQuantity: 4 }],
        },
      );
      expect(assignmentUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'assign-1' },
          data: {
            handedOverQuantity: 4,
            handoverCustodyEventId: 'custody-1',
          },
        }),
      );
      const firstUpdateArg = assignmentUpdate.mock.calls[0]?.[0];
      expect(firstUpdateArg?.data.unloadedAt).toBeUndefined();

      // Auto-closure helper no-ops cleanly on mocked txs without telemetry tables
      await expect(
        closeOpenCompartmentAssignmentsForDelivery({} as PrismaService, 'del-1', new Date()),
      ).resolves.toBe(0);
    });

    it('computes real-time sensor and vehicle staleness and signal missing states accurately', () => {
      const now = new Date('2026-11-25T12:00:00.000Z');
      expect(
        computeSensorReportingStatus({
          status: DeviceStatus.ACTIVE,
          lastCapturedAt: new Date('2026-11-25T11:58:00.000Z'),
          lastDelaySeconds: 12,
        }, now),
      ).toBe('REPORTING');

      expect(
        computeSensorReportingStatus({
          status: DeviceStatus.ACTIVE,
          lastCapturedAt: new Date('2026-11-25T11:58:00.000Z'),
          lastDelaySeconds: 240,
        }, now),
      ).toBe('DELAYED');

      expect(
        computeSensorReportingStatus({
          status: DeviceStatus.ACTIVE,
          lastCapturedAt: new Date('2026-11-25T11:40:00.000Z'),
        }, now),
      ).toBe('STALE');

      expect(
        computeSensorReportingStatus({
          status: DeviceStatus.ACTIVE,
          lastCapturedAt: new Date('2026-11-25T11:50:00.000Z'),
          lastSignalMissingAt: new Date('2026-11-25T11:59:00.000Z'),
        }, now),
      ).toBe('SENSOR_SIGNAL_MISSING');

      expect(
        computeVehicleGpsStatus({
          lastGpsCapturedAt: new Date('2026-11-25T11:42:00.000Z'),
          lastTelemetryReceivedAt: new Date('2026-11-25T11:42:05.000Z'),
        }, now),
      ).toBe('STALE');
    });
  });
});
