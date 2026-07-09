import { Injectable } from '@nestjs/common';
import { RegulatoryStatus, Species } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateSpeciesInput {
  scientificName: string;
  commercialName: string;
  regulatoryStatus?: RegulatoryStatus;
  seasonalStartMonth?: number;
  seasonalEndMonth?: number;
  minimumSizeCm?: number;
}

export interface UpdateSpeciesInput {
  commercialName?: string;
  regulatoryStatus?: RegulatoryStatus;
  seasonalStartMonth?: number;
  seasonalEndMonth?: number;
  minimumSizeCm?: number;
}

@Injectable()
export class SpeciesRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateSpeciesInput): Promise<Species> {
    return this.prisma.species.create({ data: input });
  }

  findById(id: string): Promise<Species | null> {
    return this.prisma.species.findUnique({ where: { id } });
  }

  findByScientificName(scientificName: string): Promise<Species | null> {
    return this.prisma.species.findUnique({ where: { scientificName } });
  }

  update(id: string, input: UpdateSpeciesInput): Promise<Species> {
    return this.prisma.species.update({ where: { id }, data: input });
  }

  findAll(): Promise<Species[]> {
    return this.prisma.species.findMany({ orderBy: { commercialName: 'asc' } });
  }
}
