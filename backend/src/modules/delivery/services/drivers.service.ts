import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Driver, DriverStatus, TemperatureCheckpoint } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { ListDriversDto } from '../dto/list-drivers.dto';
import { RegisterDriverDto } from '../dto/register-driver.dto';
import { MANUAL_AVAILABILITY_STATUSES } from '../dto/update-driver-availability.dto';
import { UpdateDriverProfileDto } from '../dto/update-driver-profile.dto';
import { DriverPerformanceMetricsEntity } from '../entities/driver-performance-metrics.entity';
import { DeliveriesRepository, DeliveryForMetrics } from '../repositories/deliveries.repository';
import { DriverLocationsRepository } from '../repositories/driver-locations.repository';
import { DriversRepository } from '../repositories/drivers.repository';

export interface PaginatedDrivers {
  items: Driver[];
  total: number;
  page: number;
  pageSize: number;
}

// Checkpoints that matter for cold-chain compliance from pickup through
// customer handoff - matches food-safety.ts's refined cold-chain list.
const TEMPERATURE_COMPLIANCE_CHECKPOINTS: TemperatureCheckpoint[] = [
  'DRIVER_PICKUP',
  'IN_TRANSIT',
  'DELIVERY',
  'VEHICLE_LOADING',
  'CUSTOMER_ACCEPTANCE',
];

@Injectable()
export class DriversService {
  constructor(
    private readonly driversRepository: DriversRepository,
    private readonly driverLocationsRepository: DriverLocationsRepository,
    private readonly deliveriesRepository: DeliveriesRepository,
    private readonly prisma: PrismaService,
  ) {}

  async register(userId: string, dto: RegisterDriverDto): Promise<Driver> {
    const existing = await this.driversRepository.findByUserId(userId);
    if (existing) {
      throw new ConflictException('A driver profile already exists for this account');
    }

    return this.driversRepository.create({
      userId,
      licensePlate: dto.licensePlate,
      vehicleType: dto.vehicleType,
      vehicleOwnership: dto.vehicleOwnership,
    });
  }

  async getOwnProfile(userId: string): Promise<Driver> {
    const driver = await this.driversRepository.findByUserId(userId);
    if (!driver) {
      throw new NotFoundException('No driver profile exists for this account');
    }
    return driver;
  }

  async updateStatus(driverId: string, status: DriverStatus): Promise<Driver> {
    const driver = await this.driversRepository.findById(driverId);
    if (!driver) {
      throw new NotFoundException('Driver not found');
    }
    return this.driversRepository.updateStatus(driverId, status);
  }

  async list(dto: ListDriversDto): Promise<PaginatedDrivers> {
    const { items, total } = await this.driversRepository.findMany(dto.status, {
      skip: (dto.page - 1) * dto.pageSize,
      take: dto.pageSize,
    });

    return { items, total, page: dto.page, pageSize: dto.pageSize };
  }

  async recordLocation(userId: string, latitude: number, longitude: number): Promise<void> {
    const driver = await this.getOwnProfile(userId);
    if (driver.status !== 'APPROVED') {
      throw new ForbiddenException('Only approved drivers can report their location');
    }
    await this.driverLocationsRepository.record(driver.id, latitude, longitude);
  }

  async updateAvailability(
    userId: string,
    status: (typeof MANUAL_AVAILABILITY_STATUSES)[number],
  ): Promise<Driver> {
    const driver = await this.getOwnProfile(userId);
    if (driver.status !== 'APPROVED') {
      throw new ForbiddenException('Only approved drivers can update their availability');
    }

    const activeCount = await this.deliveriesRepository.countActiveByDriverId(driver.id);
    if (activeCount > 0) {
      throw new BadRequestException(
        'Availability cannot be changed manually while an active delivery is in progress',
      );
    }

    return this.driversRepository.updateAvailabilityStatus(driver.id, status);
  }

  async updateProfile(userId: string, dto: UpdateDriverProfileDto): Promise<Driver> {
    const driver = await this.getOwnProfile(userId);
    return this.driversRepository.updateProfile(driver.id, dto);
  }

  async getOwnPerformanceMetrics(userId: string): Promise<DriverPerformanceMetricsEntity> {
    const driver = await this.getOwnProfile(userId);
    return this.getPerformanceMetrics(driver.id);
  }

