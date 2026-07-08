import { Injectable } from '@nestjs/common';
import { FleetAsset, FleetAssetStatus, FleetAssetType, FleetOwnership, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateFleetAssetInput {
  zoneId: string;
  assetType: FleetAssetType;
  ownership: FleetOwnership;
  licensePlate: string;
  capacityLbs: number;
  coldChainCapable?: boolean;
}

export interface UpdateFleetAssetInput {
  status?: FleetAssetStatus;
  currentDriverId?: string | null;
  coldChainCapable?: boolean;
}

export interface FleetAssetFilters {
  zoneId?: string;
  status?: FleetAssetStatus;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class FleetAssetsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateFleetAssetInput): Promise<FleetAsset> {
    return this.prisma.fleetAsset.create({ data: input });
  }

  findById(id: string): Promise<FleetAsset | null> {
    return this.prisma.fleetAsset.findUnique({ where: { id } });
  }

  findByLicensePlate(licensePlate: string): Promise<FleetAsset | null> {
    return this.prisma.fleetAsset.findUnique({ where: { licensePlate } });
  }

  update(id: string, input: UpdateFleetAssetInput): Promise<FleetAsset> {
    return this.prisma.fleetAsset.update({ where: { id }, data: input });
  }

  async findMany(
    filters: FleetAssetFilters,
    page: Page,
  ): Promise<{ items: FleetAsset[]; total: number }> {
    const where: Prisma.FleetAssetWhereInput = {
      ...(filters.zoneId ? { zoneId: filters.zoneId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.fleetAsset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.fleetAsset.count({ where }),
    ]);

    return { items, total };
  }
}
