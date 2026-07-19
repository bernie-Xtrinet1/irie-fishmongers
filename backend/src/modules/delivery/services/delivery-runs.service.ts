import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { AssignDeliveryRunDto } from '../dto/assign-delivery-run.dto';
import { ListDeliveryRunsDto } from '../dto/list-delivery-runs.dto';
import { DeliveryRunResponseEntity } from '../entities/delivery-run-response.entity';
import {
  DeliveryRunsRepository,
  DeliveryRunWithStops,
} from '../repositories/delivery-runs.repository';
import { DriversRepository } from '../repositories/drivers.repository';

export interface PaginatedDeliveryRuns {
  items: DeliveryRunResponseEntity[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class DeliveryRunsService {
  constructor(
    private readonly deliveryRunsRepository: DeliveryRunsRepository,
    private readonly driversRepository: DriversRepository,
  ) {}

  async getById(id: string): Promise<DeliveryRunResponseEntity> {
    const run = await this.deliveryRunsRepository.findById(id);
    if (!run) {
      throw new NotFoundException('Delivery run not found');
    }
    return DeliveryRunsService.toResponse(run);
  }

  // Feeds the Delivery Operations Center dashboard (10B): status/zoneId
  // filters let the frontend separate "needs dispatch" (PLANNED) from
  // "active" (IN_PROGRESS) lists without over-fetching.
  async list(dto: ListDeliveryRunsDto): Promise<PaginatedDeliveryRuns> {
    const { items, total } = await this.deliveryRunsRepository.findMany(
      { status: dto.status, zoneId: dto.zoneId },
      { skip: (dto.page - 1) * dto.pageSize, take: dto.pageSize },
    );

    return {
      items: items.map((run) => DeliveryRunsService.toResponse(run)),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  async assign(id: string, dto: AssignDeliveryRunDto): Promise<DeliveryRunResponseEntity> {
    const run = await this.deliveryRunsRepository.findById(id);
    if (!run) {
      throw new NotFoundException('Delivery run not found');
    }
    if (run.status !== 'PLANNED') {
      throw new BadRequestException('Only a planned delivery run can be assigned');
    }

    const driver = await this.driversRepository.findById(dto.driverId);
    if (!driver) {
      throw new NotFoundException('Driver not found');
    }

    const updated = await this.deliveryRunsRepository.assign(id, dto);
    return DeliveryRunsService.toResponse(updated);
  }

  private static toResponse(run: DeliveryRunWithStops): DeliveryRunResponseEntity {
    return {
      id: run.id,
      zoneId: run.zoneId,
      driverId: run.driverId,
      fleetAssetId: run.fleetAssetId,
      status: run.status,
      stops: run.stops.map((stop) => ({
        id: stop.id,
        deliveryId: stop.deliveryId,
        sequence: stop.sequence,
      })),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }
}