  async getPerformanceMetrics(driverId: string): Promise<DriverPerformanceMetricsEntity> {
    const driver = await this.driversRepository.findById(driverId);
    if (!driver) {
      throw new NotFoundException('Driver not found');
    }

    const deliveries = await this.deliveriesRepository.findAllByDriverForMetrics(driverId);

    const windowedDeliveries = deliveries.filter(
      (delivery) => delivery.deliveredAt && delivery.customerDeliveryWindowEnd,
    );
    const onTimeDeliveryRate = windowedDeliveries.length
      ? windowedDeliveries.filter(
          (delivery) => delivery.deliveredAt! <= delivery.customerDeliveryWindowEnd!,
        ).length / windowedDeliveries.length
      : null;

    const pickedUpDeliveries = deliveries.filter((delivery) => delivery.pickedUpAt);
    const averagePickupDelayMinutes = pickedUpDeliveries.length
      ? pickedUpDeliveries.reduce(
          (sum, delivery) =>
            sum + (delivery.pickedUpAt!.getTime() - delivery.assignedAt.getTime()) / 60_000,
          0,
        ) / pickedUpDeliveries.length
      : null;

    const resolvedAcceptanceDeliveries = deliveries.filter(
      (delivery) =>
        delivery.customerAcceptanceStatus === 'ACCEPTED' ||
        delivery.customerAcceptanceStatus === 'REJECTED',
    );
    const customerAcceptanceRate = resolvedAcceptanceDeliveries.length
      ? resolvedAcceptanceDeliveries.filter(
          (delivery) => delivery.customerAcceptanceStatus === 'ACCEPTED',
        ).length / resolvedAcceptanceDeliveries.length
      : null;

    const deliveredCount = deliveries.filter((delivery) => delivery.deliveredAt).length;
    const failedCount = deliveries.filter((delivery) => delivery.failedAt).length;
    const failedDeliveryRate =
      deliveredCount + failedCount > 0 ? failedCount / (deliveredCount + failedCount) : null;

    const deliveriesWithDuration = deliveries.filter((delivery) => delivery.routeHistory);
    const averageDeliveryDurationMinutes = deliveriesWithDuration.length
      ? deliveriesWithDuration.reduce(
          (sum, delivery) => sum + delivery.routeHistory!.durationMinutes,
          0,
        ) / deliveriesWithDuration.length
      : null;

    const temperatureComplianceRate = await this.computeTemperatureComplianceRate(
      driver.userId,
      deliveries,
    );

    return {
      onTimeDeliveryRate,
      averagePickupDelayMinutes,
      customerAcceptanceRate,
      failedDeliveryRate,
      temperatureComplianceRate,
      averageDeliveryDurationMinutes,
    };
  }

  // TemperatureReading has no direct deliveryId - correlates via the lots
  // present in a delivery's items plus a recordedAt window between
  // assignment and the delivery's terminal timestamp. Best-available signal
  // given the current schema; a direct FK would remove this ambiguity.
  private async computeTemperatureComplianceRate(
    driverUserId: string,
    deliveries: DeliveryForMetrics[],
  ): Promise<number | null> {
    const lotIds = new Set<string>();
    for (const delivery of deliveries) {
      for (const item of delivery.vendorOrder.items) {
        if (item.product.lotId) {
          lotIds.add(item.product.lotId);
        }
      }
    }
    if (lotIds.size === 0) {
      return null;
    }

    const readings = await this.prisma.temperatureReading.findMany({
      where: {
        recordedById: driverUserId,
        checkpoint: { in: TEMPERATURE_COMPLIANCE_CHECKPOINTS },
        lotId: { in: Array.from(lotIds) },
      },
      select: { lotId: true, recordedAt: true, alert: { select: { id: true } } },
    });

    let deliveriesWithReading = 0;
    let deliveriesCompliant = 0;

    for (const delivery of deliveries) {
      const deliveryLotIds = new Set(
        delivery.vendorOrder.items
          .map((item) => item.product.lotId)
          .filter((lotId): lotId is string => lotId !== null),
      );
      if (deliveryLotIds.size === 0) {
        continue;
      }

      const windowEnd = delivery.deliveredAt ?? delivery.failedAt ?? new Date();
      const matchedReadings = readings.filter(
        (reading) =>
          deliveryLotIds.has(reading.lotId) &&
          reading.recordedAt >= delivery.assignedAt &&
          reading.recordedAt <= windowEnd,
      );

      if (matchedReadings.length === 0) {
        continue;
      }
      deliveriesWithReading += 1;
      if (matchedReadings.every((reading) => !reading.alert)) {
        deliveriesCompliant += 1;
      }
    }

    return deliveriesWithReading > 0 ? deliveriesCompliant / deliveriesWithReading : null;
  }
}
