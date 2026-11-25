import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DeviceStatus,
  FleetAssetStatus,
  Prisma,
  TelemetryCredentialScope,
  TelemetryGapKind,
  TelemetryProtocol,
  TemperatureCheckpoint,
  TemperatureReadingOrigin,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { TemperatureMonitoringService } from '../../food-safety/services/temperature-monitoring.service';
import { TelemetryAuthContext } from '../guards/telemetry-gateway-auth.guard';
import { parseTeltonikaCodec8ePacket } from '../parsers/teltonika-codec8e.parser';
import {
  NormalizedTelemetryRecord,
  normalizeCanonicalHttpRecords,
  normalizeTeltonikaCodecJson,
  parseEyeAppRecoveryCsv,
} from '../parsers/teltonika-payload.normalizer';
import { computeDelaySeconds } from '../telemetry-status.util';
import {
  ImportEyeAppCsvDto,
  IngestCanonicalTelemetryDto,
  IngestCodec8eHttpDto,
  IngestCodecJsonTelemetryDto,
} from '../dto/telemetry.dto';

export interface TelemetryIngestSummary {
  imei: string;
  trackerId: string;
  fleetAssetId: string;
  protocol: TelemetryProtocol;
  totalRecords: number;
  acceptedCount: number;
  storedFrames: number;
  deduplicatedFrames: number;
  lotReadingsCreated: number;
  alertsCreated: number;
  sensorMissingFrames: number;
  delayedFrames: number;
  noFixFrames: number;
}

