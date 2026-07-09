import { Injectable } from '@nestjs/common';
import { Prisma, Vessel, VesselRegistrationStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateVesselInput {
  ownerFishermanId: string;
  registrationNumber: string;
  name: string;
  fishingMethod: Vessel['fishingMethod'];
  capacityTons?: number;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class VesselsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateVesselInput): Promise<Vessel> {
    return this.prisma.vessel.create({ data: input });
  }

  findById(id: string): Promise<Vessel | null> {
    return this.prisma.vessel.findUnique({ where: { id } });
  }

  findByRegistrationNumber(registrationNumber: string): Promise<Vessel | null> {
    return this.prisma.vessel.findUnique({ where: { registrationNumber } });
  }

  updateStatus(id: string, status: VesselRegistrationStatus): Promise<Vessel> {
    return this.prisma.vessel.update({ where: { id }, data: { status } });
  }

  async findMany(
    filters: { ownerFishermanId?: string },
    page: Page,
  ): Promise<{ items: Vessel[]; total: number }> {
    const where: Prisma.VesselWhereInput = filters.ownerFishermanId
      ? { ownerFishermanId: filters.ownerFishermanId }
      : {};

    const [items, total] = await Promise.all([
      this.prisma.vessel.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.vessel.count({ where }),
    ]);

    return { items, total };
  }
}
