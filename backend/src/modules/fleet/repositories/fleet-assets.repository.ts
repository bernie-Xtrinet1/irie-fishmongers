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
  coldChainCapable?: boolean;
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
      ...(filters.coldChainCapable !== undefined ? { coldChainCapable: filters.coldChainCapable } : {}),
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

  // 10A Fleet Dispatch Engine's candidate pool, mirroring
  // DriversRepository.findDispatchCandidates: ACTIVE + zone match + (cold-
  // chain capable if required) + not already on another in-progress run.
  async findDispatchCandidates(zoneId: string, requiresColdChain: boolean): Promise<FleetAsset[]> {
    return this.prisma.fleetAsset.findMany({
      where: {
        zoneId,
        status: 'ACTIVE',
        ...(requiresColdChain ? { coldChainCapable: true } : {}),
        deliveryRuns: { none: { status: 'IN_PROGRESS' } },
      },
    });
  }
}