export interface EyeCsvImportSummary {
  sensorId: string;
  deviceCode: string;
  totalRows: number;
  importedFrames: number;
  deduplicatedFrames: number;
  lotReadingsCreated: number;
  alertsCreated: number;
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class TelemetryIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly temperatureMonitoringService: TemperatureMonitoringService,
  ) {}

  async authorizeGatewayImei(auth: TelemetryAuthContext, imei: string): Promise<{ authorized: boolean; trackerId?: string }> {
    if (auth.scope === TelemetryCredentialScope.DEVICE_TRACKER && auth.trackerImei !== imei) {
      return { authorized: false };
    }
    const tracker = await this.prisma.vehicleTracker.findUnique({
      where: { imei },
      select: {
        id: true,
        status: true,
        fleetAsset: { select: { status: true } },
      },
    });
    if (!tracker || tracker.status !== DeviceStatus.ACTIVE || tracker.fleetAsset.status !== FleetAssetStatus.ACTIVE) {
      return { authorized: false };
    }
    return { authorized: true, trackerId: tracker.id };
  }

  async ingestCodec8e(
    auth: TelemetryAuthContext,
    dto: IngestCodec8eHttpDto,
  ): Promise<TelemetryIngestSummary> {
    if (!dto.payloadHex && !dto.payloadBase64) {
      throw new BadRequestException('Either payloadHex or payloadBase64 must be provided');
    }

    const buffer = dto.payloadHex
      ? Buffer.from(dto.payloadHex.replace(/\s+/g, ''), 'hex')
      : Buffer.from(dto.payloadBase64!.trim(), 'base64');

    const packet = parseTeltonikaCodec8ePacket(buffer);
    const normalized: NormalizedTelemetryRecord[] = packet.records.map((rec) => ({
      capturedAt: rec.capturedAt,
      latitude: rec.latitude,
      longitude: rec.longitude,
      altitudeM: rec.altitudeM,
      angleDeg: rec.angleDeg,
      satellites: rec.satellites,
      speedKph: rec.speedKph,
      gnssValid: rec.gnssValid,
      gsmSignal: rec.gsmSignal,
      externalVoltageMv: rec.externalVoltageMv,
      trackerBatteryMv: rec.trackerBatteryMv,
      eyeSensors: rec.eyeSensors,
      rawPayload: {
        codecId: packet.codecId,
        crcHex: packet.crcHex,
        eventIoId: rec.eventIoId,
        io: rec.rawIoHex,
      },
    }));

    return this.ingestNormalizedRecords(
      auth,
      dto.imei,
      TelemetryProtocol.TELTONIKA_CODEC_8E,
      normalized,
      packet.crcHex,
    );
  }

  async ingestCodecJson(
    auth: TelemetryAuthContext,
    dto: IngestCodecJsonTelemetryDto,
  ): Promise<TelemetryIngestSummary> {
    const records = normalizeTeltonikaCodecJson(dto.payload);
    return this.ingestNormalizedRecords(
      auth,
      dto.imei,
      TelemetryProtocol.TELTONIKA_CODEC_JSON,
      records,
    );
  }

  async ingestCanonicalHttp(
    auth: TelemetryAuthContext,
    dto: IngestCanonicalTelemetryDto,
  ): Promise<TelemetryIngestSummary> {
    const records = normalizeCanonicalHttpRecords(dto.records);
    return this.ingestNormalizedRecords(
      auth,
      dto.imei,
      dto.protocol ?? TelemetryProtocol.HTTP_JSON,
      records,
    );
  }

  async importEyeAppCsvRecovery(
    sensorId: string,
    dto: ImportEyeAppCsvDto,
  ): Promise<EyeCsvImportSummary> {
    const sensor = await this.prisma.temperatureDevice.findUnique({
      where: { id: sensorId },
      include: {
        compartment: {
          select: {
            id: true,
            fleetAssetId: true,
          },
        },
      },
    });
    if (!sensor) {
      throw new NotFoundException('Temperature sensor device not found');
    }
    if (sensor.status !== DeviceStatus.ACTIVE) {
      throw new BadRequestException('Cannot import EYE App recovery logs for a decommissioned sensor');
    }

    const parsedRows = parseEyeAppRecoveryCsv(dto.csvContent);
    const receivedAt = new Date();

    let importedFrames = 0;
    let deduplicatedFrames = 0;
    let lotReadingsCreated = 0;
    let alertsCreated = 0;
    let latestCsvCapture: { capturedAt: Date; tempC: number; humidityPct: number | null; batteryMv: number | null; doorOpen: boolean | null; delaySeconds: number } | null = null;

    for (const row of parsedRows) {
      const dedupeKey = `eye_csv:${sensor.id}:${row.capturedAt.getTime()}`;
      const existing = await this.prisma.vehicleTelemetryFrame.findUnique({
        where: { dedupeKey },
        select: { id: true },
      });
      if (existing) {
        deduplicatedFrames += 1;
        continue;
      }

      const { delaySeconds, isDelayed } = computeDelaySeconds(row.capturedAt, receivedAt);
      let frame: { id: string };
      try {
        frame = await this.prisma.vehicleTelemetryFrame.create({
          data: {
            sensorDeviceId: sensor.id,
            fleetAssetId: sensor.compartment?.fleetAssetId ?? null,
            compartmentId: sensor.compartmentId ?? null,
            protocol: TelemetryProtocol.EYE_APP_CSV,
            origin: TemperatureReadingOrigin.EYE_APP_RECOVERY_CSV,
            dedupeKey,
            capturedAt: row.capturedAt,
            receivedAt,
            delaySeconds,
            isDelayed,
            cargoTempC: row.temperatureC,
            humidityPct: row.humidityPct,
            doorOpen: row.doorOpen,
            batteryMv: row.batteryMv,
            gapKind: isDelayed ? TelemetryGapKind.LTE_BUFFERED_RECOVERY : null,
            rawPayload: {
              lineNumber: row.lineNumber,
              ...(dto.notes ? { notes: dto.notes } : {}),
            },
          },
          select: { id: true },
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          deduplicatedFrames += 1;
          continue;
        }
        throw err;
      }

      importedFrames += 1;

      if (!latestCsvCapture || row.capturedAt >= latestCsvCapture.capturedAt) {
        latestCsvCapture = {
          capturedAt: row.capturedAt,
          tempC: row.temperatureC,
          humidityPct: row.humidityPct,
          batteryMv: row.batteryMv,
          doorOpen: row.doorOpen,
          delaySeconds,
        };
      }

      const attributed = await this.attributeTemperatureReadingToOnboardLots({
        frameId: frame.id,
        capturedAt: row.capturedAt,
        receivedAt,
        isDelayed,
        temperatureC: row.temperatureC,
        origin: TemperatureReadingOrigin.EYE_APP_RECOVERY_CSV,
        sensorId: sensor.id,
        compartmentId: sensor.compartmentId,
        fleetAssetId: sensor.compartment?.fleetAssetId ?? null,
        trackerId: null,
        latitude: null,
        longitude: null,
      });
      lotReadingsCreated += attributed.readingsCreated;
      alertsCreated += attributed.alertsCreated;
    }

    if (
      latestCsvCapture &&
      (!sensor.lastCapturedAt || latestCsvCapture.capturedAt.getTime() >= sensor.lastCapturedAt.getTime())
    ) {
      await this.prisma.temperatureDevice.update({
        where: { id: sensor.id },
        data: {
          lastSeenAt: receivedAt,
          lastTemperatureC: latestCsvCapture.tempC,
          lastCapturedAt: latestCsvCapture.capturedAt,
          lastReceivedAt: receivedAt,
          lastDelaySeconds: latestCsvCapture.delaySeconds,
          ...(latestCsvCapture.humidityPct !== null ? { lastHumidityPct: latestCsvCapture.humidityPct } : {}),
          ...(latestCsvCapture.batteryMv !== null ? { lastBatteryMv: latestCsvCapture.batteryMv } : {}),
          ...(latestCsvCapture.doorOpen !== null ? { lastDoorOpen: latestCsvCapture.doorOpen } : {}),
          lastGapKind:
            latestCsvCapture.delaySeconds > 90 ? TelemetryGapKind.LTE_BUFFERED_RECOVERY : null,
        },
      });
    }

    return {
      sensorId: sensor.id,
      deviceCode: sensor.deviceCode,
      totalRows: parsedRows.length,
      importedFrames,
      deduplicatedFrames,
      lotReadingsCreated,
      alertsCreated,
    };
  }

  private async ingestNormalizedRecords(
    auth: TelemetryAuthContext,
    imei: string,
    protocol: TelemetryProtocol,
    records: NormalizedTelemetryRecord[],
    crcHex?: string,
  ): Promise<TelemetryIngestSummary> {
    if (auth.scope === TelemetryCredentialScope.DEVICE_TRACKER && auth.trackerImei !== imei) {
      throw new ForbiddenException('Device credential cannot submit telemetry for a different tracker IMEI');
    }

    const tracker = await this.prisma.vehicleTracker.findUnique({
      where: { imei },
      include: {
        fleetAsset: {
          select: {
            id: true,
            status: true,
            lastGpsCapturedAt: true,
          },
        },
      },
    });

    if (!tracker) {
      throw new ForbiddenException('Tracker IMEI is not registered');
    }
    if (tracker.status !== DeviceStatus.ACTIVE || tracker.fleetAsset.status !== FleetAssetStatus.ACTIVE) {
      throw new ForbiddenException('Tracker or assigned fleet vehicle is not active');
    }

    const configuredSensors = await this.prisma.temperatureDevice.findMany({
      where: {
        status: DeviceStatus.ACTIVE,
        compartment: {
          fleetAssetId: tracker.fleetAssetId,
          active: true,
        },
      },
      orderBy: [{ sensorSlot: 'asc' }, { createdAt: 'asc' }],
    });

    const sortedRecords = [...records].sort(
      (a, b) => a.capturedAt.getTime() - b.capturedAt.getTime(),
    );

    const receivedAt = new Date();
    let storedFrames = 0;
    let deduplicatedFrames = 0;
    let lotReadingsCreated = 0;
    let alertsCreated = 0;
    let sensorMissingFrames = 0;
    let delayedFrames = 0;
    let noFixFrames = 0;

    let trackedGpsCutoff = tracker.fleetAsset.lastGpsCapturedAt;
    let trackedLastCapture = tracker.lastCapturedAt;
    const sensorCutoffById = new Map<string, Date | null>(
      configuredSensors.map((sensor) => [sensor.id, sensor.lastCapturedAt]),
    );

    for (const record of sortedRecords) {
      const { delaySeconds, isDelayed } = computeDelaySeconds(record.capturedAt, receivedAt);
      if (isDelayed) delayedFrames += 1;
      if (!record.gnssValid) noFixFrames += 1;

      const targets: Array<{ sensor: (typeof configuredSensors)[number] | null; slot: number }> =
        configuredSensors.length > 0
          ? configuredSensors.map((sensor) => ({ sensor, slot: sensor.sensorSlot ?? 1 }))
          : [{ sensor: null, slot: 1 }];

      for (const target of targets) {
        const sensor = target.sensor;
        const eyeData = record.eyeSensors[target.slot] ?? null;
        const cargoTempC = eyeData?.cargoTempC ?? null;

        let gapKind: TelemetryGapKind | null = null;
        if (sensor && cargoTempC === null) {
          gapKind = TelemetryGapKind.SENSOR_SIGNAL_MISSING;
          sensorMissingFrames += 1;
        } else if (!record.gnssValid) {
          gapKind = TelemetryGapKind.GNSS_NO_FIX;
        } else if (isDelayed) {
          gapKind = TelemetryGapKind.LTE_BUFFERED_RECOVERY;
        }

        const dedupeKey = record.eventId
          ? `event:${tracker.id}:${sensor?.id ?? 'gps'}:${record.eventId}`
          : `frame:${tracker.id}:${sensor?.id ?? 'gps'}:${protocol}:${record.capturedAt.getTime()}`;

        const existingFrame = await this.prisma.vehicleTelemetryFrame.findUnique({
          where: { dedupeKey },
          select: { id: true },
        });
        if (existingFrame) {
          deduplicatedFrames += 1;
          continue;
        }

        let createdFrame: { id: string };
        try {
          createdFrame = await this.prisma.vehicleTelemetryFrame.create({
            data: {
              trackerId: tracker.id,
              sensorDeviceId: sensor?.id ?? null,
              fleetAssetId: tracker.fleetAssetId,
              compartmentId: sensor?.compartmentId ?? null,
              protocol,
              origin: TemperatureReadingOrigin.CARGO_AIR_SENSOR,
              dedupeKey,
              capturedAt: record.capturedAt,
              receivedAt,
              delaySeconds,
              isDelayed,
              latitude: record.latitude,
              longitude: record.longitude,
              altitudeM: record.altitudeM,
              speedKph: record.speedKph,
              angleDeg: record.angleDeg,
              satellites: record.satellites,
              gnssValid: record.gnssValid,
              cargoTempC: cargoTempC,
              humidityPct: eyeData?.humidityPct ?? null,
              doorOpen: eyeData?.doorOpen ?? null,
              movement: eyeData?.movement ?? null,
              batteryMv: eyeData?.batteryMv ?? null,
              externalVoltageMv: record.externalVoltageMv,
              gsmSignal: record.gsmSignal,
              gapKind,
              rawPayload: record.rawPayload as Prisma.InputJsonValue,
            },
            select: { id: true },
          });
        } catch (err) {
          if (isUniqueConstraintError(err)) {
            deduplicatedFrames += 1;
            continue;
          }
          throw err;
        }

        storedFrames += 1;

        // Monotonic live vehicle GPS state update: historical outage replays NEVER overwrite newer fixes.
        if (record.gnssValid && (!trackedGpsCutoff || record.capturedAt.getTime() >= trackedGpsCutoff.getTime())) {
          trackedGpsCutoff = record.capturedAt;
          await this.prisma.fleetAsset.update({
            where: { id: tracker.fleetAssetId },
            data: {
              lastLatitude: record.latitude,
              lastLongitude: record.longitude,
              lastSpeedKph: record.speedKph,
              lastHeadingDeg: record.angleDeg,
              lastSatellites: record.satellites,
              lastGpsCapturedAt: record.capturedAt,
              lastTelemetryReceivedAt: receivedAt,
              lastTelemetryDelayed: isDelayed,
            },
          });
        } else if (!record.gnssValid && (!trackedGpsCutoff || record.capturedAt.getTime() >= trackedGpsCutoff.getTime())) {
          await this.prisma.fleetAsset.update({
            where: { id: tracker.fleetAssetId },
            data: {
              lastGpsNoFixAt: record.capturedAt,
              lastTelemetryReceivedAt: receivedAt,
            },
          });
        }

        // Monotonic sensor live readout update
        if (sensor) {
          const sensorCutoff = sensorCutoffById.get(sensor.id) ?? null;
          if (!sensorCutoff || record.capturedAt.getTime() >= sensorCutoff.getTime()) {
            if (cargoTempC !== null) {
              sensorCutoffById.set(sensor.id, record.capturedAt);
              await this.prisma.temperatureDevice.update({
                where: { id: sensor.id },
                data: {
                  lastSeenAt: receivedAt,
                  lastTemperatureC: cargoTempC,
                  lastCapturedAt: record.capturedAt,
                  lastReceivedAt: receivedAt,
                  lastDelaySeconds: delaySeconds,
                  lastHumidityPct: eyeData?.humidityPct ?? null,
                  lastBatteryMv: eyeData?.batteryMv ?? null,
                  lastDoorOpen: eyeData?.doorOpen ?? null,
                  lastMovement: eyeData?.movement ?? null,
                  lastGapKind: isDelayed ? TelemetryGapKind.LTE_BUFFERED_RECOVERY : null,
                },
              });
            } else {
              await this.prisma.temperatureDevice.update({
                where: { id: sensor.id },
                data: {
                  lastReceivedAt: receivedAt,
                  lastDelaySeconds: delaySeconds,
                  lastSignalMissingAt: record.capturedAt,
                  lastGapKind: TelemetryGapKind.SENSOR_SIGNAL_MISSING,
                },
              });
            }
          }

          if (cargoTempC !== null && sensor.compartmentId) {
            const attributed = await this.attributeTemperatureReadingToOnboardLots({
              frameId: createdFrame.id,
              capturedAt: record.capturedAt,
              receivedAt,
              isDelayed,
              temperatureC: cargoTempC,
              origin: TemperatureReadingOrigin.CARGO_AIR_SENSOR,
              sensorId: sensor.id,
              compartmentId: sensor.compartmentId,
              fleetAssetId: tracker.fleetAssetId,
              trackerId: tracker.id,
              latitude: record.latitude,
              longitude: record.longitude,
            });
            lotReadingsCreated += attributed.readingsCreated;
            alertsCreated += attributed.alertsCreated;
          }
        }
      }

      if (!trackedLastCapture || record.capturedAt.getTime() >= trackedLastCapture.getTime()) {
        trackedLastCapture = record.capturedAt;
      }
    }

    await this.prisma.vehicleTracker.update({
      where: { id: tracker.id },
      data: {
        lastSeenAt: receivedAt,
        lastReceivedAt: receivedAt,
        ...(trackedLastCapture ? { lastCapturedAt: trackedLastCapture } : {}),
        ...(crcHex ? { lastPacketCrc: crcHex } : {}),
      },
    });

    return {
      imei: tracker.imei,
      trackerId: tracker.id,
      fleetAssetId: tracker.fleetAssetId,
      protocol,
      totalRecords: sortedRecords.length,
      acceptedCount: sortedRecords.length,
      storedFrames,
      deduplicatedFrames,
      lotReadingsCreated,
      alertsCreated,
      sensorMissingFrames,
      delayedFrames,
      noFixFrames,
    };
  }

  /**
   * Resolves custody-linked cargo compartment assignments active at the exact
   * measurement capture timestamp (supports multi-stop routes, multiple lots,
   * partial handovers, and excludes already handed-over cargo).
   */
  private async attributeTemperatureReadingToOnboardLots(params: {
    frameId: string;
    capturedAt: Date;
    receivedAt: Date;
    isDelayed: boolean;
    temperatureC: number;
    origin: TemperatureReadingOrigin;
    sensorId: string;
    compartmentId: string | null;
    fleetAssetId: string | null;
    trackerId: string | null;
    latitude: number | null;
    longitude: number | null;
  }): Promise<{ readingsCreated: number; alertsCreated: number }> {
    const {
      frameId,
      capturedAt,
      receivedAt,
      isDelayed,
      temperatureC,
      origin,
      sensorId,
      compartmentId,
      fleetAssetId,
      trackerId,
      latitude,
      longitude,
    } = params;

    const assignmentWhere: Prisma.CargoCompartmentAssignmentWhereInput = compartmentId
      ? {
          compartmentId,
          loadedAt: { lte: capturedAt },
          OR: [{ unloadedAt: null }, { unloadedAt: { gte: capturedAt } }],
        }
      : {
          sensorDeviceId: sensorId,
          loadedAt: { lte: capturedAt },
          OR: [{ unloadedAt: null }, { unloadedAt: { gte: capturedAt } }],
        };

    const activeAssignments = await this.prisma.cargoCompartmentAssignment.findMany({
      where: assignmentWhere,
      include: {
        lot: true,
      },
    });

    let readingsCreated = 0;
    let alertsCreated = 0;
    const processedLotKeys = new Set<string>();

    for (const assignment of activeAssignments) {
      const readingDedupeKey = `reading:${frameId}:${assignment.lotId}`;
      if (processedLotKeys.has(readingDedupeKey)) {
        continue;
      }
      processedLotKeys.add(readingDedupeKey);

      const existingReading = await this.prisma.temperatureReading.findUnique({
        where: { dedupeKey: readingDedupeKey },
        select: { id: true },
      });
      if (existingReading) {
        continue;
      }

      let reading;
      try {
        reading = await this.prisma.temperatureReading.create({
          data: {
            lotId: assignment.lotId,
            deviceId: sensorId,
            checkpoint: TemperatureCheckpoint.IN_TRANSIT,
            temperatureC,
            recordedById: null,
            origin,
            capturedAt,
            receivedAt,
            isDelayed,
            deliveryId: assignment.deliveryId,
            fleetAssetId,
            compartmentId,
            trackerId,
            telemetryFrameId: frameId,
            dedupeKey: readingDedupeKey,
            latitude,
            longitude,
            recordedAt: capturedAt,
          },
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          continue;
        }
        throw err;
      }

      readingsCreated += 1;

      const alert = await this.temperatureMonitoringService.evaluateAndCreateAlertForReading({
        reading,
        lot: assignment.lot,
        deviceId: sensorId,
        temperatureC,
        checkpoint: TemperatureCheckpoint.IN_TRANSIT,
      });
      if (alert) {
        alertsCreated += 1;
      }
    }

    return { readingsCreated, alertsCreated };
  }
}
