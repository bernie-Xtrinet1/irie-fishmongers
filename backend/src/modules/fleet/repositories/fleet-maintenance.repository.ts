import { Injectable } from '@nestjs/common';
import { FleetMaintenance, FleetMaintenanceStatus, Prisma } from '@prisma/client';

import { PrismaClientOrTx } from '../../orders/repositories/orders.repository';
import { PrismaService } from '../../../database/prisma.service';

export interface CreateFleetMaintenanceInput {
  fleetAssetId: string;
  serviceDate: Date;
  mileage?: number;
  technician?: string;
  cost?: number;
  nextServiceDue?: Date;
  status?: FleetMaintenanceStatus;
  notes?: string;
}

export interface UpdateFleetMaintenanceInput {
  serviceDate?: Date;
  mileage?: number;
  technician?: string;
  cost?: number;
  nextServiceDue?: Date;
  status?: FleetMaintenanceStatus;
  notes?: string;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class FleetMaintenanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    input: CreateFleetMaintenanceInput,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<FleetMaintenance> {
    return client.fleetMaintenance.create({ data: input });
  }

  findById(id: string): Promise<FleetMaintenance | null> {
    return this.prisma.fleetMaintenance.findUnique({ where: { id } });
  }

  update(id: string, input: UpdateFleetMaintenanceInput): Promise<FleetMaintenance> {
    return this.prisma.fleetMaintenance.update({ where: { id }, data: input });
  }

  async findByFleetAssetId(
    fleetAssetId: string,
    page: Page,
  ): Promise<{ items: FleetMaintenance[]; total: number }> {
    const where: Prisma.FleetMaintenanceWhereInput = { fleetAssetId };

    const [items, total] = await Promise.all([
      this.prisma.fleetMaintenance.findMany({
        where,
        orderBy: { serviceDate: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.fleetMaintenance.count({ where }),
    ]);

    return { items, total };
  }
}
