import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FleetAsset, FleetMaintenance } from '@prisma/client';

import { FleetMaintenanceOverdueEvent } from '../../../common/events/fleet-maintenance-overdue.event';
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
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(
    fleetAssetId: string,
    dto: CreateFleetMaintenanceDto,
  ): Promise<FleetMaintenance> {
    const asset = await this.fleetAssetsRepository.findById(fleetAssetId);
    if (!asset) {
      throw new NotFoundException('Fleet asset not found');
    }

    const record = await this.prisma.$transaction(async (tx) => {
      const created = await this.maintenanceRepository.create(
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
      if (created.status === 'IN_PROGRESS') {
        await tx.fleetAsset.update({
          where: { id: fleetAssetId },
          data: { status: 'MAINTENANCE' },
        });
      }

      return created;
    });

    if (record.status === 'OVERDUE') {
      await this.notifyOverdueIfDriverAssigned(asset, record);
    }

    return record;
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

    if (dto.status === 'OVERDUE' && existing.status !== 'OVERDUE') {
      const asset = await this.fleetAssetsRepository.findById(existing.fleetAssetId);
      if (asset) {
        await this.notifyOverdueIfDriverAssigned(asset, updated);
      }
    }

    return updated;
  }

  // Reads Driver.userId directly via the global PrismaService rather than
  // depending on DeliveryModule's DriversRepository - FleetModule staying
  // leaf-level avoids a cycle, mirroring VendorPickupQueueService's
  // established precedent for the same kind of cross-module lookup.
  private async notifyOverdueIfDriverAssigned(
    asset: FleetAsset,
    record: FleetMaintenance,
  ): Promise<void> {
    if (!asset.currentDriverId) {
      return;
    }

    const driver = await this.prisma.driver.findUnique({
      where: { id: asset.currentDriverId },
      select: { userId: true },
    });
    if (!driver) {
      return;
    }

    this.eventEmitter.emit(
      FleetMaintenanceOverdueEvent.eventName,
      new FleetMaintenanceOverdueEvent(
        driver.userId,
        asset.licensePlate,
        record.nextServiceDue?.toISOString() ?? null,
      ),
    );
  }
}
