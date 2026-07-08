import { Injectable, NotFoundException } from '@nestjs/common';
import { FleetMaintenance } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { CreateFleetMaintenanceDto } from '../dto/create-fleet-maintenance.dto';
import { UpdateFleetMaintenanceDto } from '../dto/update-fleet-maintenance.dto';
import { FleetAssetsRepository } from '../repositories/fleet-assets.repository';
import { FleetMaintenanceRepository } from '../repositories/fleet-maintenance.repository';

export interface PaginatedFleetMaintenance {
  items: FleetMaintenance[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class FleetMaintenanceService {
  constructor(
    private readonly maintenanceRepository: FleetMaintenanceRepository,
    private readonly fleetAssetsRepository: FleetAssetsRepository,
    private readonly prisma: PrismaService,
  ) {}

  async create(
    fleetAssetId: string,
    dto: CreateFleetMaintenanceDto,
  ): Promise<FleetMaintenance> {
    const asset = await this.fleetAssetsRepository.findById(fleetAssetId);
    if (!asset) {
      throw new NotFoundException('Fleet asset not found');
    }

    return this.prisma.$transaction(async (tx) => {
      const record = await this.maintenanceRepository.create(
        {
          fleetAssetId,
          serviceDate: new Date(dto.serviceDate),
          mileage: dto.mileage,
          technician: dto.technician,
          cost: dto.cost,
          nextServiceDue: dto.nextServiceDue ? new Date(dto.nextServiceDue) : undefined,
          status: dto.status,
          notes: dto.notes,
        },
        tx,
      );

      // Explicit, traceable state change made in this one call - not an
      // implicit trigger/side-effect on the asset.
      if (record.status === 'IN_PROGRESS') {
        await tx.fleetAsset.update({
          where: { id: fleetAssetId },
          data: { status: 'MAINTENANCE' },
        });
      }

      return record;
    });
  }

  async findByFleetAssetId(
    fleetAssetId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedFleetMaintenance> {
    const asset = await this.fleetAssetsRepository.findById(fleetAssetId);
    if (!asset) {
      throw new NotFoundException('Fleet asset not found');
    }

    const { items, total } = await this.maintenanceRepository.findByFleetAssetId(fleetAssetId, {
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    return { items, total, page: page.page, pageSize: page.pageSize };
  }

  async update(id: string, dto: UpdateFleetMaintenanceDto): Promise<FleetMaintenance> {
    const existing = await this.maintenanceRepository.findById(id);
    if (!existing) {
      throw new NotFoundException('Fleet maintenance record not found');
    }

    const updated = await this.maintenanceRepository.update(id, {
      serviceDate: dto.serviceDate ? new Date(dto.serviceDate) : undefined,
      mileage: dto.mileage,
      technician: dto.technician,
      cost: dto.cost,
      nextServiceDue: dto.nextServiceDue ? new Date(dto.nextServiceDue) : undefined,
      status: dto.status,
      notes: dto.notes,
    });

    if (dto.status === 'IN_PROGRESS') {
      await this.prisma.fleetAsset.update({
        where: { id: existing.fleetAssetId },
        data: { status: 'MAINTENANCE' },
      });
    }

    return updated;
  }
}
