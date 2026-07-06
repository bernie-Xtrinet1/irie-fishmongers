import { Injectable } from '@nestjs/common';
import { Vendor, VendorStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateVendorInput {
  userId: string;
  businessName: string;
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
}
