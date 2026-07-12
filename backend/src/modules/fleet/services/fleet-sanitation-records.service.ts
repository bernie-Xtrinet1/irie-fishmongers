import { Injectable, NotFoundException } from '@nestjs/common';
import { FleetSanitationRecord } from '@prisma/client';

import { CreateFleetSanitationRecordDto } from '../dto/create-fleet-sanitation-record.dto';
import { FleetAssetsRepository } from '../repositories/fleet-assets.repository';
import { FleetSanitationRecordsRepository } from '../repositories/fleet-sanitation-records.repository';

export interface PaginatedFleetSanitationRecords {
  items: FleetSanitationRecord[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class FleetSanitationRecordsService {
  constructor(
    private readonly sanitationRecordsRepository: FleetSanitationRecordsRepository,
    private readonly fleetAssetsRepository: FleetAssetsRepository,
  ) {}

  async create(
    fleetAssetId: string,
    dto: CreateFleetSanitationRecordDto,
  ): Promise<FleetSanitationRecord> {
    const asset = await this.fleetAssetsRepository.findById(fleetAssetId);
    if (!asset) {
      throw new NotFoundException('Fleet asset not found');
    }

    return this.sanitationRecordsRepository.create({
      fleetAssetId,
      performedAt: new Date(dto.performedAt),
      performedBy: dto.performedBy,
      method: dto.method,
      notes: dto.notes,
      nextDueAt: dto.nextDueAt ? new Date(dto.nextDueAt) : undefined,
      status: dto.status,
    });
  }

  async findByFleetAssetId(
    fleetAssetId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedFleetSanitationRecords> {
    const asset = await this.fleetAssetsRepository.findById(fleetAssetId);
    if (!asset) {
      throw new NotFoundException('Fleet asset not found');
    }

    const { items, total } = await this.sanitationRecordsRepository.findByFleetAssetId(
      fleetAssetId,
      { skip: (page.page - 1) * page.pageSize, take: page.pageSize },
    );

    return { items, total, page: page.page, pageSize: page.pageSize };
  }
}
