import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { FleetAsset, FleetAssetStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { CreateFleetAssetDto } from '../dto/create-fleet-asset.dto';
import { ListFleetAssetsDto } from '../dto/list-fleet-assets.dto';
import { UpdateFleetAssetDto } from '../dto/update-fleet-asset.dto';
import { FleetAssetsRepository } from '../repositories/fleet-assets.repository';

export interface FleetZoneSummary {
  zoneId: string;
  status: FleetAssetStatus;
  count: number;
}

export interface PaginatedFleetAssets {
  items: FleetAsset[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class FleetAssetsService {
  constructor(
    private readonly fleetAssetsRepository: FleetAssetsRepository,
    private readonly prisma: PrismaService,
  ) {}

  async create(dto: CreateFleetAssetDto): Promise<FleetAsset> {
    const zone = await this.prisma.deliveryZone.findUnique({ where: { id: dto.zoneId } });
    if (!zone) {
      throw new NotFoundException('Delivery zone not found');
    }

    const existing = await this.fleetAssetsRepository.findByLicensePlate(dto.licensePlate);
    if (existing) {
      throw new ConflictException(
        `A fleet asset with license plate "${dto.licensePlate}" already exists`,
      );
    }

    return this.fleetAssetsRepository.create(dto);
  }

  async findById(id: string): Promise<FleetAsset> {
    const asset = await this.fleetAssetsRepository.findById(id);
    if (!asset) {
      throw new NotFoundException('Fleet asset not found');
    }
    return asset;
  }

  async update(id: string, dto: UpdateFleetAssetDto): Promise<FleetAsset> {
    await this.findById(id);

    if (dto.currentDriverId) {
      const driver = await this.prisma.driver.findUnique({ where: { id: dto.currentDriverId } });
      if (!driver) {
        throw new NotFoundException('Driver not found');
      }
    }

    return this.fleetAssetsRepository.update(id, dto);
  }

  async list(dto: ListFleetAssetsDto): Promise<PaginatedFleetAssets> {
    const { items, total } = await this.fleetAssetsRepository.findMany(
      { zoneId: dto.zoneId, status: dto.status },
      { skip: (dto.page - 1) * dto.pageSize, take: dto.pageSize },
    );

    return { items, total, page: dto.page, pageSize: dto.pageSize };
  }

  getZoneSummary(): Promise<FleetZoneSummary[]> {
    return this.fleetAssetsRepository.countByZoneAndStatus();
  }
}
