import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import {
  DeviceStatus,
  FleetAssetStatus,
  RoleName,
  SeafoodStorageType,
  TelemetryCredentialScope,
  TelemetryProtocol,
} from '@prisma/client';
import * as http from 'http';
import * as net from 'net';

import { JwtAuthGuard, RequestUser } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../database/prisma.service';
import { DriversRepository } from '../delivery/repositories/drivers.repository';
import { EmergencyResponsesRepository } from '../food-safety/repositories/emergency-responses.repository';
import { SeafoodLotsRepository } from '../food-safety/repositories/seafood-lots.repository';
import { TemperatureAlertsRepository } from '../food-safety/repositories/temperature-alerts.repository';
import { TemperatureDevicesRepository } from '../food-safety/repositories/temperature-devices.repository';
import { TemperatureReadingsRepository } from '../food-safety/repositories/temperature-readings.repository';
import { TemperatureThresholdsRepository } from '../food-safety/repositories/temperature-thresholds.repository';
import { SeafoodLotsService } from '../food-safety/services/seafood-lots.service';
import { TemperatureMonitoringService } from '../food-safety/services/temperature-monitoring.service';
import { VendorsRepository } from '../vendors/repositories/vendors.repository';
import { TelemetryIngestionController } from './controllers/telemetry-ingestion.controller';
import { TelemetryOperationsController } from './controllers/telemetry-operations.controller';
import {
  hashTelemetryToken,
  TelemetryGatewayAuthGuard,
} from './guards/telemetry-gateway-auth.guard';
import { TelemetryCredentialsService } from './services/telemetry-credentials.service';
import { TelemetryIngestionService } from './services/telemetry-ingestion.service';
import { TelemetryOperationsService } from './services/telemetry-operations.service';
import { TeltonikaSimulatorClient } from './simulator/teltonika-simulator';

/**
 * Stateful in-memory Prisma store testing the real HTTP gateway-to-HTTPS
 * ingestion controller, Teltonika binary Codec 8 Extended simulator,
 * compartment lot matching across multi-lot compartments, partial unloads,
 * vehicle transfers, delayed LTE outage alerts without clobbering newer live
 * dashboard state, duplicate retries, unmatched readings, stale detection,
 * and three-role telemetry RBAC end-to-end.
 */
