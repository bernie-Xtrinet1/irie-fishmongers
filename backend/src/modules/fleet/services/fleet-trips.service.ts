import { Injectable, NotFoundException } from '@nestjs/common';
import { FleetTrip } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { CreateFleetTripDto } from '../dto/create-fleet-trip.dto';
import { ListFleetTripsDto } from '../dto/list-fleet-trips.dto';
import { UpdateFleetTripDto } from '../dto/update-fleet-trip.dto';
import { FleetAssetsRepository } from '../repositories/fleet-assets.repository';
import { FleetTripsRepository } from '../repositories/fleet-trips.repository';

export interface PaginatedFleetTrips {
  items: FleetTrip[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class FleetTripsService {
  constructor(
    private readonly fleetTripsRepository: FleetTripsRepository,
    private readonly fleetAssetsRepository: FleetAssetsRepository,
    private readonly prisma: PrismaService,
  ) {}

  async create(dto: CreateFleetTripDto): Promise<FleetTrip> {
    const asset = await this.fleetAssetsRepository.findById(dto.fleetAssetId);
    if (!asset) {
      throw new NotFoundException('Fleet asset not found');
    }

    const driver = await this.prisma.driver.findUnique({ where: { id: dto.driverId } });
    if (!driver) {
      throw new NotFoundException('Driver not found');
    }

    const zone = await this.prisma.deliveryZone.findUnique({ where: { id: dto.zoneId } });
    if (!zone) {
      throw new NotFoundException('Delivery zone not found');
    }

    return this.fleetTripsRepository.create({
      fleetAssetId: dto.fleetAssetId,
      driverId: dto.driverId,
      zoneId: dto.zoneId,
      startedAt: new Date(dto.startedAt),
      endedAt: dto.endedAt ? new Date(dto.endedAt) : undefined,
      fuelCost: dto.fuelCost,
      driverWage: dto.driverWage,
      maintenanceAllocation: dto.maintenanceAllocation,
      insuranceAllocation: dto.insuranceAllocation,
    });
  }

  async findById(id: string): Promise<FleetTrip> {
    const trip = await this.fleetTripsRepository.findById(id);
    if (!trip) {
      throw new NotFoundException('Fleet trip not found');
    }
    return trip;
  }

  async update(id: string, dto: UpdateFleetTripDto): Promise<FleetTrip> {
    await this.findById(id);

    return this.fleetTripsRepository.update(id, {
      endedAt: dto.endedAt ? new Date(dto.endedAt) : undefined,
      fuelCost: dto.fuelCost,
      driverWage: dto.driverWage,
      maintenanceAllocation: dto.maintenanceAllocation,
      insuranceAllocation: dto.insuranceAllocation,
    });
  }

  async list(dto: ListFleetTripsDto): Promise<PaginatedFleetTrips> {
    const { items, total } = await this.fleetTripsRepository.findMany(
      { fleetAssetId: dto.fleetAssetId, driverId: dto.driverId },
      { skip: (dto.page - 1) * dto.pageSize, take: dto.pageSize },
    );

    return { items, total, page: dto.page, pageSize: dto.pageSize };
  }
}
