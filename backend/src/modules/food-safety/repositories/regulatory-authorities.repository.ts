import { Injectable } from '@nestjs/common';
import { RegulatoryAuthority } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateRegulatoryAuthorityInput {
  name: string;
  country?: string;
  contactEmail?: string;
  contactPhone?: string;
  website?: string;
}

@Injectable()
export class RegulatoryAuthoritiesRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateRegulatoryAuthorityInput): Promise<RegulatoryAuthority> {
    return this.prisma.regulatoryAuthority.create({ data: input });
  }

  findById(id: string): Promise<RegulatoryAuthority | null> {
    return this.prisma.regulatoryAuthority.findUnique({ where: { id } });
  }

  findAll(): Promise<RegulatoryAuthority[]> {
    return this.prisma.regulatoryAuthority.findMany({ orderBy: { name: 'asc' } });
  }
}
