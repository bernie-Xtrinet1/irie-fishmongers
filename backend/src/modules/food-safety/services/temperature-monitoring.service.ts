import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AlertSeverity, SeafoodStorageType, TemperatureThreshold } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { DriversRepository } from '../../delivery/repositories/drivers.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateTemperatureReadingDto } from '../dto/create-temperature-reading.dto';
import { ListTemperatureAlertsDto } from '../dto/list-temperature-alerts.dto';
import { PaginatedTemperatureAlertsEntity } from '../entities/paginated-temperature-alerts.entity';
import { PaginatedTemperatureReadingsEntity } from '../entities/paginated-temperature-readings.entity';
import { RecordReadingResultEntity } from '../entities/record-reading-result.entity';
import { TemperatureAlertResponseEntity } from '../entities/temperature-alert-response.entity';
import { TemperatureReadingResponseEntity } from '../entities/temperature-reading-response.entity';
import { SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { TemperatureAlertsRepository } from '../repositories/temperature-alerts.repository';
import { TemperatureDevicesRepository } from '../repositories/temperature-devices.repository';
import { TemperatureReadingsRepository } from '../repositories/temperature-readings.repository';
import { TemperatureThresholdsRepository } from '../repositories/temperature-thresholds.repository';
import { SeafoodLotsService } from './seafood-lots.service';

@Injectable()
export class TemperatureMonitoringService {
  constructor(
    private readonly readingsRepository: TemperatureReadingsRepository,
    private readonly alertsRepository: TemperatureAlertsRepository,
    private readonly lotsRepository: SeafoodLotsRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly driversRepository: DriversRepository,
    private readonly seafoodLotsService: SeafoodLotsService,
    private readonly thresholdsRepository: TemperatureThresholdsRepository,
    private readonly devicesRepository: TemperatureDevicesRepository,
  ) {}

  async recordReading(
    userId: string,
    dto: CreateTemperatureReadingDto,
  ): Promise<RecordReadingResultEntity> {
    const lot = await this.lotsRepository.findById(dto.lotId);
    if (!lot) {
      throw new NotFoundException('Seafood lot not found');
    }

    await this.assertCanRecordReading(userId, lot.vendorId);

    const reading = await this.readingsRepository.create({
      lotId: dto.lotId,
      deviceId: dto.deviceId,
      checkpoint: dto.checkpoint,
      temperatureC: dto.temperatureC,
      recordedById: userId,
      latitude: dto.latitude,
      longitude: dto.longitude,
      photoUrl: dto.photoUrl,
    });

    if (dto.deviceId) {
      await this.devicesRepository.touchLastSeen(dto.deviceId);
    }

    const threshold = await this.resolveThreshold(dto.deviceId, lot.storageType);
    const severity = threshold
      ? TemperatureMonitoringService.evaluateSeverity(threshold, dto.temperatureC)
      : null;
    if (!severity) {
      return { reading: TemperatureMonitoringService.toReadingResponse(reading) };
    }

    const alert = await this.alertsRepository.create({
      readingId: reading.id,
      lotId: dto.lotId,
      severity,
      actualC: dto.temperatureC,
    });

    if (severity === 'CRITICAL' && lot.foodSafetyStatus === 'SAFE') {
      await this.lotsRepository.updateStatus(
        lot.id,
        'UNDER_REVIEW',
        `Automatically flagged for review after a critical temperature reading of ${dto.temperatureC}C at ${dto.checkpoint}`,
      );
    }

    // EMERGENCY quarantines the lot outright, per cold-chain-management.md's
    // automated-actions table. Never overrides RECALLED/QUARANTINED - same
    // "no silent auto-clear of a compliance hold" discipline already applied
    // to quality inspections never lifting a RECALLED status.
    if (
      severity === 'EMERGENCY' &&
      lot.foodSafetyStatus !== 'RECALLED' &&
      lot.foodSafetyStatus !== 'QUARANTINED'
    ) {
      await this.lotsRepository.updateStatus(
        lot.id,
        'QUARANTINED',
        `Automatically quarantined after an emergency temperature reading of ${dto.temperatureC}C at ${dto.checkpoint}`,
      );
    }

    return {
      reading: TemperatureMonitoringService.toReadingResponse(reading),
      alert: TemperatureMonitoringService.toAlertResponse(alert),
    };
  }

  async getReadingsForLot(
    user: RequestUser,
    lotId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedTemperatureReadingsEntity> {
    await this.seafoodLotsService.assertOwnedByRequester(user, lotId);

    const { items, total } = await this.readingsRepository.findByLotId(lotId, {
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    return {
      items: items.map((item) => TemperatureMonitoringService.toReadingResponse(item)),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async listAlerts(dto: ListTemperatureAlertsDto): Promise<PaginatedTemperatureAlertsEntity> {
    const { items, total } = await this.alertsRepository.findMany(
      { severity: dto.severity, resolved: dto.resolved },
      { skip: (dto.page - 1) * dto.pageSize, take: dto.pageSize },
    );

    return {
      items: items.map((item) => TemperatureMonitoringService.toAlertResponse(item)),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  async resolveAlert(id: string): Promise<TemperatureAlertResponseEntity> {
    const alert = await this.alertsRepository.findById(id);
    if (!alert) {
      throw new NotFoundException('Temperature alert not found');
    }
    const resolved = await this.alertsRepository.resolve(id);
    return TemperatureMonitoringService.toAlertResponse(resolved);
  }

  private async assertCanRecordReading(userId: string, lotVendorId: string): Promise<void> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (vendor) {
      if (vendor.id !== lotVendorId) {
        throw new ForbiddenException('You do not own this lot');
      }
      return;
    }

    const driver = await this.driversRepository.findByUserId(userId);
    if (driver) {
      if (driver.status !== 'APPROVED') {
        throw new ForbiddenException('Only approved drivers can record temperature readings');
      }
      return;
    }

    throw new ForbiddenException('Only vendors or drivers can record temperature readings');
  }

  // Device-specific threshold first, else the storage-type platform
  // default (seeded once per SeafoodStorageType) - replaces the previous
  // hardcoded FRESH_MAX_C/FROZEN_MAX_C constants with real, admin-editable
  // data (cold-chain-management.md's "configurable thresholds" ask).
  private async resolveThreshold(
    deviceId: string | undefined,
    storageType: SeafoodStorageType,
  ): Promise<TemperatureThreshold | null> {
    if (deviceId) {
      const deviceThreshold = await this.thresholdsRepository.findByDeviceAndStorageType(
        deviceId,
        storageType,
      );
      if (deviceThreshold) {
        return deviceThreshold;
      }
    }
    return this.thresholdsRepository.findPlatformDefault(storageType);
  }

  // A reading colder than minC is only ever a WARNING (matches the
  // pre-threshold-model behaviour: under-chilling fresh product is a minor
  // flag, not a spoilage risk) - deliberately not escalated further. A
  // reading warmer than maxC escalates WARNING -> CRITICAL -> EMERGENCY as
  // it moves further past maxC, in increments of warningBandC. EMERGENCY
  // has no concrete numeric definition in the source docs (they define it
  // by sustained duration, which needs a scheduler this codebase doesn't
  // have) - 2x the warning band past maxC is this service's own defensible
  // definition of "severely out of band."
  private static evaluateSeverity(
    threshold: TemperatureThreshold,
    temperatureC: number,
  ): AlertSeverity | null {
    const minC = threshold.minC.toNumber();
    const maxC = threshold.maxC.toNumber();
    const warningBandC = threshold.warningBandC.toNumber();

    if (temperatureC < minC) {
      return 'WARNING';
    }
    if (temperatureC <= maxC) {
      return null;
    }

    const excess = temperatureC - maxC;
    if (excess > warningBandC * 2) {
      return 'EMERGENCY';
    }
    if (excess > warningBandC) {
      return 'CRITICAL';
    }
    return 'WARNING';
  }

  private static toReadingResponse(reading: {
    id: string;
    lotId: string;
    deviceId: string | null;
    checkpoint: string;
    temperatureC: { toString(): string };
    latitude: number | null;
    longitude: number | null;
    photoUrl: string | null;
    recordedAt: Date;
  }): TemperatureReadingResponseEntity {
    return {
      id: reading.id,
      lotId: reading.lotId,
      deviceId: reading.deviceId,
      checkpoint: reading.checkpoint as TemperatureReadingResponseEntity['checkpoint'],
      temperatureC: reading.temperatureC.toString(),
      latitude: reading.latitude,
      longitude: reading.longitude,
      photoUrl: reading.photoUrl,
      recordedAt: reading.recordedAt,
    };
  }

  private static toAlertResponse(alert: {
    id: string;
    readingId: string;
    lotId: string;
    severity: string;
    actualC: { toString(): string };
    resolved: boolean;
    resolvedAt: Date | null;
    createdAt: Date;
  }): TemperatureAlertResponseEntity {
    return {
      id: alert.id,
      readingId: alert.readingId,
      lotId: alert.lotId,
      severity: alert.severity as TemperatureAlertResponseEntity['severity'],
      actualC: alert.actualC.toString(),
      resolved: alert.resolved,
      resolvedAt: alert.resolvedAt,
      createdAt: alert.createdAt,
    };
  }
}
