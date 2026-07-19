import { Injectable } from '@nestjs/common';
import { CertificationStatus, Prisma, RegulatoryCertification } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateRegulatoryCertificationInput {
  vendorId?: string;
  fishermanId?: string;
  landingSiteId?: string;
  certificateType: string;
  certificateNumber: string;
  issuingAuthorityId: string;
  issuedDate: Date;
  expiryDate?: Date;
  documentUrl?: string;
}

export interface UpdateRegulatoryCertificationInput {
  status?: CertificationStatus;
  expiryDate?: Date;
  documentUrl?: string;
}

export interface Page {
  skip: number;
  take: number;
}

export interface ListRegulatoryCertificationsFilters {
  vendorId?: string;
  fishermanId?: string;
  landingSiteId?: string;
}

@Injectable()
export class RegulatoryCertificationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateRegulatoryCertificationInput): Promise<RegulatoryCertification> {
    return this.prisma.regulatoryCertification.create({ data: input });
  }

  findById(id: string): Promise<RegulatoryCertification | null> {
    return this.prisma.regulatoryCertification.findUnique({ where: { id } });
  }

  update(id: string, input: UpdateRegulatoryCertificationInput): Promise<RegulatoryCertification> {
    return this.prisma.regulatoryCertification.update({ where: { id }, data: input });
  }

  async findMany(
    filters: ListRegulatoryCertificationsFilters,
    page: Page,
  ): Promise<{ items: RegulatoryCertification[]; total: number }> {
    const where: Prisma.RegulatoryCertificationWhereInput = {
      ...(filters.vendorId ? { vendorId: filters.vendorId } : {}),
      ...(filters.fishermanId ? { fishermanId: filters.fishermanId } : {}),
      ...(filters.landingSiteId ? { landingSiteId: filters.landingSiteId } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.regulatoryCertification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.regulatoryCertification.count({ where }),
    ]);

    return { items, total };
  }

  // Mirrors VendorDocumentsService.syncExpiredStatuses's computed-on-read
  // pattern - only ACTIVE rows can have genuinely lapsed, since a
  // PENDING/SUSPENDED certificate was never in force.
  findActiveButExpired(asOf: Date): Promise<RegulatoryCertification[]> {
    return this.prisma.regulatoryCertification.findMany({
      where: { status: 'ACTIVE', expiryDate: { lt: asOf } },
    });
  }
}
