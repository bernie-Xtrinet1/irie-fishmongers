import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { DriverSettlement, SettlementStatus } from '@prisma/client';

import { DriverLocationsRepository } from '../../delivery/repositories/driver-locations.repository';
import { DriversRepository } from '../../delivery/repositories/drivers.repository';
import { CreateRateConfigDto } from '../dto/create-rate-config.dto';
import { ListDriverSettlementsDto } from '../dto/list-driver-settlements.dto';
import { DriverSettlementResponseEntity } from '../entities/driver-settlement-response.entity';
import { GenerateSettlementsResultEntity } from '../entities/generate-settlements-result.entity';
import { PaginatedDriverSettlementsEntity } from '../entities/paginated-driver-settlements.entity';
import { RateConfigResponseEntity } from '../entities/rate-config-response.entity';
import {
  DeliveryForSettlement,
  DriverSettlementsRepository,
} from '../repositories/driver-settlements.repository';
import { SettlementRateConfigsRepository } from '../repositories/settlement-rate-configs.repository';
import { DriverSettlementEngine } from './driver-settlement-engine.service';

const JAMAICA_UTC_OFFSET_HOURS = -5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ALLOWED_STATUS_TRANSITIONS: Record<SettlementStatus, SettlementStatus[]> = {
  PENDING: ['APPROVED', 'FAILED', 'DISPUTED'],
  APPROVED: ['PAID', 'FAILED', 'DISPUTED'],
  PAID: [],
  FAILED: [],
  DISPUTED: [],
};

@Injectable()
export class DriverSettlementsService {
  constructor(
    private readonly driverSettlementsRepository: DriverSettlementsRepository,
    private readonly rateConfigsRepository: SettlementRateConfigsRepository,
    private readonly driversRepository: DriversRepository,
    private readonly driverLocationsRepository: DriverLocationsRepository,
    private readonly engine: DriverSettlementEngine,
  ) {}

  async generateWeeklySettlements(weekStartInput: string): Promise<GenerateSettlementsResultEntity> {
    const rateConfig = await this.rateConfigsRepository.findCurrent();
    if (!rateConfig) {
      throw new InternalServerErrorException('No settlement rate configuration exists');
    }

    const { periodStart, periodEnd } = DriverSettlementsService.toSettlementPeriod(weekStartInput);
    const deliveries = await this.driverSettlementsRepository.findUnsettledDeliveries(
      periodStart,
      periodEnd,
    );

    const deliveriesByDriver = new Map<string, DeliveryForSettlement[]>();
    for (const delivery of deliveries) {
      const existing = deliveriesByDriver.get(delivery.driverId);
      if (existing) {
        existing.push(delivery);
      } else {
        deliveriesByDriver.set(delivery.driverId, [delivery]);
      }
    }

    let settlementsCreated = 0;

    for (const [driverId, driverDeliveries] of deliveriesByDriver) {
      for (const delivery of driverDeliveries) {
        const locations = await this.driverLocationsRepository.findBetween(
          driverId,
          delivery.pickedUpAt ?? delivery.assignedAt,
          delivery.deliveredAt!,
        );
        const distanceKm = this.engine.computeDistanceKm(locations);
        const compensation = this.engine.computeDeliveryCompensation(
          {
            vehicleOwnership: delivery.driver.vehicleOwnership,
            distanceKm,
            items: delivery.vendorOrder.items,
            deliveredAt: delivery.deliveredAt!,
          },
          rateConfig,
        );

        await this.driverSettlementsRepository.create({
          driverId,
          deliveryId: delivery.id,
          vehicleOwnership: delivery.driver.vehicleOwnership,
          baseFee: compensation.baseFee,
          distanceKm,
          distanceFee: compensation.distanceFee,
          heavyLoadBonus: compensation.heavyLoadBonus,
          peakBonus: compensation.peakBonus,
          volumeBonus: 0,
          totalPayout:
            compensation.baseFee +
            compensation.distanceFee +
            compensation.heavyLoadBonus +
            compensation.peakBonus,
          settlementPeriodStart: periodStart,
          settlementPeriodEnd: periodEnd,
        });
        settlementsCreated += 1;
      }

      const completedCount = await this.driverSettlementsRepository.countDeliveriesInPeriod(
        driverId,
        periodStart,
        periodEnd,
      );
      const volumeBonus = this.engine.computeVolumeBonus(completedCount, rateConfig);

      if (volumeBonus > 0) {
        const existingBonusRow = await this.driverSettlementsRepository.findVolumeBonusRow(
          driverId,
          periodStart,
          periodEnd,
        );
        if (!existingBonusRow) {
          await this.driverSettlementsRepository.create({
            driverId,
            vehicleOwnership: driverDeliveries[0]!.driver.vehicleOwnership,
            baseFee: 0,
            distanceKm: 0,
            distanceFee: 0,
            heavyLoadBonus: 0,
            peakBonus: 0,
            volumeBonus,
            totalPayout: volumeBonus,
            settlementPeriodStart: periodStart,
            settlementPeriodEnd: periodEnd,
          });
          settlementsCreated += 1;
        }
      }
    }

    return { settlementPeriodStart: periodStart, settlementPeriodEnd: periodEnd, settlementsCreated };
  }

