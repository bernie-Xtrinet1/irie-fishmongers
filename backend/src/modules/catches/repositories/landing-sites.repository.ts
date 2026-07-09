import { Injectable } from '@nestjs/common';
import { LandingSite, LandingSiteStatus, Parish, SiteInspectionStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateLandingSiteInput {
  name: string;
  parish: Parish;
  latitude?: number;
  longitude?: number;
}

export interface UpdateLandingSiteInput {
  name?: string;
  latitude?: number;
  longitude?: number;
  status?: LandingSiteStatus;
  inspectionStatus?: SiteInspectionStatus;
}

@Injectable()
export class LandingSitesRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateLandingSiteInput): Promise<LandingSite> {
    return this.prisma.landingSite.create({ data: input });
  }

  findById(id: string): Promise<LandingSite | null> {
    return this.prisma.landingSite.findUnique({ where: { id } });
  }

  update(id: string, input: UpdateLandingSiteInput): Promise<LandingSite> {
    return this.prisma.landingSite.update({ where: { id }, data: input });
  }

  findAll(activeOnly = false): Promise<LandingSite[]> {
    return this.prisma.landingSite.findMany({
      where: activeOnly ? { status: 'ACTIVE' } : undefined,
      orderBy: { name: 'asc' },
    });
  }
}
