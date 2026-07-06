import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AlertSeverity, SeafoodStorageType } from '@prisma/client';

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
import { TemperatureReadingsRepository } from '../repositories/temperature-readings.repository';
import { SeafoodLotsService } from './seafood-lots.service';

// Point-in-time reading thresholds. The source docs (cold-chain-requirements.md)
// define Warning/Critical by how long a breach persists (15 vs 30 minutes),
// which only makes sense for continuous IoT telemetry - manual/discrete
// readings have no "duration," so severity here is derived from how far the
// reading is outside the safe band instead. EMERGENCY has no concrete
// numeric definition anywhere in the source docs, so it is never
// auto-derived; it remains a valid status for a future continuous-monitoring
// engine to use.
const FRESH_MAX_C = 4;
const FRESH_MIN_C = 0;
const FRESH_WARNING_MAX_C = 7;
const FROZEN_MAX_C = -18;
const FROZEN_WARNING_MAX_C = -15;

@Injectable()
export class TemperatureMonitoringService {
  constructor(
    private readonly readingsRepository: TemperatureReadingsRepository,
    private readonly alertsRepository: TemperatureAlertsRepository,
    private readonly lotsRepository: SeafoodLotsRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly driversRepository: DriversRepository,
    private readonly seafoodLotsService: SeafoodLotsService,
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
      checkpoint: dto.checkpoint,
      temperatureC: dto.temperatureC,
      recordedById: userId,
      latitude: dto.latitude,
      longitude: dto.longitude,
      photoUrl: dto.photoUrl,
    });

    const severity = TemperatureMonitoringService.evaluateSeverity(lot.storageType, dto.temperatureC);
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

  private static evaluateSeverity(
    storageType: SeafoodStorageType,
    temperatureC: number,
  ): AlertSeverity | null {
    if (storageType === 'FRESH') {
      if (temperatureC < FRESH_MIN_C) return 'WARNING';
      if (temperatureC > FRESH_WARNING_MAX_C) return 'CRITICAL';
      if (temperatureC > FRESH_MAX_C) return 'WARNING';
      return null;
    }

    if (temperatureC > FROZEN_MAX_C) {
      return temperatureC > FROZEN_WARNING_MAX_C ? 'CRITICAL' : 'WARNING';
    }
    return null;
  }

  private static toReadingResponse(reading: {
    id: string;
    lotId: string;
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
