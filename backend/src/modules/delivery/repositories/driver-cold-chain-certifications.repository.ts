import { Injectable } from '@nestjs/common';
import { DriverColdChainCertification, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateDriverColdChainCertificationInput {
  driverId: string;
  issuedBy: string;
  issuedAt: Date;
  expiresAt: Date;
  documentUrl?: string;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class DriverColdChainCertificationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateDriverColdChainCertificationInput): Promise<DriverColdChainCertification> {
    return this.prisma.driverColdChainCertification.create({ data: input });
  }

  findById(id: string): Promise<DriverColdChainCertification | null> {
    return this.prisma.driverColdChainCertification.findUnique({ where: { id } });
  }

  revoke(id: string): Promise<DriverColdChainCertification> {
    return this.prisma.driverColdChainCertification.update({
      where: { id },
      data: { status: 'REVOKED' },
    });
  }

  async findByDriverId(
    driverId: string,
    page: Page,
  ): Promise<{ items: DriverColdChainCertification[]; total: number }> {
    const where: Prisma.DriverColdChainCertificationWhereInput = { driverId };

    const [items, total] = await Promise.all([
      this.prisma.driverColdChainCertification.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.driverColdChainCertification.count({ where }),
    ]);

    return { items, total };
  }

  // Backs computeIsCertified: a driver is currently certified if any
  // non-revoked, non-expired certification exists. Status transitions to
  // EXPIRED are computed on read here rather than via a cron - unlike
  // SLABreach's OVERDUE_IN_TRANSIT (which needs a queryable historical
  // record the moment it becomes true), nothing downstream needs to know
  // the exact moment a certification expired, only whether it's valid
  // right now.
  findActiveByDriverId(driverId: string, now: Date): Promise<DriverColdChainCertification[]> {
    return this.prisma.driverColdChainCertification.findMany({
      where: { driverId, status: { not: 'REVOKED' }, expiresAt: { gt: now } },
    });
  }
}
