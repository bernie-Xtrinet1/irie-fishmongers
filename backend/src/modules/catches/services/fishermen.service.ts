import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Fisherman } from '@prisma/client';

import { ComplianceAuditLogService } from '../../food-safety/services/compliance-audit-log.service';
import { ASSIGNABLE_FISHERMAN_STATUSES } from '../dto/update-fisherman-status.dto';
import { RegisterFishermanDto } from '../dto/register-fisherman.dto';
import { FishermenRepository } from '../repositories/fishermen.repository';
import { LandingSitesRepository } from '../repositories/landing-sites.repository';

export interface PaginatedFishermen {
  items: Fisherman[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class FishermenService {
  constructor(
    private readonly fishermenRepository: FishermenRepository,
    private readonly landingSitesRepository: LandingSitesRepository,
    private readonly auditLogService: ComplianceAuditLogService,
  ) {}

  async register(userId: string, dto: RegisterFishermanDto): Promise<Fisherman> {
    const existing = await this.fishermenRepository.findByUserId(userId);
    if (existing) {
      throw new ConflictException('A fisherman profile already exists for this account');
    }

    if (dto.landingSiteId) {
      const site = await this.landingSitesRepository.findById(dto.landingSiteId);
      if (!site) {
        throw new NotFoundException('Landing site not found');
      }
    }

    return this.fishermenRepository.create({ userId, ...dto });
  }

  async getOwnProfile(userId: string): Promise<Fisherman> {
    const fisherman = await this.fishermenRepository.findByUserId(userId);
    if (!fisherman) {
      throw new NotFoundException('No fisherman profile exists for this account');
    }
    return fisherman;
  }

  async updateStatus(
    userId: string,
    id: string,
    status: (typeof ASSIGNABLE_FISHERMAN_STATUSES)[number],
    ipAddress?: string,
  ): Promise<Fisherman> {
    const fisherman = await this.fishermenRepository.findById(id);
    if (!fisherman) {
      throw new NotFoundException('Fisherman not found');
    }
    const updated = await this.fishermenRepository.updateStatus(id, status);

    await this.auditLogService.record({
      userId,
      action: 'FISHERMAN_STATUS_UPDATED',
      entityType: 'Fisherman',
      entityId: id,
      beforeValue: { status: fisherman.status },
      afterValue: { status: updated.status },
      ipAddress,
    });

    return updated;
  }

  async list(dto: {
    status?: Fisherman['status'];
    page: number;
    pageSize: number;
  }): Promise<PaginatedFishermen> {
    const { items, total } = await this.fishermenRepository.findMany(dto.status, {
      skip: (dto.page - 1) * dto.pageSize,
      take: dto.pageSize,
    });

    return { items, total, page: dto.page, pageSize: dto.pageSize };
  }
}
