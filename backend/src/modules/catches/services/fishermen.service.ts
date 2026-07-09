import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Fisherman } from '@prisma/client';

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
    id: string,
    status: (typeof ASSIGNABLE_FISHERMAN_STATUSES)[number],
  ): Promise<Fisherman> {
    const fisherman = await this.fishermenRepository.findById(id);
    if (!fisherman) {
      throw new NotFoundException('Fisherman not found');
    }
    return this.fishermenRepository.updateStatus(id, status);
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