  async getMine(
    userId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedDriverSettlementsEntity> {
    const driver = await this.driversRepository.findByUserId(userId);
    if (!driver) {
      throw new NotFoundException('No driver profile exists for this account');
    }

    const { items, total } = await this.driverSettlementsRepository.findManyByDriver(driver.id, {
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    return {
      items: items.map((item) => DriverSettlementsService.toResponse(item)),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async list(dto: ListDriverSettlementsDto): Promise<PaginatedDriverSettlementsEntity> {
    const { items, total } = await this.driverSettlementsRepository.findMany(
      { driverId: dto.driverId, status: dto.status },
      { skip: (dto.page - 1) * dto.pageSize, take: dto.pageSize },
    );

    return {
      items: items.map((item) => DriverSettlementsService.toResponse(item)),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  async updateStatus(
    id: string,
    status: SettlementStatus,
    notes?: string,
  ): Promise<DriverSettlementResponseEntity> {
    const settlement = await this.driverSettlementsRepository.findById(id);
    if (!settlement) {
      throw new NotFoundException('Settlement not found');
    }
    if (!ALLOWED_STATUS_TRANSITIONS[settlement.status].includes(status)) {
      throw new BadRequestException(`Cannot move a ${settlement.status} settlement to ${status}`);
    }

    const updated = await this.driverSettlementsRepository.updateStatus(id, status, {
      payoutDate: status === 'PAID' ? new Date() : undefined,
      notes,
    });

    return DriverSettlementsService.toResponse(updated);
  }

  async getCurrentRateConfig(): Promise<RateConfigResponseEntity> {
    const rateConfig = await this.rateConfigsRepository.findCurrent();
    if (!rateConfig) {
      throw new InternalServerErrorException('No settlement rate configuration exists');
    }
    return DriverSettlementsService.toRateConfigResponse(rateConfig);
  }

  async createRateConfig(dto: CreateRateConfigDto): Promise<RateConfigResponseEntity> {
    if (
      dto.volumeBonusTier1Threshold >= dto.volumeBonusTier2Threshold ||
      dto.volumeBonusTier2Threshold >= dto.volumeBonusTier3Threshold
    ) {
      throw new BadRequestException(
        'Volume bonus tier thresholds must be strictly increasing (tier 1 < tier 2 < tier 3)',
      );
    }

    const rateConfig = await this.rateConfigsRepository.create(dto);
    return DriverSettlementsService.toRateConfigResponse(rateConfig);
  }

  private static toSettlementPeriod(weekStartInput: string): { periodStart: Date; periodEnd: Date } {
    const input = new Date(weekStartInput);
    if (Number.isNaN(input.getTime())) {
      throw new BadRequestException('Invalid weekStart date');
    }

    // The input's UTC calendar date is treated as the intended Jamaica-local
    // calendar date (an admin typing a plain date like "2026-06-29" means
    // that Jamaica calendar day, not a UTC instant - shifting it again by
    // the Jamaica offset here would roll it back into the previous day).
    const inputDay = input.getUTCDay();
    const daysSinceMonday = (inputDay + 6) % 7;

    const mondayUtcMidnight = Date.UTC(
      input.getUTCFullYear(),
      input.getUTCMonth(),
      input.getUTCDate() - daysSinceMonday,
    );
    // Jamaica midnight on that Monday is 05:00 UTC (UTC-5 year-round, no DST).
    const periodStart = new Date(mondayUtcMidnight - JAMAICA_UTC_OFFSET_HOURS * 60 * 60 * 1000);
    const periodEnd = new Date(periodStart.getTime() + 7 * MS_PER_DAY - 1);

    return { periodStart, periodEnd };
  }

  private static toResponse(settlement: DriverSettlement): DriverSettlementResponseEntity {
    return {
      id: settlement.id,
      driverId: settlement.driverId,
      deliveryId: settlement.deliveryId,
      vehicleOwnership: settlement.vehicleOwnership,
      baseFee: settlement.baseFee.toString(),
      distanceKm: settlement.distanceKm.toString(),
      distanceFee: settlement.distanceFee.toString(),
      heavyLoadBonus: settlement.heavyLoadBonus.toString(),
      peakBonus: settlement.peakBonus.toString(),
      volumeBonus: settlement.volumeBonus.toString(),
      totalPayout: settlement.totalPayout.toString(),
      status: settlement.status,
      settlementPeriodStart: settlement.settlementPeriodStart,
      settlementPeriodEnd: settlement.settlementPeriodEnd,
      payoutDate: settlement.payoutDate,
      notes: settlement.notes,
      createdAt: settlement.createdAt,
    };
  }

  private static toRateConfigResponse(rateConfig: {
    id: string;
    baseFee: { toString(): string };
    distanceCompensationEnabled: boolean;
    distanceRatePerKm: { toString(): string };
    heavyLoadThresholdLbs: { toString(): string };
    heavyLoadBonus: { toString(): string };
    peakBonus: { toString(): string };
    volumeBonusTier1Threshold: number;
    volumeBonusTier1Amount: { toString(): string };
    volumeBonusTier2Threshold: number;
    volumeBonusTier2Amount: { toString(): string };
    volumeBonusTier3Threshold: number;
    volumeBonusTier3Amount: { toString(): string };
    createdAt: Date;
  }): RateConfigResponseEntity {
    return {
      id: rateConfig.id,
      baseFee: rateConfig.baseFee.toString(),
      distanceCompensationEnabled: rateConfig.distanceCompensationEnabled,
      distanceRatePerKm: rateConfig.distanceRatePerKm.toString(),
      heavyLoadThresholdLbs: rateConfig.heavyLoadThresholdLbs.toString(),
      heavyLoadBonus: rateConfig.heavyLoadBonus.toString(),
      peakBonus: rateConfig.peakBonus.toString(),
      volumeBonusTier1Threshold: rateConfig.volumeBonusTier1Threshold,
      volumeBonusTier1Amount: rateConfig.volumeBonusTier1Amount.toString(),
      volumeBonusTier2Threshold: rateConfig.volumeBonusTier2Threshold,
      volumeBonusTier2Amount: rateConfig.volumeBonusTier2Amount.toString(),
      volumeBonusTier3Threshold: rateConfig.volumeBonusTier3Threshold,
      volumeBonusTier3Amount: rateConfig.volumeBonusTier3Amount.toString(),
      createdAt: rateConfig.createdAt,
    };
  }
}