describe('Telemetry End-to-End Scenarios (Gateway-to-HTTPS Simulator + Lot Attribution)', () => {
  interface MemCompartment {
    id: string;
    fleetAssetId: string;
    compartmentCode: string;
    label: string;
    storageType: SeafoodStorageType;
    active: boolean;
  }
  interface MemTracker {
    id: string;
    fleetAssetId: string;
    imei: string;
    hardwareModel: string;
    firmwareVersion: string | null;
    simCarrier: string | null;
    protocol: TelemetryProtocol;
    status: DeviceStatus;
    lastSeenAt: Date | null;
    lastCapturedAt: Date | null;
    lastReceivedAt: Date | null;
    lastPacketCrc: string | null;
  }
  interface MemSensor {
    id: string;
    vendorId: string | null;
    compartmentId: string | null;
    deviceCode: string;
    hardwareModel: string;
    bleMacAddress: string | null;
    sensorSlot: number | null;
    firmwareVersion: string | null;
    status: DeviceStatus;
    lastSeenAt: Date | null;
    lastTemperatureC: { toString(): string } | null;
    lastCapturedAt: Date | null;
    lastReceivedAt: Date | null;
    lastDelaySeconds: number | null;
    lastHumidityPct: { toString(): string } | null;
    lastBatteryMv: number | null;
    lastDoorOpen: boolean | null;
    lastMovement: boolean | null;
    lastGapKind: string | null;
    lastSignalMissingAt: Date | null;
  }
  interface MemAssignment {
    id: string;
    deliveryId: string;
    vendorOrderId: string;
    lotId: string;
    fleetAssetId: string;
    compartmentId: string;
    trackerId: string | null;
    sensorDeviceId: string | null;
    quantityUnits: number;
    handedOverQuantity: number;
    loadedAt: Date;
    unloadedAt: Date | null;
    pickupCustodyEventId: string | null;
    handoverCustodyEventId: string | null;
    recordedById: string | null;
    notes: string | null;
    createdAt: Date;
  }
  interface MemFrame {
    id: string;
    trackerId: string | null;
    sensorDeviceId: string | null;
    fleetAssetId: string | null;
    compartmentId: string | null;
    protocol: TelemetryProtocol;
    origin: string;
    dedupeKey: string;
    capturedAt: Date;
    receivedAt: Date;
    delaySeconds: number;
    isDelayed: boolean;
    latitude: number | null;
    longitude: number | null;
    altitudeM: number | null;
    speedKph: number | null;
    angleDeg: number | null;
    satellites: number | null;
    gnssValid: boolean;
    cargoTempC: { toString(): string } | null;
    humidityPct: { toString(): string } | null;
    doorOpen: boolean | null;
    movement: boolean | null;
    batteryMv: number | null;
    gapKind: string | null;
  }
  interface MemReading {
    id: string;
    lotId: string;
    deviceId: string | null;
    checkpoint: string;
    temperatureC: { toString(): string };
    recordedById: string | null;
    origin: string;
    capturedAt: Date | null;
    receivedAt: Date;
    isDelayed: boolean;
    deliveryId: string | null;
    fleetAssetId: string | null;
    compartmentId: string | null;
    trackerId: string | null;
    telemetryFrameId: string | null;
    dedupeKey: string | null;
    latitude: number | null;
    longitude: number | null;
    photoUrl: string | null;
    recordedAt: Date;
  }

  let app: INestApplication;
  let baseUrl: string;
  let currentTestUser: RequestUser;
  let clockMs = new Date('2026-11-25T10:00:00.000Z').getTime();

  const fleetAssets = new Map<
    string,
    {
      id: string;
      licensePlate: string;
      assetType: string;
      status: FleetAssetStatus;
      coldChainCapable: boolean;
      lastLatitude: number | null;
      lastLongitude: number | null;
      lastSpeedKph: number | null;
      lastHeadingDeg: number | null;
      lastSatellites: number | null;
      lastGpsCapturedAt: Date | null;
      lastTelemetryReceivedAt: Date | null;
      lastTelemetryDelayed: boolean;
      lastGpsNoFixAt: Date | null;
    }
  >();
  const compartments = new Map<string, MemCompartment>();
  const trackers = new Map<string, MemTracker>();
  const sensors = new Map<string, MemSensor>();
  const credentials = new Map<
    string,
    {
      id: string;
      scope: TelemetryCredentialScope;
      trackerId: string | null;
      label: string;
      keyPrefix: string;
      secretHash: string;
      active: boolean;
      expiresAt: Date | null;
      revokedAt: Date | null;
      revokedReason: string | null;
      lastUsedAt: Date | null;
      createdAt: Date;
    }
  >();
  const frames: MemFrame[] = [];
  const assignments: MemAssignment[] = [];
  const readings: MemReading[] = [];
  const alerts: Array<{
    id: string;
    readingId: string;
    lotId: string;
    severity: string;
    actualC: { toString(): string };
    resolved: boolean;
    resolvedAt: Date | null;
    createdAt: Date;
  }> = [];
  const emergencyResponses: Array<{
    id: string;
    alertId: string;
    status: string;
    acknowledgedAt: Date | null;
    resolvedAt: Date | null;
  }> = [];
  const custodyEvents: Array<Record<string, unknown>> = [];

  const lots = new Map<
    string,
    {
      id: string;
      vendorId: string;
      lotNumber: string;
      species: string;
      storageType: SeafoodStorageType;
      foodSafetyStatus: string;
    }
  >([
    [
      'lot-1',
      {
        id: 'lot-1',
        vendorId: 'vendor-1',
        lotNumber: 'LOT-SNAPPER-01',
        species: 'Red Snapper',
        storageType: SeafoodStorageType.FRESH,
        foodSafetyStatus: 'SAFE',
      },
    ],
    [
      'lot-2',
      {
        id: 'lot-2',
        vendorId: 'vendor-1',
        lotNumber: 'LOT-SHRIMP-02',
        species: 'Jumbo Shrimp',
        storageType: SeafoodStorageType.FRESH,
        foodSafetyStatus: 'SAFE',
      },
    ],
  ]);

  const deliveries = new Map([
    [
      'del-assigned',
      {
        id: 'del-assigned',
        vendorOrderId: 'vo-1',
        assignedAt: new Date('2026-11-25T09:50:00.000Z'),
        pickedUpAt: new Date('2026-11-25T10:00:00.000Z'),
        deliveredAt: null as Date | null,
        failedAt: null as Date | null,
        driverId: 'drv-1',
        driver: {
          id: 'drv-1',
          userId: 'driver-user-1',
          licensePlate: 'VN-JM01',
          vehicleType: 'VAN',
          user: { id: 'driver-user-1', firstName: 'Derrick', lastName: 'Campbell' },
        },
        vendorOrder: {
          id: 'vo-1',
          status: 'IN_TRANSIT',
          vendor: { id: 'vendor-1', userId: 'vendor-user-1', businessName: "Miss Joyce's Catch" },
          order: {
            deliveryAddressLine1: '14 Harbour St',
            deliveryAddressLine2: null,
            deliveryParish: 'KINGSTON',
          },
          items: [
            { id: 'oi-1', quantity: 10, productName: 'Red Snapper', originalLotId: 'lot-1', product: { id: 'p-1', lotId: 'lot-1' } },
            { id: 'oi-2', quantity: 8, productName: 'Jumbo Shrimp', originalLotId: 'lot-2', product: { id: 'p-2', lotId: 'lot-2' } },
          ],
        },
        runStop: { id: 'stop-1', deliveryRunId: 'run-1', sequence: 1 },
      },
    ],
  ]);

  let opsService: TelemetryOperationsService;
  let credService: TelemetryCredentialsService;
  let ingestionService: TelemetryIngestionService;

  beforeAll(async () => {
    jest.useFakeTimers({ advanceTimers: false });
    jest.setSystemTime(clockMs);

    fleetAssets.set('veh-1', {
      id: 'veh-1',
      licensePlate: 'VN-JM01',
      assetType: 'VAN',
      status: FleetAssetStatus.ACTIVE,
      coldChainCapable: true,
      lastLatitude: null,
      lastLongitude: null,
      lastSpeedKph: null,
      lastHeadingDeg: null,
      lastSatellites: null,
      lastGpsCapturedAt: null,
      lastTelemetryReceivedAt: null,
      lastTelemetryDelayed: false,
      lastGpsNoFixAt: null,
    });
    fleetAssets.set('veh-2', {
      id: 'veh-2',
      licensePlate: 'VN-JM02',
      assetType: 'VAN',
      status: FleetAssetStatus.ACTIVE,
      coldChainCapable: true,
      lastLatitude: null,
      lastLongitude: null,
      lastSpeedKph: null,
      lastHeadingDeg: null,
      lastSatellites: null,
      lastGpsCapturedAt: null,
      lastTelemetryReceivedAt: null,
      lastTelemetryDelayed: false,
      lastGpsNoFixAt: null,
    });

    compartments.set('comp-1', {
      id: 'comp-1',
      fleetAssetId: 'veh-1',
      compartmentCode: 'VAN1-CHILL',
      label: 'Van 1 Cargo Box',
      storageType: SeafoodStorageType.FRESH,
      active: true,
    });
    compartments.set('comp-2', {
      id: 'comp-2',
      fleetAssetId: 'veh-2',
      compartmentCode: 'VAN2-CHILL',
      label: 'Van 2 Relief Box',
      storageType: SeafoodStorageType.FRESH,
      active: true,
    });

    trackers.set('trk-1', {
      id: 'trk-1',
      fleetAssetId: 'veh-1',
      imei: '356307042441013',
      hardwareModel: 'TELTONIKA_FMC130',
      firmwareVersion: '03.29.00.Rev.18',
      simCarrier: 'Digicel Jamaica LTE',
      protocol: TelemetryProtocol.TELTONIKA_CODEC_8E,
      status: DeviceStatus.ACTIVE,
      lastSeenAt: null,
      lastCapturedAt: null,
      lastReceivedAt: null,
      lastPacketCrc: null,
    });
    trackers.set('trk-2', {
      id: 'trk-2',
      fleetAssetId: 'veh-2',
      imei: '356307042441099',
      hardwareModel: 'TELTONIKA_FMC130',
      firmwareVersion: '03.29.00.Rev.18',
      simCarrier: 'Flow Jamaica LTE',
      protocol: TelemetryProtocol.TELTONIKA_CODEC_8E,
      status: DeviceStatus.ACTIVE,
      lastSeenAt: null,
      lastCapturedAt: null,
      lastReceivedAt: null,
      lastPacketCrc: null,
    });

    sensors.set('sens-1', {
      id: 'sens-1',
      vendorId: null,
      compartmentId: 'comp-1',
      deviceCode: 'EYE-VAN1-01',
      hardwareModel: 'TELTONIKA_EYE_BTSMP1_EN12830',
      bleMacAddress: '7C:D9:F4:11:22:01',
      sensorSlot: 1,
      firmwareVersion: '1.0',
      status: DeviceStatus.ACTIVE,
      lastSeenAt: null,
      lastTemperatureC: null,
      lastCapturedAt: null,
      lastReceivedAt: null,
      lastDelaySeconds: null,
      lastHumidityPct: null,
      lastBatteryMv: null,
      lastDoorOpen: null,
      lastMovement: null,
      lastGapKind: null,
      lastSignalMissingAt: null,
    });
    sensors.set('sens-2', {
      id: 'sens-2',
      vendorId: null,
      compartmentId: 'comp-2',
      deviceCode: 'EYE-VAN2-01',
      hardwareModel: 'TELTONIKA_EYE_BTSMP1_EN12830',
      bleMacAddress: '7C:D9:F4:11:22:02',
      sensorSlot: 1,
      firmwareVersion: '1.0',
      status: DeviceStatus.ACTIVE,
      lastSeenAt: null,
      lastTemperatureC: null,
      lastCapturedAt: null,
      lastReceivedAt: null,
      lastDelaySeconds: null,
      lastHumidityPct: null,
      lastBatteryMv: null,
      lastDoorOpen: null,
      lastMovement: null,
      lastGapKind: null,
      lastSignalMissingAt: null,
    });

    const prismaMock = {
      fleetAsset: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(fleetAssets.get(where.id) ?? null),
        ),
        update: jest.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const asset = fleetAssets.get(where.id)!;
          Object.assign(asset, data);
          return Promise.resolve(asset);
        }),
      },
      vehicleCompartment: {
        findUnique: jest.fn(({ where }: { where: { id: string }; include?: Record<string, unknown> }) => {
          const comp = compartments.get(where.id);
          if (!comp) return Promise.resolve(null);
          const compSensors = Array.from(sensors.values()).filter(
            (s) => s.compartmentId === comp.id && s.status === DeviceStatus.ACTIVE,
          );
          return Promise.resolve({
            ...comp,
            sensors: compSensors,
            fleetAsset: fleetAssets.get(comp.fleetAssetId),
          });
        }),
      },
      vehicleTracker: {
        findUnique: jest.fn(({ where }: { where: { id?: string; imei?: string } }) => {
          const found = where.id
            ? trackers.get(where.id)
            : Array.from(trackers.values()).find((t) => t.imei === where.imei);
          if (!found) return Promise.resolve(null);
          return Promise.resolve({
            ...found,
            fleetAsset: fleetAssets.get(found.fleetAssetId),
          });
        }),
        findFirst: jest.fn(({ where }: { where: { id?: string; fleetAssetId?: string } }) => {
          const found = Array.from(trackers.values()).find(
            (t) =>
              (!where.id || t.id === where.id) &&
              (!where.fleetAssetId || t.fleetAssetId === where.fleetAssetId),
          );
          return Promise.resolve(found ?? null);
        }),
        findMany: jest.fn(() =>
          Promise.resolve(
            Array.from(trackers.values()).map((t) => ({
              ...t,
              fleetAsset: fleetAssets.get(t.fleetAssetId)!,
              credentials: Array.from(credentials.values()).filter(
                (c) => c.trackerId === t.id && c.active && !c.revokedAt,
              ),
            })),
          ),
        ),
        update: jest.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const trk = trackers.get(where.id)!;
          Object.assign(trk, data);
          return Promise.resolve(trk);
        }),
      },
      temperatureDevice: {
        findMany: jest.fn(({ where }: { where?: { compartment?: { fleetAssetId?: string } } } = {}) => {
          let list = Array.from(sensors.values());
          if (where?.compartment?.fleetAssetId) {
            list = list.filter((s) => {
              const comp = s.compartmentId ? compartments.get(s.compartmentId) : undefined;
              return comp?.fleetAssetId === where.compartment!.fleetAssetId;
            });
          }
          return Promise.resolve(
            list.map((s) => {
              const comp = s.compartmentId ? compartments.get(s.compartmentId) : undefined;
              return {
                ...s,
                compartment: comp
                  ? { ...comp, fleetAsset: fleetAssets.get(comp.fleetAssetId)! }
                  : null,
                vendor: null,
              };
            }),
          );
        }),
        findUnique: jest.fn(({ where }: { where: { id?: string } }) => {
          const s = where.id ? sensors.get(where.id) : undefined;
          if (!s) return Promise.resolve(null);
          const comp = s.compartmentId ? compartments.get(s.compartmentId) : undefined;
          return Promise.resolve({
            ...s,
            compartment: comp
              ? { ...comp, fleetAsset: fleetAssets.get(comp.fleetAssetId)! }
              : null,
          });
        }),
        update: jest.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const s = sensors.get(where.id)!;
          if (typeof data.lastTemperatureC === 'number' || typeof data.lastTemperatureC === 'string') {
            const v = String(data.lastTemperatureC);
            data.lastTemperatureC = { toString: () => v };
          }
          Object.assign(s, data);
          return Promise.resolve(s);
        }),
      },
      telemetryDeviceCredential: {
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          const cred = {
            id: `cred-${credentials.size + 1}`,
            scope: data.scope as TelemetryCredentialScope,
            trackerId: (data.trackerId as string | null) ?? null,
            label: data.label as string,
            keyPrefix: data.keyPrefix as string,
            secretHash: data.secretHash as string,
            active: true,
            expiresAt: (data.expiresAt as Date | null) ?? null,
            revokedAt: null,
            revokedReason: null,
            lastUsedAt: null,
            createdAt: new Date(),
          };
          credentials.set(cred.id, cred);
          const { secretHash: _omit, ...safeView } = cred;
          return Promise.resolve(safeView);
        }),
        findUnique: jest.fn(({ where }: { where: { secretHash?: string; id?: string } }) => {
          const found = where.id
            ? credentials.get(where.id)
            : Array.from(credentials.values()).find((c) => c.secretHash === where.secretHash);
          if (!found) return Promise.resolve(null);
          return Promise.resolve({
            ...found,
            tracker: found.trackerId ? trackers.get(found.trackerId) ?? null : null,
          });
        }),
        update: jest.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const found = credentials.get(where.id)!;
          Object.assign(found, data);
          const { secretHash: _omit, ...safeView } = found;
          return Promise.resolve(safeView);
        }),
        findMany: jest.fn(() =>
          Promise.resolve(
            Array.from(credentials.values()).map(({ secretHash: _omit, ...safe }) => safe),
          ),
        ),
      },
      vehicleTelemetryFrame: {
        findUnique: jest.fn(({ where }: { where: { dedupeKey: string } }) =>
          Promise.resolve(frames.find((f) => f.dedupeKey === where.dedupeKey) ?? null),
        ),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          const rec: MemFrame = {
            id: `frame-${frames.length + 1}`,
            trackerId: (data.trackerId as string | null) ?? null,
            sensorDeviceId: (data.sensorDeviceId as string | null) ?? null,
            fleetAssetId: (data.fleetAssetId as string | null) ?? null,
            compartmentId: (data.compartmentId as string | null) ?? null,
            protocol: data.protocol as TelemetryProtocol,
            origin: data.origin as string,
            dedupeKey: data.dedupeKey as string,
            capturedAt: data.capturedAt as Date,
            receivedAt: data.receivedAt as Date,
            delaySeconds: (data.delaySeconds as number) ?? 0,
            isDelayed: Boolean(data.isDelayed),
            latitude: (data.latitude as number | null) ?? null,
            longitude: (data.longitude as number | null) ?? null,
            altitudeM: (data.altitudeM as number | null) ?? null,
            speedKph: (data.speedKph as number | null) ?? null,
            angleDeg: (data.angleDeg as number | null) ?? null,
            satellites: (data.satellites as number | null) ?? null,
            gnssValid: Boolean(data.gnssValid),
            cargoTempC:
              data.cargoTempC !== null && data.cargoTempC !== undefined
                ? { toString: () => String(data.cargoTempC) }
                : null,
            humidityPct:
              data.humidityPct !== null && data.humidityPct !== undefined
                ? { toString: () => String(data.humidityPct) }
                : null,
            doorOpen: (data.doorOpen as boolean | null) ?? null,
            movement: (data.movement as boolean | null) ?? null,
            batteryMv: (data.batteryMv as number | null) ?? null,
            gapKind: (data.gapKind as string | null) ?? null,
          };
          frames.push(rec);
          return Promise.resolve(rec);
        }),
        findMany: jest.fn(() =>
          Promise.resolve(
            [...frames].reverse().map((f) => ({
              ...f,
              temperatureReadings: readings
                .filter((r) => r.telemetryFrameId === f.id)
                .map((r) => ({
                  id: r.id,
                  lotId: r.lotId,
                  deliveryId: r.deliveryId,
                  origin: r.origin,
                  alert: alerts.find((a) => a.readingId === r.id) ?? null,
                })),
            })),
          ),
        ),
      },
      cargoCompartmentAssignment: {
        findMany: jest.fn(
          ({
            where,
          }: {
            where?: {
              compartmentId?: string;
              deliveryId?: string;
              unloadedAt?: null;
              loadedAt?: { lte: Date };
              OR?: Array<{ unloadedAt?: null | { gte: Date } }>;
            };
          } = {}) => {
            const matched = assignments.filter((a) => {
              if (where?.compartmentId && a.compartmentId !== where.compartmentId) return false;
              if (where?.deliveryId && a.deliveryId !== where.deliveryId) return false;
              if (where?.unloadedAt === null && a.unloadedAt !== null) return false;
              if (where?.loadedAt?.lte && a.loadedAt.getTime() > where.loadedAt.lte.getTime()) {
                return false;
              }
              if (where?.OR) {
                const boundary = where.OR[1]?.unloadedAt;
                const matchesOpen = a.unloadedAt === null;
                const matchesBeforeClose =
                  boundary && typeof boundary === 'object' && a.unloadedAt
                    ? a.unloadedAt.getTime() >= boundary.gte.getTime()
                    : false;
                if (!matchesOpen && !matchesBeforeClose) return false;
              }
              return true;
            });
            return Promise.resolve(
              matched.map((a) => ({
                ...a,
                lot: lots.get(a.lotId)!,
                fleetAsset: fleetAssets.get(a.fleetAssetId)!,
                compartment: compartments.get(a.compartmentId)!,
                tracker: a.trackerId ? trackers.get(a.trackerId) ?? null : null,
                sensorDevice: a.sensorDeviceId ? sensors.get(a.sensorDeviceId) ?? null : null,
                pickupCustodyEvent: null,
                handoverCustodyEvent: null,
              })),
            );
          },
        ),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          const rec: MemAssignment = {
            id: `assign-${assignments.length + 1}`,
            deliveryId: data.deliveryId as string,
            vendorOrderId: data.vendorOrderId as string,
            lotId: data.lotId as string,
            fleetAssetId: data.fleetAssetId as string,
            compartmentId: data.compartmentId as string,
            trackerId: (data.trackerId as string | null) ?? null,
            sensorDeviceId: (data.sensorDeviceId as string | null) ?? null,
            quantityUnits: data.quantityUnits as number,
            handedOverQuantity: (data.handedOverQuantity as number) ?? 0,
            loadedAt: data.loadedAt as Date,
            unloadedAt: null,
            pickupCustodyEventId: (data.pickupCustodyEventId as string | null) ?? null,
            handoverCustodyEventId: null,
            recordedById: (data.recordedById as string | null) ?? null,
            notes: (data.notes as string | null) ?? null,
            createdAt: new Date(),
          };
          assignments.push(rec);
          return Promise.resolve(rec);
        }),
        update: jest.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const found = assignments.find((a) => a.id === where.id)!;
          Object.assign(found, data);
          return Promise.resolve(found);
        }),
      },
      chainOfCustodyEvent: {
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          const rec = { id: `cust-${custodyEvents.length + 1}`, ...data };
          custodyEvents.push(rec);
          return Promise.resolve(rec);
        }),
      },
      delivery: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(deliveries.get(where.id) ?? null),
        ),
        findMany: jest.fn(({ where }: { where?: { driverId?: string } } = {}) => {
          const list = Array.from(deliveries.values()).filter(
            (d) => !where?.driverId || d.driverId === where.driverId,
          );
          return Promise.resolve(
            list.map((d) => ({
              ...d,
              cargoAssignments: assignments
                .filter((a) => a.deliveryId === d.id)
                .map((a) => ({
                  ...a,
                  fleetAsset: {
                    ...fleetAssets.get(a.fleetAssetId)!,
                    trackers: Array.from(trackers.values()).filter(
                      (t) => t.fleetAssetId === a.fleetAssetId,
                    ),
                    compartments: Array.from(compartments.values())
                      .filter((c) => c.fleetAssetId === a.fleetAssetId)
                      .map((c) => ({
                        ...c,
                        sensors: Array.from(sensors.values()).filter(
                          (s) => s.compartmentId === c.id,
                        ),
                      })),
                  },
                })),
            })),
          );
        }),
      },
      deliveryRun: {
        findMany: jest.fn(() => Promise.resolve([])),
      },
      driver: {
        findUnique: jest.fn(({ where }: { where: { userId?: string } }) =>
          where.userId === 'driver-user-1' ? Promise.resolve({ id: 'drv-1' }) : Promise.resolve(null),
        ),
      },
      temperatureReading: {
        findUnique: jest.fn(({ where }: { where: { dedupeKey: string } }) =>
          Promise.resolve(readings.find((r) => r.dedupeKey === where.dedupeKey) ?? null),
        ),
        findMany: jest.fn(() =>
          Promise.resolve(
            [...readings].reverse().map((r) => ({
              ...r,
              lot: lots.get(r.lotId)!,
              device: r.deviceId ? sensors.get(r.deviceId) ?? null : null,
            })),
          ),
        ),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          const val = String(data.temperatureC);
          const rec: MemReading = {
            id: `read-${readings.length + 1}`,
            lotId: data.lotId as string,
            deviceId: (data.deviceId as string | null) ?? null,
            checkpoint: data.checkpoint as string,
            temperatureC: { toString: () => val },
            recordedById: (data.recordedById as string | null) ?? null,
            origin: data.origin as string,
            capturedAt: (data.capturedAt as Date | null) ?? null,
            receivedAt: (data.receivedAt as Date) ?? new Date(),
            isDelayed: Boolean(data.isDelayed),
            deliveryId: (data.deliveryId as string | null) ?? null,
            fleetAssetId: (data.fleetAssetId as string | null) ?? null,
            compartmentId: (data.compartmentId as string | null) ?? null,
            trackerId: (data.trackerId as string | null) ?? null,
            telemetryFrameId: (data.telemetryFrameId as string | null) ?? null,
            dedupeKey: (data.dedupeKey as string | null) ?? null,
            latitude: (data.latitude as number | null) ?? null,
            longitude: (data.longitude as number | null) ?? null,
            photoUrl: null,
            recordedAt: (data.recordedAt as Date) ?? new Date(),
          };
          readings.push(rec);
          return Promise.resolve(rec);
        }),
      },
      temperatureAlert: {
        findMany: jest.fn(() =>
          Promise.resolve(
            alerts.map((a) => ({
              ...a,
              reading: readings.find((r) => r.id === a.readingId)!,
              emergencyResponse: emergencyResponses.find((er) => er.alertId === a.id) ?? null,
            })),
          ),
        ),
      },
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock)),
    } as unknown as PrismaService;

    const moduleRef = await Test.createTestingModule({
      controllers: [TelemetryIngestionController, TelemetryOperationsController],
      providers: [
        TelemetryGatewayAuthGuard,
        TelemetryCredentialsService,
        TelemetryIngestionService,
        TelemetryOperationsService,
        TemperatureMonitoringService,
        RolesGuard,
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: TemperatureReadingsRepository,
          useValue: { create: jest.fn(), findByLotId: jest.fn(), countByLotId: jest.fn() },
        },
        {
          provide: TemperatureAlertsRepository,
          useValue: {
            create: jest.fn(({ readingId, lotId, severity, actualC }: { readingId: string; lotId: string; severity: string; actualC: number }) => {
              const row = {
                id: `alert-${alerts.length + 1}`,
                readingId,
                lotId,
                severity,
                actualC: { toString: () => String(actualC) },
                resolved: false,
                resolvedAt: null,
                createdAt: new Date(),
              };
              alerts.push(row);
              return Promise.resolve(row);
            }),
          },
        },
        {
          provide: TemperatureThresholdsRepository,
          useValue: {
            findByDeviceAndStorageType: jest.fn().mockResolvedValue(null),
            findPlatformDefault: jest.fn().mockResolvedValue({
              id: 'thresh-fresh',
              storageType: SeafoodStorageType.FRESH,
              minC: { toNumber: () => 0 },
              maxC: { toNumber: () => 4 },
              warningBandC: { toNumber: () => 2 },
            }),
          },
        },
        {
          provide: SeafoodLotsRepository,
          useValue: {
            updateStatus: jest.fn((lotId: string, status: string) => {
              const lot = lots.get(lotId)!;
              lot.foodSafetyStatus = status;
              return Promise.resolve(lot);
            }),
          },
        },
        {
          provide: EmergencyResponsesRepository,
          useValue: {
            create: jest.fn((alertId: string) => {
              const row = {
                id: `resp-${emergencyResponses.length + 1}`,
                alertId,
                status: 'OPEN',
                acknowledgedAt: null,
                resolvedAt: null,
              };
              emergencyResponses.push(row);
              return Promise.resolve(row);
            }),
          },
        },
        { provide: TemperatureDevicesRepository, useValue: {} },
        { provide: SeafoodLotsService, useValue: {} },
        {
          provide: VendorsRepository,
          useValue: {
            findById: jest.fn().mockResolvedValue({ id: 'vendor-1', userId: 'vendor-user-1' }),
          },
        },
        { provide: DriversRepository, useValue: {} },
        {
          provide: EventEmitter2,
          useValue: { emitAsync: jest.fn().mockResolvedValue([]) },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp: () => { getRequest: () => { user?: RequestUser } } }) => {
          ctx.switchToHttp().getRequest().user = currentTestUser;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    const addr = (app.getHttpServer() as http.Server).address() as net.AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;

    opsService = moduleRef.get(TelemetryOperationsService);
    credService = moduleRef.get(TelemetryCredentialsService);
    ingestionService = moduleRef.get(TelemetryIngestionService);
  });

  afterAll(async () => {
    jest.useRealTimers();
    await app.close();
  });

  it('executes the full lifecycle: unmatched -> 2 lots -> partial unload -> vehicle transfer -> delayed excursion without overwriting newer reading -> dedupe -> stale + 3-role RBAC', async () => {
    const adminUser: RequestUser = { id: 'admin-1', email: 'bernard.uat@test', roles: [RoleName.ADMINISTRATOR] };
    const opsUser: RequestUser = { id: 'ops-1', email: 'staff.operations@test', roles: [RoleName.OPERATIONS_STAFF] };
    const assignedDriver: RequestUser = { id: 'driver-user-1', email: 'driver1@test', roles: [RoleName.DRIVER] };
    const otherDriver: RequestUser = { id: 'driver-user-2', email: 'driver2@test', roles: [RoleName.DRIVER] };

    // Admin issues a GATEWAY telemetry key over HTTPS ingestion
    const issued = await credService.issue(adminUser.id, {
      scope: TelemetryCredentialScope.GATEWAY,
      label: 'staging-sim-gateway',
    });
    const sim = new TeltonikaSimulatorClient(baseUrl, issued.plaintextSecret);

    // 1. Unmatched pre-load reading: Van 1 has NO lots onboard yet
    const unmatchedRes = await sim.sendCodec8e('356307042441013', [
      { capturedAt: new Date(clockMs), latitude: 17.997, longitude: -76.793, cargoTempC: 2.1 },
    ]);
    expect(unmatchedRes.status).toBe(201);
    expect(unmatchedRes.data).toMatchObject({
      storedFrames: 1,
      unmatchedFrames: 1,
      lotReadingsCreated: 0,
      alertsCreated: 0,
    });

    // 2. Two lots loaded into one compartment (comp-1 on veh-1)
    clockMs += 5 * 60_000;
    jest.setSystemTime(clockMs);
    await opsService.recordCompartmentPickup(assignedDriver, {
      deliveryId: 'del-assigned',
      fleetAssetId: 'veh-1',
      compartmentId: 'comp-1',
      loadedAt: new Date(clockMs).toISOString(),
      lots: [
        { lotId: 'lot-1', quantityUnits: 10 },
        { lotId: 'lot-2', quantityUnits: 8 },
      ],
    });

    // Single Codec 8E reading must create 1 reading for LOT-1 and 1 reading for LOT-2
    clockMs += 2 * 60_000;
    jest.setSystemTime(clockMs);
    const twoLotRes = await sim.sendCodec8e('356307042441013', [
      { capturedAt: new Date(clockMs), latitude: 17.991, longitude: -76.81, cargoTempC: 2.4 },
    ]);
    expect(twoLotRes.data).toMatchObject({
      storedFrames: 1,
      unmatchedFrames: 0,
      lotReadingsCreated: 2,
      alertsCreated: 0,
    });

    // 3. Partial unload of LOT-1 (4 of 10): LOT-1 stays onboard alongside LOT-2
    clockMs += 2 * 60_000;
    jest.setSystemTime(clockMs);
    await opsService.recordCompartmentHandover(assignedDriver, {
      deliveryId: 'del-assigned',
      items: [{ lotId: 'lot-1', handedOverQuantity: 4 }],
      unloadedAt: new Date(clockMs).toISOString(),
    });

    clockMs += 1 * 60_000;
    jest.setSystemTime(clockMs);
    const partialRes = await sim.sendCodec8e('356307042441013', [
      { capturedAt: new Date(clockMs), latitude: 17.985, longitude: -76.825, cargoTempC: 2.8 },
    ]);
    expect(partialRes.data).toMatchObject({ lotReadingsCreated: 2, alertsCreated: 0 });

    // Full unload of remaining 6 units of LOT-1 -> closes ONLY LOT-1
    clockMs += 1 * 60_000;
    jest.setSystemTime(clockMs);
    await opsService.recordCompartmentHandover(assignedDriver, {
      deliveryId: 'del-assigned',
      items: [{ lotId: 'lot-1', handedOverQuantity: 6 }],
      unloadedAt: new Date(clockMs).toISOString(),
    });

    // 4. Vehicle transfer of LOT-2 from Van 1 (comp-1) -> Van 2 (comp-2)
    clockMs += 2 * 60_000;
    jest.setSystemTime(clockMs);
    const transferAt = new Date(clockMs);
    await opsService.recordCompartmentTransfer(assignedDriver, {
      deliveryId: 'del-assigned',
      fromCompartmentId: 'comp-1',
      toFleetAssetId: 'veh-2',
      toCompartmentId: 'comp-2',
      transferredAt: transferAt.toISOString(),
    });

    // Van 1 frame after transfer matches ZERO lots
    clockMs += 60_000;
    jest.setSystemTime(clockMs);
    const van1PostTransfer = await sim.sendCodec8e('356307042441013', [
      { capturedAt: new Date(clockMs), latitude: 17.982, longitude: -76.83, cargoTempC: 3.1 },
    ]);
    expect(van1PostTransfer.data).toMatchObject({
      unmatchedFrames: 1,
      lotReadingsCreated: 0,
    });

    // 5. Newer live dashboard reading on Van 2 (2.15C at T_live)
    clockMs += 10 * 60_000;
    jest.setSystemTime(clockMs);
    const liveCaptureTime = new Date(clockMs);
    const liveVan2 = await sim.sendCodec8e('356307042441099', [
      { capturedAt: liveCaptureTime, latitude: 17.9414, longitude: -77.1089, cargoTempC: 2.15 },
    ]);
    expect(liveVan2.data).toMatchObject({
      lotReadingsCreated: 1,
      alertsCreated: 0,
      delayedFrames: 0,
    });

    // Delayed LTE outage excursion (11.50C captured 6m earlier, after transfer but before liveCaptureTime)
    const outageCaptureTime = new Date(liveCaptureTime.getTime() - 6 * 60_000);
    const delayedExcursion = await sim.sendCodec8e('356307042441099', [
      { capturedAt: outageCaptureTime, latitude: 17.96, longitude: -76.95, cargoTempC: 11.5 },
    ]);
    expect(delayedExcursion.data).toMatchObject({
      storedFrames: 1,
      lotReadingsCreated: 1,
      alertsCreated: 1, // Raises EMERGENCY alert!
      delayedFrames: 1,
    });

    // Verify EMERGENCY alert, open EmergencyResponse, and LOT-2 quarantine
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe('EMERGENCY');
    expect(emergencyResponses).toHaveLength(1);
    expect(lots.get('lot-2')?.foodSafetyStatus).toBe('QUARANTINED');

    // Verify newer live dashboard position & 2.15C readout on Van 2 / sens-2 were NOT overwritten!
    const devicesOverview = await opsService.getTelemetryDevicesOverview(new Date(clockMs));
    const sens2View = devicesOverview.sensors.find((s) => s.id === 'sens-2');
    expect(sens2View?.lastTemperatureC).toBe(2.15);
    expect(sens2View?.lastCapturedAt?.toISOString()).toBe(liveCaptureTime.toISOString());
    expect(sens2View?.reportingStatus).toBe('REPORTING');
    expect(fleetAssets.get('veh-2')?.lastLatitude).toBeCloseTo(17.9414, 4);

    // 6. Duplicate packet retry -> idempotent (0 new readings, 0 new alerts)
    const retryRes = await sim.sendCodec8e('356307042441099', [
      { capturedAt: outageCaptureTime, latitude: 17.96, longitude: -76.95, cargoTempC: 11.5 },
    ]);
    expect(retryRes.data).toMatchObject({
      acceptedCount: 1,
      storedFrames: 0,
      deduplicatedFrames: 1,
      lotReadingsCreated: 0,
      alertsCreated: 0,
    });
    expect(alerts).toHaveLength(1);

    // 7. Stale indicator when 12 minutes pass without new telemetry
    clockMs += 12 * 60_000;
    jest.setSystemTime(clockMs);
    const staleOverview = await opsService.getActiveRunsLiveOverview(opsUser, new Date(clockMs));
    const veh2Stale = staleOverview.vehicles.find((v) => v.fleetAssetId === 'veh-2');
    expect(veh2Stale?.gpsStatus).toBe('STALE');
    expect(veh2Stale?.compartments[0]?.sensors[0]?.reportingStatus).toBe('STALE');

    // 8. Real HTTP three-role telemetry RBAC & isolation checks
    currentTestUser = opsUser;
    const opsOverviewHttp = await fetch(`${baseUrl}/telemetry/overview/devices`);
    expect(opsOverviewHttp.status).toBe(200);

    // Operations staff denied administrator-only device enrollment & credentials
    const opsEnrollHttp = await fetch(`${baseUrl}/telemetry/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'GATEWAY', label: 'blocked' }),
    });
    expect(opsEnrollHttp.status).toBe(403);

    // Assigned driver allowed on assigned delivery detail, blocked on unassigned & fleet overview
    currentTestUser = assignedDriver;
    const driverAssignedHttp = await fetch(`${baseUrl}/telemetry/deliveries/del-assigned`);
    expect(driverAssignedHttp.status).toBe(200);
    const driverOverviewHttp = await fetch(`${baseUrl}/telemetry/overview/active-runs`);
    expect(driverOverviewHttp.status).toBe(403);

    currentTestUser = otherDriver;
    const otherDriverHttp = await fetch(`${baseUrl}/telemetry/deliveries/del-assigned`);
    expect(otherDriverHttp.status).toBe(403);

    const vendorUser: RequestUser = { id: 'vendor-user-1', email: 'vendor@test', roles: [RoleName.VENDOR] };
    currentTestUser = vendorUser;
    const vendorHttp = await fetch(`${baseUrl}/telemetry/deliveries/del-assigned`);
    expect(vendorHttp.status).toBe(403);

    const opsDetail = await opsService.getDeliveryTelemetryDetail(opsUser, 'del-assigned', new Date(clockMs));
    expect(opsDetail.cargoAirReadings.length).toBeGreaterThanOrEqual(4);
    expect(opsDetail.manualProductChecks).toHaveLength(0);
    expect(opsDetail.complianceChecklist.pickupManualCheckRecorded).toBe(false);

    // Confirm User Bearer JWTs are rejected (401) by TelemetryGatewayAuthGuard over HTTP
    const jwtOnIngestion = await fetch(`${baseUrl}/telemetry/codec8e`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer fake.user.jwt',
      },
      body: JSON.stringify({ imei: '356307042441013', payloadBase64: 'AAAA' }),
    });
    expect(jwtOnIngestion.status).toBe(401);

    expect(hashTelemetryToken('x')).toHaveLength(64);
    expect(ingestionService).toBeDefined();
  });
});
