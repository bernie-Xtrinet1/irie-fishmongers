import { Injectable } from '@nestjs/common';
import { FleetTrip, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateFleetTripInput {
  fleetAssetId: string;
  driverId: string;
  zoneId: string;
  startedAt: Date;
  endedAt?: Date;
  fuelCost?: number;
  driverWage?: number;
  maintenanceAllocation?: number;
  insuranceAllocation?: number;
}

export interface UpdateFleetTripInput {
  endedAt?: Date;
  fuelCost?: number;
  driverWage?: number;
  maintenanceAllocation?: number;
  insuranceAllocation?: number;
}

export interface FleetTripFilters {
  fleetAssetId?: string;
  driverId?: string;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class FleetTripsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateFleetTripInput): Promise<FleetTrip> {
    return this.prisma.fleetTrip.create({ data: input });
  }

  findById(id: string): Promise<FleetTrip | null> {
    return this.prisma.fleetTrip.findUnique({ where: { id } });
  }

  update(id: string, input: UpdateFleetTripInput): Promise<FleetTrip> {
    return this.prisma.fleetTrip.update({ where: { id }, data: input });
  }

  async findMany(
    filters: FleetTripFilters,
    page: Page,
  ): Promise<{ items: FleetTrip[]; total: number }> {
    const where: Prisma.FleetTripWhereInput = {
      ...(filters.fleetAssetId ? { fleetAssetId: filters.fleetAssetId } : {}),
      ...(filters.driverId ? { driverId: filters.driverId } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.fleetTrip.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.fleetTrip.count({ where }),
    ]);

    return { items, total };
  }
}
