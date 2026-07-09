import { Injectable } from '@nestjs/common';
import { Fisherman, FishermanStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateFishermanInput {
  userId: string;
  vendorId?: string;
  fullName: string;
  contactPhone: string;
  contactEmail?: string;
  vesselName?: string;
  vesselRegistrationNumber?: string;
  fishingLicenseNumber?: string;
  landingSiteId?: string;
  bankAccountName?: string;
  bankAccountNumber?: string;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class FishermenRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateFishermanInput): Promise<Fisherman> {
    return this.prisma.fisherman.create({ data: input });
  }

  findById(id: string): Promise<Fisherman | null> {
    return this.prisma.fisherman.findUnique({ where: { id } });
  }

  findByUserId(userId: string): Promise<Fisherman | null> {
    return this.prisma.fisherman.findUnique({ where: { userId } });
  }

  updateStatus(id: string, status: FishermanStatus): Promise<Fisherman> {
    return this.prisma.fisherman.update({ where: { id }, data: { status } });
  }

  async findMany(
    status: FishermanStatus | undefined,
    page: Page,
  ): Promise<{ items: Fisherman[]; total: number }> {
    const where: Prisma.FishermanWhereInput = status ? { status } : {};

    const [items, total] = await Promise.all([
      this.prisma.fisherman.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.fisherman.count({ where }),
    ]);

    return { items, total };
  }
}
