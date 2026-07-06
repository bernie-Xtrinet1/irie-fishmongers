import { Injectable } from '@nestjs/common';
import { Parish, Prisma, Vendor, VendorStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateVendorInput {
  userId: string;
  businessName: string;
  parish: Parish;
  termsAcceptedAt: Date;
  phone?: string;
  description?: string;
}

export interface UpdateVendorInput {
  businessName?: string;
  description?: string;
  phone?: string;
  parish?: Parish;
  logoUrl?: string;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class VendorsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateVendorInput): Promise<Vendor> {
    return this.prisma.vendor.create({ data: input });
  }

  findById(id: string): Promise<Vendor | null> {
    return this.prisma.vendor.findUnique({ where: { id } });
  }

  findByUserId(userId: string): Promise<Vendor | null> {
    return this.prisma.vendor.findUnique({ where: { userId } });
  }

  updateStatus(id: string, status: VendorStatus): Promise<Vendor> {
    return this.prisma.vendor.update({ where: { id }, data: { status } });
  }

  update(id: string, input: UpdateVendorInput): Promise<Vendor> {
    return this.prisma.vendor.update({ where: { id }, data: input });
  }

  async findMany(
    status: VendorStatus | undefined,
    page: Page,
  ): Promise<{ items: Vendor[]; total: number }> {
    const where: Prisma.VendorWhereInput = status ? { status } : {};

    const [items, total] = await Promise.all([
      this.prisma.vendor.findMany({
        where,
        skip: page.skip,
        take: page.take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.vendor.count({ where }),
    ]);

    return { items, total };
  }
}
