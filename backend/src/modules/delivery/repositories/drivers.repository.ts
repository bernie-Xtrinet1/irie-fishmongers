import { Injectable } from '@nestjs/common';
import { Driver, DriverAvailabilityStatus, DriverStatus, Prisma, VehicleOwnership, VehicleType } from '@prisma/client';

import { PrismaClientOrTx } from '../../orders/repositories/orders.repository';
import { PrismaService } from '../../../database/prisma.service';

export interface CreateDriverInput {
  userId: string;
  licensePlate: string;
  vehicleType: VehicleType;
  vehicleOwnership: VehicleOwnership;
}

export interface UpdateDriverProfileInput {
  capacityLbs?: number;
  coldChainCapable?: boolean;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class DriversRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateDriverInput): Promise<Driver> {
    return this.prisma.driver.create({ data: input });
  }

  findById(id: string): Promise<Driver | null> {
    return this.prisma.driver.findUnique({ where: { id } });
  }

  findByUserId(userId: string): Promise<Driver | null> {
    return this.prisma.driver.findUnique({ where: { userId } });
  }

  updateStatus(id: string, status: DriverStatus): Promise<Driver> {
    return this.prisma.driver.update({ where: { id }, data: { status } });
  }

  updateAvailabilityStatus(
    id: string,
    availabilityStatus: DriverAvailabilityStatus,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<Driver> {
    return client.driver.update({ where: { id }, data: { availabilityStatus } });
  }

  updateProfile(id: string, input: UpdateDriverProfileInput): Promise<Driver> {
    return this.prisma.driver.update({ where: { id }, data: input });
  }

  async findMany(
    status: DriverStatus | undefined,
    page: Page,
  ): Promise<{ items: Driver[]; total: number }> {
    const where: Prisma.DriverWhereInput = status ? { status } : {};

    const [items, total] = await Promise.all([
      this.prisma.driver.findMany({
        where,
        skip: page.skip,
        take: page.take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.driver.count({ where }),
    ]);

    return { items, total };
  }
}
