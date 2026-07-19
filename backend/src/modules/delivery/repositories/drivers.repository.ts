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

  // 10A Fleet Dispatch Engine's candidate pool for a delivery run: eligible
  // means APPROVED + ONLINE + assigned to the run's zone + (cold-chain
  // capable if the run requires it) + not already driving another
  // in-progress run (current-load exclusion, mirroring
  // DeliveriesRepository.countActiveByDriverId's hard-block pattern for the
  // single-delivery claim path rather than inventing a new one). Zone match
  // substitutes for real distance-to-pickup - no Vendor lat/long exists in
  // this schema (Phase 12B.0 finding), so this is an explicit scope
  // decision, not an oversight.
  async findDispatchCandidates(zoneId: string, requiresColdChain: boolean): Promise<Driver[]> {
    return this.prisma.driver.findMany({
      where: {
        status: 'APPROVED',
        availabilityStatus: 'ONLINE',
        assignedZoneId: zoneId,
        ...(requiresColdChain ? { coldChainCapable: true } : {}),
        deliveryRuns: { none: { status: 'IN_PROGRESS' } },
      },
    });
  }

  async countByStatus(): Promise<Record<DriverStatus, number>> {
    const groups = await this.prisma.driver.groupBy({ by: ['status'], _count: { _all: true } });
    const counts: Record<DriverStatus, number> = {
      PENDING: 0,
      APPROVED: 0,
      SUSPENDED: 0,
      REJECTED: 0,
    };
    for (const group of groups) {
      counts[group.status] = group._count._all;
    }
    return counts;
  }
}
